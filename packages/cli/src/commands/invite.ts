import { readVerifiedToken } from '@coodra/shared/auth';
import { EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveCoodraHome } from '../lib/coodra-home.js';
import { type InviteRole, InviteSecretMissingError, mintInviteFromCli } from '../lib/invite-mint.js';
import { loadHomeEnv } from '../lib/load-home-env.js';
import { readTeamConfig, readTeamHomeEnv } from '../lib/team-config.js';
import { pc } from '../ui/index.js';

/**
 * `packages/cli/src/commands/invite.ts` — Phase H.5.
 *
 * Top-level `coodra invite <email>` command. The admin's one-command
 * shortcut to mint a fresh team invite without leaving the terminal.
 *
 * Replaces (or supplements) the `/settings/team` web UI flow. Same wire
 * format, same DB row, same `/install/<token>` URL shape — so an invite
 * minted by the CLI is identical to one minted by the web (and vice
 * versa).
 *
 * Flow:
 *   1. Refuse if not in team mode. Print a tailored message pointing
 *      at `coodra team init`.
 *   2. Refuse if no verified Clerk JWT (Phase G's verified-identity
 *      guard). The legacy config.json::team.clerkUserId is forgeable;
 *      we will not stamp `invited_by_user_id` from a forgeable source.
 *   3. Read DATABASE_URL + COODRA_INVITE_HMAC_SECRET from ~/.coodra/.env.
 *   4. Mint signed token + INSERT cloud row.
 *   5. Print a single shareable URL the admin can paste into Slack /
 *      email / wherever. ONE link. No second Clerk email.
 *
 * Why this matters for Phase H: Test 3 of the acceptance gate says
 *   "coodra invite jane@example.com" must mint a single shareable
 *   URL. The pre-Phase-H path required the admin to either (a) open
 *   /settings/team in a browser, or (b) call a Clerk Backend API call
 *   manually. Both of those are sharp edges the seamless target removes.
 */

export interface InviteOptions {
  /** Role to grant. Defaults to 'member'. */
  readonly role?: string;
  /** Override 7-day default expiry. */
  readonly expiresInDays?: number;
  /** Override `COODRA_PUBLIC_URL` env resolution. */
  readonly webUrl?: string;
  /** Override home (tests). */
  readonly home?: string;
  /** Override process.env (tests). */
  readonly env?: NodeJS.ProcessEnv;
}

export interface InviteIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_INVITE_IO: InviteIO = {
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

const VALID_ROLES: ReadonlySet<string> = new Set(['admin', 'member', 'viewer']);

function isValidEmail(s: string): boolean {
  // Permissive — the cloud DB INSERT will catch shape failures via the
  // Clerk Backend API at redemption time. We just reject obviously-bad
  // input here so the admin gets a fast error.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export async function runInviteCommand(
  rawEmail: string,
  options: InviteOptions = {},
  io: InviteIO = DEFAULT_INVITE_IO,
): Promise<never> {
  const email = rawEmail.trim();
  if (email.length === 0 || !isValidEmail(email)) {
    io.writeStderr(
      `${pc.red('coodra invite')}: invalid email "${rawEmail}". Expected a shape like name@domain.tld.\n`,
    );
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }

  const role: InviteRole = (options.role ?? 'member') as InviteRole;
  if (!VALID_ROLES.has(role)) {
    io.writeStderr(
      `${pc.red('coodra invite')}: invalid role "${options.role}". Expected one of: admin, member, viewer.\n`,
    );
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }

  const home = resolveCoodraHome({
    ...(options.home !== undefined ? { override: options.home } : {}),
    env: options.env ?? process.env,
  });

  // Refuse in solo mode.
  const teamCfg = readTeamConfig({ homeOverride: home });
  if (teamCfg.mode !== 'team') {
    io.writeStderr(
      `${pc.red('coodra invite')}: this machine is in solo mode. Run \`coodra team init\` first to set up a team.\n`,
    );
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }

  // Layer ~/.coodra/.env into process.env so DATABASE_URL is visible
  // even when this CLI was spawned without inheriting it.
  const layered = loadHomeEnv(home, process.cwd());
  for (const [key, value] of Object.entries(layered)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  // Phase G — verified Clerk JWT is the source of truth for the
  // invited_by_user_id stamp. The legacy config.json::team.clerkUserId
  // is forgeable; we refuse to use it.
  const verified = await readVerifiedToken({ homeOverride: home });
  if (verified === null) {
    io.writeStderr(
      `${pc.red('coodra invite')}: no verified Clerk session. Run \`coodra login\` first (or your existing token may have expired).\n`,
    );
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }
  // Role enforcement is the cloud's job; the web's mintInviteAction
  // checks `assertActorRole('admin')`. The CLI mirrors the same check
  // against the verified JWT mirror's role claim. Phase G normalizes
  // Clerk's `org:admin`/`org:member`/`org:viewer` strings to the
  // internal Role type so the comparison is plain.
  if (verified.role !== 'admin') {
    io.writeStderr(
      `${pc.red('coodra invite')}: only org admins can mint invites. Your verified role is "${verified.role}".\n`,
    );
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }

  // Resolve env essentials. team-config provides databaseUrl + localHookSecret + clerkOrgId.
  const envBlock = readTeamHomeEnv({ homeOverride: home });
  if (envBlock === null) {
    io.writeStderr(
      `${pc.red('coodra invite')}: ~/.coodra/.env is missing or incomplete. Re-run \`coodra team init\` to repair it.\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  // Resolve baseUrl. Precedence: --web-url > COODRA_PUBLIC_URL env >
  // COODRA_WEB_URL env > http://localhost:3001 default.
  const procEnv = options.env ?? process.env;
  const baseUrl = (
    options.webUrl ??
    procEnv.COODRA_PUBLIC_URL ??
    procEnv.COODRA_WEB_URL ??
    'http://localhost:3001'
  ).replace(/\/$/, '');

  io.writeStdout(pc.gray(`Minting invite for ${pc.cyan(email)} (role=${role}) …\n`));

  let result;
  try {
    result = await mintInviteFromCli({
      databaseUrl: envBlock.databaseUrl,
      orgId: envBlock.clerkOrgId,
      email,
      role,
      invitedByUserId: verified.userId,
      baseUrl,
      ...(options.expiresInDays !== undefined ? { expiresInDays: options.expiresInDays } : {}),
      homeOverride: home,
    });
  } catch (err) {
    if (err instanceof InviteSecretMissingError) {
      io.writeStderr(`${pc.red('coodra invite')}: ${err.message}\n`);
      return io.exit(EXIT_USER_ACTION_REQUIRED);
    }
    io.writeStderr(`${pc.red('coodra invite')}: mint failed — ${(err as Error).message}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  io.writeStdout(
    `\n${pc.green('✓')} Invite minted for ${pc.cyan(result.email)} (role=${result.role}, expires ${result.expiresAt.toISOString().slice(0, 10)})\n` +
      `\n  Send them this link:\n` +
      `    ${pc.cyan(result.inviteUrl)}\n` +
      `\n  The URL includes everything they need — no separate Clerk email to accept first.\n` +
      `  Single-use; running the installer or signing in via the browser consumes it.\n`,
  );
  return io.exit(EXIT_OK);
}
