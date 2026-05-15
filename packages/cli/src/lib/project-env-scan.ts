import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `packages/cli/src/lib/project-env-scan.ts` — Phase A (clarity-pass-
 * plan, 2026-05-11). Shared scan-and-strip helpers for stale
 * `COODRA_MODE=` lines in per-project `.env` files.
 *
 * Why this exists:
 *
 *   `coodra init` (pre-Phase-A) wrote `COODRA_MODE=solo` into
 *   `<projectCwd>/.env` when the operator's machine was solo at the
 *   time. If the operator later ran `coodra team setup` /
 *   `coodra team install`, their machine flipped to team mode but
 *   the stale project `.env` still carried `COODRA_MODE=solo`. With
 *   the original `loadHomeEnv` (project wins), that one byte demoted
 *   the entire daemon stack back to solo: sync-daemon never spawned,
 *   runs never pushed to cloud, the web's team surfaces were empty.
 *
 *   The 2026-05-11 fix landed the `MACHINE_LEVEL_KEYS` carve-out in
 *   `load-home-env.ts` — home now wins for COODRA_MODE / DATABASE_URL
 *   / LOCAL_HOOK_SECRET / COODRA_TEAM_*. That stops the demotion at
 *   the spawn-env layer.
 *
 *   But the stale `COODRA_MODE=solo` line in project `.env` is still
 *   misleading: a developer reading the file thinks "we're solo here"
 *   when the machine is actually team. Phase A surfaces this drift via
 *   doctor check 36 and offers `coodra doctor --fix` to remove the
 *   lines safely. Idempotent — running `--fix` twice is a no-op the
 *   second time.
 *
 * Scope: this module ONLY operates on the per-project `.env` file at
 * `<cwd>/.env`. It does NOT touch `~/.coodra/.env` (that's owned by
 * team-config.ts) or `<cwd>/.coodra.json` (that's the project
 * registration manifest, no env keys inside).
 *
 * Atomicity: writes use tmpfile + rename, same pattern as
 * team-config.ts. A crash mid-strip leaves the original file intact.
 */

export interface ProjectEnvScanResult {
  /** Absolute path of the project root. */
  readonly cwd: string;
  /** Absolute path of `<cwd>/.env`. */
  readonly envPath: string;
  /** True when `<cwd>/.env` exists on disk. */
  readonly exists: boolean;
  /**
   * The value of `COODRA_MODE` if present; `null` otherwise.
   *
   * A `null` here means "no COODRA_MODE line found" — the file is
   * already clean.
   */
  readonly staleModeValue: string | null;
}

export interface StripStaleModeResult {
  /** True when at least one COODRA_MODE line was removed. */
  readonly stripped: boolean;
  /** The literal lines that were removed (for diagnostics / logging). */
  readonly removedLines: readonly string[];
}

/**
 * Scan a project root's `.env` file for a `COODRA_MODE=` line.
 *
 * Returns a stable result shape even when the file is missing — callers
 * filter on `staleModeValue !== null` to find drift.
 */
export function scanProjectEnvForStaleMode(cwd: string): ProjectEnvScanResult {
  const envPath = join(cwd, '.env');
  if (!existsSync(envPath)) {
    return { cwd, envPath, exists: false, staleModeValue: null };
  }
  let body: string;
  try {
    body = readFileSync(envPath, 'utf8');
  } catch {
    return { cwd, envPath, exists: true, staleModeValue: null };
  }
  for (const rawLine of body.split('\n')) {
    const parsed = parseEnvLine(rawLine);
    if (parsed === null) continue;
    if (parsed.key === 'COODRA_MODE') {
      return { cwd, envPath, exists: true, staleModeValue: parsed.value };
    }
  }
  return { cwd, envPath, exists: true, staleModeValue: null };
}

/**
 * Remove every `COODRA_MODE=` line from the given `.env` file. Idem-
 * potent — re-running on an already-stripped file is a no-op.
 *
 * Returns `stripped=false` when the file is absent or contains no
 * COODRA_MODE lines. Returns `stripped=true` with the removed line
 * bodies (verbatim, including any inline comments) on success.
 */
export function stripStaleModeFromProjectEnv(envPath: string): StripStaleModeResult {
  if (!existsSync(envPath)) {
    return { stripped: false, removedLines: [] };
  }
  let body: string;
  try {
    body = readFileSync(envPath, 'utf8');
  } catch {
    return { stripped: false, removedLines: [] };
  }
  const before = body.split('\n');
  const removed: string[] = [];
  const kept: string[] = [];
  for (const line of before) {
    const parsed = parseEnvLine(line);
    if (parsed !== null && parsed.key === 'COODRA_MODE') {
      removed.push(line);
      continue;
    }
    kept.push(line);
  }
  if (removed.length === 0) {
    return { stripped: false, removedLines: [] };
  }
  // Collapse the inevitable run of consecutive blank lines that
  // appears where the stripped line used to be. We want the file to
  // look clean after the strip, not "deleted line left a hole".
  const collapsed: string[] = [];
  let lastBlank = false;
  for (const line of kept) {
    const isBlank = line.trim().length === 0;
    if (isBlank && lastBlank) continue;
    collapsed.push(line);
    lastBlank = isBlank;
  }
  // Strip trailing blanks, then ensure trailing newline.
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === '') collapsed.pop();
  const serialized = collapsed.length === 0 ? '' : `${collapsed.join('\n')}\n`;
  const tmpPath = `${envPath}.tmp`;
  writeFileSync(tmpPath, serialized, 'utf8');
  renameSync(tmpPath, envPath);
  return { stripped: true, removedLines: removed };
}

/**
 * Inline env-line parser. Matches the same rules `team-config.ts`
 * uses so callers see consistent behaviour across files. Returns
 * `null` for comments / blanks / malformed lines.
 */
function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}
