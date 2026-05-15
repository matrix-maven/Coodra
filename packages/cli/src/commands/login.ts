import { randomBytes } from 'node:crypto';

import { readVerifiedToken, writeToken } from '@coodra/shared/auth';
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { BrowserHandoffError, openBrowser, startLoopbackListener } from '../lib/browser-handoff.js';
import { resolveCoodraHome } from '../lib/coodra-home.js';
import { loadHomeEnv } from '../lib/load-home-env.js';
import { readTeamConfig, upgradeToTeamConfig, writeTeamHomeEnv } from '../lib/team-config.js';
import { pc } from '../ui/index.js';

/**
 * `packages/cli/src/commands/login.ts` — Phase G slice G.3.
 *
 * The canonical "log into team mode" surface. Replaces the trust-based
 * `team install` flow with a Clerk-verified browser handoff.
 *
 * Flow:
 *
 *   1. Read `~/.coodra/.env` for web URL + DATABASE_URL + LOCAL_HOOK_SECRET.
 *      These must already be set by `team init` (admin) or `team join`
 *      (member). `login` only refreshes the auth token; it doesn't
 *      bootstrap the env. If env is missing, prints what to do and exits
 *      with a recoverable code.
 *
 *   2. Generate a random `state` token (32 bytes, base64url, 43 chars).
 *
 *   3. Start a loopback HTTP listener on a random port in [50000..65000].
 *
 *   4. Open the browser to `<webUrl>/auth/cli-login?port=<port>&state=<state>`.
 *
 *   5. Wait up to 5 minutes for the listener's `tokenPromise` to resolve
 *      with the JWT.
 *
 *   6. Call `writeToken(jwt, webUrl)` from shared — this verifies the
 *      JWT signature + claims and writes `~/.coodra/clerk-token.json`
 *      with mode 0600.
 *
 *   7. Update `~/.coodra/config.json::mode = 'team'` and the legacy
 *      team-block fields (derived from the verified JWT claims) for
 *      backward compat with daemons that still read config.json.
 *
 *   8. Print a one-line confirmation. The user runs `coodra start`
 *      (or it's already running and picks up the new token on next
 *      operation).
 *
 * The flow is idempotent: if a valid token already exists, the user
 * still gets a fresh one. To skip the round-trip when a token is
 * already valid, run `coodra status` first.
 *
 * Edge cases handled:
 *   - .env missing (no team setup yet) → recoverable exit + help text
 *   - browser open failure → print URL and ask user to paste
 *   - timeout (browser closed before auth) → recoverable exit
 *   - JWT verification fails → propagate to user with remediation
 *   - state mismatch → recoverable; advise re-run
 */

const STATE_BYTES = 32;
const TIMEOUT_MS = 5 * 60 * 1000;

export interface LoginOptions {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Override the resolved web URL. */
  readonly webUrl?: string;
  /**
   * Skip opening the browser; print the URL instead. Useful for headless
   * shells / SSH sessions where the browser is on a different machine.
   * (After the user opens the URL on their browser machine and completes
   * sign-in, the browser will redirect to 127.0.0.1:<port> on the laptop
   * where the URL was originally received. So this mode only works
   * if user-and-CLI are on the same machine; if not, point them at
   * the docs.)
   */
  readonly noOpen?: boolean;
  /** Override timeout. Default 5 minutes. */
  readonly timeoutMs?: number;
}

export interface LoginIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_LOGIN_IO: LoginIO = {
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

export async function runLoginCommand(options: LoginOptions = {}, io: LoginIO = DEFAULT_LOGIN_IO): Promise<never> {
  const home = resolveCoodraHome({
    ...(options.home !== undefined ? { override: options.home } : {}),
    env: options.env ?? process.env,
  });

  // 1. Resolve env (we need at minimum CLERK_* for verification + the
  //    web URL for the handoff).
  const homeEnv = loadHomeEnv(home);
  const env: NodeJS.ProcessEnv = { ...homeEnv, ...(options.env ?? process.env) };

  const webUrl = options.webUrl ?? env.COODRA_WEB_URL ?? 'http://localhost:3001';
  const clerkSecret = env.CLERK_SECRET_KEY;
  const clerkPubKey = env.CLERK_PUBLISHABLE_KEY;
  const databaseUrl = env.DATABASE_URL;
  const localHookSecret = env.LOCAL_HOOK_SECRET;

  if (
    typeof clerkSecret !== 'string' ||
    clerkSecret.length === 0 ||
    clerkSecret === 'sk_test_replace_me' ||
    typeof clerkPubKey !== 'string' ||
    clerkPubKey.length === 0
  ) {
    io.writeStderr(
      `${pc.red('coodra login')}: Clerk env is not configured on this machine.\n` +
        `\n` +
        `  Required:\n` +
        `    CLERK_SECRET_KEY (sk_test_… or sk_live_…)\n` +
        `    CLERK_PUBLISHABLE_KEY (pk_test_… or pk_live_…)\n` +
        `\n` +
        `  These must be set in ${home}/.env before \`coodra login\` is meaningful.\n` +
        `  If you're a team admin setting up for the first time, run \`coodra team init\` instead.\n` +
        `  If you're a teammate, accept an invite via \`coodra team join <invite-url>\`.\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  // DATABASE_URL + LOCAL_HOOK_SECRET aren't strictly needed for the auth
  // round-trip itself, but we surface a clear warning if they're missing
  // so the user knows their daemons won't actually be able to do team-mode
  // work after the login completes.
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    io.writeStderr(
      `${pc.yellow('warn:')} DATABASE_URL is not set in ${home}/.env. ` +
        `After login completes, team-mode sync will not work. Run \`coodra team init\` (admin) or \`coodra team join <invite>\` (member) to bootstrap full team config.\n`,
    );
  }
  if (typeof localHookSecret !== 'string' || localHookSecret.length === 0) {
    io.writeStderr(
      `${pc.yellow('warn:')} LOCAL_HOOK_SECRET is not set in ${home}/.env. Hook calls between Claude Code and the bridge will not authenticate.\n`,
    );
  }

  // 2. Generate state + start listener
  const state = randomBytes(STATE_BYTES).toString('base64url');
  io.writeStdout(`${pc.gray(`coodra login → opening browser at ${webUrl}…`)}\n`);

  let listener;
  try {
    listener = await startLoopbackListener({
      expectedState: state,
      timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    });
  } catch (err) {
    io.writeStderr(`${pc.red('coodra login:')} could not start local listener: ${(err as Error).message}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  const loginUrl = `${webUrl.replace(/\/$/, '')}/auth/cli-login?port=${listener.port}&state=${state}`;

  // 3. Open browser (or print URL)
  if (options.noOpen === true) {
    io.writeStdout(`${pc.cyan('Open this URL in your browser:')}\n  ${loginUrl}\n`);
  } else {
    const opened = openBrowser(loginUrl);
    if (!opened) {
      io.writeStdout(`${pc.yellow('Could not open browser automatically.')} Open this URL manually:\n  ${loginUrl}\n`);
    } else {
      io.writeStdout(`${pc.gray('Waiting for sign-in to complete (5 min timeout)…')}\n`);
    }
  }

  // 4. Await token
  let token: string;
  try {
    token = await listener.tokenPromise;
  } catch (err) {
    if (err instanceof BrowserHandoffError) {
      io.writeStderr(`${pc.red('coodra login:')} ${err.message}\n`);
      if (err.code === 'timeout') {
        io.writeStderr(`  Re-run \`coodra login\` and complete sign-in in the browser within 5 minutes.\n`);
      } else if (err.code === 'state_mismatch') {
        io.writeStderr(
          `  This usually means a stale browser tab redirected to your listener. Re-run \`coodra login\`.\n`,
        );
      }
      return io.exit(EXIT_USER_RECOVERABLE);
    }
    throw err;
  }

  // 5. Verify + persist token
  let claims;
  try {
    claims = await writeToken(token, webUrl, { homeOverride: home });
  } catch (err) {
    io.writeStderr(
      `${pc.red('coodra login:')} captured token failed verification: ${(err as Error).message}\n` +
        `  This usually means the Clerk JWT template 'coodra_cli' is not yet configured. ` +
        `Create it in Clerk dashboard → Configure → JWT Templates with token lifetime 86400 (24h) and include org_id + org_role + email claims.\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  // 6. Update config.json (mode → team + legacy fields from verified claims)
  //    Phase G keeps the legacy clerkUserId/clerkOrgId fields populated
  //    for backward compat with daemons that still read config.json.
  //    Those values are now sourced from the verified JWT (not user
  //    input), so they remain trustworthy. Phase H removes them entirely.
  const existingTeam = readTeamConfig({ homeOverride: home });
  const joinedAt = existingTeam.team?.joinedAt ?? Date.now();
  upgradeToTeamConfig(
    {
      clerkUserId: claims.userId,
      clerkOrgId: claims.orgId,
      ...(existingTeam.team?.clerkOrgSlug !== undefined ? { clerkOrgSlug: existingTeam.team.clerkOrgSlug } : {}),
      localHookSecret: localHookSecret ?? '',
      joinedAt,
      ...(existingTeam.team?.lastPulledAt !== undefined ? { lastPulledAt: existingTeam.team.lastPulledAt } : {}),
    },
    { homeOverride: home },
  );

  // 7. Idempotent re-write of .env so COODRA_MODE=team etc. survive
  //    a future stale-config recovery. Only do this if we have the env
  //    values to write — first-login on a teammate machine that came
  //    via `team join` will have already done this.
  if (
    typeof databaseUrl === 'string' &&
    databaseUrl.length > 0 &&
    typeof localHookSecret === 'string' &&
    localHookSecret.length > 0
  ) {
    writeTeamHomeEnv(
      {
        databaseUrl,
        localHookSecret,
        clerkOrgId: claims.orgId,
      },
      { homeOverride: home },
    );
  }

  // 8. Confirmation
  io.writeStdout(
    `\n${pc.green('✓')} Signed in as ${pc.cyan(claims.email ?? claims.userId)} (${pc.gray(claims.role)})\n` +
      `  Org: ${pc.gray(claims.orgId)}\n` +
      `  Token expires: ${pc.gray(claims.expiresAt.toISOString())}\n` +
      `  Run \`coodra start\` to bring daemons up (or restart if already running).\n`,
  );

  return io.exit(EXIT_OK);
}

/**
 * Re-export for `team login` backward-compat (the existing TeamLoginOptions
 * surface). Maps to `runLoginCommand`. Subcommands `--token` / `--server`
 * options are ignored (Phase G removes those — the flow no longer takes
 * a token as input; it captures one via browser).
 */
export async function runLoginCommandAsTeamLogin(
  _legacy: Record<string, unknown> = {},
  io: LoginIO = DEFAULT_LOGIN_IO,
): Promise<never> {
  return runLoginCommand({}, io);
}

/**
 * Best-effort "are we already logged in?" check, used by `status` and
 * the `00-full-flow.sh` functional test. Returns the verified claims
 * or null. Never throws.
 */
export async function getActiveLogin(
  home?: string,
): Promise<{ userId: string; orgId: string; role: string; email: string | null } | null> {
  try {
    const claims = await readVerifiedToken({ ...(home !== undefined ? { homeOverride: home } : {}) });
    if (claims === null) return null;
    return { userId: claims.userId, orgId: claims.orgId, role: claims.role, email: claims.email };
  } catch {
    return null;
  }
}
