import { execFile as execFileCallback } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { VERSION } from '../../version.js';
import { findExecutableOnPath } from '../executable-discovery.js';
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
  void timeoutMs;
  const pathMatch = await findExecutableOnPath('codex');
  if (pathMatch !== null) return { path: pathMatch, viaPath: true };
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
  const graphifyEntry = buildManagedGraphifyMcpEntry(coodraHome, ctx.platform);
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
    [join(paths.skillsRoot, 'coodra-work', 'SKILL.md'), coodraWorkSkill()],
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
      hooks: './hooks/hooks.json',
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

// CONFIRMED BUG (live smoke, 2026-08-08): Codex's matcher regex engine
// does NOT support look-around. The original `mcp__(?!coodra__|graphify__).*`
// — copied from Claude's TOOL_MATCHER, which does work there — made Codex
// reject the whole hooks.json at load time ("look-around, including
// look-ahead and look-behind, is not supported"), so PreToolUse/PostToolUse/
// PermissionRequest never registered at all: not "excluded Coodra's own
// calls" but "never fired for ANY tool call, ever." Codex's own docs don't
// name the underlying regex engine, but the error text matches Rust's
// `regex` crate, which deliberately excludes look-around for guaranteed
// linear-time matching — this is not a bug Codex is likely to lift.
//
// Fix: match every `mcp__*` call broadly (no exclusion in the regex at
// all) and rely entirely on the server-side `isCoodraOwnMcpTool` filter in
// `lifecycle-event/handler.ts` to skip Coodra's own two managed servers —
// that backstop already existed (originally defense-in-depth for a
// "matcher-regex edge case" that turned out to be the actual, only-working
// path for Codex) and needed no changes. "All MCP tools except these two"
// cannot be expressed in Codex-compatible regex; broad-match-then-filter
// server-side is the only correct shape here, not just a workaround.
const TOOL_MATCHER = 'Bash|apply_patch|Edit|Write|mcp__.*' as const;

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
          matcher: TOOL_MATCHER,
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
          matcher: TOOL_MATCHER,
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
      // SessionEnd's timeout was 3s pre-COOD-52; finalizeRunOnSessionEnd
      // (run-diff capture, auto Context Pack save, linked Work Pack sync,
      // ask-outcome sweep) now runs inside this window. COOD-54 keeps the
      // persistent HTTP daemon fast path, but SessionEnd still waits for
      // the result so stale HTTP sessions can fall back instead of
      // silently skipping finalization.
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command,
              timeout: 20,
            },
          ],
        },
      ],
      // Five events added (Codex hook coverage expansion, mirroring
      // Claude Code's 91e8803). PermissionRequest can override Codex's
      // own permission outcome, so it watches the same risky-action set
      // PreToolUse does. PreCompact/SubagentStop get the 10s tier
      // (real or precautionary decision control); PostCompact/
      // SubagentStart get the 3s tier (documented inert for decisions,
      // matches SessionEnd's existing tier). No matcher on the last
      // four — Coodra wants full visibility on every trigger/agent type,
      // not a narrowed subset.
      PermissionRequest: [
        {
          matcher: TOOL_MATCHER,
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
      PreCompact: [
        {
          hooks: [
            {
              type: 'command',
              command,
              statusMessage: 'Checking Coodra context before compaction',
              additionalContextLimit: 3000,
              timeout: 10,
            },
          ],
        },
      ],
      PostCompact: [
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
      SubagentStart: [
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
      SubagentStop: [
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
    },
  };
}

function hookRunner(): string {
  return `import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = process.env.PLUGIN_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
const MCP_REQUEST_TIMEOUT_MS = 8000;
// COOD-54: short budget for the HTTP-daemon-first attempt. Kept well
// under the hooks.json per-event timeout so a slow/unreachable daemon
// still leaves time for the stdio-spawn fallback within the same hook
// invocation.
const HTTP_DAEMON_TIMEOUT_MS = 800;
const HTTP_SESSION_END_TIMEOUT_MS = 18000;

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

// COOD-54: read LOCAL_HOOK_SECRET + MCP_SERVER_PORT from ~/.coodra/.env
// (the same file \`coodra install\`/\`coodra init\` write) so the HTTP path
// below can talk to an already-running \`coodra start\` daemon without
// needing anything threaded through .mcp.json.
function readCoodraRuntimeEnv() {
  const coodraHome = process.env.COODRA_HOME || join(homedir(), '.coodra');
  let localHookSecret = process.env.LOCAL_HOOK_SECRET || '';
  let mcpServerPort = process.env.MCP_SERVER_PORT || '3100';
  try {
    const envBody = readFileSync(join(coodraHome, '.env'), 'utf8');
    if (!localHookSecret) {
      const m = envBody.match(/^LOCAL_HOOK_SECRET=(\\S+)/m);
      if (m) localHookSecret = m[1];
    }
    const p = envBody.match(/^MCP_SERVER_PORT=(\\S+)/m);
    if (p) mcpServerPort = p[1];
  } catch {
    // no ~/.coodra/.env yet (coodra install never ran) — HTTP path is
    // skipped below when localHookSecret stays empty.
  }
  return { coodraHome, localHookSecret, mcpServerPort: Number(mcpServerPort) || 3100 };
}

// The Streamable HTTP transport rejects requests that don't accept
// BOTH content types (it may reply with a plain JSON body or an SSE
// stream depending on the request) with 406 Not Acceptable.
const MCP_ACCEPT_HEADER = 'application/json, text/event-stream';

function httpRoundTrip(port, path, method, headers, jsonBody, timeoutMs = HTTP_DAEMON_TIMEOUT_MS) {
  return new Promise((resolvePromise, reject) => {
    const payload = jsonBody === undefined ? undefined : JSON.stringify(jsonBody);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          accept: MCP_ACCEPT_HEADER,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolvePromise({ statusCode: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('coodra_http_daemon_timeout')));
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

// The Streamable HTTP transport may answer with a plain JSON body or
// with an SSE-framed one (\`event: message\\ndata: <json>\\n\\n\`) depending
// on internal transport state. Handle both.
function parseJsonRpcResponseBody(body) {
  const trimmed = body.trim();
  if (trimmed.length === 0) throw new Error('coodra_http_daemon_empty_response');
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const dataLines = trimmed.split('\\n').filter((l) => l.startsWith('data:'));
  if (dataLines.length === 0) throw new Error('coodra_http_daemon_unparseable_response');
  return JSON.parse(dataLines[dataLines.length - 1].slice('data:'.length).trim());
}

// The daemon's underlying MCP \`Server\` accepts exactly ONE \`initialize\`
// per process lifetime — a second caller's \`initialize\` fails with
// "Server already initialized" (confirmed against a real daemon while
// building this). So the transport session id from the first successful
// \`initialize\` has to be cached to disk and REUSED by every later hook
// call for as long as this daemon process stays up; there is no way to
// mint a second one. \`coodra stop && coodra start\` (a fresh daemon
// process) is what invalidates the cache.
function sessionCachePath(coodraHome) {
  return join(coodraHome, 'mcp-http-session.json');
}

function readCachedSessionId(coodraHome, port) {
  try {
    const raw = readFileSync(sessionCachePath(coodraHome), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.port === port && typeof parsed.sessionId === 'string' && parsed.sessionId) {
      return parsed.sessionId;
    }
  } catch {
    // no cache yet, or unreadable/corrupt — treat as no cache.
  }
  return null;
}

function writeCachedSessionId(coodraHome, port, sessionId) {
  try {
    writeFileSync(sessionCachePath(coodraHome), JSON.stringify({ port, sessionId }), 'utf8');
  } catch {
    // Best-effort — a failed cache write just means the next hook call
    // re-initializes (and likely fails, since only one initialize is
    // allowed — see below) rather than reusing this session. Degrades
    // to the stdio-spawn fallback for that call, not a hard failure.
  }
}

async function initializeHttpSession(port, secret) {
  const initRes = await httpRoundTrip(port, '/mcp', 'POST', { 'x-local-hook-secret': secret }, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'coodra-codex-hook-runner-http', version: '1.0.0' },
    },
  });
  if (initRes.statusCode < 200 || initRes.statusCode >= 300) {
    throw new Error('coodra_http_daemon_init_failed_' + initRes.statusCode);
  }
  const sessionId = initRes.headers['mcp-session-id'];
  if (!sessionId) throw new Error('coodra_http_daemon_no_session_id');
  return sessionId;
}

// Single tools/call attempt against a given session id. Returns
// \`{ sessionInvalid: true }\` on 404 "Session not found" so the caller
// can re-initialize and retry once; throws for any other failure
// (daemon down, timeout, non-2xx/non-404).
async function tryToolCall(port, secret, sessionId, rawPayload) {
  const headers = { 'x-local-hook-secret': secret, 'mcp-session-id': sessionId };
  const body = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'lifecycle_event', arguments: { agentType: 'codex', rawPayload } },
  };
  const timeoutMs = rawPayload && rawPayload.hook_event_name === 'SessionEnd'
    ? HTTP_SESSION_END_TIMEOUT_MS
    : HTTP_DAEMON_TIMEOUT_MS;
  const res = await httpRoundTrip(port, '/mcp', 'POST', headers, body, timeoutMs);
  if (res.statusCode === 404) return { sessionInvalid: true };
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error('coodra_http_daemon_call_failed_' + res.statusCode);
  }
  return { value: parseMcpResult(parseJsonRpcResponseBody(res.body)) };
}

// Tries the already-running \`coodra start\` MCP HTTP daemon: reuse the
// cached transport session if one exists for this port, re-initializing
// (and re-caching) only when there is no cache yet or the cached session
// was rejected as invalid. On ANY failure this throws and the caller
// falls back to the stdio-spawn path below, unchanged from pre-COOD-54
// behavior.
async function callLifecycleToolViaHttp(rawPayload, coodraHome, port, secret) {
  const cached = readCachedSessionId(coodraHome, port);
  if (cached !== null) {
    const attempt = await tryToolCall(port, secret, cached, rawPayload);
    if (!attempt.sessionInvalid) return attempt.value;
    // Cached session was for a since-restarted daemon — fall through to
    // mint a fresh one below.
  }
  const sessionId = await initializeHttpSession(port, secret);
  writeCachedSessionId(coodraHome, port, sessionId);
  const attempt = await tryToolCall(port, secret, sessionId, rawPayload);
  if (attempt.sessionInvalid) throw new Error('coodra_http_daemon_session_invalid_after_fresh_init');
  return attempt.value;
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw || '{}');
} catch {
  process.stdout.write(JSON.stringify(failOpen('invalid_hook_payload')));
  process.exit(0);
}

// COOD-54: prefer the persistent HTTP daemon (\`coodra start\` already
// running) over spawning a fresh stdio subprocess. SessionEnd uses the
// same request/response path with a longer timeout: correctness matters
// more than shaving a few milliseconds because a stale cached MCP HTTP
// session must be detected and retried instead of silently losing the
// finalizer's run-diff / auto-pack / Work Pack update.
const { coodraHome, localHookSecret, mcpServerPort } = readCoodraRuntimeEnv();
if (localHookSecret) {
  try {
    const hookOutput = await callLifecycleToolViaHttp(
      payload,
      coodraHome,
      mcpServerPort,
      localHookSecret,
    );
    process.stdout.write(JSON.stringify(hookOutput || {}));
    process.exit(0);
  } catch {
    // Daemon unreachable, unauthenticated, or any other HTTP-path
    // failure — fall through to the stdio-spawn path below. Never
    // surface this as a hook failure to the agent.
  }
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
5. Mirror successful saves under \`.coodra/wiki/<slug>/structure.json\` and \`.coodra/wiki/<slug>/md/<pageId>.md\` (the latter is a connected-Markdown mirror — real frontmatter plus rendered cross-links — that \`coodra wiki ask\` reads directly).
6. Derive the wiki shape from this repo's real graph, domains, and workflows rather than a fixed template.
7. Use existing wiki records as grounding, but verify claims against targeted source files before editing.
8. When the user asks a how-does-X-work question about this repo and \`.coodra/wiki/<slug>/md/\` already has pages (or \`coodra wiki status\` shows authored pages), run \`coodra wiki ask "<question>"\` first instead of re-scanning the whole repo. Read the ranked files/excerpts it returns and answer from them, citing the wiki page(s) you used.
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

function coodraWorkSkill(): string {
  return `---
name: coodra-work
description: Start or resume a Coodra Work Pack — from a Jira issue, a GitHub/GitLab PR, or a manually-created pack.
---

Use this skill when the user asks to work on, import, resume, or implement something through Coodra: a tracker issue (Jira, Linear, ...), a GitHub/GitLab PR, or a manually-scoped piece of work with no external reference at all.

## Model

A Work Pack has a canonical \`packType\` (epic, feature, story, task, bug, subtask, pr, or unknown) — Coodra's own normalized classification, independent of the provider. Keep the provider's own raw type label in \`source.issueType\` (e.g. Jira "Story", GitHub "pull_request") so nothing is lost. \`source.provider\` records where it came from: \`atlassian\`, \`github\`, \`gitlab\`, or \`manual\`. The same split applies to status: normalize into \`status\` (draft, in_progress, in_review, blocked, or done); keep the provider's own raw status label in \`source.status\`.

There is no persistent Coodra config for which project or key to use — the external reference is whatever the user typed this time, or whatever the current run is already bound to (step 2 below may already surface one to resume). If the reference is wrong or doesn't exist, the provider's own MCP will report that; Coodra does not pre-validate its shape.

## Resolve and implement

1. Call \`coodra__get_run_id\` if you do not already have the current \`runId\`.
2. Call \`coodra__work_pack_status { runId }\` and inspect any existing local Work Pack — SessionStart context may already have surfaced one to resume.
3. If the user gave an external reference, fetch it via whichever MCP the agent already has for that provider — Atlassian Rovo for a Jira key, GitHub's MCP for a PR, GitLab's for an MR. Do not ask Coodra for provider credentials, and do not call Coodra as a provider client. If the user gave no reference, this is a manually-created pack: set \`source.provider\` to \`manual\` and synthesize a reasonable \`source.externalKey\` (e.g. the pack slug).
4. Call \`coodra__work_pack_upsert\` (packType + source per the model above) before editing code. If related work matters — parent/epic, subtasks, blockers, same-epic tasks, or a linked PR — fetch it bounded and record it in \`relationships\`.
5. Call \`coodra__save_context_pack\` with \`workPackSlug\` set to the slug to create the initial linked Context Pack.
6. Implement the change using \`.coodra/work-packs/<slug>/\` as the local work record. Call \`coodra__record_decision\` for material choices as you go — the sync-back step below reads these back. If a decision also matters to a related pack (not just this one), pass \`workPackSlugs\` on that call to tag it there too.
7. Finish with a concise user-facing recap, and call \`coodra__save_context_pack\` yourself with \`workPackSlug\` set and a recap of what changed — SessionEnd does not auto-save this for you.

## Sync-back (only when the user asks, or the pack is ready to close)

Do not use \`prepare_jira_comment\` — it is superseded. Instead call \`coodra__query_decisions { projectSlug, workPackId }\` (spans every run tied to this pack, not just the current session; add \`includeRelated: true\` to also pull decisions from related packs) to gather everything recorded, compose your own natural-language summary directly from the returned decisions — no Coodra template — and post it using whichever comment tool the agent's own provider MCP exposes (Rovo's \`addCommentToJiraIssue\`, GitHub's PR-comment tool, GitLab's MR-comment tool). Always confirm the exact text and target with the user before posting.
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
