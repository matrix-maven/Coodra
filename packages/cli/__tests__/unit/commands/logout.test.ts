import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LogoutIO } from '../../../src/commands/logout.js';

/**
 * Phase G slice G.4 — `coodra logout` command tests.
 *
 * Strategy:
 *   - Real filesystem (temp home dir).
 *   - Mock `readVerifiedToken` so we don't hit Clerk during identity probe.
 *   - Mock `deleteToken` selectively in failure-path tests.
 *   - Pre-populate config.json + .env with team state, run logout,
 *     assert clean post-state.
 */

const mockDeleteToken = vi.hoisted(() => vi.fn());
const mockReadVerifiedToken = vi.hoisted(() => vi.fn());
const mockHasStoredToken = vi.hoisted(() => vi.fn());

vi.mock('@coodra/shared/auth', async () => {
  const actual = await vi.importActual<typeof import('@coodra/shared/auth')>('@coodra/shared/auth');
  return {
    ...actual,
    deleteToken: mockDeleteToken,
    readVerifiedToken: mockReadVerifiedToken,
    hasStoredToken: mockHasStoredToken,
  };
});

const { runLogoutCommand } = await import('../../../src/commands/logout.js');

interface Captured {
  stdout: string[];
  stderr: string[];
  exit: number | null;
}

function makeIO(): { io: LogoutIO; captured: Captured } {
  const captured: Captured = { stdout: [], stderr: [], exit: null };
  const io: LogoutIO = {
    writeStdout: (c) => {
      captured.stdout.push(c);
    },
    writeStderr: (c) => {
      captured.stderr.push(c);
    },
    exit: (code) => {
      captured.exit = code;
      throw new Error(`__exit__:${code}`);
    },
  };
  return { io, captured };
}

function writeTeamConfig(home: string): void {
  const config = {
    mode: 'team',
    team: {
      clerkUserId: 'user_abc',
      clerkOrgId: 'org_xyz',
      clerkOrgSlug: 'acme',
      localHookSecret: 'f'.repeat(64),
      joinedAt: 1700000000000,
    },
  };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2));
}

function writeTeamEnv(home: string): void {
  writeFileSync(
    join(home, '.env'),
    [
      '# Some user comment',
      'COODRA_MODE=team',
      'DATABASE_URL=postgres://x/y',
      'LOCAL_HOOK_SECRET=' + 'f'.repeat(64),
      'COODRA_TEAM_ORG_ID=org_xyz',
      'CLERK_SECRET_KEY=sk_test_real', // not stripped; user-managed
      '',
    ].join('\n'),
  );
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'logout-test-'));
  mkdirSync(home, { recursive: true });
  mockDeleteToken.mockReset();
  mockDeleteToken.mockImplementation((opts: { homeOverride: string }) => {
    // Default behavior: delete the file like the real implementation
    const path = join(opts.homeOverride, 'clerk-token.json');
    if (existsSync(path)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { unlinkSync } = require('node:fs');
      unlinkSync(path);
    }
  });
  mockReadVerifiedToken.mockReset();
  mockHasStoredToken.mockReset();
  mockHasStoredToken.mockImplementation((opts: { homeOverride: string }) =>
    existsSync(join(opts.homeOverride, 'clerk-token.json')),
  );
});

afterEach(() => {
  // tmp dirs auto-cleaned by vitest's tmpdir handling at process exit
});

describe('runLogoutCommand — already-solo no-op', () => {
  it('prints "Already logged out" and exits 0 when nothing to clean', async () => {
    const { io, captured } = makeIO();
    await expect(runLogoutCommand({ home }, io)).rejects.toThrow(/__exit__:0/);
    expect(captured.stdout.join('')).toMatch(/Already logged out/);
  });

  it('is idempotent — second call returns no-op', async () => {
    const { io: io1 } = makeIO();
    await expect(runLogoutCommand({ home }, io1)).rejects.toThrow(/__exit__:0/);
    const { io: io2, captured: c2 } = makeIO();
    await expect(runLogoutCommand({ home }, io2)).rejects.toThrow(/__exit__:0/);
    expect(c2.stdout.join('')).toMatch(/Already logged out/);
  });
});

describe('runLogoutCommand — happy path (full team state)', () => {
  beforeEach(() => {
    writeTeamConfig(home);
    writeTeamEnv(home);
    writeFileSync(
      join(home, 'clerk-token.json'),
      JSON.stringify({
        version: 1,
        token: 'jwt',
        webUrl: 'http://localhost:3001',
        fetchedAt: Date.now(),
      }),
      { mode: 0o600 },
    );
    mockReadVerifiedToken.mockResolvedValue({
      userId: 'user_abc',
      orgId: 'org_xyz',
      role: 'admin',
      email: 'admin@example.com',
      issuer: 'https://wise-bat-12.clerk.accounts.dev',
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    });
  });

  it('deletes clerk-token.json', async () => {
    const { io } = makeIO();
    expect(existsSync(join(home, 'clerk-token.json'))).toBe(true);
    await expect(runLogoutCommand({ home }, io)).rejects.toThrow(/__exit__:0/);
    expect(existsSync(join(home, 'clerk-token.json'))).toBe(false);
  });

  it('demotes config.json to solo (mode=solo, no team block)', async () => {
    const { io } = makeIO();
    await expect(runLogoutCommand({ home }, io)).rejects.toThrow(/__exit__:0/);
    const after = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    expect(after.mode).toBe('solo');
    expect(after.team).toBeUndefined();
  });

  it('strips the four team env keys from .env (preserves user-managed keys)', async () => {
    const { io } = makeIO();
    await expect(runLogoutCommand({ home }, io)).rejects.toThrow(/__exit__:0/);
    const after = readFileSync(join(home, '.env'), 'utf8');
    expect(after).not.toMatch(/^COODRA_MODE=/m);
    expect(after).not.toMatch(/^DATABASE_URL=/m);
    expect(after).not.toMatch(/^LOCAL_HOOK_SECRET=/m);
    expect(after).not.toMatch(/^COODRA_TEAM_ORG_ID=/m);
    // Preserved: comment + user-managed CLERK_SECRET_KEY
    expect(after).toMatch(/# Some user comment/);
    expect(after).toMatch(/CLERK_SECRET_KEY=sk_test_real/);
  });

  it('prints confirmation with email when token was verifiable', async () => {
    const { io, captured } = makeIO();
    await expect(runLogoutCommand({ home }, io)).rejects.toThrow(/__exit__:0/);
    const stdout = captured.stdout.join('');
    expect(stdout).toMatch(/Logged out as.*admin@example\.com/);
    expect(stdout).toMatch(/mode=solo/);
  });
});

describe('runLogoutCommand — token-only (config already solo)', () => {
  it('still cleans up an orphan clerk-token.json', async () => {
    writeFileSync(
      join(home, 'clerk-token.json'),
      JSON.stringify({
        version: 1,
        token: 'jwt',
        webUrl: 'http://localhost:3001',
        fetchedAt: Date.now(),
      }),
    );
    // Config doesn't exist → readTeamConfig returns SOLO
    mockReadVerifiedToken.mockResolvedValue(null);
    const { io, captured } = makeIO();
    await expect(runLogoutCommand({ home }, io)).rejects.toThrow(/__exit__:0/);
    expect(existsSync(join(home, 'clerk-token.json'))).toBe(false);
    expect(captured.stdout.join('')).toMatch(/Logged out/);
  });
});

describe('runLogoutCommand — failure paths', () => {
  it('continues even when deleteToken throws (degrades to warn)', async () => {
    writeTeamConfig(home);
    writeFileSync(
      join(home, 'clerk-token.json'),
      JSON.stringify({
        version: 1,
        token: 'jwt',
        webUrl: 'http://localhost:3001',
        fetchedAt: Date.now(),
      }),
    );
    mockReadVerifiedToken.mockResolvedValue(null);
    mockDeleteToken.mockImplementation(() => {
      throw new Error('permission denied');
    });

    const { io, captured } = makeIO();
    await expect(runLogoutCommand({ home }, io)).rejects.toThrow(/__exit__:0/);

    expect(captured.stderr.join('')).toMatch(/could not delete clerk-token\.json/);
    // Config should still be demoted
    const after = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    expect(after.mode).toBe('solo');
  });
});
