import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearTeamHomeEnv,
  demoteToSoloConfig,
  readTeamConfig,
  readTeamHomeEnv,
  type TeamBlock,
  updateLastPulledAt,
  upgradeToTeamConfig,
  writeTeamConfig,
  writeTeamHomeEnv,
} from '../../../src/lib/team-config.js';

/**
 * Module 04 Phase 4 — team-config reader/writer.
 *
 * Verifies:
 *   1. readTeamConfig returns SOLO_CONFIG on missing file / corrupt JSON / mode!=team / partial team block.
 *   2. writeTeamConfig is atomic — partial-write does not leave a half-formed file visible.
 *   3. upgradeToTeamConfig + demoteToSoloConfig round-trip correctly.
 *   4. updateLastPulledAt merges per-table timestamps without clobbering siblings.
 */

let homeDir: string;

function makeTeamBlock(over: Partial<TeamBlock> = {}): TeamBlock {
  return {
    clerkUserId: 'user_alice',
    clerkOrgId: 'org_acme',
    clerkOrgSlug: 'acme',
    localHookSecret: 'secret_xyz',
    joinedAt: 1_700_000_000_000,
    ...over,
  };
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'team-config-'));
  mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  // tmpdir cleanup is best-effort; tests are isolated by mkdtemp prefix.
});

describe('readTeamConfig', () => {
  it('returns mode=solo when the config file is missing', () => {
    const cfg = readTeamConfig({ homeOverride: homeDir });
    expect(cfg.mode).toBe('solo');
    expect(cfg.team).toBeUndefined();
  });

  it('returns mode=solo when the file is empty', () => {
    writeFileSync(join(homeDir, 'config.json'), '', 'utf8');
    expect(readTeamConfig({ homeOverride: homeDir }).mode).toBe('solo');
  });

  it('returns mode=solo when JSON is malformed', () => {
    writeFileSync(join(homeDir, 'config.json'), '{not-json', 'utf8');
    expect(readTeamConfig({ homeOverride: homeDir }).mode).toBe('solo');
  });

  it("returns mode=solo when the JSON's mode is 'solo'", () => {
    writeFileSync(join(homeDir, 'config.json'), JSON.stringify({ mode: 'solo' }), 'utf8');
    expect(readTeamConfig({ homeOverride: homeDir }).mode).toBe('solo');
  });

  it('returns mode=solo when team block is missing required fields', () => {
    writeFileSync(
      join(homeDir, 'config.json'),
      JSON.stringify({ mode: 'team', team: { clerkUserId: 'user_x' } }),
      'utf8',
    );
    expect(readTeamConfig({ homeOverride: homeDir }).mode).toBe('solo');
  });

  it('returns mode=team when every required field is present', () => {
    upgradeToTeamConfig(makeTeamBlock(), { homeOverride: homeDir });
    const cfg = readTeamConfig({ homeOverride: homeDir });
    expect(cfg.mode).toBe('team');
    expect(cfg.team?.clerkUserId).toBe('user_alice');
    expect(cfg.team?.clerkOrgId).toBe('org_acme');
    expect(cfg.team?.localHookSecret).toBe('secret_xyz');
    expect(cfg.team?.joinedAt).toBe(1_700_000_000_000);
  });

  it('tolerates unknown top-level keys', () => {
    writeFileSync(
      join(homeDir, 'config.json'),
      JSON.stringify({
        mode: 'team',
        team: makeTeamBlock(),
        someUnknownKey: 'tolerated',
      }),
      'utf8',
    );
    expect(readTeamConfig({ homeOverride: homeDir }).mode).toBe('team');
  });
});

describe('writeTeamConfig + atomicity', () => {
  it('round-trips through write+read', () => {
    writeTeamConfig({ mode: 'team', team: makeTeamBlock() }, { homeOverride: homeDir });
    const cfg = readTeamConfig({ homeOverride: homeDir });
    expect(cfg.mode).toBe('team');
    expect(cfg.team?.clerkOrgSlug).toBe('acme');
  });

  it('tmp file does not linger after a successful write', () => {
    writeTeamConfig({ mode: 'team', team: makeTeamBlock() }, { homeOverride: homeDir });
    const main = readFileSync(join(homeDir, 'config.json'), 'utf8');
    expect(main).toContain('"mode": "team"');
    expect(() => readFileSync(join(homeDir, 'config.json.tmp'), 'utf8')).toThrow();
  });
});

describe('upgradeToTeamConfig + demoteToSoloConfig', () => {
  it('upgrade then demote leaves mode=solo with no team block', () => {
    upgradeToTeamConfig(makeTeamBlock(), { homeOverride: homeDir });
    expect(readTeamConfig({ homeOverride: homeDir }).mode).toBe('team');
    demoteToSoloConfig({ homeOverride: homeDir });
    const cfg = readTeamConfig({ homeOverride: homeDir });
    expect(cfg.mode).toBe('solo');
    expect(cfg.team).toBeUndefined();
  });

  it('upgrade overwrites existing team block (reauth scenario)', () => {
    upgradeToTeamConfig(makeTeamBlock({ clerkUserId: 'user_alice' }), { homeOverride: homeDir });
    upgradeToTeamConfig(makeTeamBlock({ clerkUserId: 'user_bob' }), { homeOverride: homeDir });
    expect(readTeamConfig({ homeOverride: homeDir }).team?.clerkUserId).toBe('user_bob');
  });
});

describe('updateLastPulledAt', () => {
  it('no-ops in solo mode (no team block to update)', () => {
    updateLastPulledAt('decisions', 12345, { homeOverride: homeDir });
    expect(readTeamConfig({ homeOverride: homeDir }).mode).toBe('solo');
  });

  it('merges new timestamps without clobbering siblings', () => {
    upgradeToTeamConfig(makeTeamBlock(), { homeOverride: homeDir });
    updateLastPulledAt('decisions', 1000, { homeOverride: homeDir });
    updateLastPulledAt('context_packs', 2000, { homeOverride: homeDir });
    const cfg = readTeamConfig({ homeOverride: homeDir });
    expect(cfg.team?.lastPulledAt?.decisions).toBe(1000);
    expect(cfg.team?.lastPulledAt?.context_packs).toBe(2000);
  });

  it('overwrites the same table when called twice', () => {
    upgradeToTeamConfig(makeTeamBlock(), { homeOverride: homeDir });
    updateLastPulledAt('decisions', 1000, { homeOverride: homeDir });
    updateLastPulledAt('decisions', 2000, { homeOverride: homeDir });
    expect(readTeamConfig({ homeOverride: homeDir }).team?.lastPulledAt?.decisions).toBe(2000);
  });
});

describe('writeTeamHomeEnv + readTeamHomeEnv + clearTeamHomeEnv', () => {
  const sampleInput = {
    databaseUrl: 'postgres://user:pass@host:5432/db',
    localHookSecret: 'a'.repeat(64),
    clerkOrgId: 'org_acme',
  };

  it('writes a valid env file containing the four team keys', () => {
    writeTeamHomeEnv(sampleInput, { homeOverride: homeDir });
    const envPath = join(homeDir, '.env');
    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain('COODRA_MODE=team');
    expect(content).toContain(`DATABASE_URL=${sampleInput.databaseUrl}`);
    expect(content).toContain(`LOCAL_HOOK_SECRET=${sampleInput.localHookSecret}`);
    expect(content).toContain(`COODRA_TEAM_ORG_ID=${sampleInput.clerkOrgId}`);
  });

  it('readTeamHomeEnv round-trips the values', () => {
    writeTeamHomeEnv(sampleInput, { homeOverride: homeDir });
    const back = readTeamHomeEnv({ homeOverride: homeDir });
    expect(back).not.toBeNull();
    expect(back?.databaseUrl).toBe(sampleInput.databaseUrl);
    expect(back?.localHookSecret).toBe(sampleInput.localHookSecret);
    expect(back?.clerkOrgId).toBe(sampleInput.clerkOrgId);
  });

  it('preserves user-managed entries on update', () => {
    const envPath = join(homeDir, '.env');
    writeFileSync(envPath, 'MY_CUSTOM_VAR=hello\nANOTHER=world\n', 'utf8');
    writeTeamHomeEnv(sampleInput, { homeOverride: homeDir });
    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain('MY_CUSTOM_VAR=hello');
    expect(content).toContain('ANOTHER=world');
    expect(content).toContain('COODRA_MODE=team');
  });

  it('overwrites prior values for managed keys (re-run idempotent)', () => {
    writeTeamHomeEnv(sampleInput, { homeOverride: homeDir });
    writeTeamHomeEnv({ ...sampleInput, localHookSecret: 'b'.repeat(64) }, { homeOverride: homeDir });
    const back = readTeamHomeEnv({ homeOverride: homeDir });
    expect(back?.localHookSecret).toBe('b'.repeat(64));
    // No duplicates.
    const content = readFileSync(join(homeDir, '.env'), 'utf8');
    const lhsMatches = content.match(/LOCAL_HOOK_SECRET=/g) ?? [];
    expect(lhsMatches).toHaveLength(1);
  });

  it('readTeamHomeEnv returns null when COODRA_MODE!=team', () => {
    const envPath = join(homeDir, '.env');
    writeFileSync(envPath, 'COODRA_MODE=solo\nDATABASE_URL=postgres://x\n', 'utf8');
    expect(readTeamHomeEnv({ homeOverride: homeDir })).toBeNull();
  });

  it('readTeamHomeEnv returns null when DATABASE_URL is missing even if mode=team', () => {
    const envPath = join(homeDir, '.env');
    writeFileSync(envPath, 'COODRA_MODE=team\n', 'utf8');
    expect(readTeamHomeEnv({ homeOverride: homeDir })).toBeNull();
  });

  it('clearTeamHomeEnv removes only managed keys, preserves others', () => {
    const envPath = join(homeDir, '.env');
    writeFileSync(envPath, 'MY_CUSTOM_VAR=hello\n', 'utf8');
    writeTeamHomeEnv(sampleInput, { homeOverride: homeDir });
    clearTeamHomeEnv({ homeOverride: homeDir });
    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain('MY_CUSTOM_VAR=hello');
    expect(content).not.toContain('COODRA_MODE');
    expect(content).not.toContain('DATABASE_URL');
    expect(content).not.toContain('LOCAL_HOOK_SECRET');
    expect(readTeamHomeEnv({ homeOverride: homeDir })).toBeNull();
  });

  it('clearTeamHomeEnv is a no-op when ~/.coodra/.env is missing', () => {
    expect(() => clearTeamHomeEnv({ homeOverride: homeDir })).not.toThrow();
  });
});
