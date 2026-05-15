import { readVerifiedToken } from '@coodra/shared/auth';
import { EXIT_OK, EXIT_USER_ACTION_REQUIRED } from '../exit-codes.js';
import { resolveCoodraHome } from '../lib/coodra-home.js';
import { pc } from '../ui/index.js';

import { type LoginIO, type LoginOptions, runLoginCommand } from './login.js';

/**
 * `packages/cli/src/commands/org.ts` — Phase G slice G.10.
 *
 * Multi-org user support. A Clerk user can be a member of multiple
 * orgs; the CLI binds to ONE active org at a time (Phase G v1 — no
 * multiplexing).
 *
 *   - `coodra org status` — prints the active org from the
 *      verified clerk-token.json (org id + role + email).
 *
 *   - `coodra org switch <orgSlug>` — opens browser handoff so the
 *      user can pick a different org in Clerk's organization switcher,
 *      then mints a fresh JWT bound to that org. Internally delegates
 *      to `runLoginCommand` — the only difference vs `coodra login`
 *      is the friendly preamble announcing the org switch.
 *
 * The `<orgSlug>` argument is informational for v1 — the actual org
 * selection happens in the browser via Clerk's UI, not at the CLI
 * layer. Phase G+1 may pass `?org=<slug>` as a hint to the cli-login
 * page so the user lands directly on the right org. For now, the
 * argument is recorded in stderr for the user's reference and the
 * browser opens with no pre-selection.
 *
 * Why no flag-driven non-interactive switch: Clerk requires the user
 * to be signed in via a browser session to switch orgs. There's no
 * server-side "switch user X to org Y" admin API for the org's own
 * members (admin can change roles, but not "active org" selection
 * — that's a client-side concept).
 */

export interface OrgIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_ORG_IO: OrgIO = {
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

export interface OrgStatusOptions {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export async function runOrgStatusCommand(options: OrgStatusOptions = {}, io: OrgIO = DEFAULT_ORG_IO): Promise<never> {
  const home = resolveCoodraHome({
    ...(options.home !== undefined ? { override: options.home } : {}),
    env: options.env ?? process.env,
  });

  let claims;
  try {
    claims = await readVerifiedToken({ homeOverride: home });
  } catch {
    claims = null;
  }

  if (claims === null) {
    io.writeStdout(`${pc.gray('No active Clerk session.')} Run \`coodra login\` to sign in.\n`);
    return io.exit(EXIT_OK);
  }

  io.writeStdout(
    `${pc.green('Active org:')}\n` +
      `  Email:   ${pc.cyan(claims.email ?? '(no email claim)')}\n` +
      `  User:    ${pc.gray(claims.userId)}\n` +
      `  Org:     ${pc.cyan(claims.orgId)}\n` +
      `  Role:    ${pc.cyan(claims.role)}\n` +
      `  Expires: ${pc.gray(claims.expiresAt.toISOString())}\n` +
      `\n` +
      `To switch orgs (multi-org users): \`coodra org switch <orgSlug>\`\n`,
  );
  return io.exit(EXIT_OK);
}

export interface OrgSwitchOptions {
  readonly targetOrgSlug?: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly noOpen?: boolean;
  readonly timeoutMs?: number;
}

export async function runOrgSwitchCommand(options: OrgSwitchOptions = {}, io: OrgIO = DEFAULT_ORG_IO): Promise<never> {
  if (options.targetOrgSlug === undefined || options.targetOrgSlug.trim().length === 0) {
    io.writeStderr(
      `${pc.red('coodra org switch')}: missing <orgSlug> argument.\n` +
        `\n` +
        `  Usage: coodra org switch <orgSlug>\n` +
        `\n` +
        `  The slug is the org's short identifier in Clerk (e.g. "acme").\n` +
        `  When the browser opens, you'll see your org switcher — pick the matching org and sign in.\n` +
        `  For v1, the slug is informational; org selection happens in the Clerk UI.\n`,
    );
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }

  io.writeStdout(
    `${pc.cyan(`coodra org switch — switching to org "${options.targetOrgSlug}"`)}\n` +
      pc.gray("  Opening browser. Pick the target org in Clerk's switcher when prompted.\n"),
  );

  // Delegate to login. The browser-handoff flow will mint a new JWT
  // bound to whichever org the user picks in Clerk. The new token
  // overwrites the existing clerk-token.json.
  const loginOptions: LoginOptions = {
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.noOpen === true ? { noOpen: true } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
  // The login command's exit() never returns. Map the IO surface.
  const loginIO: LoginIO = {
    writeStdout: io.writeStdout,
    writeStderr: io.writeStderr,
    exit: io.exit,
  };
  return runLoginCommand(loginOptions, loginIO);
}
