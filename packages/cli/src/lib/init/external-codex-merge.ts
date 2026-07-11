import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { McpEntry } from './external-mcp-merge.js';
import type { WriteOutcome } from './types.js';

/**
 * `external-codex-merge.ts` — the TOML half of the Module 09 "9·Core"
 * substrate. It is to `codex-merge.ts` what `external-mcp-merge.ts` is
 * to `mcp-merge.ts`: `codex-merge.ts` is hardcoded to the `coodra` key
 * + `<cwd>/.codex/config.toml`; this module parameterises both the
 * entry key (`name`) and the absolute `filePath`, so any external MCP
 * server (Graphify today, the Atlassian Rovo MCP next) can be wired
 * into a Codex `config.toml`.
 *
 * Codex's `[mcp_servers.<name>]` STDIO table accepts exactly
 * `command` / `args` / `env` — the same three fields the JSON
 * `.mcp.json` shape uses — so this module shares the
 * `ExternalMcpEntry` type with `external-mcp-merge.ts` and only owns
 * the TOML serialization + idempotent merge.
 *
 * Idempotency mirrors `external-mcp-merge.ts` exactly: a re-run that
 * finds an identical entry is a no-op; a drifted entry is preserved
 * unless `--force`; every other table in the file is left byte-
 * untouched (smol-toml round-trips them).
 */

/** Sorted-key deep canonicalisation so entry equality is order-insensitive. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** True when `b` is byte-for-byte equal to `a` under JSON canonicalisation. */
function entriesEqual(a: McpEntry, b: unknown): boolean {
  if (typeof b !== 'object' || b === null) return false;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Project an `McpEntry` to the plain object smol-toml serializes.
 * Codex's `[mcp_servers.<name>]` table is either stdio (`command` /
 * `args` / `env`) or remote (`url` + optional `headers`). A remote table
 * additionally requires the top-level `experimental_use_rmcp_client =
 * true` flag, which the caller passes via `MergeExternalCodexOptions.topLevel`.
 */
function entryToTomlObject(entry: McpEntry): Record<string, unknown> {
  const e = entry as Record<string, unknown>;
  if (typeof e.command === 'string') {
    const obj: Record<string, unknown> = { command: e.command };
    if (e.args !== undefined) obj.args = e.args;
    if (e.env !== undefined) obj.env = e.env;
    return obj;
  }
  // Remote shape — Codex uses `url` (+ optional headers). Windsurf's
  // `serverUrl` alias is JSON-only; the Codex builder always emits `url`.
  const obj: Record<string, unknown> = {};
  if (typeof e.url === 'string') obj.url = e.url;
  if (e.headers !== undefined) obj.headers = e.headers;
  return obj;
}

/** True when every key in `topLevel` is already present + canonically equal in `parsed`. */
function topLevelSatisfied(parsed: Record<string, unknown>, topLevel: Record<string, unknown> | undefined): boolean {
  if (topLevel === undefined) return true;
  for (const [k, v] of Object.entries(topLevel)) {
    if (!Object.hasOwn(parsed, k)) return false;
    if (JSON.stringify(canonical(parsed[k])) !== JSON.stringify(canonical(v))) return false;
  }
  return true;
}

/** Set every `topLevel` key on `parsed` (mutates in place). No-op when undefined. */
function applyTopLevel(parsed: Record<string, unknown>, topLevel: Record<string, unknown> | undefined): void {
  if (topLevel === undefined) return;
  for (const [k, v] of Object.entries(topLevel)) parsed[k] = v;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseCodexToml(raw: string, filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    throw new Error(`Cannot parse ${filePath}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} must be a TOML table`);
  }
  return parsed as Record<string, unknown>;
}

export interface MergeExternalCodexOptions {
  /** Absolute path to the `.codex/config.toml`-shaped config file. */
  readonly filePath: string;
  /** The `mcp_servers` key to add/update, e.g. `'graphify'`. */
  readonly name: string;
  /** The entry to write under `mcp_servers[name]` (stdio or remote). */
  readonly entry: McpEntry;
  /**
   * Top-level TOML keys to ensure are set on every write, e.g.
   * `{ experimental_use_rmcp_client: true }` for a remote (Streamable
   * HTTP) MCP server. Applied idempotently; NEVER stripped by
   * `removeExternalCodexServer` (the flag is global — another remote
   * server may still need it).
   */
  readonly topLevel?: Record<string, unknown>;
  /** Overwrite an existing drifted entry. */
  readonly force: boolean;
  /** Report what would change without writing. */
  readonly dryRun: boolean;
}

/**
 * Idempotently merge `entry` under `mcp_servers[name]` in `filePath`.
 * Creates the file (and parent dir) if absent. Preserves sibling MCP
 * servers and every other TOML table.
 */
export async function mergeExternalCodexServer(options: MergeExternalCodexOptions): Promise<WriteOutcome> {
  const { filePath, name, entry, topLevel } = options;
  const entryObj = entryToTomlObject(entry);

  if (!(await pathExists(filePath))) {
    const baseline: Record<string, unknown> = { ...(topLevel ?? {}), mcp_servers: { [name]: entryObj } };
    if (!options.dryRun) {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${stringifyToml(baseline)}\n`, 'utf8');
    }
    return { path: filePath, action: 'wrote', notes: `created config with the ${name} MCP entry` };
  }

  const parsed = parseCodexToml(await readFile(filePath, 'utf8'), filePath);
  const servers = (parsed.mcp_servers as Record<string, unknown> | undefined) ?? {};
  const existing = servers[name];

  if (options.force) {
    parsed.mcp_servers = { ...servers, [name]: entryObj };
    applyTopLevel(parsed, topLevel);
    if (!options.dryRun) await writeFile(filePath, `${stringifyToml(parsed)}\n`, 'utf8');
    return { path: filePath, action: 'forced', notes: `overwrote the ${name} entry` };
  }

  if (existing === undefined) {
    parsed.mcp_servers = { ...servers, [name]: entryObj };
    applyTopLevel(parsed, topLevel);
    if (!options.dryRun) await writeFile(filePath, `${stringifyToml(parsed)}\n`, 'utf8');
    return { path: filePath, action: 'merged', notes: `added the ${name} entry` };
  }

  if (entriesEqual(entry, existing)) {
    if (topLevelSatisfied(parsed, topLevel)) {
      return { path: filePath, action: 'unchanged', notes: `${name} entry already matches` };
    }
    // Entry matches but a required top-level flag is absent — set it so
    // the remote MCP server actually works (idempotent on re-run).
    applyTopLevel(parsed, topLevel);
    if (!options.dryRun) await writeFile(filePath, `${stringifyToml(parsed)}\n`, 'utf8');
    return { path: filePath, action: 'merged', notes: `${name} entry matches; set required top-level flag` };
  }

  // Drift — preserve the user's custom entry unless --force.
  return {
    path: filePath,
    action: 'unchanged',
    notes: `${name} entry exists with custom config; pass --force to overwrite`,
  };
}

/**
 * Remove the `mcp_servers[name]` entry from `filePath`. Idempotent — a
 * missing file or missing key is `action: 'unchanged'`. Leaves every
 * other table untouched.
 */
export async function removeExternalCodexServer(options: {
  readonly filePath: string;
  readonly name: string;
  readonly dryRun: boolean;
}): Promise<WriteOutcome> {
  const { filePath, name } = options;
  if (!(await pathExists(filePath))) {
    return { path: filePath, action: 'unchanged', notes: 'config file does not exist; nothing to remove' };
  }
  const parsed = parseCodexToml(await readFile(filePath, 'utf8'), filePath);
  const servers = (parsed.mcp_servers as Record<string, unknown> | undefined) ?? {};
  if (!Object.hasOwn(servers, name)) {
    return { path: filePath, action: 'unchanged', notes: `no ${name} entry to remove` };
  }
  const next: Record<string, unknown> = { ...servers };
  delete next[name];
  parsed.mcp_servers = next;
  if (!options.dryRun) await writeFile(filePath, `${stringifyToml(parsed)}\n`, 'utf8');
  return { path: filePath, action: 'merged', notes: `removed the ${name} entry` };
}

/**
 * Scan every `mcp_servers` table EXCEPT `excludeName` for one whose
 * serialized value contains `needle` (e.g. a vendor URL host like
 * `mcp.atlassian.com`). Returns the first matching key, or `null`.
 * TOML sibling of `findExternalMcpServerByContent` — see that docblock
 * for why detection is content-based, not key-based. Missing or
 * unparseable files return `null` (advisory, never a hard failure).
 */
export async function findExternalCodexServerByContent(options: {
  readonly filePath: string;
  readonly needle: string;
  readonly excludeName: string;
}): Promise<string | null> {
  if (!(await pathExists(options.filePath))) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseCodexToml(await readFile(options.filePath, 'utf8'), options.filePath);
  } catch {
    return null;
  }
  const servers = (parsed.mcp_servers as Record<string, unknown> | undefined) ?? {};
  for (const [key, value] of Object.entries(servers)) {
    if (key === options.excludeName) continue;
    try {
      if (JSON.stringify(value).includes(options.needle)) return key;
    } catch {
      // Non-serializable entry — cannot match, skip it.
    }
  }
  return null;
}

export interface CodexServerPresence {
  /** Whether the config file exists. */
  readonly exists: boolean;
  /** Whether the file carries the named MCP entry. */
  readonly wired: boolean;
  /** True when the file exists but is not valid TOML. */
  readonly unreadable: boolean;
}

/** Read-only probe — does `filePath` carry an `mcp_servers[name]` entry? */
export async function readExternalCodexServerPresence(options: {
  readonly filePath: string;
  readonly name: string;
}): Promise<CodexServerPresence> {
  if (!(await pathExists(options.filePath))) {
    return { exists: false, wired: false, unreadable: false };
  }
  try {
    const parsed = parseToml(await readFile(options.filePath, 'utf8')) as {
      mcp_servers?: Record<string, unknown>;
    };
    const wired = parsed.mcp_servers !== undefined && Object.hasOwn(parsed.mcp_servers, options.name);
    return { exists: true, wired, unreadable: false };
  } catch {
    return { exists: true, wired: false, unreadable: true };
  }
}
