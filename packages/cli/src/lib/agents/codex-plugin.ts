import { execFile as execFileCallback } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { VERSION } from '../../version.js';
import { buildCoodraMcpEntry, type CoodraMcpEntry } from '../init/mcp-merge.js';
import type { WriteOutcome } from '../init/types.js';
import { buildManagedGraphifyMcpEntry } from './managed-capabilities.js';
import type { AgentContext, AgentPathContext, AgentRemoveContext } from './types.js';

const execFile = promisify(execFileCallback);

export const CODEX_PLUGIN_NAME = 'coodra' as const;
export const CODEX_MARKETPLACE_NAME = 'coodra' as const;
export const CODEX_PLUGIN_KEY = `${CODEX_PLUGIN_NAME}@${CODEX_MARKETPLACE_NAME}` as const;

/**
 * Prefer Codex's own `codex plugin` CLI to register the marketplace and
 * install/remove the plugin — it owns `~/.codex/config.toml` (marketplace
 * registrations, per-plugin enable state) and the plugin cache directly,
 * so Coodra never hand-writes or hand-deletes state Codex is responsible
 * for. Verified live against `codex-cli 0.146.0-alpha.9.2` (2026-08-02):
 * `codex plugin marketplace add <path>` requires the path to contain a
 * nested `.agents/plugins/marketplace.json` (a bare `marketplace.json`
 * at the root fails with "marketplace root does not contain a supported
 * manifest"); `codex plugin add <plugin>@<marketplace>` installs AND
 * enables in one step, is idempotent, and refreshes the cache in place
 * on re-run when the source content changes — there is no separate
 * enable call and no per-version cache directory to manage ourselves.
 *
 * Previously (through 0.4.5) this file wrote directly into the shared
 * `~/.agents/plugins/marketplace.json` ("personal" marketplace) and
 * hand-deleted `~/.codex/plugins/cache/personal/coodra/` on removal.
 * Both were wrong: the personal marketplace is the user's own namespace
 * (can hold their other plugins) — Coodra editing it directly risked
 * clobbering unrelated entries — and hand-deleting a cache path Codex
 * itself owns the format of is exactly the kind of guess this rewrite
 * removes. Coodra's marketplace is now dedicated
 * (`~/.coodra/codex-marketplaces/coodra/`, `codexPluginPaths().marketplaceRoot`),
 * named `"coodra"` not `"personal"`, which also makes the cache path
 * Codex assigns (`cache/$MARKETPLACE_NAME/$PLUGIN_NAME/`) become
 * `cache/coodra/coodra/` — the same shape as Claude's own
 * `cache/coodra/coodra/<version>/` mirror.
 */
export interface CodexCliRunner {
  /**
   * Resolves the codex binary: `which codex` first, then known bundle
   * install locations (the ChatGPT desktop app does not add itself to
   * PATH). `viaPath: false` means the caller should consider suggesting
   * the user symlink it onto PATH for their own convenience — Coodra's
   * own calls work fine either way since they always exec the resolved
   * absolute path directly.
   */
  detect(userHome: string): Promise<{ readonly path: string; readonly viaPath: boolean } | null>;
  installMarketplaceAndPlugin(
    codexBin: string,
    marketplaceRoot: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  uninstallPlugin(codexBin: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Best-effort: is `coodra@coodra` reported installed by `codex plugin list --json`? */
  isInstalled(codexBin: string): Promise<boolean>;
}

const CLI_TIMEOUT_MS = 15_000;

/**
 * Known locations for the Codex CLI binary when it's bundled inside the
 * ChatGPT desktop app rather than symlinked onto PATH — confirmed live
 * 2026-08-02: `/Applications/ChatGPT.app/Contents/Resources/codex`.
 * macOS only; Windows/Linux bundle locations aren't verified, so this
 * list intentionally stays short rather than guessing at unverified paths.
 */
function knownCodexBundlePaths(userHome: string): readonly string[] {
  return [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    join(userHome, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex'),
  ];
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function detectCodexCli(
  userHome: string,
  timeoutMs: number,
): Promise<{ readonly path: string; readonly viaPath: boolean } | null> {
  try {
    const { stdout } = await execFile('which', ['codex'], { timeout: timeoutMs });
    const path = stdout.trim();
    if (path.length > 0) return { path, viaPath: true };
  } catch {
    // not on PATH — fall through to known bundle locations
  }
  for (const candidate of knownCodexBundlePaths(userHome)) {
    if (await isExecutableFile(candidate)) return { path: candidate, viaPath: false };
  }
  return null;
}

/**
 * Factory rather than a single constant so callers with a tight time
 * budget (doctor's per-check timeout) can ask for a short-timeout runner —
 * mirrors `createClaudeCliRunner`.
 */
export function createCodexCliRunner(timeoutMs: number = CLI_TIMEOUT_MS): CodexCliRunner {
  return {
    detect: (userHome) => detectCodexCli(userHome, timeoutMs),
    async installMarketplaceAndPlugin(codexBin, marketplaceRoot) {
      try {
        await execFile(codexBin, ['plugin', 'marketplace', 'add', marketplaceRoot, '--json'], { timeout: timeoutMs });
        await execFile(codexBin, ['plugin', 'add', CODEX_PLUGIN_KEY, '--json'], { timeout: timeoutMs });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    async uninstallPlugin(codexBin) {
      const pluginRemove = await execFile(codexBin, ['plugin', 'remove', CODEX_PLUGIN_KEY, '--json'], {
        timeout: timeoutMs,
      }).then(
        () => ({ ok: true as const }),
        (err) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }),
      );
      const marketRemove = await execFile(
        codexBin,
        ['plugin', 'marketplace', 'remove', CODEX_MARKETPLACE_NAME, '--json'],
        { timeout: timeoutMs },
      ).then(
        () => ({ ok: true as const }),
        (err) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }),
      );
      if (pluginRemove.ok && marketRemove.ok) return { ok: true };
      const reasons = [
        !pluginRemove.ok ? `plugin remove: ${pluginRemove.reason}` : null,
        !marketRemove.ok ? `marketplace remove: ${marketRemove.reason}` : null,
      ]
        .filter((r): r is string => r !== null)
        .join('; ');
      return { ok: false, reason: reasons };
    },
    async isInstalled(codexBin) {
      try {
        const { stdout } = await execFile(codexBin, ['plugin', 'list', '--json'], { timeout: timeoutMs });
        const parsed = JSON.parse(stdout) as {
          installed?: ReadonlyArray<{ pluginId?: string; installed?: boolean }>;
        };
        return (parsed.installed ?? []).some((p) => p.pluginId === CODEX_PLUGIN_KEY && p.installed === true);
      } catch {
        return false;
      }
    },
  };
}

export const defaultCodexCliRunner: CodexCliRunner = createCodexCliRunner();

export interface CodexPluginPaths {
  readonly marketplaceRoot: string;
  readonly marketplacePath: string;
  readonly pluginRoot: string;
  readonly manifestPath: string;
  readonly mcpPath: string;
  readonly hooksPath: string;
  readonly hookRunnerPath: string;
  readonly skillsRoot: string;
}

export function codexPluginPaths(userHome: string, coodraHome: string = join(userHome, '.coodra')): CodexPluginPaths {
  const marketplaceRoot = join(coodraHome, 'codex-marketplaces', CODEX_MARKETPLACE_NAME);
  const pluginRoot = join(marketplaceRoot, 'plugins', CODEX_PLUGIN_NAME);
  const skillsRoot = join(pluginRoot, 'skills');
  return {
    marketplaceRoot,
    marketplacePath: join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
    pluginRoot,
    manifestPath: join(pluginRoot, '.codex-plugin', 'plugin.json'),
    mcpPath: join(pluginRoot, '.mcp.json'),
    hooksPath: join(pluginRoot, 'hooks', 'hooks.json'),
    hookRunnerPath: join(pluginRoot, 'hooks', 'hook-runner.mjs'),
    skillsRoot,
  };
}

export function buildCodexPluginMcpEntry(ctx: AgentContext): CoodraMcpEntry {
  return buildCoodraMcpEntry({ ...ctx.mcpEntryOptions, agentType: 'codex' });
}

export async function probeCodexPlugin(
  ctx: AgentPathContext,
  cliRunner: CodexCliRunner = defaultCodexCliRunner,
): Promise<{
  readonly manifest: boolean;
  readonly marketplace: boolean;
  readonly mcp: boolean;
  readonly hooks: boolean;
  readonly skills: boolean;
  readonly paths: CodexPluginPaths;
}> {
  const paths = codexPluginPaths(ctx.userHome);
  const codex = await cliRunner.detect(ctx.userHome);
  if (codex !== null && (await cliRunner.isInstalled(codex.path))) {
    return { manifest: true, marketplace: true, mcp: true, hooks: true, skills: true, paths };
  }
  const [manifest, marketplace, mcp, hooks, coodraContextSkill, coodraWikiSkillFile] = await Promise.all([
    fileContains(paths.manifestPath, `"name": "${CODEX_PLUGIN_NAME}"`),
    fileContains(paths.marketplacePath, `"name": "${CODEX_MARKETPLACE_NAME}"`),
    fileContainsAll(paths.mcpPath, [`"coodra"`, `"graphify"`]),
    fileContains(paths.hooksPath, `"SessionStart"`),
    fileContains(join(paths.skillsRoot, 'coodra-context', 'SKILL.md'), 'name: coodra-context'),
    fileContains(join(paths.skillsRoot, 'coodra-wiki', 'SKILL.md'), 'name: coodra-wiki'),
  ]);
  const skills = coodraContextSkill && coodraWikiSkillFile;
  return { manifest, marketplace, mcp, hooks, skills, paths };
}

export async function installCodexPlugin(
  ctx: AgentContext,
  cliRunner: CodexCliRunner = defaultCodexCliRunner,
): Promise<{
  readonly outcomes: WriteOutcome[];
  readonly paths: CodexPluginPaths;
}> {
  const coodraHome = ctx.mcpEntryOptions.coodraHome ?? join(ctx.userHome, '.coodra');
  const paths = codexPluginPaths(ctx.userHome, coodraHome);
  const mcpEntry = buildCodexPluginMcpEntry(ctx);
  const graphifyEntry = buildManagedGraphifyMcpEntry(coodraHome);
  const sourceFiles = new Map<string, string>([
    [paths.marketplacePath, marketplaceManifest()],
    [paths.manifestPath, pluginManifest()],
    [paths.mcpPath, `${JSON.stringify({ mcpServers: { coodra: mcpEntry, graphify: graphifyEntry } }, null, 2)}\n`],
    [paths.hooksPath, `${JSON.stringify(hooksConfig(), null, 2)}\n`],
    [paths.hookRunnerPath, hookRunner()],
    [join(paths.skillsRoot, 'coodra-init', 'SKILL.md'), coodraInitSkill()],
    [join(paths.skillsRoot, 'coodra-context', 'SKILL.md'), coodraContextSkill()],
    [join(paths.skillsRoot, 'coodra-recipe', 'SKILL.md'), coodraSkillSkill()],
    [join(paths.skillsRoot, 'coodra-wiki', 'SKILL.md'), coodraWikiSkill()],
    [join(paths.skillsRoot, 'coodra-graphify', 'SKILL.md'), coodraGraphifySkill()],
    [join(paths.skillsRoot, 'coodra-jira-work', 'SKILL.md'), coodraJiraWorkSkill()],
  ]);

  // The marketplace SOURCE — Coodra's own dedicated files — always lands on
  // disk first; `codex plugin marketplace add` registers an *existing*
  // local marketplace, it doesn't create one.
  const outcomes: WriteOutcome[] = [];
  for (const [path, content] of sourceFiles) {
    outcomes.push(await writeGenerated(path, content, ctx.force, ctx.dryRun));
  }

  if (ctx.dryRun) return { outcomes, paths };

  const codex = await cliRunner.detect(ctx.userHome);
  if (codex === null) {
    outcomes.push({
      path: paths.marketplaceRoot,
      action: 'unchanged',
      notes:
        'codex CLI not found on PATH or at known install locations; cannot register the plugin — install Codex ' +
        '(or add it to PATH if already installed, e.g. via `~/Applications/ChatGPT.app/Contents/Resources/codex`), ' +
        'then re-run `coodra agent add codex`',
    });
    return { outcomes, paths };
  }
  if (!codex.viaPath) {
    outcomes.push({
      path: codex.path,
      action: 'unchanged',
      notes:
        `found the Codex CLI at ${codex.path} (not on PATH — this install still works via the full path, but ` +
        `\`codex\` alone won't work in your own shell). To fix that: sudo ln -sf ${codex.path} /usr/local/bin/codex`,
    });
  }
  const result = await cliRunner.installMarketplaceAndPlugin(codex.path, paths.marketplaceRoot);
  if (result.ok) {
    outcomes.push({
      path: paths.marketplacePath,
      action: 'wrote',
      notes: `installed via 'codex plugin add ${CODEX_PLUGIN_KEY}'`,
    });
  } else {
    outcomes.push({
      path: paths.marketplacePath,
      action: 'unchanged',
      notes: `'codex plugin marketplace add' / 'codex plugin add' failed (${result.reason})`,
    });
  }
  return { outcomes, paths };
}

export async function removeCodexPlugin(
  ctx: AgentRemoveContext,
  cliRunner: CodexCliRunner = defaultCodexCliRunner,
): Promise<{
  readonly outcomes: WriteOutcome[];
  readonly paths: CodexPluginPaths;
}> {
  const paths = codexPluginPaths(ctx.userHome, ctx.coodraHome);
  const outcomes: WriteOutcome[] = [];

  if (!ctx.dryRun) {
    const codex = await cliRunner.detect(ctx.userHome);
    if (codex !== null) {
      const result = await cliRunner.uninstallPlugin(codex.path);
      outcomes.push({
        path: paths.marketplacePath,
        action: result.ok ? 'merged' : 'unchanged',
        notes: result.ok
          ? `removed ${CODEX_PLUGIN_KEY} via 'codex plugin remove' + 'codex plugin marketplace remove'`
          : `codex plugin removal failed or plugin not installed via CLI (${result.reason})`,
      });
    } else {
      outcomes.push({
        path: paths.marketplacePath,
        action: 'unchanged',
        notes: 'codex CLI not found; could not ask Codex to remove its own plugin/marketplace registration or cache',
      });
    }
  }

  // Coodra's own marketplace SOURCE — fully owned, safe to remove directly
  // regardless of whether the CLI call above succeeded.
  outcomes.push(await removePath(paths.marketplaceRoot, ctx.dryRun, 'removed Coodra Codex marketplace source'));
  return { outcomes, paths };
}

async function removePath(path: string, dryRun: boolean, note: string): Promise<WriteOutcome> {
  try {
    await access(path);
    if (!dryRun) await rm(path, { recursive: true });
    return { path, action: 'merged', notes: note };
  } catch {
    return { path, action: 'unchanged', notes: 'path does not exist; nothing to remove' };
  }
}

async function writeGenerated(path: string, content: string, force: boolean, dryRun: boolean): Promise<WriteOutcome> {
  try {
    const existing = await readFile(path, 'utf8');
    if (existing === content)
      return { path, action: 'unchanged', notes: 'already matches Coodra Codex plugin baseline' };
    if (!force) {
      return { path, action: 'unchanged', notes: 'exists with local changes; pass --force to overwrite' };
    }
    if (!dryRun) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    }
    return { path, action: 'forced', notes: 'overwrote with Coodra Codex plugin baseline' };
  } catch {
    if (!dryRun) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    }
    return { path, action: 'wrote', notes: 'created Coodra Codex plugin file' };
  }
}

function marketplaceManifest(): string {
  return `${JSON.stringify(
    {
      name: CODEX_MARKETPLACE_NAME,
      interface: { displayName: 'Coodra' },
      plugins: [
        {
          name: CODEX_PLUGIN_NAME,
          source: { source: 'local', path: './plugins/coodra' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Developer Tools',
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function pluginManifest(): string {
  return `${JSON.stringify(
    {
      name: CODEX_PLUGIN_NAME,
      version: VERSION,
      description: 'Coodra project memory, context packs, wiki, Graphify, policy, and Jira sync workflows for Codex.',
      author: { name: 'Coodra' },
      homepage: 'https://github.com/matrix-maven/Coodra',
      repository: 'https://github.com/matrix-maven/Coodra',
      license: 'MIT',
      keywords: ['coodra', 'codex', 'mcp', 'context', 'wiki', 'graphify', 'jira'],
      skills: './skills/',
      mcpServers: './.mcp.json',
      interface: {
        displayName: 'Coodra',
        shortDescription: 'Project memory and context for Codex',
        longDescription:
          'Use Coodra to initialize project state, retrieve context and Agent Recipes, consult the project wiki, use Graphify output, and sync implementation progress.',
        developerName: 'Coodra',
        category: 'Developer Tools',
        capabilities: ['Read', 'Write'],
        websiteURL: 'https://github.com/matrix-maven/Coodra',
        defaultPrompt: [
          'Initialize Coodra for this repository.',
          'Use Coodra context before implementing this change.',
          'Use the project wiki and Graphify graph before editing code.',
        ],
        brandColor: '#10A37F',
      },
    },
    null,
    2,
  )}\n`;
}

function hooksConfig(): unknown {
  const command = 'node "$PLUGIN_ROOT/hooks/hook-runner.mjs"';
  return {
    description: 'Coodra Codex plugin lifecycle hooks.',
    hooks: {
      SessionStart: [
        {
          matcher: 'startup|resume|clear|compact',
          hooks: [
            {
              type: 'command',
              command,
              statusMessage: 'Loading Coodra project context',
              additionalContextLimit: 3000,
              timeout: 10,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command,
              statusMessage: 'Checking Coodra context',
              additionalContextLimit: 3000,
              timeout: 10,
            },
          ],
        },
      ],
      ConfigChange: [
        {
          hooks: [
            {
              type: 'command',
              command,
              statusMessage: 'Checking Coodra policy projection',
              additionalContextLimit: 1000,
              timeout: 3,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Bash|apply_patch|Edit|Write|mcp__.*',
          hooks: [
            {
              type: 'command',
              command,
              statusMessage: 'Checking Coodra policy',
              additionalContextLimit: 3000,
              timeout: 10,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Bash|apply_patch|Edit|Write|mcp__.*',
          hooks: [
            {
              type: 'command',
              command,
              statusMessage: 'Recording Coodra activity',
              additionalContextLimit: 3000,
              timeout: 10,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command,
              timeout: 10,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command,
              timeout: 3,
            },
          ],
        },
      ],
    },
  };
}

function hookRunner(): string {
  return `import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = process.env.PLUGIN_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
const MCP_REQUEST_TIMEOUT_MS = 8000;

function readStdin() {
  return new Promise((resolve) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      body += chunk;
    });
    process.stdin.on('end', () => resolve(body));
  });
}

function failOpen(reason, hookEventName) {
  return {
    hookSpecificOutput: {
      ...(hookEventName ? { hookEventName } : {}),
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  };
}

function loadCoodraMcpEntry() {
  const mcpPath = join(PLUGIN_ROOT, '.mcp.json');
  const parsed = JSON.parse(readFileSync(mcpPath, 'utf8'));
  const servers = parsed.mcpServers || parsed.mcp_servers || parsed;
  const entry = servers && servers.coodra;
  if (!entry || typeof entry !== 'object' || typeof entry.command !== 'string') {
    throw new Error('coodra_mcp_entry_missing');
  }
  return {
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    env: entry.env && typeof entry.env === 'object' ? entry.env : {},
  };
}

function parseMcpResult(response) {
  const result = response && response.result;
  const structured = result && result.structuredContent;
  if (structured && typeof structured === 'object' && structured.hookOutput) {
    return structured.hookOutput;
  }
  const firstText = result && Array.isArray(result.content) ? result.content.find((c) => c.type === 'text') : null;
  if (firstText && typeof firstText.text === 'string') {
    const parsed = JSON.parse(firstText.text);
    if (parsed && typeof parsed === 'object' && parsed.hookOutput) return parsed.hookOutput;
  }
  throw new Error('coodra_lifecycle_output_missing');
}

function callLifecycleTool(rawPayload) {
  return new Promise((resolve, reject) => {
    const entry = loadCoodraMcpEntry();
    const child = spawn(entry.command, entry.args, {
      env: { ...process.env, ...entry.env, COODRA_LOG_DESTINATION: 'stderr' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('coodra_mcp_lifecycle_timeout'));
    }, MCP_REQUEST_TIMEOUT_MS);

    function send(message) {
      child.stdin.write(JSON.stringify(message) + '\\n');
    }

    function settleWith(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(value);
    }

    function settleError(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      reject(err);
    }

    child.on('error', settleError);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const idx = buffer.indexOf('\\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'lifecycle_event', arguments: { agentType: 'codex', rawPayload } },
          });
        } else if (msg.id === 2) {
          if (msg.error) settleError(new Error(String(msg.error.message || 'coodra_lifecycle_tool_failed')));
          else settleWith(parseMcpResult(msg));
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'coodra-codex-hook-runner', version: '1.0.0' },
      },
    });
  });
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw || '{}');
} catch {
  process.stdout.write(JSON.stringify(failOpen('invalid_hook_payload')));
  process.exit(0);
}

try {
  const hookOutput = await callLifecycleTool(payload);
  process.stdout.write(JSON.stringify(hookOutput || {}));
} catch {
  process.stdout.write(JSON.stringify(failOpen('coodra_lifecycle_mcp_unavailable', payload.hook_event_name)));
}
`;
}

function coodraInitSkill(): string {
  return `---
name: coodra-init
description: Initialize or repair Coodra project state for the current repository using the project-local .coodra layout.
---

Use this skill when the user asks to initialize, register, repair, or inspect Coodra setup for a repository.

1. Inspect the repository root and current Coodra state under \`.coodra/\`.
2. Run \`coodra init\` to create or repair project-local Coodra files.
3. Confirm that setup created \`.coodra/config.json\`, \`.coodra/manifest.json\`, \`.coodra/recipes/\`, \`.coodra/graphify/\`, and \`.coodra/wiki/\`.
4. Do not create legacy root-level \`.coodra.json\`, \`.mcp.json\`, project \`.env\`, \`.codex/config.toml\`, or \`AGENTS.md\` for Coodra setup.
`;
}

function coodraContextSkill(): string {
  return `---
name: coodra-context
description: Retrieve and use Coodra project context, decisions, run history, and context packs before making code changes.
---

Use this skill before implementation when the task may depend on repository architecture, previous decisions, Work Pack state, or policy history.

1. Prefer Coodra MCP tools for live project context when available.
2. Read \`.coodra/config.json\` and \`.coodra/manifest.json\` to identify the project.
3. Review relevant context packs and recent decisions before editing.
4. Keep generated Coodra state under \`.coodra/\`.
`;
}

function coodraSkillSkill(): string {
  return `---
name: coodra-recipe
description: Find and apply project Coodra Agent Recipes such as API development, security audit, plugin-building, or language best-practice workflows.
---

Use this skill when the user asks for a reusable project Agent Recipe, or when a task clearly matches one.

1. Look for project Agent Recipes under \`.coodra/recipes/\`.
2. Use \`coodra__list_recipes\` to inspect available recipes.
3. Load a matching recipe with \`coodra__get_recipe\`; do not load every recipe blindly.
4. Treat Agent Recipes as reusable task guidance, not issue-bound Work Packs.
5. Apply the chosen recipe's instructions before implementing.
`;
}

function coodraWikiSkill(): string {
  return `---
name: coodra-wiki
description: Use this when the user asks to generate, update, refresh, inspect, or use the Coodra project wiki / Deep Wiki / codebase wiki / architecture docs for this project (e.g. "generate the deep wiki", "build the wiki", "document the architecture"), or wants wiki-grounded implementation context. Drives the two-pass Coodra Wiki flow end to end — this is the only wiki skill; there is no separate "deep wiki author" skill.
---

Use this skill when the user asks for wiki generation, architecture documentation, codebase explanations, or wiki-grounded implementation context.

1. If \`.coodra/wiki/job.md\` or \`.coodra/wiki/grounding.md\` is missing, run \`coodra wiki build\` first. That command creates the bounded grounding bundle and includes Graphify communities, god nodes, and \`GRAPH_REPORT.md\` when \`.coodra/graphify/out/graph.json\` exists.
2. Read \`.coodra/wiki/job.md\` and \`.coodra/wiki/grounding.md\` before planning — \`job.md\` contains the full two-pass authoring recipe (plan the structure, then author each page). Treat the Graphify section as the first structural map; do not start by recursively scanning the whole repo unless the grounding explicitly says the file list is truncated or a page needs verification.
3. When the managed Graphify MCP server is available, query it without \`project_path\` for neighbours/dependency paths that the grounding summary does not already include.
4. Save wiki structure/pages through Coodra's \`wiki_save_structure\`, \`wiki_save_page\`, and \`wiki_status\` MCP tools before writing mirror files.
5. Mirror successful saves under \`.coodra/wiki/<slug>/structure.json\` and \`.coodra/wiki/<slug>/<pageId>.md\`.
6. Derive the wiki shape from this repo's real graph, domains, and workflows rather than a fixed template.
7. Use existing wiki records as grounding, but verify claims against targeted source files before editing.
`;
}

function coodraGraphifySkill(): string {
  return `---
name: coodra-graphify
description: Build, inspect, or use Graphify codebase graph artifacts managed by Coodra under .coodra/graphify.
---

Use this skill when the user asks to graphify a repository, use the code graph, inspect graph artifacts, or make the assistant always consult the graph.

1. Prefer Coodra-managed Graphify output under \`.coodra/graphify/out/\`.
2. Build with \`coodra graphify build\`; it sets \`GRAPHIFY_OUT=.coodra/graphify/out\` and records generated artifacts.
3. Do not inspect or print environment variables to discover LLM keys unless the user explicitly asks. If a semantic build fails because Graphify lacks a backend, explain that the external Graphify process cannot automatically borrow this Codex chat session, then fall back to \`coodra graphify build --no-llm\` for a structural graph.
4. When querying the managed Graphify MCP server installed by the Coodra plugin, omit \`project_path\` unless the user has explicitly wired a custom Graphify server. The managed plugin entry already points at \`.coodra/graphify/out/graph.json\`; passing \`project_path\` can make Graphify append its stock \`graphify-out/\` path and miss the Coodra-managed graph.
5. Treat \`coodra graphify status\` legacy config rows as explicit/custom wiring only. Native Coodra plugin wiring is managed by \`coodra agent add <agent>\` / \`coodra agent repair <agent>\`.
6. Use Graphify artifacts as context before broad architecture, dependency, wiki, or refactor work.
7. Do not leave new Graphify output in root-level \`graphify-out/\` unless the user explicitly asks.
`;
}

function coodraJiraWorkSkill(): string {
  return `---
name: coodra-jira-work
description: Start or resume a Jira-linked Coodra Work Pack implementation session from a Jira key such as COOD-10.
---

Use this skill when the user asks to work on, import, resume, or implement a Jira issue through Coodra.

1. Parse the Jira key from the user request and derive the Work Pack slug by lowercasing it, for example \`COOD-10\` -> \`cood-10\`.
2. Call \`coodra__get_run_id\` if you do not already have the current \`runId\`.
3. Call \`coodra__work_pack_status { runId }\` and inspect any existing local Work Pack for that slug.
4. Use Atlassian Rovo MCP to fetch the Jira issue. If the user asked for related work, also fetch bounded parent/epic, subtasks, blockers, blocked-by links, and same-epic tasks relevant to implementation.
5. Call \`coodra__work_pack_upsert\` before editing code.
6. Call \`coodra__save_context_pack\` with \`workPackSlug\` set to the slug to create the initial linked Context Pack.
7. Implement the change using \`.coodra/work-packs/<slug>/\` as the local work record, call \`record_decision\` for material choices, and finish with a concise user-facing recap. Before ending the session, call \`coodra__save_context_pack\` yourself with \`workPackSlug\` set to the slug and a recap of what changed — SessionEnd does not auto-save this for you.
`;
}

async function fileContains(path: string, needle: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')).includes(needle);
  } catch {
    return false;
  }
}

async function fileContainsAll(path: string, needles: readonly string[]): Promise<boolean> {
  try {
    const content = await readFile(path, 'utf8');
    return needles.every((needle) => content.includes(needle));
  } catch {
    return false;
  }
}
