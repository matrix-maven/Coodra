import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, insertMemoryAccessEvent, migrateSqlite, type SqliteHandle } from '../../src/index.js';

/**
 * COOD-97 — ON CONFLICT must collapse RETRIES, not distinct events.
 *
 * The pull recorder now mints a UUID per row instead of deriving the id
 * from the tool's input-only idempotency key. That fixes distinct
 * accesses collapsing into one row, but it only stays safe because the
 * id is minted at ENQUEUE time and lives inside the payload
 * `scheduleDurableWrite` persists to `pending_jobs`.
 *
 * The outbox redelivers by lease expiry: a job picked but not completed
 * is re-picked and the SAME persisted payload is dispatched again. So
 * the row id repeats on a retry, and `onConflictDoNothing` is what stops
 * a redelivery from double-counting.
 *
 * This test is the other half of that argument. Without it, "retry
 * safety is unaffected" is a claim rather than a fact.
 */

let cwd: string;
let handle: SqliteHandle;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'mae-retry-dedupe-'));
  const opened = createDb({ kind: 'local', sqlite: { path: join(cwd, 'data.db') } });
  if (opened.kind !== 'sqlite') throw new Error('expected sqlite');
  handle = opened;
  migrateSqlite(handle.db);
  handle.raw
    .prepare(`INSERT INTO projects (id, slug, org_id, name, cwd) VALUES (?, ?, ?, ?, ?)`)
    .run('proj_mae', 'mae', 'org_dev_local', 'mae', cwd);
});

afterAll(() => {
  handle?.close();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

function baseRow(id: string) {
  return {
    id,
    orgId: null,
    projectId: 'proj_mae',
    runId: null,
    sessionId: 'sess-retry',
    agentType: 'claude_code',
    channel: 'pull',
    site: 'query_decisions',
    memoryType: 'decision',
    memoryId: 'dec_x',
    position: 0,
    bytes: 10,
    latencyMs: 5,
    triggerType: 'tool_call',
  };
}

function rowCount(): number {
  const row = handle.raw.prepare(`SELECT COUNT(*) AS n FROM memory_access_events`).get() as { n: number };
  return row.n;
}

describe('insertMemoryAccessEvent', () => {
  it('collapses a redelivered job — same id inserted twice yields one row', async () => {
    await insertMemoryAccessEvent(handle, baseRow('mae_retry_1'));
    await insertMemoryAccessEvent(handle, baseRow('mae_retry_1'));
    expect(rowCount()).toBe(1);
  });

  it('keeps distinct events distinct — different ids, same content', async () => {
    // Identical in every field the query produced; only the minted id
    // differs. These are two accesses and must both survive, which is
    // exactly what the old input-derived id destroyed.
    const before = rowCount();
    await insertMemoryAccessEvent(handle, baseRow('mae_distinct_a'));
    await insertMemoryAccessEvent(handle, baseRow('mae_distinct_b'));
    expect(rowCount()).toBe(before + 2);
  });
});
