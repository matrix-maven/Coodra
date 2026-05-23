import { isAbsolute, join } from 'node:path';
import { type IDE, IDE_ORDER } from '../detect.js';
import {
  mergeExternalCodexServer,
  readExternalCodexServerPresence,
  removeExternalCodexServer,
} from './external-codex-merge.js';
import {
  type ExternalMcpEntry,
  mergeExternalMcpServer,
  readExternalMcpServerPresence,
  removeExternalMcpServer,
} from './external-mcp-merge.js';
import type { WriteOutcome } from './types.js';
import { defaultWindsurfMcpConfigPath } from './windsurf-merge.js';

/**
 * `graphify-wire.ts` — the Graphify-specific wiring core shared by
 * `coodra graphify {enable,disable,status}` and `coodra init`'s
 * optional Graphify step.
 *
 * Module 09, Track 9B (ADR-010, Option C). Graphify ships its own
 * stdio MCP server — `python -m graphify.serve graphify-out/graph.json`.
 * This module knows the Graphify entry shape and the per-IDE config
 * dispatch; the actual idempotent never-clobber merge lives in the
 * 9·Core substrate — `external-mcp-merge.ts` for the JSON agents
 * (Claude Code / Cursor / Windsurf) and `external-codex-merge.ts` for
 * Codex's TOML config.
 *
 * Keeping this dispatch in one place means the CLI command and the
 * `init` step cannot drift apart on, say, how Windsurf's global config
 * resolves its graph path.
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
 * Resolve the agent's MCP-config path for `ide`. Claude Code, Cursor
 * and Codex are project-scoped (under `cwd`); Windsurf's config is
 * global (under `userHome`). Mirrors `commands/agents.ts`.
 */
export function graphifyConfigPath(ide: IDE, cwd: string, userHome: string): string {
  switch (ide) {
    case 'claude':
      return join(cwd, '.mcp.json');
    case 'cursor':
      return join(cwd, '.cursor', 'mcp.json');
    case 'windsurf':
      return defaultWindsurfMcpConfigPath(userHome);
    case 'codex':
      return join(cwd, '.codex', 'config.toml');
  }
}

/**
 * Resolve the `graph.json` argument for `ide`. Claude Code, Cursor and
 * Codex read project-scoped configs, so a relative path resolves
 * against the repo root the agent spawns the server from — keep it
 * relative. Windsurf's config is global and has no project anchor, so
 * a relative path is pinned absolute against `cwd`.
 */
function graphArgFor(ide: IDE, graphPath: string, cwd: string): string {
  if (isAbsolute(graphPath)) return graphPath;
  if (ide === 'windsurf') return join(cwd, graphPath);
  return graphPath;
}

/** Build the Graphify stdio MCP server entry for `ide`. */
export function buildGraphifyEntry(opts: {
  readonly ide: IDE;
  readonly python: string;
  readonly graphPath: string;
  readonly cwd: string;
}): ExternalMcpEntry {
  return {
    command: opts.python,
    args: ['-m', 'graphify.serve', graphArgFor(opts.ide, opts.graphPath, opts.cwd)],
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
  const entry = buildGraphifyEntry({
    ide: options.ide,
    python: options.python,
    graphPath: options.graphPath,
    cwd: options.cwd,
  });
  if (options.ide === 'codex') {
    return mergeExternalCodexServer({
      filePath,
      name: GRAPHIFY_SERVER_NAME,
      entry,
      force: options.force,
      dryRun: options.dryRun,
    });
  }
  return mergeExternalMcpServer({
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
  if (options.ide === 'codex') {
    return removeExternalCodexServer({ filePath, name: GRAPHIFY_SERVER_NAME, dryRun: options.dryRun });
  }
  return removeExternalMcpServer({ filePath, name: GRAPHIFY_SERVER_NAME, dryRun: options.dryRun });
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
  if (options.ide === 'codex') {
    return readExternalCodexServerPresence({ filePath, name: GRAPHIFY_SERVER_NAME });
  }
  return readExternalMcpServerPresence({ filePath, name: GRAPHIFY_SERVER_NAME });
}
