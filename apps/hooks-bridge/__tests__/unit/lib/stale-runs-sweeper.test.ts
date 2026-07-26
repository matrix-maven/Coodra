import { createDb, migrateSqlite, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { startStaleRunsSweeper } from '../../../src/lib/stale-runs-sweeper.js';

/**
 * 2026-07-24 QA sweep — the sweeper's original predicate keyed on
 * `started_at` alone, so a LIVE 40-minute session that had written an
 * mcp_call run_event one minute earlier was cancelled at the 30-minute
 * mark (observed on the maintainer machine, run 10c2d920…). These tests
 * lock the activity-aware contract:
 *
 *   1. An old in_progress run with NO recent run_events is cancelled.
 *   2. An old in_progress run WITH a recent run_event is spared —
 *      long sessions keep producing events; age alone is not "stuck".
 *   3. A young in_progress run is untouched either way.
 *
 * Real :memory: SQLite + migrations, no mocks for the thing under test.
 */

function setup(): { db: ReturnType<typeof createDb> & { kind: 'sqlite' }; projectId: string } {
  const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
  if (db.kind !== 'sqlite') throw new Error('expected sqlite');
  migrateSqlite(db.db);
  const projectId = '00000000-0000-0000-0000-000000000042';
  db.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectId, 'sweep-p', '__solo__', 'sweep-p');
  return { db, projectId };
}

function seedRun(db: ReturnType<typeof createDb>, id: string, projectId: string, startedAtSec: number): void {
  if (db.kind !== 'sqlite') throw new Error('expected sqlite');
  db.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at)
       VALUES (?, ?, ?, 'claude_code', 'solo', 'in_progress', ?)`,
    )
    .run(id, projectId, `sess_${id}`, startedAtSec);
}

function seedEvent(db: ReturnType<typeof createDb>, runId: string, createdAtSec: number): void {
  if (db.kind !== 'sqlite') throw new Error('expected sqlite');
  db.raw
    .prepare(
      `INSERT INTO run_events (id, run_id, phase, tool_name, tool_use_id, tool_input, created_at)
       VALUES (?, ?, 'mcp_call', 'coodra__record_decision', ?, '{}', ?)`,
    )
    .run(`ev_${runId}_${createdAtSec}`, runId, `use_${runId}_${createdAtSec}`, createdAtSec);
}

async function statusOf(db: ReturnType<typeof createDb>, id: string): Promise<string | undefined> {
  if (db.kind !== 'sqlite') throw new Error('expected sqlite');
  const rows = (await db.db
    .select({ status: sqliteSchema.runs.status })
    .from(sqliteSchema.runs)
    .where(eq(sqliteSchema.runs.id, id))
    .limit(1)) as Array<{ status: string }>;
  return rows[0]?.status;
}

describe('stale-runs sweeper — activity-aware cancellation', () => {
  it('cancels an old in_progress run with no recent events, spares an equally old ACTIVE one', async () => {
    const { db, projectId } = setup();
    const nowSec = Math.floor(Date.now() / 1000);

    seedRun(db, 'run_dead', projectId, nowSec - 3600); // started 1h ago
    seedEvent(db, 'run_dead', nowSec - 3500); // last event ~58m ago — stuck
    seedRun(db, 'run_live', projectId, nowSec - 3600); // started 1h ago
    seedEvent(db, 'run_live', nowSec - 60); // event 1 minute ago — ALIVE

    const sweeper = startStaleRunsSweeper({ db, thresholdSec: 1800, intervalMs: 60 * 60 * 1000 });
    // NOTE: the sweeper also fires a boot-time sweep at construction, so the
    // explicit sweepOnce() may see 0 changes — final statuses are the contract.
    await sweeper.sweepOnce();
    await sweeper.stop();

    expect(await statusOf(db, 'run_dead')).toBe('cancelled');
    expect(await statusOf(db, 'run_live')).toBe('in_progress');
  });

  it('cancels an old in_progress run with zero events at all', async () => {
    const { db, projectId } = setup();
    const nowSec = Math.floor(Date.now() / 1000);
    seedRun(db, 'run_eventless', projectId, nowSec - 3600);

    const sweeper = startStaleRunsSweeper({ db, thresholdSec: 1800, intervalMs: 60 * 60 * 1000 });
    await sweeper.sweepOnce();
    await sweeper.stop();

    expect(await statusOf(db, 'run_eventless')).toBe('cancelled');
  });

  it('never touches a run younger than the threshold', async () => {
    const { db, projectId } = setup();
    const nowSec = Math.floor(Date.now() / 1000);
    seedRun(db, 'run_young', projectId, nowSec - 300); // 5 minutes old

    const sweeper = startStaleRunsSweeper({ db, thresholdSec: 1800, intervalMs: 60 * 60 * 1000 });
    await sweeper.sweepOnce();
    await sweeper.stop();

    expect(await statusOf(db, 'run_young')).toBe('in_progress');
  });
});
