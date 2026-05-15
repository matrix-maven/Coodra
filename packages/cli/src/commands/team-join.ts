import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeToken } from '@coodra/shared/auth';
import { EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { BrowserHandoffError, openBrowser, startLoopbackListener } from '../lib/browser-handoff.js';
import { resolveCoodraHome } from '../lib/coodra-home.js';
import { upgradeToTeamConfig, writeTeamHomeEnv } from '../lib/team-config.js';
import { pc } from '../ui/index.js';

/**
 * `packages/cli/src/commands/team-join.ts` — Phase G slice G.5.
 *
 * Canonical teammate onboarding command:
 *
 *     coodra team join <invite-url>
 *
 * Where `<invite-url>` is the URL the admin pasted to the teammate
 * (something like `http://team.example.com/install/<token>` or the
 * raw `<token>`).
 *
 * The flow:
 *
 *   1. Parse the URL → derive `<baseUrl>` and `<token>`.
 *   2. Start the loopback HTTP listener for the cli-login handoff.
 *   3. Open the browser to `<baseUrl>/auth/cli-login?invite=<token>&port=N&state=S`.
 *      The cli-login page:
 *        - Requires Clerk sign-in (signs up if user is brand-new)
 *        - Enforces invite-email match (returns invite_email_mismatch
 *          error page if the signed-in user's email doesn't match the
 *          invite)
 *        - Mints the long-lived JWT and redirects to `127.0.0.1:N`
 *   4. CLI captures the JWT.
 *   5. CLI POSTs to `<baseUrl>/api/install/<token>` to redeem the invite
 *      (single-use) and fetch the install bundle (DATABASE_URL,
 *      LOCAL_HOOK_SECRET, CLERK_PUBLISHABLE_KEY, etc.).
 *   6. CLI writes:
 *        - `~/.coodra/config.json` (mode=team, team block from bundle)
 *        - `~/.coodra/.env` (DATABASE_URL, LOCAL_HOOK_SECRET, CLERK_PUBLISHABLE_KEY)
 *        - `~/.coodra/clerk-token.json` (verified JWT, mode 0600)
 *   7. Prints next-step (run `coodra start` or `coodra init` in a project).
 *
 * Why this replaces `team install --bootstrap-url`:
 *   - The legacy flow had no proof the redeemer was actually the
 *     invited person — it just looked up the user by the invite's
 *     email via Clerk Backend API. An attacker with the URL could
 *     trigger redemption as long as a Clerk user with that email
 *     existed.
 *   - This flow requires the redeemer to sign into Clerk in their
 *     browser AND match the invite email — proof of identity, not
 *     just proof of URL possession.
 *
 * Idempotency: the invite token is single-use (jti). Running `team
 * join` twice with the same URL fails the second time with
 * `already_redeemed`. The first call's writes are durable.
 *
 * Order of operations:
 *   - Login flow first → captures JWT proving identity.
 *   - Bundle fetch second → atomically burns the invite + delivers env.
 *   - Local writes third → all-or-nothing through the upgrade helpers
 *     (which use atomic rename).
 */

const STATE_BYTES = 32;
const TIMEOUT_MS = 5 * 60 * 1000;

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
  readonly clerkPublishableKey: string | null;
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

export interface TeamJoinInviteOptions {
  readonly inviteUrl?: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Skip opening the browser; print the URL instead. */
  readonly noOpen?: boolean;
  /** Override browser-handoff timeout (default 5 min). */
  readonly timeoutMs?: number;
}

export interface TeamJoinInviteIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_TEAM_JOIN_INVITE_IO: TeamJoinInviteIO = {
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

/**
 * Parse `<invite-url>` into `{ baseUrl, token }`. Accepts:
 *   - Full URL: `https://team.example.com/install/<token>`
 *   - With `/api/install/<token>` (legacy bootstrap URL): same parse
 *   - With `/auth/cli-login?invite=<token>`: less common but ok
 *   - Bare token: returns `{ baseUrl: '', token }` and caller fills baseUrl
 */
function parseInviteUrl(input: string): { baseUrl: string; token: string } | { error: string } {
  const trimmed = input.trim();
  // Bare token (no scheme, no slash) — heuristic
  if (!/^https?:/i.test(trimmed)) {
    // If the input looks like a bare base64url-style token (no slash, no
    // ?, only base64url chars + a dot), treat it as such. Otherwise bail.
    if (/^[A-Za-z0-9_.-]+$/.test(trimmed) && trimmed.includes('.')) {
      return { baseUrl: '', token: trimmed };
    }
    return { error: `Invalid invite — expected an https URL or a bare token. Got: ${trimmed.slice(0, 40)}…` };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: `Invalid URL: ${trimmed}` };
  }
  // Extract token from /install/<token>, /api/install/<token>, or ?invite=<token>
  const m = parsed.pathname.match(/^(?:\/api)?\/install\/([^/]+)/);
  if (m !== null) {
    return { baseUrl: `${parsed.protocol}//${parsed.host}`, token: m[1] as string };
  }
  const inviteParam = parsed.searchParams.get('invite');
  if (inviteParam !== null && inviteParam.length > 0) {
    return { baseUrl: `${parsed.protocol}//${parsed.host}`, token: inviteParam };
  }
  return { error: `Could not extract token from URL: ${parsed.pathname}` };
}

export async function runTeamJoinInviteCommand(
  options: TeamJoinInviteOptions = {},
  io: TeamJoinInviteIO = DEFAULT_TEAM_JOIN_INVITE_IO,
): Promise<never> {
  const inviteUrl = options.inviteUrl?.trim();
  if (inviteUrl === undefined || inviteUrl.length === 0) {
    io.writeStderr(
      `${pc.red('coodra team join')}: missing invite URL.\n` +
        `\n` +
        `  Usage: coodra team join <invite-url>\n` +
        `\n` +
        `  The admin should have shared a URL like:\n` +
        `    https://team.example.com/install/<token>\n` +
        `\n` +
        `  Open the invite email (sent by Clerk) and the /install/<token> page in your browser to confirm the invite is active, then run \`team join\` with the URL.\n`,
    );
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }

  const parsed = parseInviteUrl(inviteUrl);
  if ('error' in parsed) {
    io.writeStderr(`${pc.red('coodra team join')}: ${parsed.error}\n`);
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }
  let { baseUrl, token } = parsed;
  if (baseUrl.length === 0) {
    // Bare token mode — require explicit --web-url via env
    const envWebUrl = (options.env ?? process.env).COODRA_WEB_URL;
    if (typeof envWebUrl !== 'string' || envWebUrl.length === 0) {
      io.writeStderr(
        `${pc.red('coodra team join')}: bare-token input requires COODRA_WEB_URL to be set, OR pass the full https URL.\n`,
      );
      return io.exit(EXIT_USER_ACTION_REQUIRED);
    }
    baseUrl = envWebUrl.replace(/\/$/, '');
  }

  const home = resolveCoodraHome({
    ...(options.home !== undefined ? { override: options.home } : {}),
    env: options.env ?? process.env,
  });

  io.writeStdout(pc.cyan(`coodra team join — base=${baseUrl} token=${token.slice(0, 16)}…\n`));

  // Generate state, start loopback listener
  const { randomBytes } = await import('node:crypto');
  const state = randomBytes(STATE_BYTES).toString('base64url');
  let listener;
  try {
    listener = await startLoopbackListener({
      expectedState: state,
      timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    });
  } catch (err) {
    io.writeStderr(`${pc.red('coodra team join')}: could not start local listener: ${(err as Error).message}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  // Open browser at cli-login with the invite token
  const cliLoginUrl = `${baseUrl}/auth/cli-login?port=${listener.port}&state=${state}&invite=${encodeURIComponent(token)}`;

  if (options.noOpen === true) {
    io.writeStdout(`${pc.cyan('Open this URL in your browser to accept the invite:')}\n  ${cliLoginUrl}\n`);
  } else {
    const opened = openBrowser(cliLoginUrl);
    if (!opened) {
      io.writeStdout(
        `${pc.yellow('Could not open browser automatically.')} Open this URL manually:\n  ${cliLoginUrl}\n`,
      );
    } else {
      io.writeStdout(pc.gray('Waiting for sign-in to complete (5 min timeout)…\n'));
    }
  }

  // Wait for JWT
  let jwt: string;
  try {
    jwt = await listener.tokenPromise;
  } catch (err) {
    if (err instanceof BrowserHandoffError) {
      io.writeStderr(`${pc.red('coodra team join')}: ${err.message}\n`);
      return io.exit(EXIT_USER_RECOVERABLE);
    }
    throw err;
  }

  // Fetch install bundle via POST /api/install/<token>
  const bundleUrl = `${baseUrl}/api/install/${token}`;
  io.writeStdout(pc.gray(`  Fetching install bundle from ${bundleUrl}…\n`));

  let response: Response;
  try {
    response = await fetch(bundleUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // The JWT establishes identity. The current /api/install route does
        // its own Clerk-user-by-email lookup, so the header is informational
        // for now; future Phase G+1 may switch the route to a pure
        // Bearer-verify model. Either way, sending it is the right shape.
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({}),
    });
  } catch (err) {
    io.writeStderr(
      `${pc.red('coodra team join')}: bundle fetch failed (network error): ${(err as Error).message}\n` +
        `  Confirm ${baseUrl} is reachable from this machine.\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    io.writeStderr(
      `${pc.red('coodra team join')}: bundle endpoint returned non-JSON (HTTP ${response.status}). ${(err as Error).message}\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  if (!response.ok) {
    if (isInstallError(body)) {
      io.writeStderr(
        `${pc.red('coodra team join')}: server rejected (${response.status} ${body.error})\n  ${pc.yellow(body.howToFix)}\n`,
      );
      return io.exit(EXIT_USER_ACTION_REQUIRED);
    }
    io.writeStderr(`${pc.red('coodra team join')}: server returned HTTP ${response.status}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  if (!isInstallBundle(body)) {
    io.writeStderr(`${pc.red('coodra team join')}: bundle shape unexpected. Refusing to write partial config.\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  const bundle = body;

  // Write the .env FIRST so subsequent JWT verification (writeToken) has the
  // Clerk publishable key it needs.
  mkdirSync(home, { recursive: true });
  writeTeamHomeEnv(
    {
      databaseUrl: bundle.databaseUrl,
      localHookSecret: bundle.localHookSecret,
      clerkOrgId: bundle.orgId,
    },
    { homeOverride: home },
  );
  // Phase G — also write CLERK_PUBLISHABLE_KEY so the verifier (JWKS mode)
  // can find the issuer. Done inline because `writeTeamHomeEnv` only
  // manages four specific keys.
  if (bundle.clerkPublishableKey !== null && bundle.clerkPublishableKey.length > 0) {
    appendKeyToHomeEnv(home, 'CLERK_PUBLISHABLE_KEY', bundle.clerkPublishableKey);
  }

  // Write config.json with team block
  upgradeToTeamConfig(
    {
      clerkUserId: bundle.userId,
      clerkOrgId: bundle.orgId,
      ...(bundle.orgSlug !== null ? { clerkOrgSlug: bundle.orgSlug } : {}),
      localHookSecret: bundle.localHookSecret,
      joinedAt: Date.now(),
    },
    { homeOverride: home },
  );

  // Write the JWT — verification uses the publishable key we just wrote
  try {
    await writeToken(jwt, baseUrl, { homeOverride: home });
  } catch (err) {
    io.writeStderr(
      `${pc.red('coodra team join')}: JWT verification failed after capturing it: ${(err as Error).message}\n` +
        `  Bundle was already written; you can re-run \`coodra login\` to retry the auth round-trip.\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  io.writeStdout(
    `\n${pc.green('✓')} Joined team as ${pc.cyan(bundle.invitedEmail)} (${pc.gray(bundle.role)})\n` +
      `  Org: ${pc.gray(bundle.orgSlug ?? bundle.orgId)}\n` +
      `  Next: \`coodra init\` in a project directory, then \`coodra start\`.\n`,
  );
  return io.exit(EXIT_OK);
}

/**
 * Append a key=value pair to ~/.coodra/.env, preserving existing
 * lines. If the key already exists, updates in place. Used for the
 * non-team-mode-managed keys (CLERK_PUBLISHABLE_KEY) that
 * `writeTeamHomeEnv` doesn't handle.
 */
function appendKeyToHomeEnv(home: string, key: string, value: string): void {
  const envPath = join(home, '.env');
  let existing = '';
  if (existsSync(envPath)) {
    existing = readFileSync(envPath, 'utf8');
  }
  const lines = existing.split(/\r?\n/);
  let replaced = false;
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      out.push(`${key}=${value}`);
      replaced = true;
    } else {
      out.push(line);
    }
  }
  if (!replaced) {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    out.push(`${key}=${value}`);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  const tmpPath = `${envPath}.tmp`;
  writeFileSync(tmpPath, `${out.join('\n')}\n`, 'utf8');
  renameSync(tmpPath, envPath);
}
