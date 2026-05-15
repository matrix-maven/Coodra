import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase G slice G.7 — `apps/hooks-bridge/src/lib/actor-identity.ts` tests.
 *
 * The bridge's actor-identity resolver reads `~/.coodra/clerk-token.json::
 * claimsMirror` (Phase G primary path) with a config.json::team
 * fallback. The function is SYNCHRONOUS — bridge hot-path constraint.
 *
 * We mock `readTeamConfig` and use a real temp dir for the token file
 * (the resolver reads disk directly to keep it fast).
 */

const mockReadTeamConfig = vi.hoisted(() => vi.fn());

vi.mock('@coodra/cli/lib/team-config', async () => ({
  readTeamConfig: mockReadTeamConfig,
}));

let homeDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'bridge-actor-test-'));
  mkdirSync(homeDir, { recursive: true });
  prevHome = process.env.COODRA_HOME;
  process.env.COODRA_HOME = homeDir;
  mockReadTeamConfig.mockReset();
});

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.COODRA_HOME;
  } else {
    process.env.COODRA_HOME = prevHome;
  }
});

const { getActorIdentity } = await import('../../../src/lib/actor-identity.js');

function writeClerkTokenMirror(opts: { userId?: string; orgId?: string; expiresOffsetMs?: number; omitMirror?: boolean } = {}): void {
  const stored = {
    version: 1,
    token: 'jwt.body.sig',
    webUrl: 'http://localhost:3001',
    fetchedAt: Date.now(),
    ...(opts.omitMirror === true
      ? {}
      : {
          claimsMirror: {
            userId: opts.userId ?? 'user_abc',
            orgId: opts.orgId ?? 'org_xyz',
            role: 'admin',
            email: 'admin@example.com',
            expiresAt: new Date(Date.now() + (opts.expiresOffsetMs ?? 3600 * 1000)).toISOString(),
          },
        }),
  };
  writeFileSync(join(homeDir, 'clerk-token.json'), JSON.stringify(stored, null, 2), { mode: 0o600 });
}

describe('getActorIdentity — Phase G primary path (clerk-token.json)', () => {
  it('returns clerk-sourced identity from claimsMirror', () => {
    writeClerkTokenMirror({ userId: 'user_real', orgId: 'org_real' });
    mockReadTeamConfig.mockReturnValue({ mode: 'team', team: { clerkUserId: 'stale', clerkOrgId: 'stale', localHookSecret: 'x', joinedAt: 0 } });

    const id = getActorIdentity();
    expect(id).toEqual({ userId: 'user_real', orgId: 'org_real', source: 'clerk' });
    // Clerk source must win over the legacy config.json
    expect(id?.source).toBe('clerk');
  });

  it('refuses to use a mirror with expiry in the past', () => {
    writeClerkTokenMirror({ expiresOffsetMs: -60_000 });
    mockReadTeamConfig.mockReturnValue({ mode: 'solo' });
    expect(getActorIdentity()).toBeNull();
  });

  it('falls back to legacy config when mirror is missing', () => {
    writeClerkTokenMirror({ omitMirror: true });
    mockReadTeamConfig.mockReturnValue({ mode: 'team', team: { clerkUserId: 'user_legacy', clerkOrgId: 'org_legacy', localHookSecret: 'x', joinedAt: 0 } });
    const id = getActorIdentity();
    expect(id).toEqual({ userId: 'user_legacy', orgId: 'org_legacy', source: 'config' });
  });
});

describe('getActorIdentity — legacy fallback', () => {
  it('returns config.json team values when no clerk-token.json', () => {
    mockReadTeamConfig.mockReturnValue({ mode: 'team', team: { clerkUserId: 'user_legacy', clerkOrgId: 'org_legacy', localHookSecret: 'x', joinedAt: 0 } });
    expect(getActorIdentity()).toEqual({ userId: 'user_legacy', orgId: 'org_legacy', source: 'config' });
  });

  it('returns null when no clerk-token.json + solo config', () => {
    mockReadTeamConfig.mockReturnValue({ mode: 'solo' });
    expect(getActorIdentity()).toBeNull();
  });

  it('returns null when both clerk-token.json and config are absent', () => {
    mockReadTeamConfig.mockReturnValue({ mode: 'solo' });
    expect(getActorIdentity()).toBeNull();
  });
});

describe('getActorIdentity — malformed file handling', () => {
  it('falls back when clerk-token.json is unparseable JSON', () => {
    writeFileSync(join(homeDir, 'clerk-token.json'), '{ not json', { mode: 0o600 });
    mockReadTeamConfig.mockReturnValue({ mode: 'team', team: { clerkUserId: 'user_legacy', clerkOrgId: 'org_legacy', localHookSecret: 'x', joinedAt: 0 } });
    const id = getActorIdentity();
    expect(id?.source).toBe('config');
  });
});
