import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { WriteOutcome } from './types.js';

/**
 * `external-mcp-merge.ts` — generalised reader/writer for a single named
 * MCP server entry inside a `.mcp.json`-shaped config file.
 *
 * This is the Module 09 "9·Core" substrate: `mcp-merge.ts` is hardcoded
 * to the `coodra` key + `<cwd>/.mcp.json`; this module parameterises
 * both the entry key (`name`) and the absolute `filePath`, so any
 * external MCP server (Graphify today; the Atlassian Rovo MCP next) can
 * be wired into any agent config that uses the `{ mcpServers: { … } }`
 * shape — Claude Code's `.mcp.json`, Cursor's `.cursor/mcp.json`,
 * Windsurf's `~/.codeium/windsurf/mcp_config.json`.
 *
 * Idempotency follows `mcp-merge.ts` exactly: a re-run that finds an
 * identical entry is a no-op; a drifted entry is preserved unless
 * `--force` is passed; sibling entries are never touched.
 */

/** stdio MCP server entry shape — `{ command, args?, env? }`. */
export interface ExternalMcpEntry {
  readonly command: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
}

/**
 * Remote (Streamable HTTP / SSE) MCP server entry. The native per-client
 * shapes differ: Claude Code `{ type: 'http', url }`, Cursor `{ url }`,
 * Windsurf `{ serverUrl }`. Every field is optional so a single type
 * covers all clients; the per-client builder (e.g. `jira-wire.ts`) emits
 * exactly the keys that client expects. Added for Module 09 Track 9A
 * (Jira = Direct, ADR-016) — Rovo is a remote MCP, not stdio like Graphify.
 */
export interface RemoteMcpEntry {
  readonly type?: string;
  readonly url?: string;
  readonly serverUrl?: string;
  readonly headers?: Record<string, string>;
}

/** Any MCP server entry the 9·Core writers persist — stdio or remote. */
export type McpEntry = ExternalMcpEntry | RemoteMcpEntry;

/** Sorted-key deep canonicalisation so entry equality is order-insensitive. */
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

/** True when `b` is byte-for-byte equal to `a` under JSON canonicalisation. */
function entriesEqual(a: McpEntry, b: unknown): boolean {
  if (typeof b !== 'object' || b === null) return false;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface McpJsonShape {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

function parseMcpJson(raw: string, filePath: string): McpJsonShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot parse ${filePath}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} must be a JSON object`);
  }
  return parsed as McpJsonShape;
}

export interface MergeExternalMcpOptions {
  /** Absolute path to the `.mcp.json`-shaped config file. */
  readonly filePath: string;
  /** The `mcpServers` key to add/update, e.g. `'graphify'`. */
  readonly name: string;
  /** The entry to write under `mcpServers[name]` (stdio or remote). */
  readonly entry: McpEntry;
  /** Overwrite an existing drifted entry. */
  readonly force: boolean;
  /** Report what would change without writing. */
  readonly dryRun: boolean;
}

/**
 * Idempotently merge `entry` under `mcpServers[name]` in `filePath`.
 * Creates the file (and parent dir) if absent. Preserves sibling MCP
 * servers and any other top-level keys.
 */
export async function mergeExternalMcpServer(options: MergeExternalMcpOptions): Promise<WriteOutcome> {
  const { filePath, name, entry } = options;

  if (!(await pathExists(filePath))) {
    const baseline = { mcpServers: { [name]: entry } };
    if (!options.dryRun) {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    }
    return { path: filePath, action: 'wrote', notes: `created config with the ${name} MCP entry` };
  }

  const parsed = parseMcpJson(await readFile(filePath, 'utf8'), filePath);
  const servers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existing = servers[name];

  if (options.force) {
    parsed.mcpServers = { ...servers, [name]: entry };
    if (!options.dryRun) await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return { path: filePath, action: 'forced', notes: `overwrote the ${name} entry` };
  }

  if (existing === undefined) {
    parsed.mcpServers = { ...servers, [name]: entry };
    if (!options.dryRun) await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return { path: filePath, action: 'merged', notes: `added the ${name} entry` };
  }

  if (entriesEqual(entry, existing)) {
    return { path: filePath, action: 'unchanged', notes: `${name} entry already matches` };
  }

  // Drift — preserve the user's custom entry unless --force.
  return {
    path: filePath,
    action: 'unchanged',
    notes: `${name} entry exists with custom config; pass --force to overwrite`,
  };
}

/**
 * Remove the `mcpServers[name]` entry from `filePath`. Idempotent — a
 * missing file or missing key is `action: 'unchanged'`. Leaves every
 * other entry untouched.
 */
export async function removeExternalMcpServer(options: {
  readonly filePath: string;
  readonly name: string;
  readonly dryRun: boolean;
}): Promise<WriteOutcome> {
  const { filePath, name } = options;
  if (!(await pathExists(filePath))) {
    return { path: filePath, action: 'unchanged', notes: 'config file does not exist; nothing to remove' };
  }
  const parsed = parseMcpJson(await readFile(filePath, 'utf8'), filePath);
  const servers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
  if (!Object.hasOwn(servers, name)) {
    return { path: filePath, action: 'unchanged', notes: `no ${name} entry to remove` };
  }
  const next: Record<string, unknown> = { ...servers };
  delete next[name];
  parsed.mcpServers = next;
  if (!options.dryRun) await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return { path: filePath, action: 'merged', notes: `removed the ${name} entry` };
}

/**
 * Scan every `mcpServers` entry EXCEPT `excludeName` for one whose
 * serialized value contains `needle` (e.g. a vendor URL host like
 * `mcp.atlassian.com`). Returns the first matching key, or `null`.
 *
 * Why serialize-and-substring instead of reading specific fields: the
 * same vendor server appears as `{ url }` (Cursor/Codex), `{ serverUrl }`
 * (Windsurf), `{ type: 'http', url }` (Claude Code), or an
 * `npx mcp-remote <url>` stdio shim — and users' IDEs write their own
 * shapes too (`disabled: true` variants, custom keys like
 * `atlassian-mcp-server`). A substring over the canonical JSON catches
 * every shape without a per-client parser. Field bug 2026-07-12: `coodra
 * jira enable` keyed only on the literal `atlassian` name and blindly
 * added a second Atlassian server next to the user's existing
 * `atlassian-mcp-server` entry.
 *
 * Missing or unparseable files return `null` — detection is advisory,
 * never a hard failure.
 */
export async function findExternalMcpServerByContent(options: {
  readonly filePath: string;
  readonly needle: string;
  readonly excludeName: string;
}): Promise<string | null> {
  if (!(await pathExists(options.filePath))) return null;
  let parsed: McpJsonShape;
  try {
    parsed = parseMcpJson(await readFile(options.filePath, 'utf8'), options.filePath);
  } catch {
    return null;
  }
  const servers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
  for (const [key, value] of Object.entries(servers)) {
    if (key === options.excludeName) continue;
    try {
      if (JSON.stringify(value).includes(options.needle)) return key;
    } catch {
      // Circular / non-serializable entry — cannot match, skip it.
    }
  }
  return null;
}

export interface McpServerPresence {
  /** Whether the config file exists. */
  readonly exists: boolean;
  /** Whether the file carries the named MCP entry. */
  readonly wired: boolean;
  /** True when the file exists but is not valid JSON. */
  readonly unreadable: boolean;
}

/** Read-only probe — does `filePath` carry an `mcpServers[name]` entry? */
export async function readExternalMcpServerPresence(options: {
  readonly filePath: string;
  readonly name: string;
}): Promise<McpServerPresence> {
  if (!(await pathExists(options.filePath))) {
    return { exists: false, wired: false, unreadable: false };
  }
  try {
    const parsed = JSON.parse(await readFile(options.filePath, 'utf8')) as { mcpServers?: Record<string, unknown> };
    const wired = parsed.mcpServers !== undefined && Object.hasOwn(parsed.mcpServers, options.name);
    return { exists: true, wired, unreadable: false };
  } catch {
    return { exists: true, wired: false, unreadable: true };
  }
}
