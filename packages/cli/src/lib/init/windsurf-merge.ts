import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type CoodraMcpEntry, isCoodraEntryEqual } from './mcp-merge.js';
import type { WriteOutcome } from './types.js';

/**
 * `packages/cli/src/lib/init/windsurf-merge.ts` — beta.95 (Scope A).
 *
 * Writes the `coodra` MCP entry into Windsurf Cascade's MCP config
 * so a Cascade session can spawn the bundled Coodra MCP server and
 * call the `coodra__*` tools.
 *
 * **Global, not project-scoped.** Unlike Claude Code (`.mcp.json`) and
 * Codex (`.codex/config.toml`), Windsurf has no project-level MCP
 * config — Cascade only reads `~/.codeium/windsurf/mcp_config.json`.
 * So this writer touches a shared user file, which makes the
 * merge-don't-clobber discipline load-bearing: every server entry the
 * user already has is preserved byte-for-byte; we only ever add or
 * update the `coodra` key.
 *
 * The file shape is identical to `.mcp.json` —
 * `{ "mcpServers": { "<name>": { command, args, env } } }` — so we
 * reuse the `CoodraMcpEntry` shape and the `isCoodraEntryEqual`
 * canonical comparator from `mcp-merge.ts`. This module only owns the
 * global-path resolution + the `~/.codeium/windsurf/` mkdir.
 *
 * Merge contract mirrors `mergeMcpJson` (spec §11 Decision 3): an
 * existing drifted `coodra` entry is preserved unless `--force`.
 */

/**
 * Resolve the canonical Windsurf MCP config path. `userHome` override
 * lets tests point at a tmpdir instead of the runner's real home.
 *
 * F2 (2026-07-04): `COODRA_WINDSURF_CONFIG_PATH` env override, mirroring
 * `CLAUDE_SETTINGS_PATH` for Claude Code. Windsurf's MCP config is a
 * single GLOBAL file (`~/.codeium/windsurf/mcp_config.json`), so without a
 * redirect a scratch / CI `coodra init` writes the operator's real file.
 * When set, this env var wins over both the arg and the home default.
 */
export function defaultWindsurfMcpConfigPath(userHome?: string): string {
  const override = process.env.COODRA_WINDSURF_CONFIG_PATH;
  if (typeof override === 'string' && override.length > 0) return override;
  const home = userHome ?? homedir();
  return join(home, '.codeium', 'windsurf', 'mcp_config.json');
}

export interface MergeWindsurfMcpConfigOptions {
  readonly entry: CoodraMcpEntry;
  readonly force: boolean;
  readonly dryRun: boolean;
  /** Override `$HOME` for tests. Production callers omit it. */
  readonly userHome?: string;
}

/**
 * Idempotent merge of the `coodra` entry into
 * `~/.codeium/windsurf/mcp_config.json` under `mcpServers.coodra`.
 */
export async function mergeWindsurfMcpConfig(options: MergeWindsurfMcpConfigOptions): Promise<WriteOutcome> {
  const path = defaultWindsurfMcpConfigPath(options.userHome);
  const exists = await pathExists(path);

  if (!exists) {
    const baseline = { mcpServers: { coodra: options.entry } };
    if (!options.dryRun) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    }
    return { path, action: 'wrote', notes: 'created baseline mcp_config.json with coodra entry' };
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
    return { path, action: 'forced', notes: 'overwrote coodra entry in mcp_config.json with baseline' };
  }

  if (existingCoodra === undefined) {
    parsed.mcpServers = { ...servers, coodra: options.entry };
    if (!options.dryRun) await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return { path, action: 'merged', notes: 'added coodra entry to existing mcp_config.json' };
  }

  if (isCoodraEntryEqual(options.entry, existingCoodra)) {
    return { path, action: 'unchanged', notes: 'coodra entry already matches baseline' };
  }

  // Drift: preserve the user's edits (Decision 3).
  return {
    path,
    action: 'unchanged',
    notes: 'coodra entry exists with custom config; pass --force to overwrite with baseline',
  };
}

/**
 * `coodra uninstall` reverse — removes the `coodra` key from
 * `mcpServers` in `~/.codeium/windsurf/mcp_config.json`. Every other
 * server entry is left untouched. Idempotent.
 */
export async function removeWindsurfMcpConfig(options: { dryRun: boolean; userHome?: string }): Promise<WriteOutcome> {
  const path = defaultWindsurfMcpConfigPath(options.userHome);
  const exists = await pathExists(path);
  if (!exists) {
    return { path, action: 'unchanged', notes: 'mcp_config.json does not exist; nothing to remove' };
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
    return { path, action: 'unchanged', notes: 'no coodra entry to remove' };
  }

  const next: Record<string, unknown> = { ...servers };
  delete next.coodra;
  parsed.mcpServers = next;

  if (!options.dryRun) {
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  }
  return { path, action: 'merged', notes: 'removed coodra entry from mcp_config.json' };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
