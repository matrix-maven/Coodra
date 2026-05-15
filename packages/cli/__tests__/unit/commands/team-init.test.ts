import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamCommandIO } from '../../../src/commands/team.js';

/**
 * Phase B (clarity-pass-plan, 2026-05-11) — CLI wizard tests.
 *
 * The wizard makes real network calls (Postgres + Clerk) when the
 * bootstraps fire, so we mock both bootstrap modules at the module
 * level. The CLI's prompt loop is exercised via the injected
 * `readPrompt` callback.
 *
 * Test cases:
 *   1. Re-init guard fires when machine is already in team mode.
 *   2. --yes-reinit skips the re-init prompt.
 *   3. Flag-supplied DATABASE_URL + Clerk key skip the prompts;
 *      single-org auto-selects; full happy path lands.
 *   4. Postgres failure short-circuits the wizard.
 *   5. Multi-org Clerk → prompts for selection → user picks 2.
 */

vi.mock('../../../src/lib/team-init/postgres-bootstrap.js', () => ({
  bootstrapPostgres: vi.fn(),
}));
vi.mock('../../../src/lib/team-init/clerk-bootstrap.js', () => ({
  bootstrapClerk: vi.fn(),
}));
vi.mock('../../../src/lib/team-init/finalize-config.js', () => ({
  finalizeConfig: vi.fn().mockReturnValue({
    localHookSecret: 'f'.repeat(64),
    inviteHmacSecret: 'g'.repeat(64),
    configPath: '/tmp/home/.coodra/config.json',
    envPath: '/tmp/home/.coodra/.env',
    joinedAt: 1700000000000,
  }),
}));
vi.mock('../../../src/lib/team-init/clerk-jwt-template.js', () => ({
  ensureCoodraCliJwtTemplate: vi.fn().mockResolvedValue({
    ok: true,
    status: 'already_exists',
    templateId: 'jtpl_mocked',
  }),
}));

async function getMocks() {
  const pg = await import('../../../src/lib/team-init/postgres-bootstrap.js');
  const clerk = await import('../../../src/lib/team-init/clerk-bootstrap.js');
  const fin = await import('../../../src/lib/team-init/finalize-config.js');
  return {
    bootstrapPostgres: pg.bootstrapPostgres as unknown as ReturnType<typeof vi.fn>,
    bootstrapClerk: clerk.bootstrapClerk as unknown as ReturnType<typeof vi.fn>,
    finalizeConfig: fin.finalizeConfig as unknown as ReturnType<typeof vi.fn>,
  };
}

interface Captured {
  stdout: string[];
  stderr: string[];
  exit: number | null;
}

function makeIO(): { io: TeamCommandIO; captured: Captured } {
  const captured: Captured = { stdout: [], stderr: [], exit: null };
  const io: TeamCommandIO = {
    writeStdout: (chunk) => {
      captured.stdout.push(chunk);
    },
    writeStderr: (chunk) => {
      captured.stderr.push(chunk);
    },
    exit: (code) => {
      captured.exit = code;
      throw new Error(`__exit__:${code}`);
    },
  };
  return { io, captured };
}

let homeDir: string;
let prevHome: string | undefined;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'team-init-cli-'));
  mkdirSync(homeDir, { recursive: true });
  prevHome = process.env.COODRA_HOME;
  process.env.COODRA_HOME = homeDir;
  const mocks = await getMocks();
  mocks.bootstrapPostgres.mockReset();
  mocks.bootstrapClerk.mockReset();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.COODRA_HOME;
  else process.env.COODRA_HOME = prevHome;
});

describe('runTeamInitCommand', () => {
  it('full happy path with --database-url and --clerk-secret-key flags', async () => {
    const mocks = await getMocks();
    mocks.bootstrapPostgres.mockResolvedValueOnce({
      ok: true,
      migrationsApplied: 14,
      pgvectorInstalled: true,
      serverVersion: 'PostgreSQL 17.4',
    });
    mocks.bootstrapClerk.mockResolvedValueOnce({
      ok: true,
      userId: 'user_alice',
      userEmail: 'alice@acme.com',
      orgs: [{ id: 'org_acme', slug: 'acme', name: 'Acme', role: 'org:admin' }],
      selectedOrg: { id: 'org_acme', slug: 'acme', name: 'Acme', role: 'org:admin' },
    });
    const { runTeamInitCommand } = await import('../../../src/commands/team-init.js');
    const { io, captured } = makeIO();
    await expect(
      runTeamInitCommand(
        {
          databaseUrl: 'postgres://x:y@h/d',
          clerkSecretKey: 'sk_test_xxx',
          clerkPublishableKey: 'pk_test_xxx',
          noLogin: true,
          readPrompt: async () => '',
        },
        io,
      ),
    ).rejects.toThrow('__exit__:0');
    expect(captured.exit).toBe(0);
    const out = captured.stdout.join('');
    expect(out).toContain('Step 1 of 3 · Postgres');
    expect(out).toContain('Step 2 of 3 · Clerk');
    expect(out).toContain('Step 3 of 3 · Local config');
    expect(out).toContain('Team setup complete');
    expect(out).toContain('acme');
    expect(mocks.bootstrapPostgres).toHaveBeenCalledOnce();
    expect(mocks.bootstrapClerk).toHaveBeenCalledOnce();
    expect(mocks.finalizeConfig).toHaveBeenCalledOnce();
  });

  // Phase H.6 — the live test caught the wizard rejecting a paste that
  // contained a leading `DATABASE_URL=` (and/or quotes) because the user
  // copied the whole env-file line. The fix strips the prefix + quotes.
  it('Phase H.6 — strips inline `DATABASE_URL=` prefix from paste', async () => {
    const mocks = await getMocks();
    let postgresUrlReceived: string | undefined;
    mocks.bootstrapPostgres.mockImplementationOnce(async (input: { databaseUrl: string }) => {
      postgresUrlReceived = input.databaseUrl;
      return {
        ok: true,
        migrationsApplied: 1,
        pgvectorInstalled: true,
        serverVersion: 'PostgreSQL 17.4',
      };
    });
    let clerkSecretReceived: string | undefined;
    mocks.bootstrapClerk.mockImplementationOnce(async (input: { secretKey: string }) => {
      clerkSecretReceived = input.secretKey;
      return {
        ok: true,
        userId: 'user_alice',
        userEmail: 'alice@acme.com',
        orgs: [{ id: 'org_acme', slug: 'acme', name: 'Acme', role: 'org:admin' }],
        selectedOrg: { id: 'org_acme', slug: 'acme', name: 'Acme', role: 'org:admin' },
      };
    });
    const { runTeamInitCommand } = await import('../../../src/commands/team-init.js');
    const { io } = makeIO();
    await expect(
      runTeamInitCommand(
        {
          databaseUrl: 'DATABASE_URL=postgresql://u:p@h:5432/d',
          clerkSecretKey: 'CLERK_SECRET_KEY="sk_test_quoted"',
          clerkPublishableKey: "'pk_test_quoted'",
          noLogin: true,
          readPrompt: async () => '',
        },
        io,
      ),
    ).rejects.toThrow('__exit__:0');
    expect(postgresUrlReceived).toBe('postgresql://u:p@h:5432/d');
    expect(clerkSecretReceived).toBe('sk_test_quoted');
  });

  it('Postgres failure short-circuits — Clerk and Finalize are never called', async () => {
    const mocks = await getMocks();
    mocks.bootstrapPostgres.mockResolvedValueOnce({
      ok: false,
      error: 'connect_failed',
      howToFix: 'check the URL',
      underlyingError: 'ECONNREFUSED',
    });
    const { runTeamInitCommand } = await import('../../../src/commands/team-init.js');
    const { io, captured } = makeIO();
    await expect(
      runTeamInitCommand(
        { databaseUrl: 'postgres://bad', clerkSecretKey: 'sk_test_xxx', readPrompt: async () => '' },
        io,
      ),
    ).rejects.toThrow('__exit__:1');
    expect(captured.stderr.join('')).toContain('Postgres step failed');
    expect(captured.stderr.join('')).toContain('check the URL');
    expect(mocks.bootstrapClerk).not.toHaveBeenCalled();
    expect(mocks.finalizeConfig).not.toHaveBeenCalled();
  });

  it('multi-org Clerk prompts user to pick an org', async () => {
    const mocks = await getMocks();
    mocks.bootstrapPostgres.mockResolvedValueOnce({
      ok: true,
      migrationsApplied: 14,
      pgvectorInstalled: true,
      serverVersion: 'PostgreSQL 17.4',
    });
    mocks.bootstrapClerk.mockResolvedValueOnce({
      ok: true,
      userId: 'user_alice',
      userEmail: null,
      orgs: [
        { id: 'org_a', slug: 'a', name: 'A', role: null },
        { id: 'org_b', slug: 'b', name: 'B', role: null },
      ],
      selectedOrg: null,
    });
    const { runTeamInitCommand } = await import('../../../src/commands/team-init.js');
    const { io, captured } = makeIO();
    await expect(
      runTeamInitCommand(
        {
          databaseUrl: 'postgres://x:y@h/d',
          clerkSecretKey: 'sk_test_xxx',
          readPrompt: async () => '2', // pick org_b
        },
        io,
      ),
    ).rejects.toThrow('__exit__:0');
    expect(captured.stdout.join('')).toContain('member of 2 organizations');
    expect(captured.stdout.join('')).toContain('Org: ');
    expect(captured.stdout.join('')).toContain('org_b');
    expect(mocks.finalizeConfig).toHaveBeenCalledOnce();
    const finalizeArgs = mocks.finalizeConfig.mock.calls[0]?.[0];
    expect(finalizeArgs?.clerkOrgId).toBe('org_b');
  });

  it('aborts when user supplies an invalid org-picker selection', async () => {
    const mocks = await getMocks();
    mocks.bootstrapPostgres.mockResolvedValueOnce({
      ok: true,
      migrationsApplied: 14,
      pgvectorInstalled: true,
      serverVersion: 'PostgreSQL 17.4',
    });
    mocks.bootstrapClerk.mockResolvedValueOnce({
      ok: true,
      userId: 'user_alice',
      userEmail: null,
      orgs: [
        { id: 'org_a', slug: 'a', name: 'A', role: null },
        { id: 'org_b', slug: 'b', name: 'B', role: null },
      ],
      selectedOrg: null,
    });
    const { runTeamInitCommand } = await import('../../../src/commands/team-init.js');
    const { io, captured } = makeIO();
    await expect(
      runTeamInitCommand(
        {
          databaseUrl: 'postgres://x:y@h/d',
          clerkSecretKey: 'sk_test_xxx',
          readPrompt: async () => '99', // out of range
        },
        io,
      ),
    ).rejects.toThrow('__exit__:');
    expect(captured.exit).not.toBe(0);
    expect(captured.stderr.join('')).toContain('Invalid selection');
    expect(mocks.finalizeConfig).not.toHaveBeenCalled();
  });
});
