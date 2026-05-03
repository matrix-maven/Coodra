import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertKillSwitch, migrateSqlite, type SqliteHandle } from '@coodra/contextos-db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { activeKillSwitchesCheck } from '../../../src/doctor/checks/31-active-kill-switches.js';
import { upgradeAvailableCheck } from '../../../src/doctor/checks/32-upgrade-available.js';
import { staleBackupsCheck } from '../../../src/doctor/checks/33-stale-backups.js';
import { bundledTemplatesCheck } from '../../../src/doctor/checks/34-bundled-templates.js';
import { autoMarkerSmokeCheck } from '../../../src/doctor/checks/35-auto-marker-smoke.js';
import { buildCheckContext } from '../../../src/doctor/context.js';
import { openLocalDb } from '../../../src/lib/open-local-db.js';

/**
 * M08b S18 — five operational-visibility doctor checks.
 *
 * 31 (kill-switches), 33 (stale backups) need an isolated home + DB.
 * 32 (upgrade-available) is gated on env so the offline path is
 * trivially testable; the network branch isn't exercised here.
 * 34 (bundled templates) and 35 (@auto-marker smoke) read the
 * shipped templates dir from this very repo, so the tests assert
 * GREEN against the real artefacts.
 */

function ctxWithHome(home: string, overrides: Partial<Parameters<typeof buildCheckContext>[0]> = {}) {
  return buildCheckContext({
    env: {},
    contextosHomeOverride: home,
    cwd: home,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Check 31 — active kill switches
// ---------------------------------------------------------------------------

describe('activeKillSwitchesCheck (31)', () => {
  let homeDir: string;
  let dbPath: string;
  let handle: SqliteHandle;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'doctor-31-'));
    dbPath = join(homeDir, 'data.db');
    handle = await openLocalDb(dbPath, { loadVecExtension: true });
    migrateSqlite(handle.db);
  });
  afterEach(() => {
    handle.close();
  });

  it('returns green when no kill switches are active', async () => {
    const ctx = ctxWithHome(homeDir);
    const result = await activeKillSwitchesCheck.run(ctx);
    expect(result.status).toBe('green');
    expect(result.detail).toContain('no active kill switches');
  });

  it('returns yellow with count + age when a switch is active', async () => {
    await insertKillSwitch(handle, {
      scope: 'global',
      target: null,
      reason: 'demo pause',
      pausedBySessionId: 'sess-1',
    });
    // Use a now() five minutes after pausedAt so we can assert the age string.
    const future = new Date(Date.now() + 5 * 60_000);
    const ctx = ctxWithHome(homeDir, { now: () => future });
    const result = await activeKillSwitchesCheck.run(ctx);
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/1 active kill switch\(es\); oldest paused 5 min ago/);
    expect(result.remediation).toContain('contextos resume --all');
  });

  it('counts project-scoped switches (scope-agnostic by design)', async () => {
    // listAllActiveKillSwitches must include scope='project' rows,
    // otherwise the doctor would silently miss a paused project.
    await insertKillSwitch(handle, {
      scope: 'project',
      target: 'some-other-project',
      reason: 'paused while debugging cross-project incident',
    });
    const ctx = ctxWithHome(homeDir);
    const result = await activeKillSwitchesCheck.run(ctx);
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/1 active kill switch/);
  });

  it('skipped when data.db is absent (covered by check 3)', async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), 'doctor-31-empty-'));
    const ctx = ctxWithHome(emptyHome);
    const result = await activeKillSwitchesCheck.run(ctx);
    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('covered by check 3');
  });

  it('returns red when data.db exists but cannot be opened', async () => {
    const corruptHome = await mkdtemp(join(tmpdir(), 'doctor-31-corrupt-'));
    // Write garbage at the data.db path so existsSync passes but
    // SQLite refuses to open it.
    await writeFile(join(corruptHome, 'data.db'), 'this is not a sqlite database');
    const ctx = ctxWithHome(corruptHome);
    const result = await activeKillSwitchesCheck.run(ctx);
    expect(result.status).toBe('red');
    expect(result.detail).toMatch(/cannot open data.db/);
  });
});

// ---------------------------------------------------------------------------
// Check 32 — upgrade available (env-gated)
// ---------------------------------------------------------------------------

describe('upgradeAvailableCheck (32)', () => {
  it('skipped when CONTEXTOS_DOCTOR_CHECK_UPDATES is unset', async () => {
    const ctx = buildCheckContext({ env: {}, contextosHomeOverride: '/tmp/x', cwd: '/tmp' });
    const result = await upgradeAvailableCheck.run(ctx);
    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('CONTEXTOS_DOCTOR_CHECK_UPDATES=1');
  });

  it('skipped when the env var is set to anything other than "1"', async () => {
    const ctx = buildCheckContext({
      env: { CONTEXTOS_DOCTOR_CHECK_UPDATES: 'true' },
      contextosHomeOverride: '/tmp/x',
      cwd: '/tmp',
    });
    const result = await upgradeAvailableCheck.run(ctx);
    expect(result.status).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// Check 33 — stale backups
// ---------------------------------------------------------------------------

describe('staleBackupsCheck (33)', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'doctor-33-'));
  });

  it('green when no backups directory exists', async () => {
    const ctx = ctxWithHome(homeDir);
    const result = await staleBackupsCheck.run(ctx);
    expect(result.status).toBe('green');
    expect(result.detail).toContain('no backups directory yet');
  });

  it('green when backups exist but are recent', async () => {
    const dir = join(homeDir, 'backups');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'data.db.bak.2026-05-03'), 'fresh');
    const ctx = ctxWithHome(homeDir);
    const result = await staleBackupsCheck.run(ctx);
    expect(result.status).toBe('green');
    expect(result.detail).toContain('no backup files older than 30 days');
  });

  it('yellow when a backup is older than 30 days', async () => {
    const dir = join(homeDir, 'backups');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'data.db.bak.old');
    await writeFile(file, 'antique payload');
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await utimes(file, oldDate, oldDate);
    const ctx = ctxWithHome(homeDir);
    const result = await staleBackupsCheck.run(ctx);
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/1 stale backup/);
    expect(result.detail).toMatch(/oldest 60 days/);
    expect(result.remediation).toContain('rm');
  });
});

// ---------------------------------------------------------------------------
// Check 34 — bundled templates manifest
// ---------------------------------------------------------------------------

describe('bundledTemplatesCheck (34)', () => {
  it('green for the real bundled templates dir', async () => {
    const ctx = buildCheckContext({ env: {}, contextosHomeOverride: '/tmp/x', cwd: '/tmp' });
    const result = await bundledTemplatesCheck.run(ctx);
    expect(result.status).toBe('green');
    expect(result.detail).toMatch(/7 bundled templates loaded cleanly/);
  });
});

// ---------------------------------------------------------------------------
// Check 35 — @auto-marker grammar smoke
// ---------------------------------------------------------------------------

describe('autoMarkerSmokeCheck (35)', () => {
  it('green for every shipped template', async () => {
    const ctx = buildCheckContext({ env: {}, contextosHomeOverride: '/tmp/x', cwd: '/tmp' });
    const result = await autoMarkerSmokeCheck.run(ctx);
    expect(result.status).toBe('green');
    expect(result.detail).toContain('every bundled template parses cleanly');
  });
});
