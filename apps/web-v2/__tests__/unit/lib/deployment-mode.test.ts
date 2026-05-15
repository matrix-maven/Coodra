import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isCloudHostedWeb,
  resolveDeploymentMode,
  resolveIdentityMode,
} from '../../../lib/deployment-mode';

/**
 * Phase G slice G.8 — `apps/web-v2/lib/deployment-mode.ts` tests.
 *
 * Verifies the new two-mode helpers (`resolveIdentityMode`,
 * `isCloudHostedWeb`) AND the legacy three-mode `resolveDeploymentMode`
 * which is derived from the two new helpers.
 *
 * Mock the `team-config` import to control the laptop config.json
 * fallback path. Env vars are stubbed via vi.stubEnv.
 */

vi.mock('../../../lib/team-config', () => ({
  resolveEffectiveMode: vi.fn(() => 'solo'),
}));

const { resolveEffectiveMode } = await import('../../../lib/team-config');

beforeEach(() => {
  vi.stubEnv('COODRA_MODE', '');
  vi.stubEnv('COODRA_DEPLOYMENT', '');
  (resolveEffectiveMode as unknown as ReturnType<typeof vi.fn>).mockReturnValue('solo');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveIdentityMode — Phase G two-mode model', () => {
  it('returns solo when COODRA_MODE=solo', () => {
    vi.stubEnv('COODRA_MODE', 'solo');
    expect(resolveIdentityMode()).toBe('solo');
  });

  it('returns team when COODRA_MODE=team', () => {
    vi.stubEnv('COODRA_MODE', 'team');
    expect(resolveIdentityMode()).toBe('team');
  });

  it('falls back to config.json::mode when COODRA_MODE empty', () => {
    (resolveEffectiveMode as unknown as ReturnType<typeof vi.fn>).mockReturnValue('team');
    expect(resolveIdentityMode()).toBe('team');
  });

  it('returns solo when config.json::mode is solo', () => {
    (resolveEffectiveMode as unknown as ReturnType<typeof vi.fn>).mockReturnValue('solo');
    expect(resolveIdentityMode()).toBe('solo');
  });

  it('ignores invalid COODRA_MODE values', () => {
    vi.stubEnv('COODRA_MODE', 'garbage');
    (resolveEffectiveMode as unknown as ReturnType<typeof vi.fn>).mockReturnValue('team');
    expect(resolveIdentityMode()).toBe('team');
  });
});

describe('isCloudHostedWeb', () => {
  it('returns true when COODRA_DEPLOYMENT=team-hosted', () => {
    vi.stubEnv('COODRA_DEPLOYMENT', 'team-hosted');
    expect(isCloudHostedWeb()).toBe(true);
  });

  it('returns false for any other COODRA_DEPLOYMENT value', () => {
    vi.stubEnv('COODRA_DEPLOYMENT', 'local');
    expect(isCloudHostedWeb()).toBe(false);
  });

  it('returns false when COODRA_DEPLOYMENT unset', () => {
    expect(isCloudHostedWeb()).toBe(false);
  });
});

describe('resolveDeploymentMode (legacy, derived)', () => {
  it('solo + laptop → local-solo', () => {
    vi.stubEnv('COODRA_MODE', 'solo');
    expect(resolveDeploymentMode()).toBe('local-solo');
  });

  it('team + laptop → local-team', () => {
    vi.stubEnv('COODRA_MODE', 'team');
    expect(resolveDeploymentMode()).toBe('local-team');
  });

  it('team + cloud → team-hosted', () => {
    vi.stubEnv('COODRA_MODE', 'team');
    vi.stubEnv('COODRA_DEPLOYMENT', 'team-hosted');
    expect(resolveDeploymentMode()).toBe('team-hosted');
  });

  it('solo + cloud → team-hosted (legacy quirk: cloud always wins for legacy mode)', () => {
    vi.stubEnv('COODRA_MODE', 'solo');
    vi.stubEnv('COODRA_DEPLOYMENT', 'team-hosted');
    // The legacy resolveDeploymentMode returned team-hosted whenever
    // COODRA_DEPLOYMENT=team-hosted, regardless of MODE. We preserve
    // that for backward compat. Real deployments always set
    // COODRA_MODE=team alongside, so this edge is theoretical.
    expect(resolveDeploymentMode()).toBe('team-hosted');
  });
});
