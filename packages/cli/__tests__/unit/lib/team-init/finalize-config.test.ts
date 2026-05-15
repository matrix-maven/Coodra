import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readTeamConfig, readTeamHomeEnv } from '../../../../src/lib/team-config.js';
import { finalizeConfig } from '../../../../src/lib/team-init/finalize-config.js';

/**
 * Phase B (clarity-pass-plan, 2026-05-11) — finalizeConfig writes the
 * two files (`config.json` + `.env`) atomically and returns the paths
 * + the secret. Tests cover:
 *   1. Default generated secret has 64 hex chars.
 *   2. Supplied secret is passed through verbatim.
 *   3. config.json round-trips via readTeamConfig.
 *   4. .env round-trips via readTeamHomeEnv.
 *   5. clerkOrgSlug=null is correctly omitted from the team block.
 */

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'finalize-config-'));
  mkdirSync(homeDir, { recursive: true });
});

describe('finalizeConfig', () => {
  it('generates a 64-char hex secret when none is supplied', () => {
    const result = finalizeConfig({
      databaseUrl: 'postgres://x:y@h/d',
      clerkUserId: 'user_a',
      clerkOrgId: 'org_a',
      clerkOrgSlug: 'acme',
      homeOverride: homeDir,
    });
    expect(result.localHookSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('passes through a supplied localHookSecret', () => {
    const supplied = 'b'.repeat(64);
    const result = finalizeConfig({
      databaseUrl: 'postgres://x:y@h/d',
      clerkUserId: 'user_a',
      clerkOrgId: 'org_a',
      clerkOrgSlug: 'acme',
      localHookSecret: supplied,
      homeOverride: homeDir,
    });
    expect(result.localHookSecret).toBe(supplied);
  });

  it('writes config.json that readTeamConfig can round-trip', () => {
    finalizeConfig({
      databaseUrl: 'postgres://x:y@h/d',
      clerkUserId: 'user_a',
      clerkOrgId: 'org_a',
      clerkOrgSlug: 'acme',
      localHookSecret: 'c'.repeat(64),
      homeOverride: homeDir,
    });
    const cfg = readTeamConfig({ homeOverride: homeDir });
    expect(cfg.mode).toBe('team');
    expect(cfg.team?.clerkUserId).toBe('user_a');
    expect(cfg.team?.clerkOrgId).toBe('org_a');
    expect(cfg.team?.clerkOrgSlug).toBe('acme');
    expect(cfg.team?.localHookSecret).toBe('c'.repeat(64));
  });

  it('writes ~/.coodra/.env that readTeamHomeEnv can round-trip', () => {
    finalizeConfig({
      databaseUrl: 'postgres://x:y@h.example/d',
      clerkUserId: 'user_a',
      clerkOrgId: 'org_a',
      clerkOrgSlug: null,
      localHookSecret: 'd'.repeat(64),
      homeOverride: homeDir,
    });
    const env = readTeamHomeEnv({ homeOverride: homeDir });
    expect(env).not.toBeNull();
    expect(env?.databaseUrl).toBe('postgres://x:y@h.example/d');
    expect(env?.localHookSecret).toBe('d'.repeat(64));
    expect(env?.clerkOrgId).toBe('org_a');
    // The .env file must actually exist on disk.
    expect(existsSync(join(homeDir, '.env'))).toBe(true);
  });

  it('omits clerkOrgSlug from the team block when null', () => {
    finalizeConfig({
      databaseUrl: 'postgres://x:y@h/d',
      clerkUserId: 'user_a',
      clerkOrgId: 'org_a',
      clerkOrgSlug: null,
      localHookSecret: 'e'.repeat(64),
      homeOverride: homeDir,
    });
    const raw = readFileSync(join(homeDir, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { team?: { clerkOrgSlug?: unknown } };
    expect(parsed.team?.clerkOrgSlug).toBeUndefined();
  });
});
