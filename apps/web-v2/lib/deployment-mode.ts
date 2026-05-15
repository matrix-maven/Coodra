import 'server-only';

import { resolveEffectiveMode } from '@/lib/team-config';

/**
 * `apps/web-v2/lib/deployment-mode.ts` — Phase G slice G.8.
 *
 * Phase G unifies the user-facing identity model to TWO modes:
 *
 *   - `solo` — no Clerk, no team, single user. `getActor()` returns
 *              the synthetic `__solo__` actor with admin privileges.
 *   - `team` — Clerk-authenticated, role-from-Clerk. Identical UX
 *              whether the web is running on a developer laptop OR
 *              deployed on Vercel/fly.io. The location of the web
 *              app is implementation detail.
 *
 * For backward compat the legacy three-mode API is preserved (every
 * call site doesn't have to flip in the same commit). Three modes:
 *
 *   - `local-solo` (legacy) — same as Phase G `solo`.
 *   - `local-team` (legacy) — Phase G `team` running on a developer laptop.
 *   - `team-hosted` (legacy) — Phase G `team` running on a deployed server.
 *
 * The legacy distinction `local-team` vs `team-hosted` was an
 * implementation-detail leak surfaced in Phase F.6+ user testing:
 *   "i dont understand. why is it local team mode, this is so confusing"
 *
 * The COODRA_DEPLOYMENT env var still exists for the db.ts code
 * that needs to decide between "use local SQLite" (laptop) vs "use
 * cloud Postgres directly" (server). That's a real runtime decision
 * — but it's `isCloudHostedWeb()` now, not `resolveDeploymentMode`.
 *
 * Phase H will delete `resolveDeploymentMode` once every caller has
 * migrated to `resolveIdentityMode` or `isCloudHostedWeb`.
 */

/**
 * Phase G — the canonical two-mode identity model. Every user-facing
 * page / action / middleware path should call this. Branches on
 * `'solo' | 'team'` and treats laptop-vs-server as implementation
 * detail.
 *
 * Resolution order:
 *   1. `process.env.COODRA_MODE` — explicit env override (test +
 *      production deploys both set this).
 *   2. `~/.coodra/config.json::mode` — laptop default.
 *   3. `'solo'` — safe fallback when neither is set.
 */
export function resolveIdentityMode(): 'solo' | 'team' {
  const envMode = process.env.COODRA_MODE;
  if (envMode === 'team' || envMode === 'solo') return envMode;
  return resolveEffectiveMode();
}

/**
 * True iff this web process is a cloud deployment (no local
 * `~/.coodra`, data lives in cloud Postgres directly). Used by
 * `lib/db.ts` to pick the DB driver and by action-guards to refuse
 * laptop-only operations.
 *
 * Set `COODRA_DEPLOYMENT=team-hosted` in your Vercel / fly.io /
 * docker deployment env.
 */
export function isCloudHostedWeb(): boolean {
  return process.env.COODRA_DEPLOYMENT === 'team-hosted';
}

// ---------------------------------------------------------------------------
// LEGACY THREE-MODE API (deprecated; preserved for backward compat).
// Every existing call site continues to compile; Phase H removes these.
// ---------------------------------------------------------------------------

/** @deprecated Phase G — use `resolveIdentityMode` and `isCloudHostedWeb` separately. */
export type DeploymentMode = 'local-solo' | 'local-team' | 'team-hosted';

/**
 * @deprecated Phase G — use `resolveIdentityMode()` for solo-vs-team
 * branching and `isCloudHostedWeb()` for laptop-vs-server branching.
 *
 * Preserved so existing call sites compile without an in-flight
 * mass-refactor. Phase H deletes this.
 */
export function resolveDeploymentMode(): DeploymentMode {
  if (isCloudHostedWeb()) return 'team-hosted';
  return resolveIdentityMode() === 'team' ? 'local-team' : 'local-solo';
}

/** @deprecated Phase G — use `isCloudHostedWeb()` instead. */
export function isTeamHosted(): boolean {
  return isCloudHostedWeb();
}

/** @deprecated Phase G — use `!isCloudHostedWeb()` instead. */
export function isLocalIdentity(): boolean {
  return !isCloudHostedWeb();
}
