import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isDeploymentBaseUrlUnset, resolveDeploymentBaseUrl } from '../../../lib/public-url';

/**
 * Locks the 2026-05-18 invite-URL regression: a laptop admin running
 * `coodra start` (which sets `COODRA_HOME` + `PORT`) and minting an
 * invite via the CLI OR the web's Invite form used to produce a URL
 * with `https://COODRA_PUBLIC_URL_NOT_SET.invalid` baked into both the
 * host AND the JWT `iss` claim — the sentinel was reached because the
 * resolver had no fallback for local CLI invocation. Case 3 now resolves
 * to `http://localhost:${PORT}` when `COODRA_HOME` is present.
 */

describe('resolveDeploymentBaseUrl', () => {
  beforeEach(() => {
    vi.stubEnv('COODRA_PUBLIC_URL', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('COODRA_HOME', '');
    vi.stubEnv('PORT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('case 1 — COODRA_PUBLIC_URL wins outright', () => {
    vi.stubEnv('COODRA_PUBLIC_URL', 'https://team.coodra.example');
    vi.stubEnv('VERCEL_URL', 'should-be-ignored.vercel.app');
    vi.stubEnv('COODRA_HOME', '/should/be/ignored');
    expect(resolveDeploymentBaseUrl()).toBe('https://team.coodra.example');
  });

  it('case 1 — trailing slash is stripped', () => {
    vi.stubEnv('COODRA_PUBLIC_URL', 'https://team.coodra.example/');
    expect(resolveDeploymentBaseUrl()).toBe('https://team.coodra.example');
  });

  it('case 2 — VERCEL_URL is prefixed with https://', () => {
    vi.stubEnv('VERCEL_URL', 'coodra-pr-42.vercel.app');
    expect(resolveDeploymentBaseUrl()).toBe('https://coodra-pr-42.vercel.app');
  });

  it('case 3 — COODRA_HOME resolves to http://localhost on the resolved PORT', () => {
    vi.stubEnv('COODRA_HOME', '/Users/admin/.coodra');
    vi.stubEnv('PORT', '3001');
    expect(resolveDeploymentBaseUrl()).toBe('http://localhost:3001');
  });

  it('case 3 — COODRA_HOME without PORT defaults to 3001', () => {
    vi.stubEnv('COODRA_HOME', '/Users/admin/.coodra');
    // PORT intentionally empty
    expect(resolveDeploymentBaseUrl()).toBe('http://localhost:3001');
  });

  it('case 3 — honors a non-default PORT', () => {
    vi.stubEnv('COODRA_HOME', '/Users/admin/.coodra');
    vi.stubEnv('PORT', '4242');
    expect(resolveDeploymentBaseUrl()).toBe('http://localhost:4242');
  });

  it('case 4 — sentinel fires when no env signal is present', () => {
    // All env vars are empty per beforeEach
    expect(resolveDeploymentBaseUrl()).toBe('https://COODRA_PUBLIC_URL_NOT_SET.invalid');
  });
});

describe('isDeploymentBaseUrlUnset', () => {
  beforeEach(() => {
    vi.stubEnv('COODRA_PUBLIC_URL', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('COODRA_HOME', '');
    vi.stubEnv('PORT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns true only when the sentinel is reached', () => {
    expect(isDeploymentBaseUrlUnset()).toBe(true);
  });

  it('returns false when COODRA_PUBLIC_URL is set', () => {
    vi.stubEnv('COODRA_PUBLIC_URL', 'https://team.coodra.example');
    expect(isDeploymentBaseUrlUnset()).toBe(false);
  });

  it('returns false when VERCEL_URL is set', () => {
    vi.stubEnv('VERCEL_URL', 'foo.vercel.app');
    expect(isDeploymentBaseUrlUnset()).toBe(false);
  });

  it('returns false when the COODRA_HOME local fallback is hit — laptop installs are not "unset"', () => {
    vi.stubEnv('COODRA_HOME', '/Users/admin/.coodra');
    expect(isDeploymentBaseUrlUnset()).toBe(false);
  });
});
