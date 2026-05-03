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
   * `@coodra/contextos-db`'s own `import.meta.url`.
   */
  readonly migrationsDir?: string | null;
}

export interface ContextosMcpEntry {
  readonly command: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
}

/**
 * Build the canonical `contextos` entry for `.mcp.json`. The bundled
 * mcp-server binary path is resolved by the init command and passed in
 * verbatim. Pre dec_83ba10c1 we wrote a `npx -y @coodra/contextos-cli
 * mcp-stdio` fallback when no monorepo was detected — that subcommand
 * never existed, so npm-installed users got a `.mcp.json` that Claude
 * Code could not spawn. With bundled dists the runtime is always on
 * disk inside the @coodra/contextos-cli package, so the fallback is gone and
 * init fails loudly when the binary cannot be located.
 */
export function buildContextosMcpEntry(options: BuildMcpEntryOptions): ContextosMcpEntry {
  const env: Record<string, string> = {
    CONTEXTOS_LOG_DESTINATION: 'stderr',
    CLERK_SECRET_KEY: options.clerkSecretKey,
  };
  if (typeof options.migrationsDir === 'string' && options.migrationsDir.length > 0) {
    // Tells the bundled mcp-server's `@coodra/contextos-db::MIGRATIONS_FOLDER`
    // where to find drizzle SQL files (the bundle inlines the code but
    // not the SQL — those land under <cli-dist>/runtime/drizzle/).
    env.CONTEXTOS_MIGRATIONS_DIR = options.migrationsDir;
  }
  return {
    command: 'node',
    args: [options.mcpServerBin, '--transport', 'stdio'],
    env,
  };
}

/** True when both entries are byte-for-byte equal under JSON canonicalisation. */
export function isContextosEntryEqual(a: ContextosMcpEntry, b: unknown): boolean {
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
  readonly entry: ContextosMcpEntry;
  readonly force: boolean;
  readonly dryRun: boolean;
}

/**
 * Idempotent merge of the `contextos` entry into `<cwd>/.mcp.json` per
 * spec §11 Decision 3. Returns the WriteOutcome describing what happened.
 */
export async function mergeMcpJson(options: MergeMcpJsonOptions): Promise<WriteOutcome> {
  const path = join(options.cwd, '.mcp.json');
  const exists = await pathExists(path);

  if (!exists) {
    const baseline = { mcpServers: { contextos: options.entry } };
    if (!options.dryRun) await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    return { path, action: 'wrote', notes: 'created baseline .mcp.json with contextos entry' };
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
  const existingContextos = servers.contextos;

  if (options.force) {
    parsed.mcpServers = { ...servers, contextos: options.entry };
    if (!options.dryRun) await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return { path, action: 'forced', notes: 'overwrote .mcp.json with baseline contextos entry' };
  }

  if (existingContextos === undefined) {
    parsed.mcpServers = { ...servers, contextos: options.entry };
    if (!options.dryRun) await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return { path, action: 'merged', notes: 'added contextos entry to existing .mcp.json' };
  }

  if (isContextosEntryEqual(options.entry, existingContextos)) {
    return { path, action: 'unchanged', notes: 'contextos entry already matches baseline' };
  }

  // Drift: existing contextos entry differs from baseline. Without `--force`
  // we preserve the user's edits (Decision 3 — "never destroys user edits").
  return {
    path,
    action: 'unchanged',
    notes: 'contextos entry exists with custom config; pass --force to overwrite with baseline',
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
 * Module 08b S8 — `contextos uninstall` reverse for `.mcp.json`.
 *
 * Removes the `contextos` key from `mcpServers` if present. Leaves
 * every other server entry untouched. Returns a WriteOutcome
 * describing what happened (action='unchanged' on no-op, 'merged'
 * when the entry was actually removed, 'wrote' is unused).
 *
 * Idempotent: re-running on a file with no `contextos` entry is
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
  if (!Object.hasOwn(servers, 'contextos')) {
    return { path, action: 'unchanged', notes: 'no contextos entry to remove' };
  }

  const next: Record<string, unknown> = { ...servers };
  delete next.contextos;
  parsed.mcpServers = next;

  if (!options.dryRun) {
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  }
  return { path, action: 'merged', notes: 'removed contextos entry from .mcp.json' };
}
