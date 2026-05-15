import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase G slice G.6 — `apps/mcp-server/src/lib/actor-identity.ts` tests.
 *
 * Two dependencies are mocked at module load:
 *   - `@coodra/shared/auth::readVerifiedToken` — controls
 *     whether a Clerk JWT exists + verifies on this machine.
 *   - `@coodra/cli/lib/team-config::readTeamConfig` —
 *     controls the legacy config.json::team block (deprecation
 *     fallback).
 *
 * The two-tier trust hierarchy is exercised across:
 *   - Verified token present → `source: 'clerk'`
 *   - Verified token absent + legacy config team block → `source: 'config'`
 *   - Solo mode → null
 *   - `requireActorIdentityForTeamMode` strict path → refuses without token
 */

const mockReadVerifiedToken = vi.hoisted(() => vi.fn());
const mockReadTeamConfig = vi.hoisted(() => vi.fn());

vi.mock('@coodra/shared/auth', async () => {
  const actual = await vi.importActual<typeof import('@coodra/shared/auth')>(
    '@coodra/shared/auth',
  );
  return {
    ...actual,
    readVerifiedToken: mockReadVerifiedToken,
  };
});

vi.mock('@coodra/cli/lib/team-config', async () => ({
  readTeamConfig: mockReadTeamConfig,
}));

const { getActorIdentity, requireActorIdentityForTeamMode } = await import('../../../src/lib/actor-identity.js');

function clerkClaims(overrides: Partial<{ userId: string; orgId: string; role: string; email: string | null }> = {}) {
  return {
    userId: overrides.userId ?? 'user_abc',
    orgId: overrides.orgId ?? 'org_xyz',
    role: (overrides.role as 'admin' | 'member' | 'viewer') ?? 'admin',
    email: overrides.email !== undefined ? overrides.email : 'admin@example.com',
    issuer: 'https://wise-bat-12.clerk.accounts.dev',
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600 * 1000),
  };
}

beforeEach(() => {
  mockReadVerifiedToken.mockReset();
  mockReadTeamConfig.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('getActorIdentity', () => {
  it('returns clerk-sourced identity when verified token exists', async () => {
    mockReadVerifiedToken.mockResolvedValue(clerkClaims());
    mockReadTeamConfig.mockReturnValue({ mode: 'team', team: { clerkUserId: 'stale_user', clerkOrgId: 'stale_org', localHookSecret: 'x', joinedAt: 0 } });

    const id = await getActorIdentity();
    expect(id).toEqual({ userId: 'user_abc', orgId: 'org_xyz', source: 'clerk' });
    // Clerk source wins over legacy config.json even when both are present
    expect(id?.source).toBe('clerk');
  });

  it('falls back to legacy config.json when no verified token', async () => {
    mockReadVerifiedToken.mockResolvedValue(null);
    mockReadTeamConfig.mockReturnValue({
      mode: 'team',
      team: { clerkUserId: 'user_legacy', clerkOrgId: 'org_legacy', localHookSecret: 'x', joinedAt: 0 },
    });
    const id = await getActorIdentity();
    expect(id).toEqual({ userId: 'user_legacy', orgId: 'org_legacy', source: 'config' });
  });

  it('returns null in solo mode', async () => {
    mockReadVerifiedToken.mockResolvedValue(null);
    mockReadTeamConfig.mockReturnValue({ mode: 'solo' });
    expect(await getActorIdentity()).toBeNull();
  });

  it('returns null in team mode with no credential at all', async () => {
    mockReadVerifiedToken.mockResolvedValue(null);
    mockReadTeamConfig.mockReturnValue({ mode: 'team' }); // no team block
    expect(await getActorIdentity()).toBeNull();
  });

  it('falls back to legacy config when readVerifiedToken throws', async () => {
    mockReadVerifiedToken.mockRejectedValue(new Error('jwks fetch failed'));
    mockReadTeamConfig.mockReturnValue({
      mode: 'team',
      team: { clerkUserId: 'user_legacy', clerkOrgId: 'org_legacy', localHookSecret: 'x', joinedAt: 0 },
    });
    const id = await getActorIdentity();
    expect(id?.source).toBe('config');
  });
});

describe('requireActorIdentityForTeamMode', () => {
  it('returns identity:null in solo mode (no auth required)', async () => {
    mockReadTeamConfig.mockReturnValue({ mode: 'solo' });
    const result = await requireActorIdentityForTeamMode();
    expect(result).toEqual({ kind: 'identity', actor: null });
    expect(mockReadVerifiedToken).not.toHaveBeenCalled();
  });

  it('returns identity:clerk in team mode with verified token', async () => {
    mockReadTeamConfig.mockReturnValue({ mode: 'team', team: { clerkUserId: 'unused', clerkOrgId: 'unused', localHookSecret: 'x', joinedAt: 0 } });
    mockReadVerifiedToken.mockResolvedValue(clerkClaims({ userId: 'user_real', orgId: 'org_real' }));
    const result = await requireActorIdentityForTeamMode();
    expect(result).toEqual({
      kind: 'identity',
      actor: { userId: 'user_real', orgId: 'org_real', source: 'clerk' },
    });
  });

  it('returns auth_required in team mode with no verified token (legacy config IS NOT acceptable)', async () => {
    mockReadTeamConfig.mockReturnValue({
      mode: 'team',
      team: { clerkUserId: 'user_legacy', clerkOrgId: 'org_legacy', localHookSecret: 'x', joinedAt: 0 },
    });
    mockReadVerifiedToken.mockResolvedValue(null);
    const result = await requireActorIdentityForTeamMode();
    expect(result.kind).toBe('auth_required');
    if (result.kind === 'auth_required') {
      expect(result.howToFix).toMatch(/coodra login/);
    }
  });

  it('returns auth_required when readVerifiedToken throws', async () => {
    mockReadTeamConfig.mockReturnValue({ mode: 'team', team: { clerkUserId: 'x', clerkOrgId: 'y', localHookSecret: 'z', joinedAt: 0 } });
    mockReadVerifiedToken.mockRejectedValue(new Error('network'));
    const result = await requireActorIdentityForTeamMode();
    expect(result.kind).toBe('auth_required');
  });
});
