import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGlobalProject, migrateSqlite } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCheckContext } from '../../../src/doctor/context.js';
import { ALL_CHECKS } from '../../../src/doctor/registry.js';
import { runChecks } from '../../../src/doctor/run.js';
import { openLocalDb } from '../../../src/lib/open-local-db.js';

/**
 * Drives the full 20-check registry against a controlled tmp `~/.coodra/`
 * fixture. This is the slice's "real test" — every check executes against
 * real fs + real SQLite (with migrations applied + F7 sentinel seeded).
 *
 * **Why we exclude check 29.** Check 29 (synthetic PreToolUse → bridge →
 * policy enforcement loop) fires a real HTTP POST at `127.0.0.1:<bridgePort>`.
 * If the developer happens to have a production hooks-bridge running while
 * tests execute, that bridge writes to the real `~/.coodra/data.db` —
 * one synthetic projects row + one in_progress run + one policy_decision
 * per fixture iteration. The fixture has no use for the result (no `it()`
 * asserts on check 29). Filtering it out keeps the test hermetic without
 * losing coverage; check 29 has its own dedicated mock-bridge unit test.
 */
const FIXTURE_CHECKS = ALL_CHECKS.filter((c) => c.id !== 29);
describe('doctor — full registry against a controlled fixture', () => {
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'coodra-doctor-'));
    cwd = await mkdtemp(join(tmpdir(), 'coodra-cwd-'));
    await mkdir(join(home, 'logs'), { recursive: true });
    await mkdir(join(home, 'pids'), { recursive: true });
    await chmod(home, 0o700);
  });

  afterEach(async () => {
    // tmp dirs auto-cleaned by OS, but we don't need to leak DB handles
  });

  it('greenfield (no data.db, no .coodra.json) — checks 3,4,5,12 land as red/yellow/skipped per spec', async () => {
    const ctx = buildCheckContext({
      coodraHomeOverride: home,
      cwd,
      env: { LOCAL_HOOK_SECRET: 'a'.repeat(64) },
      timeoutMs: 800,
    });
    const report = await runChecks(FIXTURE_CHECKS, ctx);
    const get = (id: number) => report.checks.find((c) => c.id === id);

    // Node ≥22 (running tests on 22+ — green). data.db missing → red on 3, skipped on 4 + 5 + 12.
    expect(get(1)?.status).toBe('green');
    expect(get(3)?.status).toBe('red');
    expect(get(4)?.status).toBe('skipped');
    expect(get(5)?.status).toBe('skipped');
    expect(get(12)?.status).toBe('yellow'); // .coodra.json missing → yellow w/ remediation
    expect(get(13)?.status).toBe('green'); // M03.1 closed; placeholder converted to green
    // 17/18 may be green (port free) or yellow (in use); both are acceptable in CI runners.
    expect(['green', 'yellow']).toContain(get(17)?.status);
    expect(['green', 'yellow']).toContain(get(18)?.status);
    // 21/22/23 — pending_jobs checks. data.db missing → all skipped.
    expect(get(21)?.status).toBe('skipped');
    expect(get(22)?.status).toBe('skipped');
    expect(get(23)?.status).toBe('skipped');
  });

  it('initialised home with migrations applied + F7 sentinel — checks 3,4,5 green, 6/7 green', async () => {
    // Apply migrations and seed __global__ project so checks 3-5 are green.
    const dataDb = join(home, 'data.db');
    const handle = await openLocalDb(dataDb, { loadVecExtension: true });
    migrateSqlite(handle.db);
    await ensureGlobalProject(handle);
    handle.close();

    const ctx = buildCheckContext({
      coodraHomeOverride: home,
      cwd,
      env: { LOCAL_HOOK_SECRET: 'a'.repeat(64) },
      timeoutMs: 800,
    });
    const report = await runChecks(FIXTURE_CHECKS, ctx);
    const get = (id: number) => report.checks.find((c) => c.id === id);

    expect(get(3)?.status).toBe('green');
    expect(get(4)?.status).toBe('green');
    expect(get(5)?.status).toBe('green');
    // No policy_decisions rows yet — check 6 is green (nothing to validate).
    expect(get(6)?.status).toBe('green');
    // No run_events orphans (no rows at all) — check 7 is green.
    expect(get(7)?.status).toBe('green');
    // Bridge runId logs check — no log files → skipped.
    expect(get(8)?.status).toBe('skipped');
    // .coodra.json absent → yellow.
    expect(get(12)?.status).toBe('yellow');
    expect(get(20)?.status).toBe('green'); // LOCAL_HOOK_SECRET via env
    // 21/22/23 — clean DB, no pending_jobs rows → all green.
    expect(get(21)?.status).toBe('green');
    expect(get(22)?.status).toBe('green');
    expect(get(23)?.status).toBe('green');
  });

  it('with .coodra.json pointing at a registered project — check 12 green', async () => {
    const dataDb = join(home, 'data.db');
    const handle = await openLocalDb(dataDb, { loadVecExtension: true });
    migrateSqlite(handle.db);
    await ensureGlobalProject(handle);
    // Add a registered project for the test slug.
    const projectId = 'proj_test_001';
    handle.raw
      .prepare(
        `INSERT INTO projects (id, slug, org_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run(projectId, 'doctortest', 'org_test', 'doctortest');
    handle.close();
    await writeFile(join(cwd, '.coodra.json'), JSON.stringify({ projectSlug: 'doctortest' }));

    const ctx = buildCheckContext({
      coodraHomeOverride: home,
      cwd,
      env: { LOCAL_HOOK_SECRET: 'a'.repeat(64) },
      timeoutMs: 800,
    });
    const report = await runChecks(FIXTURE_CHECKS, ctx);
    const get = (id: number) => report.checks.find((c) => c.id === id);
    expect(get(12)?.status).toBe('green');
  });

  it('check 7 surfaces a NULL run_events.run_id as RED (F8 invariant; load-bearing doctor)', async () => {
    const dataDb = join(home, 'data.db');
    const handle = await openLocalDb(dataDb, { loadVecExtension: true });
    migrateSqlite(handle.db);
    await ensureGlobalProject(handle);

    // Seed a runs row, then a single run_events row with NULL run_id.
    handle.raw
      .prepare(
        `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at)
         VALUES (?, '__global__', 'sess-orphan-test', 'claude_code', 'solo', 'in_progress', unixepoch())`,
      )
      .run('run-orphan-test');
    handle.raw
      .prepare(
        `INSERT INTO run_events (id, run_id, phase, tool_name, tool_use_id, tool_input)
         VALUES (?, NULL, 'PreToolUse', 'edit_file', ?, '{}')`,
      )
      .run('ev-orphan-test', 'tu_orphan_test');
    handle.close();

    const ctx = buildCheckContext({
      coodraHomeOverride: home,
      cwd,
      env: { LOCAL_HOOK_SECRET: 'a'.repeat(64) },
      timeoutMs: 800,
    });
    const report = await runChecks(FIXTURE_CHECKS, ctx);
    const get = (id: number) => report.checks.find((c) => c.id === id);
    expect(get(7)?.status).toBe('red');
    expect(get(7)?.detail).toMatch(/NULL run_id/);
  });

  it('check 6 surfaces F14 legacy 3-segment rows as yellow', async () => {
    const dataDb = join(home, 'data.db');
    const handle = await openLocalDb(dataDb, { loadVecExtension: true });
    migrateSqlite(handle.db);
    await ensureGlobalProject(handle);

    // Insert two policy_decisions rows: one F14 4-segment, one legacy 3-segment.
    const insert = handle.raw.prepare(
      `INSERT INTO policy_decisions
         (id, idempotency_key, agent_type, project_id, session_id, event_type, tool_name,
          tool_input_snapshot, permission_decision, reason, created_at)
       VALUES (?, ?, 'claude_code', '__global__', 'sess1', 'PreToolUse', 'write_file',
          '{}', 'allow', 'no_rule_matched', unixepoch())`,
    );
    insert.run('pd_legacy_001', 'pd:sess1:write_file:PreToolUse');
    insert.run('pd_f14_001', 'pd:sess1:tu_abc:write_file:PreToolUse');
    handle.close();

    const ctx = buildCheckContext({
      coodraHomeOverride: home,
      cwd,
      env: { LOCAL_HOOK_SECRET: 'a'.repeat(64) },
      timeoutMs: 800,
    });
    const report = await runChecks(FIXTURE_CHECKS, ctx);
    const get = (id: number) => report.checks.find((c) => c.id === id);
    expect(get(6)?.status).toBe('yellow');
    expect(get(6)?.detail).toMatch(/pre-F14/);
  });

  it('check 21: pending_jobs depth crosses thresholds (0 → green, 11 → yellow, 200 → red)', async () => {
    const dataDb = join(home, 'data.db');
    const handle = await openLocalDb(dataDb, { loadVecExtension: true });
    migrateSqlite(handle.db);
    await ensureGlobalProject(handle);

    const insertPending = handle.raw.prepare(
      `INSERT INTO pending_jobs (id, queue, payload, status, run_after, created_at)
       VALUES (?, 'run_event', '{}', 'pending', unixepoch(), unixepoch())`,
    );

    // 11 rows → yellow (between 10 and 100).
    for (let i = 0; i < 11; i += 1) insertPending.run(`pj-yellow-${i}`);
    handle.close();

    let ctx = buildCheckContext({
      coodraHomeOverride: home,
      cwd,
      env: { LOCAL_HOOK_SECRET: 'a'.repeat(64) },
      timeoutMs: 800,
    });
    let report = await runChecks(FIXTURE_CHECKS, ctx);
    let get = (id: number) => report.checks.find((c) => c.id === id);
    expect(get(21)?.status).toBe('yellow');

    // Bump above 100 → red.
    const handle2 = await openLocalDb(dataDb, { loadVecExtension: true });
    const insertMore = handle2.raw.prepare(
      `INSERT INTO pending_jobs (id, queue, payload, status, run_after, created_at)
       VALUES (?, 'run_event', '{}', 'pending', unixepoch(), unixepoch())`,
    );
    for (let i = 0; i < 200; i += 1) insertMore.run(`pj-red-${i}`);
    handle2.close();

    ctx = buildCheckContext({
      coodraHomeOverride: home,
      cwd,
      env: { LOCAL_HOOK_SECRET: 'a'.repeat(64) },
      timeoutMs: 800,
    });
    report = await runChecks(FIXTURE_CHECKS, ctx);
    get = (id: number) => report.checks.find((c) => c.id === id);
    expect(get(21)?.status).toBe('red');
  });

  it('check 22: pending_jobs oldest row crosses age thresholds (fresh → green, 1m → yellow, 10m → red)', async () => {
    const dataDb = join(home, 'data.db');
    const handle = await openLocalDb(dataDb, { loadVecExtension: true });
    migrateSqlite(handle.db);
    await ensureGlobalProject(handle);

    // Single row aged 90 seconds — yellow (30s–5min window).
    const ninetySecAgo = Math.floor((Date.now() - 90 * 1000) / 1000);
    handle.raw
      .prepare(
        `INSERT INTO pending_jobs (id, queue, payload, status, run_after, created_at)
         VALUES (?, 'run_event', '{}', 'pending', ?, ?)`,
      )
      .run('pj-yellow-age', ninetySecAgo, ninetySecAgo);
    handle.close();

    let ctx = buildCheckContext({
      coodraHomeOverride: home,
      cwd,
      env: { LOCAL_HOOK_SECRET: 'a'.repeat(64) },
      timeoutMs: 800,
    });
    let report = await runChecks(FIXTURE_CHECKS, ctx);
    let get = (id: number) => report.checks.find((c) => c.id === id);
    expect(get(22)?.status).toBe('yellow');

    // Insert a 10-minute-old row — red (>5min).
    const tenMinAgo = Math.floor((Date.now() - 10 * 60 * 1000) / 1000);
    const handle2 = await openLocalDb(dataDb, { loadVecExtension: true });
    handle2.raw
      .prepare(
        `INSERT INTO pending_jobs (id, queue, payload, status, run_after, created_at)
         VALUES (?, 'run_event', '{}', 'pending', ?, ?)`,
      )
      .run('pj-red-age', tenMinAgo, tenMinAgo);
    handle2.close();

    ctx = buildCheckContext({
      coodraHomeOverride: home,
      cwd,
      env: { LOCAL_HOOK_SECRET: 'a'.repeat(64) },
      timeoutMs: 800,
    });
    report = await runChecks(FIXTURE_CHECKS, ctx);
    get = (id: number) => report.checks.find((c) => c.id === id);
    expect(get(22)?.status).toBe('red');
  });

  it('check 23: dead-letter escalation per OQ3 (5 → yellow, 11 → red, 1 row >1h → red)', async () => {
    const dataDb = join(home, 'data.db');
    const handle = await openLocalDb(dataDb, { loadVecExtension: true });
    migrateSqlite(handle.db);
    await ensureGlobalProject(handle);

    const nowSec = Math.floor(Date.now() / 1000);
    const insertDead = handle.raw.prepare(
      `INSERT INTO pending_jobs (id, queue, payload, status, run_after, picked_at, failed_at, last_error, created_at)
       VALUES (?, 'run_event', '{}', 'dead', unixepoch(), ?, ?, 'simulated', ?)`,
    );

    // 5 dead rows, all recent → yellow.
    for (let i = 0; i < 5; i += 1) insertDead.run(`pj-dead-${i}`, nowSec, nowSec, nowSec);
    handle.close();

    let ctx = buildCheckContext({
      coodraHomeOverride: home,
      cwd,
      env: { LOCAL_HOOK_SECRET: 'a'.repeat(64) },
      timeoutMs: 800,
    });
    let report = await runChecks(FIXTURE_CHECKS, ctx);
    let get = (id: number) => report.checks.find((c) => c.id === id);
    expect(get(23)?.status).toBe('yellow');

    // Bump count past 10 → red (count threshold).
    const handle2 = await openLocalDb(dataDb, { loadVecExtension: true });
    const insertMore = handle2.raw.prepare(
      `INSERT INTO pending_jobs (id, queue, payload, status, run_after, picked_at, failed_at, last_error, created_at)
       VALUES (?, 'run_event', '{}', 'dead', unixepoch(), ?, ?, 'simulated', ?)`,
    );
    for (let i = 0; i < 7; i += 1) insertMore.run(`pj-dead-extra-${i}`, nowSec, nowSec, nowSec);
    handle2.close();

    ctx = buildCheckContext({
      coodraHomeOverride: home,
      cwd,
      env: { LOCAL_HOOK_SECRET: 'a'.repeat(64) },
      timeoutMs: 800,
    });
    report = await runChecks(FIXTURE_CHECKS, ctx);
    get = (id: number) => report.checks.find((c) => c.id === id);
    expect(get(23)?.status).toBe('red');

    // Reset to a single row aged >1h — red via age escalation alone.
    const handle3 = await openLocalDb(dataDb, { loadVecExtension: true });
    handle3.raw.prepare(`DELETE FROM pending_jobs`).run();
    const twoHoursAgo = nowSec - 2 * 60 * 60;
    handle3.raw
      .prepare(
        `INSERT INTO pending_jobs (id, queue, payload, status, run_after, picked_at, failed_at, last_error, created_at)
         VALUES (?, 'run_event', '{}', 'dead', unixepoch(), ?, ?, 'simulated', ?)`,
      )
      .run('pj-dead-old', twoHoursAgo, twoHoursAgo, twoHoursAgo);
    handle3.close();

    ctx = buildCheckContext({
      coodraHomeOverride: home,
      cwd,
      env: { LOCAL_HOOK_SECRET: 'a'.repeat(64) },
      timeoutMs: 800,
    });
    report = await runChecks(FIXTURE_CHECKS, ctx);
    get = (id: number) => report.checks.find((c) => c.id === id);
    expect(get(23)?.status).toBe('red');
    expect(get(23)?.detail).toMatch(/older than 1h/);
  });
});
