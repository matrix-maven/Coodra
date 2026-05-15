import { EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { upgradeToTeamConfig, writeTeamHomeEnv } from '../lib/team-config.js';
import { pc } from '../ui/index.js';

import type { TeamCommandIO } from './team.js';
import { DEFAULT_TEAM_IO } from './team.js';

/**
 * `packages/cli/src/commands/team-install.ts` — Module 04 Phase 2.
 *
 * `coodra team install --bootstrap-url <URL>` — teammate-side
 * counterpart to `team setup`.
 *
 * Where `team setup` is the admin minting a new team, `team install`
 * is the teammate joining an existing team via a one-click signed
 * invite. It:
 *
 *   1. POSTs to the bootstrap URL (`/api/install/[token]` on the
 *      admin's deployed web).
 *   2. Receives a JSON bundle: { userId, orgId, orgSlug?, databaseUrl,
 *      localHookSecret, cloudApiBaseUrl, role, invitedEmail }.
 *   3. Writes `~/.coodra/config.json::team` with the identity +
 *      hook secret.
 *   4. Writes `~/.coodra/.env` with the env vars `coodra start`
 *      spawns daemons against.
 *   5. Prints the next-step ("run `coodra init` in your project").
 *
 * The signed token lives in the bootstrap URL itself. The server side
 * verifies the signature, expiry, single-use jti, AND the redeemer's
 * Clerk session matches the invited email — so this command will fail
 * cleanly if the user runs it without first signing into the deployment's
 * Clerk app via a browser (the cookie isn't on this machine).
 *
 * That's by design: a leaked invite URL alone can't be redeemed without
 * a matching Clerk session, per caveat B of the Phase 2 design.
 *
 * If the server returns a non-2xx with our standard `{ok:false, error, howToFix}`
 * shape, we surface `howToFix` to the user and exit with a non-zero code.
 */

export interface TeamInstallOptions {
  readonly bootstrapUrl?: string;
  readonly json?: boolean;
}

interface InstallBundle {
  readonly ok: true;
  readonly userId: string;
  readonly orgId: string;
  readonly orgSlug: string | null;
  readonly databaseUrl: string;
  readonly localHookSecret: string;
  readonly cloudApiBaseUrl: string;
  readonly role: 'admin' | 'member' | 'viewer';
  readonly invitedEmail: string;
}

interface InstallErrorShape {
  readonly ok: false;
  readonly error: string;
  readonly howToFix: string;
}

function isInstallBundle(x: unknown): x is InstallBundle {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o.ok === true &&
    typeof o.userId === 'string' &&
    typeof o.orgId === 'string' &&
    typeof o.databaseUrl === 'string' &&
    typeof o.localHookSecret === 'string' &&
    typeof o.cloudApiBaseUrl === 'string' &&
    typeof o.role === 'string' &&
    typeof o.invitedEmail === 'string'
  );
}

function isInstallError(x: unknown): x is InstallErrorShape {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return o.ok === false && typeof o.error === 'string' && typeof o.howToFix === 'string';
}

/**
 * Strip any user-visible signed-token segment off a URL before logging,
 * so a teammate's terminal scrollback / shell history doesn't expose the
 * redeemable token to anyone reading the screen.
 *
 * Token format: `<base64url payload>.<base64url sig>`. Replace it with a
 * short prefix + `…`.
 */
function maskBootstrapUrl(url: string): string {
  return url.replace(/(\/install\/)([^/?#]{12})[^/?#]+/, '$1$2…');
}

export async function runTeamInstallCommand(
  options: TeamInstallOptions = {},
  io: TeamCommandIO = DEFAULT_TEAM_IO,
): Promise<never> {
  const bootstrapUrl = options.bootstrapUrl ?? process.env.COODRA_BOOTSTRAP_URL;
  if (typeof bootstrapUrl !== 'string' || bootstrapUrl.length === 0) {
    io.writeStderr(
      `${pc.red('coodra team install')}: missing --bootstrap-url (or COODRA_BOOTSTRAP_URL).\n` +
        '  This URL is the `/api/install/<token>` endpoint your team admin shared with you. Open the invite\n' +
        '  email or the /install/<token> landing page to copy it.\n',
    );
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }

  // Light URL shape sanity-check. Doesn't enforce a host — local-dev
  // installs against http://localhost should still work.
  if (!/^https?:\/\//i.test(bootstrapUrl)) {
    io.writeStderr(
      `${pc.red('coodra team install')}: --bootstrap-url must be a full http(s) URL, got "${bootstrapUrl}".\n`,
    );
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }

  io.writeStdout(pc.cyan(`coodra team install — redeeming invite at ${maskBootstrapUrl(bootstrapUrl)}\n`));

  let response: Response;
  try {
    response = await fetch(bootstrapUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({}),
    });
  } catch (err) {
    io.writeStderr(
      `${pc.red('install failed')}: could not reach ${bootstrapUrl} — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    io.writeStderr(
      pc.yellow(
        '  hint: confirm the deployment URL is correct and reachable from this machine, and that the link\n' +
          '  has not expired. Ask the admin to mint a fresh invite from /settings/team if needed.\n',
      ),
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    io.writeStderr(
      `${pc.red('install failed')}: server responded HTTP ${response.status} with non-JSON body — ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  if (!response.ok) {
    if (isInstallError(body)) {
      io.writeStderr(
        `${pc.red('install failed')}: server rejected (${response.status} ${body.error})\n` +
          `  ${pc.yellow(body.howToFix)}\n`,
      );
      // user_not_in_clerk / user_not_in_org → user-actionable (click the
      // Clerk invitation email first). schema_not_migrated / already_redeemed
      // / revoked → admin-actionable. expired → admin-actionable. Either
      // way, user_action_required is the right exit hint.
      return io.exit(EXIT_USER_ACTION_REQUIRED);
    }
    io.writeStderr(`${pc.red('install failed')}: server returned HTTP ${response.status} (no structured error)\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  if (!isInstallBundle(body)) {
    io.writeStderr(
      `${pc.red('install failed')}: server returned 200 but the bundle shape is wrong. Refusing to write a ` +
        `partial config. Raw body: ${JSON.stringify(body).slice(0, 200)}…\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  const bundle: InstallBundle = body;
  io.writeStdout(pc.green('  ✓ invite redeemed — bundle received\n'));

  // Write ~/.coodra/config.json (team block).
  try {
    upgradeToTeamConfig({
      clerkUserId: bundle.userId,
      clerkOrgId: bundle.orgId,
      ...(bundle.orgSlug !== null ? { clerkOrgSlug: bundle.orgSlug } : {}),
      localHookSecret: bundle.localHookSecret,
      joinedAt: Date.now(),
    });
  } catch (err) {
    io.writeStderr(
      `${pc.red('install failed')}: writing ~/.coodra/config.json threw — ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  io.writeStdout(pc.green('  ✓ ~/.coodra/config.json promoted to team mode\n'));

  // Write ~/.coodra/.env so daemons spawned by `coodra start` see
  // the right env. Mirrors what `team setup` does for admins.
  try {
    writeTeamHomeEnv({
      databaseUrl: bundle.databaseUrl,
      localHookSecret: bundle.localHookSecret,
      clerkOrgId: bundle.orgId,
    });
  } catch (err) {
    io.writeStderr(
      `${pc.red('install failed')}: writing ~/.coodra/.env threw — ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  io.writeStdout(pc.green('  ✓ ~/.coodra/.env updated (COODRA_MODE=team, DATABASE_URL, LOCAL_HOOK_SECRET)\n'));

  if (options.json === true) {
    io.writeStdout(
      `${JSON.stringify(
        {
          ok: true,
          userId: bundle.userId,
          orgId: bundle.orgId,
          orgSlug: bundle.orgSlug,
          role: bundle.role,
          invitedEmail: bundle.invitedEmail,
          cloudApiBaseUrl: bundle.cloudApiBaseUrl,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.writeStdout(
      `\n${pc.cyan('Welcome to the team.')}\n` +
        `  email · ${bundle.invitedEmail}\n` +
        `  org   · ${bundle.orgSlug ?? bundle.orgId}\n` +
        `  role  · ${bundle.role}\n\n` +
        `${pc.bold('Next steps')}\n` +
        `  1. ${pc.cyan('cd <your-project-repo>')}\n` +
        `  2. ${pc.cyan('coodra init')}\n` +
        `  3. ${pc.cyan('coodra start')}\n\n`,
    );
  }

  return io.exit(EXIT_OK);
}
