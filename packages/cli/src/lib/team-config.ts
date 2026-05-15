import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveCoodraConfigJson, resolveCoodraHome } from './coodra-home.js';

/**
 * `packages/cli/src/lib/team-config.ts` — Module 04 Phase 4. Reader +
 * writer for `~/.coodra/config.json::team` block. Used by:
 *
 *   - `apps/hooks-bridge` at boot: reads the active user/org so it can
 *     stamp `created_by_user_id` on writes (the actor identity layer).
 *   - `apps/mcp-server` at boot: same purpose, stamps tool-handler writes.
 *   - `apps/sync-daemon`: pull-tick uses `last_pulled_at` per-table state.
 *   - `packages/cli` `team migrate` / `team join` / `team leave` commands:
 *     write/clear the team block on transition.
 *
 * The file is shared with M02/M03's existing `local_hook_secret` slot and
 * will absorb future team-mode keys; readers MUST tolerate unknown fields.
 *
 * Shape (TeamConfig):
 *   {
 *     mode: 'solo' | 'team',
 *     team?: {
 *       clerkUserId: string,
 *       clerkOrgId: string,
 *       clerkOrgSlug?: string,
 *       localHookSecret: string,             // for cloud-API auth (NOT bridge)
 *       lastPulledAt?: { [table]: number }, // ms timestamp per pull-tick state
 *       joinedAt: number,                    // ms timestamp; for diagnostics
 *     }
 *   }
 *
 * Solo mode either omits `team` entirely or sets `mode='solo'`. Either
 * shape parses. Team mode requires every field above.
 *
 * Atomicity: writes go through a tmpfile + rename. If a crash lands
 * mid-write, the prior file remains intact. Concurrent writes from
 * different processes are not protected (the file is per-machine
 * single-user). The CLI commands that mutate this file run in a single
 * process by design.
 */

export interface TeamBlock {
  readonly clerkUserId: string;
  readonly clerkOrgId: string;
  readonly clerkOrgSlug?: string;
  readonly localHookSecret: string;
  readonly lastPulledAt?: Record<string, number>;
  readonly joinedAt: number;
}

export interface TeamConfig {
  readonly mode: 'solo' | 'team';
  readonly team?: TeamBlock;
}

const SOLO_CONFIG: TeamConfig = Object.freeze({ mode: 'solo' });

export interface ResolveTeamConfigOptions {
  /** Override the home directory (used by tests + dev-loop overrides). */
  readonly homeOverride?: string;
}

/**
 * Read + parse `~/.coodra/config.json`. Returns SOLO_CONFIG when the
 * file is absent, unreadable, malformed, or mode is not 'team'. Never
 * throws — callers branch on the result.
 *
 * Validation is permissive — unknown top-level keys are dropped, and a
 * `team` block missing required fields downgrades to solo (logged at
 * caller's discretion). This keeps `coodra team migrate` interruption
 * scenarios from leaving the bridge in a half-broken state.
 */
export function readTeamConfig(opts: ResolveTeamConfigOptions = {}): TeamConfig {
  const path = resolveCoodraConfigJson(
    resolveCoodraHome(opts.homeOverride !== undefined ? { override: opts.homeOverride } : {}),
  );
  if (!existsSync(path)) return SOLO_CONFIG;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return SOLO_CONFIG;
  }
  if (raw.trim().length === 0) return SOLO_CONFIG;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return SOLO_CONFIG;
  }
  if (typeof parsed !== 'object' || parsed === null) return SOLO_CONFIG;
  const obj = parsed as Record<string, unknown>;
  const modeRaw = obj.mode;
  if (modeRaw !== 'team') return SOLO_CONFIG;
  const teamRaw = obj.team;
  if (typeof teamRaw !== 'object' || teamRaw === null) return SOLO_CONFIG;
  const t = teamRaw as Record<string, unknown>;
  const clerkUserId = typeof t.clerkUserId === 'string' ? t.clerkUserId : null;
  const clerkOrgId = typeof t.clerkOrgId === 'string' ? t.clerkOrgId : null;
  const localHookSecret = typeof t.localHookSecret === 'string' ? t.localHookSecret : null;
  const joinedAt = typeof t.joinedAt === 'number' ? t.joinedAt : null;
  if (clerkUserId === null || clerkOrgId === null || localHookSecret === null || joinedAt === null) {
    return SOLO_CONFIG;
  }
  const team: TeamBlock = {
    clerkUserId,
    clerkOrgId,
    localHookSecret,
    joinedAt,
    ...(typeof t.clerkOrgSlug === 'string' ? { clerkOrgSlug: t.clerkOrgSlug } : {}),
    ...(isLastPulledAtMap(t.lastPulledAt) ? { lastPulledAt: t.lastPulledAt } : {}),
  };
  return { mode: 'team', team };
}

function isLastPulledAtMap(v: unknown): v is Record<string, number> {
  if (typeof v !== 'object' || v === null) return false;
  for (const value of Object.values(v as Record<string, unknown>)) {
    if (typeof value !== 'number') return false;
  }
  return true;
}

/**
 * Atomic write of the team config. Writes to `<path>.tmp` then renames.
 * Caller is responsible for passing a complete TeamConfig — partial
 * writes corrupt the file. Use the helper builders below for safe
 * mutation patterns.
 */
export function writeTeamConfig(config: TeamConfig, opts: ResolveTeamConfigOptions = {}): void {
  const path = resolveCoodraConfigJson(
    resolveCoodraHome(opts.homeOverride !== undefined ? { override: opts.homeOverride } : {}),
  );
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${path}.tmp`;
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(tmpPath, serialized, 'utf8');
  // POSIX rename is atomic; on Windows it's atomic for same-volume renames
  // which `dirname(path)` always satisfies for our usage.
  renameSync(tmpPath, path);
}

/**
 * Promote the local config from solo to team. Writes `mode='team'` and
 * the supplied team block. If the file already has a team block, the
 * supplied one wins (reauth / migrate on top of an existing setup).
 */
export function upgradeToTeamConfig(team: TeamBlock, opts: ResolveTeamConfigOptions = {}): void {
  writeTeamConfig({ mode: 'team', team }, opts);
}

/**
 * Demote to solo. Writes `mode='solo'` with no team block. Used by
 * `coodra team leave`. The local SQLite cleanup is the caller's
 * responsibility.
 */
export function demoteToSoloConfig(opts: ResolveTeamConfigOptions = {}): void {
  writeTeamConfig(SOLO_CONFIG, opts);
}

/**
 * Merge a partial pull-state update into the existing team block. No-op
 * in solo mode (no team block to update). Used by the sync daemon's
 * pull-tick to record `lastPulledAt` per table after each successful tick.
 */
export function updateLastPulledAt(table: string, ts: number, opts: ResolveTeamConfigOptions = {}): void {
  const cfg = readTeamConfig(opts);
  if (cfg.mode !== 'team' || cfg.team === undefined) return;
  const next: TeamBlock = {
    ...cfg.team,
    lastPulledAt: { ...(cfg.team.lastPulledAt ?? {}), [table]: ts },
  };
  writeTeamConfig({ mode: 'team', team: next }, opts);
}

// ---------------------------------------------------------------------------
// `~/.coodra/.env` writer / reader (Phase G+H, 2026-05-09).
// ---------------------------------------------------------------------------
//
// The team-config block in `config.json` is the source of truth for the
// CLI's own internal use (`team-config.ts` readers). But `coodra
// start` spawns the daemons (mcp-server, hooks-bridge, sync-daemon) by
// reading env from `~/.coodra/.env` via `loadHomeEnv` (per
// `packages/cli/src/lib/load-home-env.ts`). The daemons themselves
// validate `process.env.DATABASE_URL` / `COODRA_MODE` etc. via Zod
// schemas at boot.
//
// Without writing the team-mode env vars to `~/.coodra/.env` after
// `team setup` / `team join`, the next `coodra start` would see
// `COODRA_MODE=solo` (default) and refuse to launch sync-daemon, OR
// see `COODRA_MODE=team` (from a stale .env) but no DATABASE_URL and
// crash sync-daemon at boot. Either way the user is stuck.
//
// `writeTeamHomeEnv` does an idempotent merge — preserves existing
// non-team keys (so a developer's manual customizations stay), updates
// our four keys, atomic-renames the file.

/** The four env vars team mode requires for `coodra start` to launch the full stack. */
const TEAM_ENV_KEYS = ['COODRA_MODE', 'DATABASE_URL', 'LOCAL_HOOK_SECRET', 'COODRA_TEAM_ORG_ID'] as const;

export interface TeamHomeEnvInput {
  readonly databaseUrl: string;
  readonly localHookSecret: string;
  readonly clerkOrgId: string;
}

function readEnvFileLines(envPath: string): string[] {
  if (!existsSync(envPath)) return [];
  try {
    return readFileSync(envPath, 'utf8').split('\n');
  } catch {
    return [];
  }
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  // Strip enclosing quotes if present (parity with dotenv parser).
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function quoteIfNeeded(value: string): string {
  if (/[\s#'"\\$]/.test(value)) {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }
  return value;
}

/**
 * Atomic, idempotent merge of team-mode env vars into
 * `<coodraHome>/.env`. Preserves any existing keys we don't manage.
 * Updates / inserts the four team keys.
 */
export function writeTeamHomeEnv(input: TeamHomeEnvInput, opts: ResolveTeamConfigOptions = {}): void {
  const home = resolveCoodraHome(opts.homeOverride !== undefined ? { override: opts.homeOverride } : {});
  const envPath = join(home, '.env');
  mkdirSync(home, { recursive: true });

  const desired: Record<string, string> = {
    COODRA_MODE: 'team',
    DATABASE_URL: input.databaseUrl,
    LOCAL_HOOK_SECRET: input.localHookSecret,
    COODRA_TEAM_ORG_ID: input.clerkOrgId,
  };

  const existing = readEnvFileLines(envPath);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of existing) {
    const parsed = parseEnvLine(rawLine);
    if (parsed === null) {
      out.push(rawLine);
      continue;
    }
    const updated = desired[parsed.key];
    if (updated !== undefined) {
      seen.add(parsed.key);
      out.push(`${parsed.key}=${quoteIfNeeded(updated)}`);
    } else {
      out.push(rawLine);
    }
  }
  // Append any keys we manage but didn't already see in the file.
  for (const key of TEAM_ENV_KEYS) {
    if (seen.has(key)) continue;
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    out.push(`${key}=${quoteIfNeeded(desired[key] as string)}`);
  }

  // Strip trailing empty lines, then ensure trailing newline.
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  const tmpPath = `${envPath}.tmp`;
  writeFileSync(tmpPath, `${out.join('\n')}\n`, 'utf8');
  renameSync(tmpPath, envPath);
}

/**
 * Reverse of `writeTeamHomeEnv`. Used by `coodra team leave` to
 * remove the four team env keys, leaving any user-managed entries
 * intact. The file itself stays even if it ends up empty (so users
 * who put other vars there don't lose them).
 */
export function clearTeamHomeEnv(opts: ResolveTeamConfigOptions = {}): void {
  const home = resolveCoodraHome(opts.homeOverride !== undefined ? { override: opts.homeOverride } : {});
  const envPath = join(home, '.env');
  if (!existsSync(envPath)) return;
  const existing = readEnvFileLines(envPath);
  const out: string[] = [];
  const managed = new Set(TEAM_ENV_KEYS);
  for (const rawLine of existing) {
    const parsed = parseEnvLine(rawLine);
    if (parsed === null) {
      out.push(rawLine);
      continue;
    }
    if (managed.has(parsed.key as (typeof TEAM_ENV_KEYS)[number])) continue;
    out.push(rawLine);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  const tmpPath = `${envPath}.tmp`;
  writeFileSync(tmpPath, out.length === 0 ? '' : `${out.join('\n')}\n`, 'utf8');
  renameSync(tmpPath, envPath);
}

/**
 * Read the four team env keys from `~/.coodra/.env`. Returns null
 * when the file is missing or doesn't contain a complete team block.
 * Used by doctor check 36 to verify env-vs-config sync.
 */
export function readTeamHomeEnv(opts: ResolveTeamConfigOptions = {}): TeamHomeEnvInput | null {
  const home = resolveCoodraHome(opts.homeOverride !== undefined ? { override: opts.homeOverride } : {});
  const envPath = join(home, '.env');
  if (!existsSync(envPath)) return null;
  const lines = readEnvFileLines(envPath);
  const map = new Map<string, string>();
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (parsed !== null) map.set(parsed.key, parsed.value);
  }
  if (map.get('COODRA_MODE') !== 'team') return null;
  const databaseUrl = map.get('DATABASE_URL');
  const localHookSecret = map.get('LOCAL_HOOK_SECRET');
  const clerkOrgId = map.get('COODRA_TEAM_ORG_ID');
  if (
    typeof databaseUrl !== 'string' ||
    databaseUrl.length === 0 ||
    typeof localHookSecret !== 'string' ||
    localHookSecret.length === 0 ||
    typeof clerkOrgId !== 'string' ||
    clerkOrgId.length === 0
  ) {
    return null;
  }
  return { databaseUrl, localHookSecret, clerkOrgId };
}
