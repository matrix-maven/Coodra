import { listProjects } from '@coodra/db';

import { openLocalDb } from '../../lib/open-local-db.js';
import { scanProjectEnvForStaleMode } from '../../lib/project-env-scan.js';
import { readTeamConfig, readTeamHomeEnv } from '../../lib/team-config.js';

import type { Check } from '../types.js';

/**
 * Module 04 Phase 4 — doctor check 36 — team-config well-formed.
 *
 * Validates the team-mode config block in `~/.coodra/config.json`:
 *   - solo mode  → green ('not in team mode' is a valid state)
 *   - team mode + complete block → green
 *   - team mode + missing fields → yellow (the `readTeamConfig` reader
 *     downgrades partial blocks to solo silently; this check surfaces
 *     them as triage info)
 *   - COODRA_MODE=team but config says solo → yellow (config out of
 *     sync with env; team-mode services will start without the actor
 *     identity layer; rows will be unattributed)
 *
 * The reader is permissive on read; this check is the strict
 * counterpart that tells the operator when their config is suspect.
 */
export const teamConfigCheck: Check = {
  id: 36,
  name: 'team-config block well-formed (Module 04 Phase 4)',
  severity: 'green-or-yellow',
  async run(ctx) {
    const cfg = readTeamConfig({ homeOverride: ctx.coodraHome });
    const envMode = ctx.env.COODRA_MODE ?? 'solo';

    if (cfg.mode === 'solo') {
      if (envMode === 'team') {
        return {
          status: 'yellow',
          detail:
            'COODRA_MODE=team but ~/.coodra/config.json::team is missing or partial — services will start ' +
            'without the actor identity layer; cross-team-member attribution will be NULL',
          remediation:
            'Run `coodra team join --user-id <id> --org-id <id> --secret <hex> --database-url <url>` to write ' +
            'the team block, or `coodra team setup` if you are the org admin doing first-time bootstrap.',
        };
      }
      // Phase A — solo machine, but check for stale `COODRA_MODE=team`
      // (or any value) in project .env files. Neutralised by the
      // MACHINE_LEVEL_KEYS carve-out, but still misleading.
      const soloDrift = await scanProjectDrift(ctx.dataDb);
      const soloMisleading = soloDrift.filter((d) => d.staleModeValue !== 'solo');
      if (soloMisleading.length > 0) {
        const sample = soloMisleading
          .slice(0, 3)
          .map((p) => p.envPath)
          .join(', ');
        return {
          status: 'yellow',
          detail:
            `mode=solo but ${soloMisleading.length} project .env file(s) carry a non-solo COODRA_MODE line ` +
            `(${sample}${soloMisleading.length > 3 ? ', …' : ''}) — neutralised at runtime but misleading to read`,
          remediation: 'Run `coodra doctor --fix` to strip the stale lines. Idempotent.',
        };
      }
      return { status: 'green', detail: 'mode=solo (no team config required)' };
    }

    // Team mode — verify every required field is present + non-empty.
    const team = cfg.team;
    if (team === undefined) {
      return {
        status: 'yellow',
        detail: 'config mode=team but the team block was downgraded to solo by the reader (missing required fields)',
        remediation: 'Re-run `coodra team join` or `coodra team setup` to write a complete team block.',
      };
    }
    const missing: string[] = [];
    if (team.clerkUserId.length === 0) missing.push('clerkUserId');
    if (team.clerkOrgId.length === 0) missing.push('clerkOrgId');
    if (team.localHookSecret.length === 0) missing.push('localHookSecret');
    if (team.localHookSecret.length < 32) missing.push('localHookSecret (too short — must be ≥32 chars hex)');
    if (missing.length > 0) {
      return {
        status: 'yellow',
        detail: `team-config has weak fields: ${missing.join(', ')}`,
        remediation: 'Re-run `coodra team setup` to regenerate a fresh local hook secret + valid identity.',
      };
    }

    // Phase G+H — verify config.json and ~/.coodra/.env are in sync.
    // The daemons spawned by `coodra start` read from .env, so a
    // healthy config.json without matching .env entries means the next
    // `start` will run in solo mode (or crash sync-daemon for missing
    // DATABASE_URL). Surface this so the operator can re-run the
    // appropriate team command.
    const homeEnv = readTeamHomeEnv({ homeOverride: ctx.coodraHome });
    if (homeEnv === null) {
      return {
        status: 'yellow',
        detail:
          'config.json says team mode but ~/.coodra/.env is missing COODRA_MODE=team / DATABASE_URL / LOCAL_HOOK_SECRET — `coodra start` will run in solo mode',
        remediation:
          'Re-run `coodra team setup --database-url <url> --user-id <id> --org-id <id>` (admin) or `coodra team join …` (member) to refresh both config.json and .env in one step.',
      };
    }
    if (homeEnv.localHookSecret !== team.localHookSecret) {
      return {
        status: 'yellow',
        detail:
          'config.json::team.localHookSecret differs from ~/.coodra/.env::LOCAL_HOOK_SECRET — daemon-side stamping uses a different secret than the CLI thinks',
        remediation:
          'Re-run `coodra team setup` (admin) or `coodra team join` (member) to bring both in sync. Both writes happen in one command.',
      };
    }
    if (homeEnv.clerkOrgId !== team.clerkOrgId) {
      return {
        status: 'yellow',
        detail: 'config.json::team.clerkOrgId differs from ~/.coodra/.env::COODRA_TEAM_ORG_ID',
        remediation: 'Re-run `coodra team setup` / `team join` to align both files.',
      };
    }

    // Phase A (clarity-pass-plan, 2026-05-11) — scan every registered
    // project's `<cwd>/.env` for stale `COODRA_MODE` lines. These
    // were written by pre-Phase-A `coodra init` runs and survive
    // even after `team setup`. The `loadHomeEnv` MACHINE_LEVEL_KEYS
    // carve-out neutralises their runtime effect (home wins for
    // COODRA_MODE) but the line itself remains misleading
    // documentation — a developer reading the file thinks the project
    // is solo when the machine is actually team.
    const projectDrift = await scanProjectDrift(ctx.dataDb);
    if (projectDrift.length > 0) {
      const sample = projectDrift
        .slice(0, 3)
        .map((p) => p.envPath)
        .join(', ');
      return {
        status: 'yellow',
        detail:
          `team mode wired correctly, but ${projectDrift.length} project .env file(s) carry a stale COODRA_MODE line ` +
          `(${sample}${projectDrift.length > 3 ? ', …' : ''}) — neutralised at runtime by MACHINE_LEVEL_KEYS but ` +
          'misleading to read',
        remediation:
          'Run `coodra doctor --fix` to strip the stale lines. Idempotent — re-runs after the strip report "no drift".',
      };
    }

    return {
      status: 'green',
      detail: `team mode wired (user=${team.clerkUserId.slice(0, 12)}…, org=${team.clerkOrgId.slice(0, 12)}…, joined ${new Date(team.joinedAt).toISOString().slice(0, 10)}, env synced, no project .env drift)`,
    };
  },
};

/**
 * Open the local data.db and scan every registered project's
 * `<cwd>/.env` for a stale `COODRA_MODE=` line. Read-only — never
 * mutates files. Failures (DB missing, project rows without `cwd`)
 * gracefully degrade to "no drift found" so this check never goes red
 * for reasons unrelated to its intent.
 */
async function scanProjectDrift(
  dataDb: string,
): Promise<Array<{ cwd: string; envPath: string; staleModeValue: string }>> {
  let handle: Awaited<ReturnType<typeof openLocalDb>>;
  try {
    handle = await openLocalDb(dataDb);
  } catch {
    return [];
  }
  try {
    const projects = await listProjects(handle);
    const drift: Array<{ cwd: string; envPath: string; staleModeValue: string }> = [];
    for (const p of projects) {
      if (p.cwd === null) continue;
      const scan = scanProjectEnvForStaleMode(p.cwd);
      if (!scan.exists || scan.staleModeValue === null) continue;
      drift.push({ cwd: p.cwd, envPath: scan.envPath, staleModeValue: scan.staleModeValue });
    }
    return drift;
  } finally {
    handle.close();
  }
}
