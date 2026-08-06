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

export const DEVIN_PLUGIN_NAME = 'coodra' as const;

/**
 * Devin's plugin model is a hybrid of Codex's and Cursor's: install is a
 * real CLI call like Codex (`devin plugins install <path> -y` — no
 * Cursor-style auto-discovered directory), but hook content is pure
 * command scripts like Cursor's (no Claude-style built-in `mcp_tool`
 * hook type), so a dedicated `hook-runner.mjs` is still needed.
 *
 * Login: `devin plugins install` on the bundled CLI this was written
 * against (`devin 3000.3.27`, confirmed live 2026-08-05) hard-fails with
 * "You must be logged in to manage Devin CLI plugins" for a LOCAL PATH
 * source, reproduced 4 separate ways (fresh isolated $HOME each time;
 * with/without `-y`; with the DEVIN_PLUGIN_DISCOVERY env var toggled).
 * Devin's own docs describe source-dependent login requirements (local
 * folder: no login) that don't match what this build actually does —
 * most likely explanation: plugins are documented as closed beta, so the
 * check is probably a beta-entitlement gate rather than the per-source
 * distinction the docs describe applying once past that gate. Given
 * that ambiguity, `installDevinPlugin` does NOT pre-gate on `authStatus`
 * — it always attempts the real install and surfaces whatever the CLI
 * itself reports, rather than Coodra guessing. Coodra must never call
 * `devin auth login` itself.
 */
export interface DevinCliRunner {
  detect(userHome: string): Promise<{ readonly path: string; readonly viaPath: boolean } | null>;
  /** `devin auth status` — status-only, for the `status()` report; never gates install. */
  authStatus(devinBin: string): Promise<boolean>;
  installPlugin(devinBin: string, pluginRoot: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  removePlugin(devinBin: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Best-effort: is `coodra` reported installed by `devin plugins list`? */
  isInstalled(devinBin: string): Promise<boolean>;
}

const CLI_TIMEOUT_MS = 15_000;

/**
 * Known locations for the Devin CLI binary when it's bundled inside the
 * Devin desktop app rather than symlinked onto PATH — confirmed live
 * 2026-08-05: `/Applications/Devin.app/Contents/Resources/app/extensions/
 * windsurf/devin/bin/devin`. macOS only; Windows/Linux bundle locations
 * aren't verified, so this list intentionally stays short rather than
 * guessing at unverified paths — same discipline as Codex's bundle list.
 */
function knownDevinBundlePaths(userHome: string): readonly string[] {
  return [
    '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin',
    join(
      userHome,
      'Applications',
      'Devin.app',
      'Contents',
      'Resources',
      'app',
      'extensions',
      'windsurf',
      'devin',
      'bin',
      'devin',
    ),
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

async function detectDevinCli(
  userHome: string,
  timeoutMs: number,
): Promise<{ readonly path: string; readonly viaPath: boolean } | null> {
  try {
    const { stdout } = await execFile('which', ['devin'], { timeout: timeoutMs });
    const path = stdout.trim();
    if (path.length > 0) return { path, viaPath: true };
  } catch {
    // not on PATH — fall through to known bundle locations
  }
  for (const candidate of knownDevinBundlePaths(userHome)) {
    if (await isExecutableFile(candidate)) return { path: candidate, viaPath: false };
  }
  return null;
}

/**
 * Factory rather than a single constant so callers with a tight time
 * budget can ask for a short-timeout runner — mirrors `createCodexCliRunner`.
 */
export function createDevinCliRunner(timeoutMs: number = CLI_TIMEOUT_MS): DevinCliRunner {
  return {
    detect: (userHome) => detectDevinCli(userHome, timeoutMs),
    async authStatus(devinBin) {
      try {
        const { stdout } = await execFile(devinBin, ['auth', 'status'], { timeout: timeoutMs });
        return !stdout.includes('Not logged in');
      } catch {
        return false;
      }
    },
    async installPlugin(devinBin, pluginRoot) {
      try {
        await execFile(devinBin, ['plugins', 'install', pluginRoot, '-y'], { timeout: timeoutMs });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    async removePlugin(devinBin) {
      try {
        await execFile(devinBin, ['plugins', 'remove', DEVIN_PLUGIN_NAME], { timeout: timeoutMs });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    async isInstalled(devinBin) {
      try {
        const { stdout } = await execFile(devinBin, ['plugins', 'list'], { timeout: timeoutMs });
        return stdout.includes(DEVIN_PLUGIN_NAME);
      } catch {
        return false;
      }
    },
  };
}

export const defaultDevinCliRunner: DevinCliRunner = createDevinCliRunner();

export interface DevinPluginPaths {
  readonly pluginRoot: string;
  readonly manifestPath: string;
  readonly mcpPath: string;
  readonly hooksPath: string;
  readonly hookRunnerPath: string;
  readonly skillsRoot: string;
}

/**
 * No marketplace subdirectory, unlike Codex — Devin reads a local
 * plugin live from its source path ("Local plugins are linked directly
 * to their source folder... changes apply on the next session, no
 * `update` needed" — confirmed in docs), so there's no Devin-owned
 * cache mirror to manage on removal either.
 */
export function devinPluginPaths(userHome: string, coodraHome: string = join(userHome, '.coodra')): DevinPluginPaths {
  const pluginRoot = join(coodraHome, 'devin-plugins', DEVIN_PLUGIN_NAME);
  return {
    pluginRoot,
    manifestPath: join(pluginRoot, '.devin-plugin', 'plugin.json'),
    mcpPath: join(pluginRoot, 'mcp_config.json'),
    hooksPath: join(pluginRoot, 'hooks.json'),
    hookRunnerPath: join(pluginRoot, 'hooks', 'hook-runner.mjs'),
    skillsRoot: join(pluginRoot, 'skills'),
  };
}

export function buildDevinPluginMcpEntry(ctx: AgentContext): CoodraMcpEntry {
  return buildCoodraMcpEntry({ ...ctx.mcpEntryOptions, agentType: 'devin' });
}

export async function probeDevinPlugin(
  ctx: AgentPathContext,
  cliRunner: DevinCliRunner = defaultDevinCliRunner,
): Promise<{
  readonly manifest: boolean;
  readonly mcp: boolean;
  readonly hooks: boolean;
  readonly skills: boolean;
  readonly registered: boolean;
  readonly paths: DevinPluginPaths;
}> {
  const paths = devinPluginPaths(ctx.userHome);
  const devin = await cliRunner.detect(ctx.userHome);
  const registered = devin !== null && (await cliRunner.isInstalled(devin.path));
  const [manifest, mcp, hooks, coodraContextSkill, coodraWikiSkillFile] = await Promise.all([
    fileContains(paths.manifestPath, `"name": "${DEVIN_PLUGIN_NAME}"`),
    fileContainsAll(paths.mcpPath, [`"coodra"`, `"graphify"`]),
    fileContains(paths.hooksPath, `"SessionStart"`),
    fileContains(join(paths.skillsRoot, 'coodra-context', 'SKILL.md'), 'name: coodra-context'),
    fileContains(join(paths.skillsRoot, 'coodra-wiki', 'SKILL.md'), 'name: coodra-wiki'),
  ]);
  const skills = coodraContextSkill && coodraWikiSkillFile;
  return { manifest, mcp, hooks, skills, registered, paths };
}

export async function installDevinPlugin(
  ctx: AgentContext,
  cliRunner: DevinCliRunner = defaultDevinCliRunner,
): Promise<{
  readonly outcomes: WriteOutcome[];
  readonly paths: DevinPluginPaths;
}> {
  const coodraHome = ctx.mcpEntryOptions.coodraHome ?? join(ctx.userHome, '.coodra');
  const paths = devinPluginPaths(ctx.userHome, coodraHome);
  const mcpEntry = buildDevinPluginMcpEntry(ctx);
  const graphifyEntry = buildManagedGraphifyMcpEntry(coodraHome);
  const sourceFiles = new Map<string, string>([
    [paths.manifestPath, pluginManifest()],
    [paths.mcpPath, `${JSON.stringify({ mcpServers: { coodra: mcpEntry, graphify: graphifyEntry } }, null, 2)}\n`],
    [paths.hooksPath, `${JSON.stringify(hooksConfig(paths.hookRunnerPath), null, 2)}\n`],
    [paths.hookRunnerPath, hookRunner()],
    [join(paths.skillsRoot, 'coodra-init', 'SKILL.md'), coodraInitSkill()],
    [join(paths.skillsRoot, 'coodra-context', 'SKILL.md'), coodraContextSkill()],
    [join(paths.skillsRoot, 'coodra-recipe', 'SKILL.md'), coodraSkillSkill()],
    [join(paths.skillsRoot, 'coodra-wiki', 'SKILL.md'), coodraWikiSkill()],
    [join(paths.skillsRoot, 'coodra-graphify', 'SKILL.md'), coodraGraphifySkill()],
    [join(paths.skillsRoot, 'coodra-work', 'SKILL.md'), coodraWorkSkill()],
  ]);

  const outcomes: WriteOutcome[] = [];
  for (const [path, content] of sourceFiles) {
    outcomes.push(await writeGenerated(path, content, ctx.force, ctx.dryRun));
  }

  if (ctx.dryRun) return { outcomes, paths };

  const devin = await cliRunner.detect(ctx.userHome);
  if (devin === null) {
    outcomes.push({
      path: paths.pluginRoot,
      action: 'unchanged',
      notes:
        'devin CLI not found on PATH or at known install locations; cannot register the plugin — install Devin ' +
        '(or add it to PATH if already installed, e.g. via ' +
        '`~/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin`), then re-run ' +
        '`coodra agent add devin`',
    });
    return { outcomes, paths };
  }
  if (!devin.viaPath) {
    outcomes.push({
      path: devin.path,
      action: 'unchanged',
      notes:
        `found the Devin CLI at ${devin.path} (not on PATH — this install still works via the full path, but ` +
        `\`devin\` alone won't work in your own shell). To fix that: sudo ln -sf ${devin.path} /usr/local/bin/devin`,
    });
  }
  // Always attempt the real install — never pre-gate on authStatus (see
  // the module docblock: login-gating differs by source/version in ways
  // this session couldn't fully pin down, so Coodra surfaces whatever
  // the CLI itself actually reports rather than pre-guessing).
  const result = await cliRunner.installPlugin(devin.path, paths.pluginRoot);
  if (result.ok) {
    outcomes.push({ path: paths.pluginRoot, action: 'wrote', notes: "installed via 'devin plugins install'" });
  } else {
    outcomes.push({
      path: paths.pluginRoot,
      action: 'unchanged',
      notes:
        `'devin plugins install' failed (${result.reason}) — if this is an auth error, run \`devin auth login\` ` +
        'then `coodra agent add devin` again',
    });
  }
  return { outcomes, paths };
}

export async function removeDevinPlugin(
  ctx: AgentRemoveContext,
  cliRunner: DevinCliRunner = defaultDevinCliRunner,
): Promise<{
  readonly outcomes: WriteOutcome[];
  readonly paths: DevinPluginPaths;
}> {
  const paths = devinPluginPaths(ctx.userHome, ctx.coodraHome);
  const outcomes: WriteOutcome[] = [];

  if (ctx.dryRun) {
    outcomes.push(await removePath(paths.pluginRoot, ctx.dryRun, 'removed Coodra Devin plugin source'));
    return { outcomes, paths };
  }

  // Unlike Codex/Claude, Devin's local plugin is a LIVE LINK to Coodra's
  // own source directory (no cache copy — see devinPluginPaths' docblock)
  // — deleting that source after a failed unregister would leave Devin
  // pointed at a path that no longer exists. So the source directory is
  // only removed when the CLI confirms the unregister actually
  // succeeded; otherwise it's preserved and the failure is reported so
  // the user can `devin auth login` and retry `coodra agent remove devin`.
  const devin = await cliRunner.detect(ctx.userHome);
  if (devin === null) {
    outcomes.push({
      path: paths.pluginRoot,
      action: 'unchanged',
      notes: 'devin CLI not found; could not ask Devin to unregister its own plugin — plugin source left in place',
    });
    return { outcomes, paths };
  }
  const result = await cliRunner.removePlugin(devin.path);
  if (result.ok) {
    outcomes.push(await removePath(paths.pluginRoot, ctx.dryRun, "removed via 'devin plugins remove' + source"));
  } else {
    outcomes.push({
      path: paths.pluginRoot,
      action: 'unchanged',
      notes:
        `'devin plugins remove' failed (${result.reason}) — plugin source left in place; if this is an auth error, ` +
        'run `devin auth login` then `coodra agent remove devin` again to finish unregistering',
    });
  }
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
      return { path, action: 'unchanged', notes: 'already matches Coodra Devin plugin baseline' };
    if (!force) {
      return { path, action: 'unchanged', notes: 'exists with local changes; pass --force to overwrite' };
    }
    if (!dryRun) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    }
    return { path, action: 'forced', notes: 'overwrote with Coodra Devin plugin baseline' };
  } catch {
    if (!dryRun) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    }
    return { path, action: 'wrote', notes: 'created Coodra Devin plugin file' };
  }
}

function pluginManifest(): string {
  return `${JSON.stringify(
    {
      name: DEVIN_PLUGIN_NAME,
      description: 'Coodra project memory, context packs, wiki, Graphify, policy, and Jira sync workflows for Devin.',
      version: VERSION,
      author: { name: 'Coodra' },
      homepage: 'https://github.com/matrix-maven/Coodra',
      repository: 'https://github.com/matrix-maven/Coodra',
      license: 'MIT',
      keywords: ['coodra', 'devin', 'mcp', 'context', 'wiki', 'graphify', 'jira'],
      mcpServers: './mcp_config.json',
      skills: './skills/',
    },
    null,
    2,
  )}\n`;
}

/**
 * Devin's matcher is a real regex tested against `tool_name` (confirmed
 * in docs). Devin's MCP tool names use the SAME `mcp__<server>__<tool>`
 * prefix format as Claude Code/Codex (confirmed in both the MCP and
 * hook-matcher docs) — unlike Cursor's bare `MCP:<tool_name>` shape, so
 * this reuses Claude/Codex's exact structural-prefix negative-lookahead
 * instead of Cursor's maintained-name-list workaround. `read`/`grep`/
 * `glob`/`webfetch` excluded — same noise-reduction precedent as every
 * other agent's matcher (Devin's own tool vocabulary, confirmed in
 * docs: read, write, edit, apply_patch, notebook_read, notebook_edit,
 * grep, glob, exec, ...).
 */
const TOOL_MATCHER = 'write|edit|apply_patch|notebook_edit|exec|mcp__(?!coodra__|graphify__).*' as const;

/**
 * Devin hooks are pure command/prompt hooks (stdin/stdout JSON, no
 * built-in `mcp_tool` hook type like Claude Code) — see Devin's
 * extensibility/hooks docs. The hooks.json shape is the event map
 * directly at the file's top level (no `version`/`hooks` wrapper the
 * way Cursor's format has, confirmed via Devin's docs examples and the
 * `hooks.json` parse-failure string embedded in the Devin binary).
 * Devin's own hook vocabulary is smaller than every other agent's — no
 * PreCompact-equivalent exists at all (only PostCompaction, fired after
 * the fact — Coodra's PreCompact one-shot nudge cannot fire for Devin),
 * no SubagentStart/Stop, no PermissionDenied, no PostToolUseFailure, no
 * StopFailure, no ConfigChange-equivalent. Local plugins are never
 * copied to a cache location, so an absolute path to the hook runner
 * (computed at install time) is stable — same reasoning as Cursor's.
 */
function hooksConfig(hookRunnerPath: string): unknown {
  const command = `node "${hookRunnerPath}"`;
  return {
    SessionStart: [{ hooks: [{ type: 'command', command, timeout: 10 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 10 }] }],
    PreToolUse: [{ matcher: TOOL_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] }],
    PostToolUse: [{ matcher: TOOL_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] }],
    PermissionRequest: [{ matcher: TOOL_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command, timeout: 10 }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command, timeout: 3 }] }],
    PostCompaction: [{ hooks: [{ type: 'command', command, timeout: 3 }] }],
  };
}

function hookRunner(): string {
  return `import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
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

function loadCoodraMcpEntry() {
  const mcpPath = join(PLUGIN_ROOT, 'mcp_config.json');
  const parsed = JSON.parse(readFileSync(mcpPath, 'utf8'));
  const servers = parsed.mcpServers || parsed;
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
            params: { name: 'lifecycle_event', arguments: { agentType: 'devin', rawPayload } },
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
        clientInfo: { name: 'coodra-devin-hook-runner', version: '1.0.0' },
      },
    });
  });
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw || '{}');
} catch {
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

// Devin's stdin payload carries no cwd field in any documented event
// (unlike Cursor's, which does) — Devin instead sets DEVIN_PROJECT_DIR
// as an environment variable. Enrich rather than assume the field is
// there.
if (payload && typeof payload === 'object' && payload.cwd === undefined && process.env.DEVIN_PROJECT_DIR) {
  payload.cwd = process.env.DEVIN_PROJECT_DIR;
}

try {
  const hookOutput = await callLifecycleTool(payload);
  process.stdout.write(JSON.stringify(hookOutput || {}));
} catch {
  // Fail open with an empty object — every field in every Devin hook
  // output schema is optional, so \`{}\` is the one shape that's safe
  // for all eight events without knowing which event this invocation
  // was for (same reasoning as Cursor's own hook-runner.mjs).
  process.stdout.write(JSON.stringify({}));
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
4. Do not create legacy root-level \`.coodra.json\`, \`.mcp.json\`, project \`.env\`, \`.cursorrules\`, or \`AGENTS.md\` for Coodra setup.
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
3. Do not inspect or print environment variables to discover LLM keys unless the user explicitly asks. If a semantic build fails because Graphify lacks a backend, explain that the external Graphify process cannot automatically borrow this session, then fall back to \`coodra graphify build --no-llm\` for a structural graph.
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
