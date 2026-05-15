import { EXIT_OK, EXIT_USER_ACTION_REQUIRED } from '../exit-codes.js';
import { readTeamConfig } from '../lib/team-config.js';
import { pc } from '../ui/index.js';

import type { TeamCommandIO } from './team.js';
import { DEFAULT_TEAM_IO } from './team.js';

/**
 * `coodra team init` — Phase B (clarity-pass-plan, 2026-05-11). The
 * guided admin-onboarding wizard. Replaces the six-flag `team setup`
 * with a three-step interactive flow:
 *
 *   1. Postgres — paste DATABASE_URL → connect → CREATE EXTENSION
 *      vector → apply migrations.
 *   2. Clerk    — paste Secret Key → resolve user + orgs → pick org
 *      when more than one.
 *   3. Finalize — generate hook secret → write config.json + .env.
 *
 * Inputs can be pre-filled via flags (`--database-url`, `--clerk-
 * secret-key`, `--org-id`) for CI / automation; the wizard skips the
 * corresponding prompt when a flag is supplied AND non-empty.
 *
 * Re-init: when `~/.coodra/config.json` already carries a team
 * block, the wizard prompts for a "type 're-init' to overwrite"
 * confirmation. `--yes-reinit` skips the confirmation (CI only).
 *
 * Test surface: `readPrompt` callback overrides stdin so unit tests
 * don't need TTY emulation. The wizard never reads stdin directly;
 * it goes through this callback exclusively.
 */

export interface TeamInitOptions {
  /** Pre-fill DATABASE_URL. When set, the Postgres-URL prompt is skipped. */
  readonly databaseUrl?: string;
  /** Pre-fill Clerk Secret Key. When set, the Clerk-key prompt is skipped. */
  readonly clerkSecretKey?: string;
  /** Pre-fill Clerk Publishable Key. When set, the Clerk PK prompt is skipped. */
  readonly clerkPublishableKey?: string;
  /** Pre-select Clerk org by id. When set, the org-picker prompt is skipped. */
  readonly orgId?: string;
  /** Skip the pgvector extension install. */
  readonly skipPgvector?: boolean;
  /** Skip the "you're already in team mode — re-init?" prompt. */
  readonly yesReinit?: boolean;
  /**
   * Phase H.4 — skip the post-finalize `coodra login` browser handoff.
   * Used in tests/CI where opening a browser is impossible. In normal
   * use the wizard chains directly into login so the admin gets a
   * verified JWT before exiting.
   */
  readonly noLogin?: boolean;
  /** Test override — supplies prompt responses without reading stdin. */
  readonly readPrompt?: (prompt: string) => Promise<string>;
}

export async function runTeamInitCommand(
  options: TeamInitOptions = {},
  io: TeamCommandIO = DEFAULT_TEAM_IO,
): Promise<never> {
  const readPrompt = options.readPrompt ?? defaultReadPrompt;

  // Re-init guard. Reading the existing config tells us whether to
  // print the overwrite warning.
  const existing = readTeamConfig();
  if (existing.mode === 'team' && existing.team !== undefined) {
    const orgLabel = existing.team.clerkOrgSlug ?? existing.team.clerkOrgId;
    io.writeStdout(
      `${pc.yellow('⚠')} This machine is already in team mode (org ${pc.cyan(orgLabel)}).\n` +
        '   Re-running will overwrite the local config block. Cloud data is untouched.\n\n',
    );
    if (options.yesReinit !== true) {
      const typed = (await readPrompt(`Type ${pc.yellow('`re-init`')} to continue, anything else to cancel: `)).trim();
      if (typed !== 're-init') {
        io.writeStderr(`${pc.red('✗')} Cancelled. Existing team config is unchanged.\n`);
        return io.exit(EXIT_USER_ACTION_REQUIRED);
      }
      io.writeStdout('\n');
    }
  }

  io.writeStdout(
    `${pc.bold('Coodra team setup')} — three steps:\n` +
      `  (1) Postgres — your team's cloud database\n` +
      `  (2) Clerk    — your team's identity provider\n` +
      `  (3) Local    — generate hook secret + write config\n\n`,
  );

  // Step 1 input — DATABASE_URL
  let databaseUrl = (options.databaseUrl ?? '').trim();
  if (databaseUrl.length === 0) {
    io.writeStdout(`${pc.bold('Step 1 of 3 · Postgres')}\n`);
    io.writeStdout(pc.gray('  Recommended: Supabase free tier (https://supabase.com/dashboard).\n'));
    io.writeStdout(pc.gray('  Create a project, then copy Settings → Database → "Connection string" → "URI".\n'));
    databaseUrl = (await readPrompt('  Paste your DATABASE_URL: ')).trim();
  } else {
    io.writeStdout(`${pc.bold('Step 1 of 3 · Postgres')} ${pc.gray(`(--database-url supplied)`)}\n`);
  }
  // Phase H.6 — strip a leading `DATABASE_URL=` if the user pasted the
  // full env line (the goal text framing "no manual env editing" implies
  // pasting the raw `.env` line should Just Work). Also strip surrounding
  // quotes / whitespace.
  databaseUrl = stripEnvPrefix(databaseUrl, 'DATABASE_URL');
  if (databaseUrl.length === 0) {
    io.writeStderr(`${pc.red('✗')} No DATABASE_URL supplied — aborting.\n`);
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }

  // Step 2 input — CLERK_SECRET_KEY
  let clerkSecretKey = (options.clerkSecretKey ?? '').trim();
  // We collect this UP FRONT so the wizard fails fast on a bad key
  // before doing the heavier Postgres preflight on step 1. Actually
  // no — we DO want Postgres to validate first, since that's the
  // more common failure mode (typo'd URLs, network issues). Collect
  // Clerk key only after Postgres succeeds.

  // The wizard library's `runWizard` runs all three bootstraps
  // back-to-back. The CLI needs a different flow — prompt for input
  // BETWEEN steps so a Postgres failure doesn't waste the operator's
  // time typing a Clerk key first. We therefore invoke the bootstrap
  // functions directly here for prompt-interleaved output. The
  // orchestrator stays valuable for tests + the web wizard (where
  // both inputs arrive in one form submission).
  const { bootstrapPostgres } = await import('../lib/team-init/postgres-bootstrap.js');
  const pgInputForBootstrap: { databaseUrl: string; skipPgvector?: boolean } = { databaseUrl };
  if (options.skipPgvector === true) pgInputForBootstrap.skipPgvector = true;
  const pg = await bootstrapPostgres(pgInputForBootstrap);
  if (!pg.ok) {
    renderStepFailure(io, 'Postgres', pg.error, pg.howToFix, pg.underlyingError);
    return io.exit(1);
  }
  io.writeStdout(`${pc.green('✓')} Connected to Postgres (${pg.serverVersion})\n`);
  io.writeStdout(
    `${pg.pgvectorInstalled ? pc.green('✓') : pc.yellow('⚠')} pgvector ${pg.pgvectorInstalled ? 'installed' : 'SKIPPED (--skip-pgvector)'}\n`,
  );
  io.writeStdout(`${pc.green('✓')} ${pg.migrationsApplied} Drizzle migration row(s) recorded\n\n`);

  // Now prompt for Clerk
  let clerkPublishableKey = (options.clerkPublishableKey ?? '').trim();
  if (clerkSecretKey.length === 0) {
    io.writeStdout(`${pc.bold('Step 2 of 3 · Clerk')}\n`);
    io.writeStdout(pc.gray('  Recommended: Clerk free tier (https://dashboard.clerk.com).\n'));
    io.writeStdout(pc.gray('  Create an app, then create one organization. Copy BOTH keys from API keys:\n'));
    io.writeStdout(pc.gray('    - Secret Key (starts with sk_test_ or sk_live_)\n'));
    io.writeStdout(pc.gray('    - Publishable Key (starts with pk_test_ or pk_live_)\n'));
    clerkSecretKey = (await readPrompt('  Paste your Clerk Secret Key: ')).trim();
    if (clerkPublishableKey.length === 0) {
      clerkPublishableKey = (await readPrompt('  Paste your Clerk Publishable Key: ')).trim();
    }
  } else {
    io.writeStdout(`${pc.bold('Step 2 of 3 · Clerk')} ${pc.gray('(--clerk-secret-key supplied)')}\n`);
    if (clerkPublishableKey.length === 0) {
      io.writeStdout(pc.gray('  We also need your Clerk Publishable Key (pk_test_/pk_live_) for JWT verification.\n'));
      clerkPublishableKey = (await readPrompt('  Paste your Clerk Publishable Key: ')).trim();
    }
  }
  // Phase H.6 — same paste-tolerance as DATABASE_URL: strip an inline
  // `CLERK_SECRET_KEY=` / `CLERK_PUBLISHABLE_KEY=` prefix so users who
  // copy whole lines from another env file get accepted.
  clerkSecretKey = stripEnvPrefix(clerkSecretKey, 'CLERK_SECRET_KEY');
  clerkPublishableKey = stripEnvPrefix(clerkPublishableKey, 'CLERK_PUBLISHABLE_KEY');
  if (clerkSecretKey.length === 0) {
    io.writeStderr(`${pc.red('✗')} No Clerk secret key supplied — aborting.\n`);
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }
  if (clerkPublishableKey.length === 0) {
    io.writeStderr(`${pc.red('✗')} No Clerk publishable key supplied — aborting.\n`);
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }

  const { bootstrapClerk } = await import('../lib/team-init/clerk-bootstrap.js');
  const clerkInputForBootstrap: { secretKey: string; preferredOrgId?: string } = { secretKey: clerkSecretKey };
  if (options.orgId !== undefined && options.orgId.length > 0) clerkInputForBootstrap.preferredOrgId = options.orgId;
  const clerk = await bootstrapClerk(clerkInputForBootstrap);
  if (!clerk.ok) {
    renderStepFailure(io, 'Clerk', clerk.error, clerk.howToFix, clerk.underlyingError);
    return io.exit(1);
  }
  io.writeStdout(`${pc.green('✓')} Authenticated to Clerk\n`);
  io.writeStdout(
    `${pc.green('✓')} You: ${clerk.userId.slice(0, 14)}…${clerk.userEmail !== null ? ` (${clerk.userEmail})` : ''}\n`,
  );

  // Pick an org if not auto-selected
  let selectedOrg = clerk.selectedOrg;
  if (selectedOrg === null) {
    io.writeStdout(`  You are a member of ${clerk.orgs.length} organizations:\n`);
    clerk.orgs.forEach((o, idx) => {
      const label = o.slug ?? o.name;
      io.writeStdout(`    [${idx + 1}] ${pc.cyan(label)}  ${pc.gray(`(${o.id})`)}\n`);
    });
    const choice = (await readPrompt('  Which one represents your team? Type a number: ')).trim();
    const parsedChoice = Number.parseInt(choice, 10);
    if (!Number.isFinite(parsedChoice) || parsedChoice < 1 || parsedChoice > clerk.orgs.length) {
      io.writeStderr(`${pc.red('✗')} Invalid selection — aborting. Re-run when ready.\n`);
      return io.exit(EXIT_USER_ACTION_REQUIRED);
    }
    selectedOrg = clerk.orgs[parsedChoice - 1] ?? null;
    if (selectedOrg === null) {
      io.writeStderr(`${pc.red('✗')} Could not resolve selected org — aborting.\n`);
      return io.exit(EXIT_USER_ACTION_REQUIRED);
    }
  }
  io.writeStdout(`${pc.green('✓')} Org: ${pc.cyan(selectedOrg.slug ?? selectedOrg.name)} (${selectedOrg.id})\n\n`);

  // Phase H.12 — auto-create the `coodra_cli` JWT template via Clerk
  // Backend API. Pre-Phase-H the admin had to do this manually in the
  // Clerk dashboard (and typically got the claim names wrong, producing
  // tokens the verifier rejected with `org_id missing`). The wizard now
  // does it idempotently — re-runs detect the existing template and
  // skip the POST. Dynamic import so unit tests can stub via vi.mock.
  io.writeStdout(pc.gray('  Creating coodra_cli JWT template (idempotent) …\n'));
  const { ensureCoodraCliJwtTemplate } = await import('../lib/team-init/clerk-jwt-template.js');
  const tmpl = await ensureCoodraCliJwtTemplate({ secretKey: clerkSecretKey });
  if (tmpl.ok) {
    if (tmpl.status === 'created') {
      io.writeStdout(`${pc.green('✓')} JWT template "coodra_cli" created\n`);
    } else {
      io.writeStdout(`${pc.gray('=')} JWT template "coodra_cli" already exists — left as-is\n`);
    }
  } else {
    io.writeStdout(`${pc.yellow('⚠')} JWT template auto-create failed (${tmpl.error}): ${tmpl.howToFix}\n`);
    io.writeStdout(
      pc.gray(
        '  (You can create it manually later. The wizard will continue without it; CLI login will fail until the template exists.)\n',
      ),
    );
  }
  io.writeStdout('\n');

  // Step 3 — finalize (writes config.json + .env including the HMAC
  // invite secret + Clerk keys, idempotently per H.4).
  io.writeStdout(`${pc.bold('Step 3 of 3 · Local config')}\n`);
  const { finalizeConfig } = await import('../lib/team-init/finalize-config.js');
  const finalize = finalizeConfig({
    databaseUrl,
    clerkUserId: clerk.userId,
    clerkOrgId: selectedOrg.id,
    clerkOrgSlug: selectedOrg.slug,
    clerkSecretKey,
    clerkPublishableKey,
  });
  io.writeStdout(`${pc.green('✓')} Generated/persisted 32-byte hook + invite secrets\n`);
  io.writeStdout(`${pc.green('✓')} Wrote ${finalize.configPath}\n`);
  io.writeStdout(`${pc.green('✓')} Wrote ${finalize.envPath}\n\n`);

  io.writeStdout(`${pc.green('✓ Team setup complete')} — machine flipped to ${pc.cyan('team')} mode.\n\n`);
  io.writeStdout(
    `  ${pc.bold('Org')}        ${selectedOrg.slug ?? selectedOrg.name}  ${pc.gray(`(${selectedOrg.id})`)}\n`,
  );
  io.writeStdout(`  ${pc.bold('Database')}   ${maskDatabaseUrl(databaseUrl)}\n`);
  io.writeStdout(
    `  ${pc.bold('You')}        ${clerk.userId}${clerk.userEmail !== null ? `  (${clerk.userEmail})` : ''}\n\n`,
  );

  // Phase H.4 — chain into the browser login so the admin gets a
  // verified Clerk JWT in the same wizard run. `noLogin` is a test
  // escape hatch only.
  if (options.noLogin !== true) {
    io.writeStdout(pc.gray('  Opening your browser to capture a verified Clerk session …\n'));
    const { runLoginCommand } = await import('./login.js');
    const fakeIO = {
      writeStdout: (chunk: string) => io.writeStdout(chunk),
      writeStderr: (chunk: string) => io.writeStderr(chunk),
      // The login command exits the process on success/failure; we
      // catch those exits below.
      exit: (code: number) => {
        throw new LoginExit(code);
      },
    } as const;
    let loginExitCode = 0;
    try {
      await (runLoginCommand as unknown as (opts: object, io: object) => Promise<never>)({}, fakeIO);
    } catch (err) {
      if (err instanceof LoginExit) {
        loginExitCode = err.code;
      } else {
        throw err;
      }
    }
    if (loginExitCode !== 0) {
      io.writeStderr(
        `${pc.yellow('⚠')} Browser sign-in didn't complete cleanly (exit ${loginExitCode}). Run \`coodra login\` manually to finish.\n`,
      );
    }
  }

  io.writeStdout(`\n${pc.bold('Next steps:')}\n`);
  io.writeStdout(`  1. ${pc.cyan('`coodra start`')} — daemons pick up team-mode env; sync-daemon spawns now.\n`);
  io.writeStdout(`  2. ${pc.cyan('`coodra invite <email>`')} — share invite links with teammates.\n`);
  io.writeStdout(`  3. Open ${pc.cyan('http://localhost:3001/')} once daemons are up — admin dashboard.\n`);

  return io.exit(EXIT_OK);
}

/**
 * Internal sentinel — when the chained `coodra login` command tries
 * to `process.exit(code)`, throw this instead so the wizard can catch
 * and continue. Without this the wizard's `.action` handler would die
 * mid-flow on a successful login (process.exit(0) bubbles out).
 */
class LoginExit extends Error {
  constructor(public readonly code: number) {
    super(`login exited ${code}`);
  }
}

function renderStepFailure(io: TeamCommandIO, step: string, code: string, howToFix: string, underlying: string): void {
  io.writeStderr(`\n${pc.red('✗')} ${pc.bold(`${step} step failed`)} — code: ${pc.yellow(code)}\n`);
  io.writeStderr(`${pc.bold('How to fix:')} ${howToFix}\n`);
  io.writeStderr(pc.gray(`(underlying: ${underlying.slice(0, 200)}${underlying.length > 200 ? '…' : ''})\n`));
}

function maskDatabaseUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ':***@');
}

/**
 * Phase H.6 — tolerate `KEY=value` prefix when the user pasted a whole
 * env-file line by mistake. Also strip wrapping quotes and trim.
 *
 * Example: `stripEnvPrefix("DATABASE_URL=postgresql://...", "DATABASE_URL")`
 *          returns `"postgresql://..."`. Without this, the wizard
 *          fed the prefixed string straight into `new URL(...)` and the
 *          paste rejected with "Invalid URL".
 */
function stripEnvPrefix(value: string, key: string): string {
  let v = value.trim();
  const prefix = `${key}=`;
  if (v.startsWith(prefix)) v = v.slice(prefix.length).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

async function defaultReadPrompt(prompt: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
