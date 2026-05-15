import { deleteToken, hasStoredToken, readVerifiedToken } from '@coodra/shared/auth';
import { EXIT_OK } from '../exit-codes.js';
import { resolveCoodraHome } from '../lib/coodra-home.js';
import { clearTeamHomeEnv, demoteToSoloConfig, readTeamConfig } from '../lib/team-config.js';
import { pc } from '../ui/index.js';

/**
 * `packages/cli/src/commands/logout.ts` — Phase G slice G.4.
 *
 * Symmetric to `login`. Tears down team-mode state on the local
 * machine and returns to solo:
 *
 *   1. Delete `~/.coodra/clerk-token.json` (idempotent).
 *   2. Demote `~/.coodra/config.json::mode` from `team` to `solo`,
 *      removing the team block.
 *   3. Strip the four team-mode env keys (COODRA_MODE, DATABASE_URL,
 *      LOCAL_HOOK_SECRET, COODRA_TEAM_ORG_ID) from `~/.coodra/.env`.
 *   4. Print confirmation.
 *
 * Idempotent: running `logout` when already in solo mode is a no-op
 * that prints "already logged out" and exits 0.
 *
 * Daemon restart is NOT done here — the next `coodra start` (or
 * the running daemons' next disk-read of clerk-token.json) picks up
 * the new state. Doing a hard restart on logout would surprise users
 * who run logout while Claude Code sessions are active; the
 * soft-failure path (MCP returns `auth_required` on the next tool
 * call) is intentional UX.
 *
 * Token revocation against Clerk: NOT done by default. Clerk session
 * revocation is a privileged admin operation; the typical "log out"
 * UX just clears local state. For a hard revoke, the user signs out
 * from the web Clerk UI separately. Phase G+1 may add `--revoke`.
 */

export interface LogoutOptions {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Force the operation even if no team state exists (currently a no-op flag — logout is already idempotent). */
  readonly force?: boolean;
}

export interface LogoutIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_LOGOUT_IO: LogoutIO = {
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
  exit: (code) => {
    process.exit(code);
  },
};

export async function runLogoutCommand(options: LogoutOptions = {}, io: LogoutIO = DEFAULT_LOGOUT_IO): Promise<never> {
  const home = resolveCoodraHome({
    ...(options.home !== undefined ? { override: options.home } : {}),
    env: options.env ?? process.env,
  });

  // 0. Read existing state for the confirmation message
  const existingConfig = readTeamConfig({ homeOverride: home });
  const hadToken = hasStoredToken({ homeOverride: home });

  // Best-effort identity capture — we'll print "logged out from <email>"
  // when we know who was authenticated.
  let identityHint: string | null = null;
  if (hadToken) {
    try {
      const claims = await readVerifiedToken({ homeOverride: home });
      if (claims !== null) {
        identityHint = claims.email ?? claims.userId;
      }
    } catch {
      // ignore — token may be expired, that's fine for logout
    }
  }

  // If we're already in solo + no token, this is a no-op.
  if (existingConfig.mode === 'solo' && !hadToken) {
    io.writeStdout(`${pc.gray('Already logged out — mode is solo.')}\n`);
    return io.exit(EXIT_OK);
  }

  // 1. Delete the token (idempotent — no-op when missing)
  try {
    deleteToken({ homeOverride: home });
  } catch (err) {
    io.writeStderr(`${pc.yellow('warn:')} could not delete clerk-token.json: ${(err as Error).message}\n`);
    // Continue — the config/env cleanup below is still useful.
  }

  // 2. Demote config.json: mode='solo', team block removed
  try {
    demoteToSoloConfig({ homeOverride: home });
  } catch (err) {
    io.writeStderr(`${pc.red('coodra logout:')} could not update config.json: ${(err as Error).message}\n`);
    // This is recoverable — user can manually edit config.json. Don't fail hard.
  }

  // 3. Strip the four team env keys from .env
  try {
    clearTeamHomeEnv({ homeOverride: home });
  } catch (err) {
    io.writeStderr(`${pc.yellow('warn:')} could not strip team env keys from .env: ${(err as Error).message}\n`);
  }

  // 4. Confirmation
  const subject = identityHint !== null ? ` as ${pc.cyan(identityHint)}` : '';
  io.writeStdout(
    `${pc.green('✓')} Logged out${subject}.\n` +
      `  Local state reset: mode=solo, clerk-token.json deleted, team env keys cleared.\n` +
      `  If daemons are running, they'll switch to solo on the next operation. Restart with \`coodra stop && coodra start\` for a clean handoff.\n`,
  );

  return io.exit(EXIT_OK);
}
