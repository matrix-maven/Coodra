/**
 * `apps/web-v2/lib/team-config.ts` — server-only thin wrapper that reads
 * the local team config (`~/.coodra/config.json::team` block) so web
 * pages can branch on actual setup state instead of just env-var mode.
 *
 * The CLI package re-exports `readTeamConfig` via `@coodra/cli/lib/team-config`.
 * We isolate that import here so a single import-style mistake doesn't
 * scatter through pages.
 *
 * Why this is server-only: it reads the file system. The web app's
 * server components call it directly; client components must receive
 * the resolved snapshot as a prop.
 */

import 'server-only';

import { readTeamConfig as readTeamConfigCli, type TeamConfig } from '@coodra/cli/lib/team-config';

export type { TeamBlock, TeamConfig } from '@coodra/cli/lib/team-config';

export function readTeamConfig(): TeamConfig {
  return readTeamConfigCli();
}

/**
 * Resolve the effective machine mode for the web's deployment-mode
 * resolver.
 *
 * Phase A intent (clarity-pass-plan, 2026-05-11): `~/.coodra/config.json::
 * mode` is the SOLE authority for machine mode. Env vars are derived from
 * config.json by `coodra team init` / `team leave`, never the other
 * way around.
 *
 * Pre-fix the function gated on `process.env.COODRA_MODE === 'team'`
 * AND a complete team block in config.json. That broke a real user flow:
 * after `team init`, the daemons spawn with `COODRA_MODE=team` (from
 * `~/.coodra/.env`), but the Next.js dev server inherits the operator's
 * SHELL env which doesn't export that var. Result: machine flipped to
 * team, daemons running as team, but web stuck in solo mode showing the
 * pre-flip projects with a "SOLO WORKSPACE — click to upgrade" badge.
 *
 * Post-fix: read the config block directly. The presence of a complete
 * team block in `~/.coodra/config.json` is the only signal that
 * matters. If a user wants to force-override (rare — e.g. testing),
 * they can either edit the file or set `COODRA_DEPLOYMENT=team-hosted`
 * which the outer `resolveDeploymentMode` honors.
 */
export function resolveEffectiveMode(): 'solo' | 'team' {
  const cfg = readTeamConfigCli();
  return cfg.mode === 'team' && cfg.team !== undefined ? 'team' : 'solo';
}
