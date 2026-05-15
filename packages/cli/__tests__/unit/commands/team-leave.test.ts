import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TeamCommandIO } from '../../../src/commands/team.js';
import { runTeamLeaveCommand } from '../../../src/commands/team-migrate-cmd.js';
import { readTeamConfig, upgradeToTeamConfig, writeTeamHomeEnv } from '../../../src/lib/team-config.js';

/**
 * Phase C (clarity-pass-plan, 2026-05-11) — `coodra team leave` typed-
 * confirmation flow.
 *
 * The leave command was previously a single `--yes` boolean gate. Phase C
 * adds:
 *
 *   1. An always-printed "what stays / what goes" block so the operator
 *      can never confuse `leave` with "delete history".
 *   2. A typed-confirmation prompt — must literally type
 *      `leave <orgname>` — to prevent muscle-memory `--yes` mistakes.
 *      `--yes` still skips the prompt for CI / automation.
 *   3. A solo-mode short-circuit: `leave` refuses immediately when
 *      the machine is already in solo mode.
 *
 * These tests exercise every branch via an in-memory IO + a stubbed
 * `readConfirm` callback so no stdin / TTY mocking is required.
 */

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

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'team-leave-'));
  mkdirSync(homeDir, { recursive: true });
  prevHome = process.env.COODRA_HOME;
  process.env.COODRA_HOME = homeDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.COODRA_HOME;
  else process.env.COODRA_HOME = prevHome;
});

const NO_SLUG = Symbol('no-slug');
function seedTeamMode(orgSlug: string | typeof NO_SLUG = 'acme'): void {
  const slug = orgSlug === NO_SLUG ? undefined : orgSlug;
  upgradeToTeamConfig(
    {
      clerkUserId: 'user_alice',
      clerkOrgId: 'org_acme',
      ...(slug !== undefined ? { clerkOrgSlug: slug } : {}),
      localHookSecret: 'a'.repeat(64),
      joinedAt: Date.now(),
    },
    { homeOverride: homeDir },
  );
  writeTeamHomeEnv(
    { databaseUrl: 'postgres://x:y@host/db', localHookSecret: 'a'.repeat(64), clerkOrgId: 'org_acme' },
    { homeOverride: homeDir },
  );
}

describe('runTeamLeaveCommand', () => {
  it('refuses immediately when the machine is already in solo mode', async () => {
    // No team config seeded — readTeamConfig returns SOLO_CONFIG.
    const { io, captured } = makeIO();
    await expect(runTeamLeaveCommand({}, io)).rejects.toThrow('__exit__:');
    expect(captured.exit).not.toBe(0);
    const err = captured.stderr.join('');
    expect(err).toContain('already in solo mode');
    expect(err).toContain('nothing to leave');
    // Config file still SOLO — leave did not write anything.
    expect(readTeamConfig({ homeOverride: homeDir }).mode).toBe('solo');
  });

  it('--yes path: prints stays/goes block and demotes config + clears env', async () => {
    seedTeamMode('acme');
    const { io, captured } = makeIO();
    await expect(runTeamLeaveCommand({ yes: true }, io)).rejects.toThrow('__exit__:0');
    expect(captured.exit).toBe(0);

    const out = captured.stdout.join('');
    // "what stays / goes" block must appear in BOTH paths.
    expect(out).toContain('What gets removed');
    expect(out).toContain('mode → solo');
    expect(out).toContain('What stays');
    expect(out).toContain('historical state intact');
    // Config demoted.
    expect(readTeamConfig({ homeOverride: homeDir }).mode).toBe('solo');
    // Home .env stripped of team keys.
    const envBody = readFileSync(join(homeDir, '.env'), 'utf8');
    expect(envBody).not.toContain('COODRA_MODE=');
    expect(envBody).not.toContain('DATABASE_URL=');
  });

  it('interactive path: typed confirmation matching the org slug → demotes', async () => {
    seedTeamMode('phase-1');
    const { io, captured } = makeIO();
    await expect(runTeamLeaveCommand({ readConfirm: async () => 'leave phase-1' }, io)).rejects.toThrow('__exit__:0');
    expect(captured.exit).toBe(0);
    expect(readTeamConfig({ homeOverride: homeDir }).mode).toBe('solo');
  });

  it('interactive path: typed confirmation mismatch → aborts, no state change', async () => {
    seedTeamMode('phase-1');
    const { io, captured } = makeIO();
    await expect(runTeamLeaveCommand({ readConfirm: async () => 'oops' }, io)).rejects.toThrow('__exit__:');
    expect(captured.exit).not.toBe(0);
    expect(captured.stderr.join('')).toContain('did not match');
    expect(captured.stderr.join('')).toContain('aborted');
    // Config UNCHANGED — leave was aborted.
    expect(readTeamConfig({ homeOverride: homeDir }).mode).toBe('team');
  });

  it('falls back to clerkOrgId when the team block has no clerkOrgSlug', async () => {
    seedTeamMode(NO_SLUG); // no slug
    const { io, captured } = makeIO();
    await expect(runTeamLeaveCommand({ readConfirm: async () => 'leave org_acme' }, io)).rejects.toThrow('__exit__:0');
    expect(captured.exit).toBe(0);
    expect(captured.stdout.join('')).toContain('leaving team');
    expect(captured.stdout.join('')).toContain('org_acme');
    expect(readTeamConfig({ homeOverride: homeDir }).mode).toBe('solo');
  });
});
