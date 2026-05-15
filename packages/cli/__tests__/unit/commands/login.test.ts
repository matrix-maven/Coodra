import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoginIO } from '../../../src/commands/login.js';

/**
 * Phase G slice G.3 — `coodra login` command tests.
 *
 * Strategy:
 *   - Hoist-mock `@coodra/shared/auth` so `writeToken` returns
 *     a controllable VerifiedClerkClaims shape.
 *   - Hoist-mock the browser-handoff module so `startLoopbackListener`
 *     returns a controllable `tokenPromise`.
 *   - Use a temp home dir; populate ~/.coodra/.env with Clerk env.
 *   - Capture IO via a stub.
 */

const mockWriteToken = vi.hoisted(() => vi.fn());
const mockReadVerifiedToken = vi.hoisted(() => vi.fn());
const mockStartListener = vi.hoisted(() => vi.fn());
const mockOpenBrowser = vi.hoisted(() => vi.fn());

vi.mock('@coodra/shared/auth', async () => {
  const actual = await vi.importActual<typeof import('@coodra/shared/auth')>('@coodra/shared/auth');
  return {
    ...actual,
    writeToken: mockWriteToken,
    readVerifiedToken: mockReadVerifiedToken,
  };
});

vi.mock('../../../src/lib/browser-handoff.js', () => ({
  startLoopbackListener: mockStartListener,
  openBrowser: mockOpenBrowser,
  BrowserHandoffError: class BrowserHandoffError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'BrowserHandoffError';
    }
  },
}));

const { runLoginCommand } = await import('../../../src/commands/login.js');

interface Captured {
  stdout: string[];
  stderr: string[];
  exit: number | null;
}

function makeIO(): { io: LoginIO; captured: Captured } {
  const captured: Captured = { stdout: [], stderr: [], exit: null };
  const io: LoginIO = {
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

function fakeClaims(
  overrides: Partial<{ userId: string; orgId: string; role: string; email: string | null; expiresAt: Date }> = {},
) {
  return {
    userId: overrides.userId ?? 'user_abc',
    orgId: overrides.orgId ?? 'org_xyz',
    role: (overrides.role as 'admin' | 'member' | 'viewer') ?? 'admin',
    email: overrides.email !== undefined ? overrides.email : 'admin@example.com',
    issuer: 'https://wise-bat-12.clerk.accounts.dev',
    issuedAt: new Date(),
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 24 * 3600 * 1000),
  };
}

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'login-test-'));
  mkdirSync(homeDir, { recursive: true });
  mockWriteToken.mockReset();
  mockReadVerifiedToken.mockReset();
  mockStartListener.mockReset();
  mockOpenBrowser.mockReset();
});

afterEach(() => {
  // Best-effort cleanup; vitest rms temp dirs automatically anyway.
});

function writeEnv(contents: string): void {
  writeFileSync(join(homeDir, '.env'), contents);
}

const FULL_ENV = [
  'CLERK_SECRET_KEY=sk_test_realkey',
  'CLERK_PUBLISHABLE_KEY=pk_test_realkey',
  'DATABASE_URL=postgres://user:pass@host/db',
  'LOCAL_HOOK_SECRET=' + 'f'.repeat(64),
  '',
].join('\n');

describe('runLoginCommand — preconditions', () => {
  it('refuses when CLERK_SECRET_KEY missing', async () => {
    writeEnv('CLERK_PUBLISHABLE_KEY=pk_test\n');
    const { io, captured } = makeIO();
    await expect(runLoginCommand({ home: homeDir, env: { COODRA_HOME: homeDir } }, io)).rejects.toThrow(/__exit__/);
    expect(captured.exit).not.toBe(0);
    expect(captured.stderr.join('')).toMatch(/CLERK_SECRET_KEY/);
  });

  it('refuses when CLERK_SECRET_KEY is the solo-bypass sentinel', async () => {
    writeEnv('CLERK_SECRET_KEY=sk_test_replace_me\nCLERK_PUBLISHABLE_KEY=pk_test\n');
    const { io, captured } = makeIO();
    await expect(runLoginCommand({ home: homeDir, env: { COODRA_HOME: homeDir } }, io)).rejects.toThrow(/__exit__/);
    expect(captured.stderr.join('')).toMatch(/Clerk env is not configured/);
  });

  it('warns when DATABASE_URL is missing but proceeds', async () => {
    writeEnv('CLERK_SECRET_KEY=sk_test_real\nCLERK_PUBLISHABLE_KEY=pk_test\n');
    const { io, captured } = makeIO();
    mockStartListener.mockResolvedValue({
      port: 50001,
      tokenPromise: Promise.resolve('jwt-token'),
      close: () => undefined,
    });
    mockOpenBrowser.mockReturnValue(true);
    mockWriteToken.mockResolvedValue(fakeClaims());
    await expect(runLoginCommand({ home: homeDir, env: { COODRA_HOME: homeDir } }, io)).rejects.toThrow(
      /__exit__:0/,
    );
    expect(captured.stderr.join('')).toMatch(/DATABASE_URL is not set/);
  });
});

describe('runLoginCommand — happy path', () => {
  beforeEach(() => {
    writeEnv(FULL_ENV);
  });

  it('opens browser with cli-login URL containing port + state', async () => {
    const { io, captured } = makeIO();
    mockStartListener.mockResolvedValue({
      port: 50001,
      tokenPromise: Promise.resolve('jwt-token'),
      close: () => undefined,
    });
    mockOpenBrowser.mockReturnValue(true);
    mockWriteToken.mockResolvedValue(fakeClaims());

    await expect(runLoginCommand({ home: homeDir, env: { COODRA_HOME: homeDir } }, io)).rejects.toThrow(
      /__exit__:0/,
    );

    expect(mockOpenBrowser).toHaveBeenCalledOnce();
    const url = mockOpenBrowser.mock.calls[0]?.[0] as string;
    expect(url).toContain('/auth/cli-login?port=50001');
    expect(url).toContain('state=');
    expect(captured.exit).toBe(0);
  });

  it('writes the token via shared/auth and prints confirmation', async () => {
    const { io, captured } = makeIO();
    mockStartListener.mockResolvedValue({
      port: 50002,
      tokenPromise: Promise.resolve('jwt-good'),
      close: () => undefined,
    });
    mockOpenBrowser.mockReturnValue(true);
    mockWriteToken.mockResolvedValue(fakeClaims({ email: 'me@team.com', role: 'member' }));

    await expect(runLoginCommand({ home: homeDir, env: { COODRA_HOME: homeDir } }, io)).rejects.toThrow(
      /__exit__:0/,
    );

    expect(mockWriteToken).toHaveBeenCalledWith('jwt-good', expect.stringContaining('http'), { homeOverride: homeDir });
    expect(captured.stdout.join('')).toMatch(/Signed in as.*me@team\.com/);
    expect(captured.stdout.join('')).toMatch(/member/);
  });

  it('honors --no-open by printing the URL instead of opening browser', async () => {
    const { io, captured } = makeIO();
    mockStartListener.mockResolvedValue({
      port: 50003,
      tokenPromise: Promise.resolve('jwt'),
      close: () => undefined,
    });
    mockWriteToken.mockResolvedValue(fakeClaims());

    await expect(
      runLoginCommand({ home: homeDir, env: { COODRA_HOME: homeDir }, noOpen: true }, io),
    ).rejects.toThrow(/__exit__:0/);

    expect(mockOpenBrowser).not.toHaveBeenCalled();
    expect(captured.stdout.join('')).toMatch(/Open this URL/);
  });

  it('honors --web-url override', async () => {
    const { io } = makeIO();
    mockStartListener.mockResolvedValue({
      port: 50004,
      tokenPromise: Promise.resolve('jwt'),
      close: () => undefined,
    });
    mockOpenBrowser.mockReturnValue(true);
    mockWriteToken.mockResolvedValue(fakeClaims());

    await expect(
      runLoginCommand({ home: homeDir, env: { COODRA_HOME: homeDir }, webUrl: 'https://team.example.com' }, io),
    ).rejects.toThrow(/__exit__:0/);

    const url = mockOpenBrowser.mock.calls[0]?.[0] as string;
    expect(url.startsWith('https://team.example.com/auth/cli-login')).toBe(true);
  });
});

describe('runLoginCommand — failure paths', () => {
  beforeEach(() => {
    writeEnv(FULL_ENV);
  });

  it('exits non-zero on browser-handoff timeout', async () => {
    const { BrowserHandoffError } = await import('../../../src/lib/browser-handoff.js');
    const { io, captured } = makeIO();
    mockStartListener.mockResolvedValue({
      port: 50005,
      tokenPromise: Promise.reject(new BrowserHandoffError('timeout', 'browser handoff timed out after 300s')),
      close: () => undefined,
    });
    mockOpenBrowser.mockReturnValue(true);
    await expect(runLoginCommand({ home: homeDir, env: { COODRA_HOME: homeDir } }, io)).rejects.toThrow(/__exit__/);
    expect(captured.exit).not.toBe(0);
    expect(captured.stderr.join('')).toMatch(/timed out/);
  });

  it('exits non-zero on state mismatch', async () => {
    const { BrowserHandoffError } = await import('../../../src/lib/browser-handoff.js');
    const { io, captured } = makeIO();
    mockStartListener.mockResolvedValue({
      port: 50006,
      tokenPromise: Promise.reject(new BrowserHandoffError('state_mismatch', 'state mismatch')),
      close: () => undefined,
    });
    mockOpenBrowser.mockReturnValue(true);
    await expect(runLoginCommand({ home: homeDir, env: { COODRA_HOME: homeDir } }, io)).rejects.toThrow(/__exit__/);
    expect(captured.stderr.join('')).toMatch(/state mismatch/);
  });

  it('exits non-zero when writeToken throws (JWT template missing, etc.)', async () => {
    const { io, captured } = makeIO();
    mockStartListener.mockResolvedValue({
      port: 50007,
      tokenPromise: Promise.resolve('bad-jwt'),
      close: () => undefined,
    });
    mockOpenBrowser.mockReturnValue(true);
    mockWriteToken.mockRejectedValue(new Error('JWT signature invalid'));
    await expect(runLoginCommand({ home: homeDir, env: { COODRA_HOME: homeDir } }, io)).rejects.toThrow(/__exit__/);
    expect(captured.exit).not.toBe(0);
    expect(captured.stderr.join('')).toMatch(/JWT/);
  });
});
