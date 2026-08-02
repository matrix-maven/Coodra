import { join } from 'node:path';
import { type IDE, IDE_ORDER } from '../detect.js';
import {
  mergeExternalCodexServer,
  readExternalCodexServerPresence,
  removeExternalCodexServer,
} from './external-codex-merge.js';
import type { ExternalMcpEntry } from './external-mcp-merge.js';
import type { WriteOutcome } from './types.js';

/**
 * `graphify-wire.ts` — the Graphify-specific wiring core shared by
 * `coodra graphify {enable,disable,status}` and `coodra init`'s
 * optional Graphify step.
 *
 * Module 09, Track 9B (ADR-010, Option C). Graphify ships its own
 * stdio MCP server — `python -m graphify.serve graphify-out/graph.json`.
 * Claude Code is native-plugin-managed (Coodra's own plugin bundles
 * Graphify automatically); this module's only remaining job is Codex's
 * project-scoped `.codex/config.toml`, for a custom graph path or a
 * Codex install that isn't running through the Coodra plugin.
 */

/**
 * Re-exported so consumers (the `coodra graphify` command, the web-v2
 * `/settings/integrations` surface) get the canonical agent type +
 * ordered list from the graphify module without reaching into
 * `lib/detect.ts` directly.
 */
export { type IDE, IDE_ORDER };

/** The `mcpServers` / `mcp_servers` key under which Graphify is wired. */
export const GRAPHIFY_SERVER_NAME = 'graphify';
/**
 * Default Python interpreter for `-m graphify.serve`. `python3` is
 * present on macOS + modern Linux; bare `python` increasingly is not.
 * Overridable so a venv interpreter (`.venv/bin/python3`) can be wired
 * — Graphify's own recommendation when `graphifyy[mcp]` is venv-installed.
 */
export const DEFAULT_GRAPHIFY_PYTHON = 'python3';
/** Default graph artifact path Graphify writes, relative to the repo root. */
export const DEFAULT_GRAPHIFY_GRAPH_PATH = 'graphify-out/graph.json';

/**
 * Resolve the agent's MCP-config path for `ide`. Coodra does not create or
 * edit Claude Code repo-root `.mcp.json`; Claude uses the native Coodra
 * plugin's plugin-scoped MCP file. Codex is project-scoped (under `cwd`).
 */
export function graphifyConfigPath(ide: IDE, cwd: string, _userHome: string): string | null {
  switch (ide) {
    case 'claude':
      return null;
    case 'codex':
      return join(cwd, '.codex', 'config.toml');
  }
}

/** Build the Graphify stdio MCP server entry for `ide`. Codex reads a project-scoped config, so a relative graph path resolves against the repo root it spawns the server from — kept as-is. */
export function buildGraphifyEntry(opts: {
  readonly ide: IDE;
  readonly python: string;
  readonly graphPath: string;
  readonly cwd: string;
}): ExternalMcpEntry {
  return {
    command: opts.python,
    args: ['-m', 'graphify.serve', opts.graphPath],
  };
}

export interface WireGraphifyOptions {
  readonly ide: IDE;
  readonly cwd: string;
  readonly userHome: string;
  readonly python: string;
  readonly graphPath: string;
  readonly force: boolean;
  readonly dryRun: boolean;
}

/**
 * Idempotently add the `graphify` MCP server entry to `ide`'s config.
 * Dispatches to the JSON or TOML 9·Core writer by agent. Preserves the
 * `coodra` entry and any user edits (a drifted `graphify` entry is left
 * untouched unless `force`).
 */
export async function wireGraphify(options: WireGraphifyOptions): Promise<WriteOutcome> {
  const filePath = graphifyConfigPath(options.ide, options.cwd, options.userHome);
  if (filePath === null) return nativePluginOutcome();
  const entry = buildGraphifyEntry({
    ide: options.ide,
    python: options.python,
    graphPath: options.graphPath,
    cwd: options.cwd,
  });
  return mergeExternalCodexServer({
    filePath,
    name: GRAPHIFY_SERVER_NAME,
    entry,
    force: options.force,
    dryRun: options.dryRun,
  });
}

/**
 * Idempotently remove the `graphify` MCP server entry from `ide`'s
 * config. A missing file or missing entry is a no-op. Every other
 * server entry (incl. `coodra`) is left untouched.
 */
export async function unwireGraphify(options: {
  readonly ide: IDE;
  readonly cwd: string;
  readonly userHome: string;
  readonly dryRun: boolean;
}): Promise<WriteOutcome> {
  const filePath = graphifyConfigPath(options.ide, options.cwd, options.userHome);
  if (filePath === null) return nativePluginOutcome();
  return removeExternalCodexServer({ filePath, name: GRAPHIFY_SERVER_NAME, dryRun: options.dryRun });
}

export interface GraphifyServerPresence {
  /** Whether the config file exists. */
  readonly exists: boolean;
  /** Whether the file carries the `graphify` MCP entry. */
  readonly wired: boolean;
  /** True when the file exists but cannot be parsed. */
  readonly unreadable: boolean;
}

/** Read-only probe — does `ide`'s config carry the `graphify` entry? */
export async function readGraphifyPresence(options: {
  readonly ide: IDE;
  readonly cwd: string;
  readonly userHome: string;
}): Promise<GraphifyServerPresence> {
  const filePath = graphifyConfigPath(options.ide, options.cwd, options.userHome);
  if (filePath === null) return { exists: false, wired: false, unreadable: false };
  return readExternalCodexServerPresence({ filePath, name: GRAPHIFY_SERVER_NAME });
}

function nativePluginOutcome(): WriteOutcome {
  return {
    path: 'Claude Code native plugin',
    action: 'unchanged',
    notes: 'Claude Code uses the native Coodra plugin MCP; repo-root .mcp.json is user-owned and not managed by Coodra',
  };
}
