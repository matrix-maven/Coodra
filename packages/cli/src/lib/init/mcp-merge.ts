import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WriteOutcome } from './types.js';

export interface BuildMcpEntryOptions {
  /**
   * Absolute path to the bundled mcp-server binary. The init command
   * resolves this via `lib/runtime-paths.ts::resolveRuntimeBinary` —
   * which prefers the bundled `<cli-dist>/runtime/mcp-server/index.js`
   * (npm-install case) and falls back to `apps/mcp-server/dist/index.js`
   * (monorepo dev). If neither exists init throws with a structured
   * remediation BEFORE this builder runs, so the value is always a real
   * path here.
   */
  readonly mcpServerBin: string;
  /** Solo-mode bypass token to set on the MCP entry. Always solo-only. */
  readonly clerkSecretKey: string;
  /**
   * Absolute path to the bundled drizzle migrations folder, when the
   * runtime resolver detected a bundled deploy. `null` when the CLI
   * is running from a workspace checkout — in that case the bundled
   * mcp-server's `MIGRATIONS_FOLDER.sqlite` resolves correctly via
   * `@coodra/db`'s own `import.meta.url`.
   */
  readonly migrationsDir?: string | null;
  /**
   * Absolute path to the resolved COODRA_HOME. When set, the spawned
   * MCP server reads/writes the project's local SQLite (in this home)
   * instead of the user's default `~/.coodra/` — eliminating the
   * split-brain where the bridge's audit chain lives in the project home
   * but the MCP server's record_decision / save_context_pack writes go
   * to a totally different SQLite database.
   */
  readonly coodraHome?: string;
  /**
   * Phase F.6+ (2026-05-12) — machine mode. When set to 'team', the MCP
   * child process spawned by Claude Code knows to enqueue `sync_to_cloud`
   * jobs on every record_decision / save_context_pack write so the
   * sync-daemon pushes them to cloud Postgres.
   *
   * Without this, Claude Code's MCP child inherits its env from Claude's
   * shell — which doesn't auto-load ~/.coodra/.env. Result:
   * COODRA_MODE defaults to 'solo' inside the child, sync skips, every
   * decision/pack stays local-only, teammates never see admin's work.
   * Symptom: web /decisions and /context-packs render empty even after
   * the user successfully ran the MCP tools.
   */
  readonly mode?: 'solo' | 'team';
  /**
   * Phase F.6+ — cloud Postgres URL. The MCP child's sync enqueue path
   * actually only needs the local SQLite handle, but the sync-daemon
   * (which dispatches the queue) needs DATABASE_URL. We inline it here
   * so even an MCP child run from a shell that hasn't sourced
   * ~/.coodra/.env still has it for any cloud-direct paths.
   */
  readonly databaseUrl?: string;
  /**
   * Phase F.6+ — local hook secret literal. Kept in lockstep with the
   * daemon's secret so Claude Code's hook substitutions match. Distinct
   * from the project `.env`'s LOCAL_HOOK_SECRET — that file isn't
   * auto-loaded by shells.
   */
  readonly localHookSecret?: string;
  /**
   * Which agent this MCP entry is written FOR (`claude_code` / `cursor` /
   * `windsurf` / `codex`). Stamped as `COODRA_AGENT_TYPE` in the entry's
   * env so the spawned stdio server can attribute `runs.agent_type` even
   * when the client's `initialize.clientInfo.name` is one the server's
   * mapping table has never seen (the observed failure: Codex ships
   * 'codex-mcp-client', which stamped every Codex run 'unknown' in the
   * web app). The server treats the stamp as a FALLBACK — a clientInfo
   * name that maps always wins (`apps/mcp-server/src/lib/agent-type.ts::
   * resolveAgentType`). Safe per-entry because each agent has its own
   * config file and spawns its own server process.
   */
  readonly agentType?: 'claude_code' | 'cursor' | 'windsurf' | 'codex';
}

export interface CoodraMcpEntry {
  readonly command: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
}

/**
 * Build the canonical `coodra` entry for `.mcp.json`. The bundled
 * mcp-server binary path is resolved by the init command and passed in
 * verbatim. Pre dec_83ba10c1 we wrote a `npx -y @coodra/cli
 * mcp-stdio` fallback when no monorepo was detected — that subcommand
 * never existed, so npm-installed users got a `.mcp.json` that Claude
 * Code could not spawn. With bundled dists the runtime is always on
 * disk inside the @coodra/cli package, so the fallback is gone and
 * init fails loudly when the binary cannot be located.
 */
export function buildCoodraMcpEntry(options: BuildMcpEntryOptions): CoodraMcpEntry {
  const env: Record<string, string> = {
    COODRA_LOG_DESTINATION: 'stderr',
    CLERK_SECRET_KEY: options.clerkSecretKey,
  };
  if (typeof options.migrationsDir === 'string' && options.migrationsDir.length > 0) {
    // Tells the bundled mcp-server's `@coodra/db::MIGRATIONS_FOLDER`
    // where to find drizzle SQL files (the bundle inlines the code but
    // not the SQL — those land under <cli-dist>/runtime/drizzle/).
    env.COODRA_MIGRATIONS_DIR = options.migrationsDir;
  }
  if (typeof options.coodraHome === 'string' && options.coodraHome.length > 0) {
    // CRITICAL: when Claude Code spawns the MCP server via this entry, the
    // child process inherits its env from Claude Code's environment (NOT
    // from the user's shell that ran `coodra init`). Without an explicit
    // COODRA_HOME here the MCP server defaults to `~/.coodra/`, so
    // every decision/context_pack the agent records via record_decision /
    // save_context_pack lands in the user's REAL home — not the project's
    // home. The bridge writes to the configured COODRA_HOME, the MCP
    // writes to ~/.coodra: split-brain. Pin the home explicitly.
    env.COODRA_HOME = options.coodraHome;
  }
  // Phase F.6+ (2026-05-12) — pin team-mode + cloud creds in the MCP
  // child env. See option docblocks above for the rationale. Without
  // these, the child defaults to solo and every record_decision /
  // save_context_pack call skips the sync_to_cloud enqueue, leaving
  // cloud Postgres empty even though local SQLite has the rows.
  if (options.mode === 'team') {
    env.COODRA_MODE = 'team';
  }
  if (typeof options.databaseUrl === 'string' && options.databaseUrl.length > 0) {
    env.DATABASE_URL = options.databaseUrl;
  }
  if (typeof options.localHookSecret === 'string' && options.localHookSecret.length > 0) {
    env.LOCAL_HOOK_SECRET = options.localHookSecret;
  }
  if (options.agentType !== undefined) {
    env.COODRA_AGENT_TYPE = options.agentType;
  }
  return {
    command: 'node',
    args: [options.mcpServerBin, '--transport', 'stdio'],
    env,
  };
}

/** True when both entries are byte-for-byte equal under JSON canonicalisation. */
export function isCoodraEntryEqual(a: CoodraMcpEntry, b: unknown): boolean {
  if (typeof b !== 'object' || b === null) return false;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export interface MergeMcpJsonOptions {
  readonly cwd: string;
  readonly entry: CoodraMcpEntry;
  readonly force: boolean;
  readonly dryRun: boolean;
}

/**
 * Idempotent merge of the `coodra` entry into `<cwd>/.mcp.json` per
 * spec §11 Decision 3. Returns the WriteOutcome describing what happened.
 */
export async function mergeMcpJson(options: MergeMcpJsonOptions): Promise<WriteOutcome> {
  const path = join(options.cwd, '.mcp.json');
  const exists = await pathExists(path);

  if (!exists) {
    const baseline = { mcpServers: { coodra: options.entry } };
    if (!options.dryRun) await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    return { path, action: 'wrote', notes: 'created baseline .mcp.json with coodra entry' };
  }

  const raw = await readFile(path, 'utf8');
  let parsed: { mcpServers?: Record<string, unknown>; [k: string]: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot parse existing .mcp.json: ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`.mcp.json must be a JSON object`);
  }

  const servers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existingCoodra = servers.coodra;

  if (options.force) {
    parsed.mcpServers = { ...servers, coodra: options.entry };
    if (!options.dryRun) await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return { path, action: 'forced', notes: 'overwrote .mcp.json with baseline coodra entry' };
  }

  if (existingCoodra === undefined) {
    parsed.mcpServers = { ...servers, coodra: options.entry };
    if (!options.dryRun) await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return { path, action: 'merged', notes: 'added coodra entry to existing .mcp.json' };
  }

  if (isCoodraEntryEqual(options.entry, existingCoodra)) {
    return { path, action: 'unchanged', notes: 'coodra entry already matches baseline' };
  }

  // Drift: existing coodra entry differs from baseline. Without `--force`
  // we preserve the user's edits (Decision 3 — "never destroys user edits").
  return {
    path,
    action: 'unchanged',
    notes: 'coodra entry exists with custom config; pass --force to overwrite with baseline',
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Module 08b S8 — `coodra uninstall` reverse for `.mcp.json`.
 *
 * Removes the `coodra` key from `mcpServers` if present. Leaves
 * every other server entry untouched. Returns a WriteOutcome
 * describing what happened (action='unchanged' on no-op, 'merged'
 * when the entry was actually removed, 'wrote' is unused).
 *
 * Idempotent: re-running on a file with no `coodra` entry is
 * action='unchanged'.
 */
export async function removeMcpJson(options: { cwd: string; dryRun: boolean }): Promise<WriteOutcome> {
  const path = join(options.cwd, '.mcp.json');
  const exists = await pathExists(path);
  if (!exists) {
    return { path, action: 'unchanged', notes: '.mcp.json does not exist; nothing to remove' };
  }

  const raw = await readFile(path, 'utf8');
  let parsed: { mcpServers?: Record<string, unknown>; [k: string]: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot parse existing .mcp.json: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`.mcp.json must be a JSON object`);
  }

  const servers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
  if (!Object.hasOwn(servers, 'coodra')) {
    return { path, action: 'unchanged', notes: 'no coodra entry to remove' };
  }

  const next: Record<string, unknown> = { ...servers };
  delete next.coodra;
  parsed.mcpServers = next;

  if (!options.dryRun) {
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  }
  return { path, action: 'merged', notes: 'removed coodra entry from .mcp.json' };
}
