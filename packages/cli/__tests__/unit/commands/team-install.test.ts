import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamCommandIO } from '../../../src/commands/team.js';
import { runTeamInstallCommand } from '../../../src/commands/team-install.js';
import { EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../../../src/exit-codes.js';
import { buildProgram } from '../../../src/program.js';

/**
 * Unit tests for `coodra team install` — Module 04 Phase 2 (2026-05-11).
 *
 * Covers:
 *   - Missing --bootstrap-url → user-action-required exit + clear stderr.
 *   - Non-http URL → user-action-required.
 *   - Server fetch failure → user-recoverable.
 *   - Server returns structured `{ ok:false, error, howToFix }` →
 *     stderr surfaces howToFix verbatim.
 *   - Server returns 200 but bundle shape is wrong → refuse to write
 *     a partial config.
 *   - Happy path → writes ~/.coodra/config.json + .env, prints
 *     welcome message, exits 0.
 *   - Program-level wiring: `buildProgram()` registers a `team install`
 *     subcommand that dispatches to our handler.
 */

function captureIO(): { io: TeamCommandIO; stdout: string[]; stderr: string[]; exitCode: number | null } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;
  const io: TeamCommandIO = {
    writeStdout: (chunk) => {
      stdout.push(chunk);
    },
    writeStderr: (chunk) => {
      stderr.push(chunk);
    },
    exit: (code) => {
      exitCode = code;
      throw new ExitSignal(code);
    },
  };
  return {
    io,
    stdout,
    stderr,
    get exitCode() {
      return exitCode;
    },
  } as { io: TeamCommandIO; stdout: string[]; stderr: string[]; exitCode: number | null };
}

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`);
  }
}

async function expectExit(p: Promise<unknown>, expected: number): Promise<void> {
  try {
    await p;
    throw new Error('expected the command to call io.exit(), but it returned normally');
  } catch (err) {
    if (err instanceof ExitSignal) {
      expect(err.code).toBe(expected);
      return;
    }
    throw err;
  }
}

describe('runTeamInstallCommand — argument validation', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('exits USER_ACTION_REQUIRED when --bootstrap-url is missing and env is empty', async () => {
    delete process.env.COODRA_BOOTSTRAP_URL;
    const c = captureIO();
    await expectExit(runTeamInstallCommand({}, c.io), EXIT_USER_ACTION_REQUIRED);
    expect(c.stderr.join('')).toMatch(/missing --bootstrap-url/);
  });

  it('exits USER_ACTION_REQUIRED for a non-http URL', async () => {
    const c = captureIO();
    await expectExit(runTeamInstallCommand({ bootstrapUrl: 'ftp://nope' }, c.io), EXIT_USER_ACTION_REQUIRED);
    expect(c.stderr.join('')).toMatch(/full http\(s\) URL/);
  });
});

describe('runTeamInstallCommand — network paths', () => {
  let tempHome: string;
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'coodra-team-install-'));
    process.env.COODRA_HOME = tempHome;
  });
  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  it('exits USER_RECOVERABLE on fetch failure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network is down');
    }) as unknown as typeof fetch;
    const c = captureIO();
    await expectExit(
      runTeamInstallCommand({ bootstrapUrl: 'https://acme.test/api/install/tok' }, c.io),
      EXIT_USER_RECOVERABLE,
    );
    expect(c.stderr.join('')).toMatch(/network is down/);
    expect(c.stderr.join('')).toMatch(/install failed/);
  });

  it('surfaces structured server error howToFix', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: 'user_not_in_org',
            howToFix:
              'alice@acme.com has a Clerk account but is not a member of org_2nKjAcme…. Open the invitation email from Clerk and accept the organization invite, then re-run this command.',
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
    const c = captureIO();
    await expectExit(
      runTeamInstallCommand({ bootstrapUrl: 'https://acme.test/api/install/tok' }, c.io),
      EXIT_USER_ACTION_REQUIRED,
    );
    const errOut = c.stderr.join('');
    expect(errOut).toMatch(/user_not_in_org/);
    expect(errOut).toMatch(/Open the invitation email from Clerk/);
  });

  it('refuses a 200-but-malformed bundle', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, missing: 'fields' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const c = captureIO();
    await expectExit(
      runTeamInstallCommand({ bootstrapUrl: 'https://acme.test/api/install/tok' }, c.io),
      EXIT_USER_RECOVERABLE,
    );
    expect(c.stderr.join('')).toMatch(/bundle shape is wrong/);
  });

  it('happy path: writes config.json + .env, exits 0, prints welcome message', async () => {
    const bundle = {
      ok: true,
      userId: 'user_test',
      orgId: 'org_test',
      orgSlug: 'acme',
      databaseUrl: 'postgresql://test:test@127.0.0.1:5432/test',
      localHookSecret: 'a'.repeat(64),
      cloudApiBaseUrl: 'https://acme.test',
      role: 'member',
      invitedEmail: 'bob@acme.com',
    };
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(bundle), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const c = captureIO();
    await expectExit(runTeamInstallCommand({ bootstrapUrl: 'https://acme.test/api/install/tok' }, c.io), EXIT_OK);
    const configRaw = readFileSync(join(tempHome, 'config.json'), 'utf-8');
    const config = JSON.parse(configRaw);
    expect(config.mode).toBe('team');
    expect(config.team.clerkUserId).toBe('user_test');
    expect(config.team.clerkOrgId).toBe('org_test');
    expect(config.team.clerkOrgSlug).toBe('acme');
    expect(config.team.localHookSecret).toBe('a'.repeat(64));
    const envRaw = readFileSync(join(tempHome, '.env'), 'utf-8');
    expect(envRaw).toMatch(/COODRA_MODE=team/);
    expect(envRaw).toMatch(/DATABASE_URL=/);
    expect(envRaw).toMatch(/LOCAL_HOOK_SECRET=/);
    const out = c.stdout.join('');
    expect(out).toMatch(/Welcome to the team/);
    expect(out).toMatch(/bob@acme.com/);
  });

  it('--json suppresses the welcome message and emits parseable JSON', async () => {
    const bundle = {
      ok: true,
      userId: 'user_json',
      orgId: 'org_json',
      orgSlug: null,
      databaseUrl: 'postgresql://x',
      localHookSecret: 'b'.repeat(64),
      cloudApiBaseUrl: 'https://x.test',
      role: 'viewer',
      invitedEmail: 'pm@acme.com',
    };
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(bundle), { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;
    const c = captureIO();
    await expectExit(
      runTeamInstallCommand({ bootstrapUrl: 'https://acme.test/api/install/tok', json: true }, c.io),
      EXIT_OK,
    );
    const out = c.stdout.join('');
    // The last stdout chunk should be the JSON block.
    const jsonStart = out.lastIndexOf('{\n');
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(out.slice(jsonStart));
    expect(parsed.userId).toBe('user_json');
    expect(parsed.role).toBe('viewer');
    expect(out).not.toMatch(/Welcome to the team/);
  });
});

describe('buildProgram — team install wiring', () => {
  it('registers a `team install` subcommand that dispatches to the override runner', async () => {
    const calls: Array<{ opts: unknown }> = [];
    const fake = async (opts: unknown, _io?: TeamCommandIO) => {
      calls.push({ opts });
      return { ok: true };
    };
    const program = buildProgram({ runTeamInstall: fake });
    // Find the parent `team` command + the `install` subcommand.
    const teamCmd = program.commands.find((c) => c.name() === 'team');
    expect(teamCmd).toBeDefined();
    if (teamCmd === undefined) return;
    const installCmd = teamCmd.commands.find((c) => c.name() === 'install');
    expect(installCmd).toBeDefined();
    if (installCmd === undefined) return;
    expect(installCmd.description()).toMatch(/Join an existing team/);
    // Verify the --bootstrap-url + --json options are registered.
    const optNames = installCmd.options.map((o) => o.long).filter(Boolean);
    expect(optNames).toContain('--bootstrap-url');
    expect(optNames).toContain('--json');

    // Dispatch synthetically via parseAsync against argv.
    await program.parseAsync(['node', 'cli', 'team', 'install', '--bootstrap-url', 'https://x.test/api/install/abc'], {
      from: 'node',
    });
    expect(calls.length).toBe(1);
    const opts = calls[0]?.opts as { bootstrapUrl?: string };
    expect(opts?.bootstrapUrl).toBe('https://x.test/api/install/abc');
  });
});
