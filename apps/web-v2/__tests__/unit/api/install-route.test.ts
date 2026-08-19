import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyClerkJwtAndExtractClaimsMock = vi.hoisted(() => vi.fn());
const verifyInviteTokenMock = vi.hoisted(() => vi.fn());
const getInviteByJtiMock = vi.hoisted(() => vi.fn());
const redeemInviteMock = vi.hoisted(() => vi.fn());

vi.mock('@coodra/shared/auth', () => ({
  verifyClerkJwtAndExtractClaims: verifyClerkJwtAndExtractClaimsMock,
}));

vi.mock('@/lib/deployment-mode', () => ({
  resolveIdentityMode: () => 'team',
}));

vi.mock('@/lib/invite-token', () => ({
  verifyInviteToken: verifyInviteTokenMock,
}));

vi.mock('@/lib/postgres-errors', () => ({
  isMissingTeamInvitesTableError: () => false,
}));

vi.mock('@/lib/public-url', () => ({
  resolveDeploymentBaseUrl: () => 'https://coodra.example',
}));

vi.mock('@/lib/queries/invites', () => ({
  getInviteByJti: getInviteByJtiMock,
  redeemInvite: redeemInviteMock,
}));

const { POST } = await import('@/app/api/install/[token]/route');

const payload = {
  v: 1 as const,
  jti: 'jti_install_test',
  org: 'org_invited',
  role: 'member' as const,
  email: 'dev@example.com',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iss: 'https://coodra.example',
};

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = 'sk_test_real';
  process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_real';
  verifyClerkJwtAndExtractClaimsMock.mockReset();
  verifyInviteTokenMock.mockReset();
  getInviteByJtiMock.mockReset();
  redeemInviteMock.mockReset();
  verifyInviteTokenMock.mockReturnValue({ ok: true, payload });
  getInviteByJtiMock.mockResolvedValue({
    jti: payload.jti,
    orgId: payload.org,
    revokedAt: null,
    usedAt: null,
  });
});

function routeParams() {
  return { params: Promise.resolve({ token: 'signed-invite-token' }) };
}

describe('/api/install/[token] POST auth boundary', () => {
  it('rejects invite redemption without a Clerk bearer token', async () => {
    const res = await POST(new Request('https://coodra.example/api/install/token', { method: 'POST' }), routeParams());
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: 'auth_required' });
    expect(verifyClerkJwtAndExtractClaimsMock).not.toHaveBeenCalled();
    expect(redeemInviteMock).not.toHaveBeenCalled();
  });

  it('rejects a signed-in user whose Clerk token does not match the invite email', async () => {
    verifyClerkJwtAndExtractClaimsMock.mockResolvedValue({
      userId: 'user_other',
      orgId: payload.org,
      email: 'other@example.com',
      role: 'member',
      issuer: 'https://clerk.example',
      expiresAt: Date.now() + 3600,
    });

    const res = await POST(
      new Request('https://coodra.example/api/install/token', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-but-wrong-user' },
      }),
      routeParams(),
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: 'invite_email_mismatch' });
    expect(redeemInviteMock).not.toHaveBeenCalled();
  });
});
