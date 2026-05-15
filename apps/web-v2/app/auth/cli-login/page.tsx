import { redirect } from 'next/navigation';

import { consumeCliLoginState } from '@/lib/cli-login-state';
import { resolveDeploymentMode } from '@/lib/deployment-mode';
import { verifyInviteToken } from '@/lib/invite-token';

/**
 * `/auth/cli-login` — Phase G browser-handoff endpoint.
 *
 * The CLI's `coodra login` command opens this URL in the user's
 * default browser. After Clerk sign-in completes, the page mints a
 * long-lived JWT and redirects back to the CLI's loopback HTTP
 * listener at `http://127.0.0.1:<port>/?token=<jwt>&state=<state>`.
 *
 * Query parameters:
 *   • port    — 1024-65535, the loopback port the CLI is listening on
 *   • state   — random URL-safe token (16-128 chars) the CLI generates
 *               on each `coodra login` invocation. Echoed back to
 *               the loopback URL; the CLI verifies match before
 *               accepting the token.
 *   • invite  — OPTIONAL. The invite-token from `coodra team join`.
 *               When present, the page enforces that the signed-in
 *               Clerk user's primary email matches the invite's email.
 *
 * Security model:
 *
 *   1. Clerk session is the source of identity (no trust in CLI env).
 *   2. State parameter: single-use replay protection. Second hit with
 *      the same state returns an error page (see `cli-login-state.ts`).
 *   3. Port pinning: redirect target is hardcoded to 127.0.0.1 (not
 *      `localhost`, not user-supplied host) — token can't escape the
 *      laptop.
 *   4. Invite-email gate: if `invite` is supplied, the signed-in
 *      user's email must match. Prevents an attacker from running
 *      `coodra team join <invite-url>` on their own laptop using
 *      a stolen invite URL but their own Clerk account.
 *
 * The JWT minted via `getToken({ template: 'coodra_cli' })`. That
 * template must exist in the Clerk dashboard with token lifetime ≥
 * 24h. If the template is missing, the page surfaces a remediation
 * error pointing at the dashboard setup step.
 *
 * Solo mode (no Clerk): the page returns a 404-equivalent error;
 * `coodra login` is only meaningful in team mode.
 */

export const dynamic = 'force-dynamic';

const CLI_JWT_TEMPLATE = 'coodra_cli';
const PORT_MIN = 1024;
const PORT_MAX = 65535;
const STATE_MIN_LEN = 16;
const STATE_MAX_LEN = 128;
const STATE_PATTERN = /^[A-Za-z0-9_-]+$/;

interface SearchParams {
  readonly port?: string | string[];
  readonly state?: string | string[];
  readonly invite?: string | string[];
}

interface PageProps {
  readonly searchParams: Promise<SearchParams>;
}

function firstString(v: string | string[] | undefined): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  // Reject leading zeros / whitespace by round-tripping the parse.
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n)) return null;
  if (n < PORT_MIN || n > PORT_MAX) return null;
  if (String(n) !== raw) return null;
  return n;
}

function isValidState(s: string | undefined): s is string {
  if (s === undefined) return false;
  if (s.length < STATE_MIN_LEN || s.length > STATE_MAX_LEN) return false;
  return STATE_PATTERN.test(s);
}

export default async function CliLoginPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const port = parsePort(firstString(sp.port));
  const state = firstString(sp.state);
  const invite = firstString(sp.invite);

  // 0. Solo-mode refuse — no Clerk to mint tokens from.
  const mode = resolveDeploymentMode();
  if (mode === 'local-solo') {
    return renderError(
      'solo_mode',
      'This route only exists in team mode. Coodra is currently running in solo mode (no Clerk). The `coodra login` command should not be called in solo mode.',
    );
  }

  // 1. Validate query params (pre-auth so a malformed URL doesn't
  //    needlessly drag the user through a sign-in flow first).
  if (port === null) {
    return renderError(
      'bad_port',
      `Port parameter is missing or invalid. Expected integer between ${PORT_MIN} and ${PORT_MAX}.`,
    );
  }
  if (!isValidState(state)) {
    return renderError(
      'bad_state',
      `State parameter is missing or invalid. Expected URL-safe random token, ${STATE_MIN_LEN}-${STATE_MAX_LEN} chars.`,
    );
  }

  // 2. Check Clerk session. If not signed in, bounce through sign-in
  //    with this URL preserved as redirect_url. Clerk's `<SignIn>`
  //    component honors `redirect_url` query param.
  const { auth, clerkClient } = await import('@clerk/nextjs/server');
  const session = await auth();
  if (session.userId === null || session.userId === undefined) {
    const back = buildSelfUrl(port, state, invite);
    redirect(`/auth/sign-in?redirect_url=${encodeURIComponent(back)}`);
  }

  // 3. Invite-email match check (when an invite token was supplied).
  if (typeof invite === 'string' && invite.length > 0) {
    const verification = verifyInviteToken(invite, Math.floor(Date.now() / 1000));
    if (!verification.ok) {
      return renderError(
        'invite_invalid',
        `Invite verification failed (${verification.reason}): ${verification.howToFix}`,
      );
    }
    const client = await clerkClient();
    const user = await client.users.getUser(session.userId);
    const primary =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
      user.emailAddresses[0]?.emailAddress ??
      null;
    if (primary === null || primary.toLowerCase() !== verification.payload.email.toLowerCase()) {
      return renderError(
        'invite_email_mismatch',
        `You're signed in as ${primary ?? '(no email)'} but this invite is for ${verification.payload.email}. Sign out and sign in as the invited email.`,
      );
    }
  }

  // 4. Single-use state consumption (defense-in-depth).
  if (!consumeCliLoginState(state)) {
    return renderError(
      'state_already_consumed',
      'This authorization URL has already been used. Return to your terminal and run `coodra login` again to start a fresh flow.',
    );
  }

  // 5. Mint the long-lived JWT via the Clerk JWT template.
  let token: string | null = null;
  try {
    token = await session.getToken({ template: CLI_JWT_TEMPLATE });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return renderError(
      'template_missing',
      `Could not mint the Clerk JWT for the CLI handoff. Most commonly: the JWT template '${CLI_JWT_TEMPLATE}' is not configured in this Clerk app. ` +
        `Create it in Clerk dashboard → Configure → JWT Templates → New: name='${CLI_JWT_TEMPLATE}', token lifetime 86400 (24h), include claims org_id + org_role + email. ` +
        `Underlying error: ${detail}`,
    );
  }
  if (token === null) {
    return renderError(
      'token_mint_null',
      'Clerk returned null for the JWT. This usually means the active org changed mid-session or the user has no active org. Sign out, sign back in, and select an org before retrying.',
    );
  }

  // 6. Redirect to the CLI's loopback listener.
  //    NOTE: redirect() throws — execution stops here. Anything after
  //    this line is dead code.
  redirect(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`);
}

function buildSelfUrl(port: number, state: string, invite: string | undefined): string {
  const base = `/auth/cli-login?port=${port}&state=${state}`;
  return invite === undefined || invite.length === 0 ? base : `${base}&invite=${encodeURIComponent(invite)}`;
}

interface RenderedError {
  readonly code: string;
  readonly message: string;
}

function renderError(code: RenderedError['code'], message: RenderedError['message']) {
  return (
    <main
      style={{
        padding: '48px 24px',
        maxWidth: 720,
        margin: '0 auto',
        fontFamily: 'var(--sans, system-ui)',
        color: 'var(--ink, #0a0a0a)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--mono, ui-monospace)',
          fontSize: 11,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--warn, #b85c00)',
          marginBottom: 12,
        }}
      >
        CLI · sign-in handoff failed
      </div>
      <h1
        style={{
          fontFamily: 'var(--serif, Georgia)',
          fontSize: 40,
          fontWeight: 400,
          marginBottom: 18,
          letterSpacing: '-0.02em',
        }}
      >
        We couldn't complete <em>your login</em>.
      </h1>
      <p style={{ fontSize: 14, color: 'var(--ink-dim, #444)', lineHeight: 1.65, marginBottom: 20 }}>{message}</p>
      <p
        style={{
          fontSize: 11,
          fontFamily: 'var(--mono, ui-monospace)',
          color: 'var(--ink-mute, #888)',
          letterSpacing: '0.08em',
        }}
      >
        ERROR · {code}
      </p>
      <p style={{ marginTop: 28, fontSize: 13, color: 'var(--ink-mute, #888)', lineHeight: 1.65 }}>
        Return to your terminal and re-run <code style={{ fontFamily: 'var(--mono, ui-monospace)' }}>coodra login</code>.
        Your CLI listener will time out after 5 minutes; if it's already gone, the new <code>coodra login</code> will
        spin up a fresh one.
      </p>
    </main>
  );
}
