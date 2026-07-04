import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type CoodraMcpEntry, isCoodraEntryEqual } from './mcp-merge.js';
import type { WriteOutcome } from './types.js';

/**
 * `packages/cli/src/lib/init/cursor-merge.ts` — Scope B (0.2.0-beta.1).
 *
 * Writes the `coodra` MCP entry into Cursor's per-project MCP config so a
 * Cursor session can spawn the bundled Coodra MCP server and call the
 * `coodra__*` tools.
 *
 * **Project-scoped, not global.** Cursor reads MCP servers from either
 * `~/.cursor/mcp.json` (global) or `<repo>/.cursor/mcp.json`
 * (project-scoped). We write the PROJECT file — same model as Codex
 * (`.codex/config.toml`) and Claude Code (`.mcp.json`): repo-scoped,
 * uninstall removes it cleanly, never touches the user's shared global
 * Cursor config.
 *
 * The file shape matches `.mcp.json` / Windsurf MCP config —
 * `{ "mcpServers": { "<name>": { command, args, env } } }` — so we
 * reuse the `CoodraMcpEntry` shape and the `isCoodraEntryEqual`
 * canonical comparator from `mcp-merge.ts`. This module only owns the
 * project-scoped path resolution.
 *
 * Merge contract mirrors `mergeMcpJson` (spec §11 Decision 3): never
 * destroys user edits — an existing drifted `coodra` entry is preserved
 * unless `--force`; every other server entry in the file is left
 * untouched.
 */

export interface MergeCursorMcpConfigOptions {
  readonly cwd: string;
  readonly entry: CoodraMcpEntry;
  readonly force: boolean;
  readonly dryRun: boolean;
}

/**
 * Idempotent merge of the `coodra` entry into
 * `<cwd>/.cursor/mcp.json` under `mcpServers.coodra`.
 */
export async function mergeCursorMcpConfig(options: MergeCursorMcpConfigOptions): Promise<WriteOutcome> {
  const path = join(options.cwd, '.cursor', 'mcp.json');
  const exists = await pathExists(path);

  if (!exists) {
    const baseline = { mcpServers: { coodra: options.entry } };
    if (!options.dryRun) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    }
    return { path, action: 'wrote', notes: 'created baseline .cursor/mcp.json with coodra entry' };
  }

  const raw = await readFile(path, 'utf8');
  let parsed: { mcpServers?: Record<string, unknown>; [k: string]: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot parse existing ${path}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path} must be a JSON object`);
  }

  const servers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existingCoodra = servers.coodra;

  if (options.force) {
    parsed.mcpServers = { ...servers, coodra: options.entry };
    if (!options.dryRun) await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return { path, action: 'forced', notes: 'overwrote coodra entry in .cursor/mcp.json with baseline' };
  }

  if (existingCoodra === undefined) {
    parsed.mcpServers = { ...servers, coodra: options.entry };
    if (!options.dryRun) await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return { path, action: 'merged', notes: 'added coodra entry to existing .cursor/mcp.json' };
  }

  if (isCoodraEntryEqual(options.entry, existingCoodra)) {
    return { path, action: 'unchanged', notes: 'coodra entry in .cursor/mcp.json already matches baseline' };
  }

  // Drift: preserve the user's edits (Decision 3).
  return {
    path,
    action: 'unchanged',
    notes: 'coodra entry in .cursor/mcp.json exists with custom config; pass --force to overwrite with baseline',
  };
}

/**
 * `coodra uninstall` reverse — removes the `coodra` key from
 * `mcpServers` in `<cwd>/.cursor/mcp.json`. Every other server entry is
 * left untouched. Idempotent: a no-op when there's no `coodra` entry.
 */
export async function removeCursorMcpConfig(options: { cwd: string; dryRun: boolean }): Promise<WriteOutcome> {
  const path = join(options.cwd, '.cursor', 'mcp.json');
  const exists = await pathExists(path);
  if (!exists) {
    return { path, action: 'unchanged', notes: '.cursor/mcp.json does not exist; nothing to remove' };
  }

  const raw = await readFile(path, 'utf8');
  let parsed: { mcpServers?: Record<string, unknown>; [k: string]: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot parse existing ${path}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path} must be a JSON object`);
  }

  const servers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
  if (!Object.hasOwn(servers, 'coodra')) {
    return { path, action: 'unchanged', notes: 'no coodra entry in .cursor/mcp.json to remove' };
  }

  const next: Record<string, unknown> = { ...servers };
  delete next.coodra;
  parsed.mcpServers = next;

  if (!options.dryRun) {
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  }
  return { path, action: 'merged', notes: 'removed coodra entry from .cursor/mcp.json' };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
