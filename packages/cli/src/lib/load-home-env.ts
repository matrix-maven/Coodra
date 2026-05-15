import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseDotenv } from 'dotenv';

/**
 * Reads the two dotenv files `coodra start` cares about and returns a
 * single merged dict. Used by `services.ts::resolveServices` to seed the
 * daemon's spawn env.
 *
 * Layering (low → high precedence):
 *   1. `<COODRA_HOME>/.env`  — user-global daemon defaults + the
 *                                 machine-level identity / mode keys
 *                                 (COODRA_MODE, DATABASE_URL,
 *                                 LOCAL_HOOK_SECRET, COODRA_TEAM_*) —
 *                                 these are PER-MACHINE concepts and
 *                                 the home value always wins for them.
 *   2. `<projectCwd>/.env`      — per-project overrides for everything
 *                                 ELSE (MCP_SERVER_PORT, HOOKS_BRIDGE_PORT,
 *                                 Clerk test sentinels, project-specific
 *                                 secrets).
 *   3. process.env              — applied by the caller; always wins
 *
 * Why home wins for the MACHINE_LEVEL_KEYS set: those keys describe the
 * developer's identity on this laptop, not the project. A stale project
 * `.env` from a pre-team-mode `coodra init` run carries
 * `COODRA_MODE=solo`; without this carve-out, that stale value
 * silently demotes the entire developer machine back to solo (sync-
 * daemon never spawns, runs never push to cloud). M04 Phase 4 Fix
 * (2026-05-11): the old "project wins for everything" model was wrong
 * for these keys.
 *
 * Pre-fix history: only `<COODRA_HOME>/.env` was read, so the .env
 * `init` writes (`<cwd>/.env`) was decorative end-to-end. Solo mode
 * survived only because `COODRA_MODE` defaults to `'solo'` in
 * `baseEnvSchema`; team-mode setups silently fell back to solo. Doctor
 * check 20 (`LOCAL_HOOK_SECRET present`) was YELLOW because the
 * `LOCAL_HOOK_SECRET` `init` wrote never reached the daemon either.
 *
 * Either file may be absent or unreadable — that's a no-op (empty dict
 * for that layer); `coodra start` must not fail just because the
 * operator hasn't run `init` yet, or hasn't customised either file.
 *
 * Function name kept as `loadHomeEnv` for source-grep continuity even
 * though it now reads two files; `projectCwd` is optional so existing
 * call sites that only need the home layer don't have to change.
 */

/**
 * Keys that describe the developer's machine + team identity. Home
 * always wins for these — project .env cannot override.
 *
 * Anything in this set is per-developer, not per-project: a developer
 * who's a member of a team has COODRA_MODE=team for every project
 * they work on. Conversely, a project's .env carrying these keys is
 * almost always stale state from a prior `coodra init` that ran
 * before team mode was set up.
 *
 * Phase H.6 (2026-05-13) — added `CLERK_SECRET_KEY` and
 * `CLERK_PUBLISHABLE_KEY` to this set. Pre-fix, `coodra init` wrote
 * the solo-bypass sentinels (`sk_test_replace_me` / `pk_test_replace_me`)
 * into every project's `.env`. When `coodra feature add` later ran
 * from such a project, the sentinels overrode the real keys from
 * `~/.coodra/.env` → `verifyClerkJwtAndExtractClaims` threw the
 * solo-bypass-sentinel error → `readVerifiedToken` returned null →
 * `feature-db.ts` fell back to the legacy (forgeable) `teamConfig.
 * team.clerkUserId`. That regressed the Phase G tamper-safety invariant.
 * Adding these to MACHINE_LEVEL_KEYS makes the home value win and the
 * Phase G verified-JWT path stays load-bearing.
 */
const MACHINE_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'COODRA_MODE',
  'DATABASE_URL',
  'LOCAL_HOOK_SECRET',
  'COODRA_TEAM_ORG_ID',
  'COODRA_TEAM_USER_ID',
  'COODRA_TEAM_ORG_SLUG',
  'CLERK_SECRET_KEY',
  'CLERK_PUBLISHABLE_KEY',
]);

export function loadHomeEnv(coodraHome: string, projectCwd?: string): Record<string, string> {
  const home = readDotenvFile(join(coodraHome, '.env'));
  const project = projectCwd !== undefined ? readDotenvFile(join(projectCwd, '.env')) : {};
  // Start with project (low precedence for general keys) then layer
  // home on top, but ONLY for the machine-level keys. For everything
  // else, project wins (as before).
  const merged: Record<string, string> = { ...home, ...project };
  for (const key of MACHINE_LEVEL_KEYS) {
    if (home[key] !== undefined) merged[key] = home[key];
  }
  return merged;
}

function readDotenvFile(path: string): Record<string, string> {
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  return parseDotenv(body);
}
