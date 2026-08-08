import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, migrateSqlite, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { finalizeRunOnSessionEnd } from '../../src/finalize-run-on-session-end.js';

/**
 * Parity coverage for the Phase 1 lifecycle extraction (2026-08-08):
 * `finalizeRunOnSessionEnd` is the shared orchestrator both the HTTP
 * Hooks Bridge (Claude Code only) and the native `lifecycle_event` MCP
 * tool (Codex/Devin/Cursor/Antigravity/Claude Code plugin installs)
 * call on SessionEnd. This locks that a single call produces every
 * artifact the pre-extraction bridge produced: run completion, an
 * auto-saved Context Pack (DB row + `.md` file), a synced linked Work
 * Pack, and a swept unexecuted-`ask` policy decision — using a real
 * `:memory:` SQLite, no mocks for the thing under test.
 */

const PROJECT_ID = '00000000-0000-0000-0000-0000000000cc';

async function seedProjectAndRun(
  db: ReturnType<typeof createDb>,
  runId: string,
  opts?: { readonly workPackId?: string },
) {
  if (db.kind !== 'sqlite') throw new Error('expected sqlite handle');
  await db.db.insert(sqliteSchema.projects).values({
    id: PROJECT_ID,
    slug: 'finalize-test',
    orgId: '__solo__',
    name: 'finalize-test',
  });
  await db.db.insert(sqliteSchema.runs).values({
    id: runId,
    projectId: PROJECT_ID,
    sessionId: 'sess-finalize',
    agentType: 'codex',
    mode: 'solo',
    status: 'in_progress',
    ...(opts?.workPackId !== undefined ? { workPackId: opts.workPackId } : {}),
  });
}

describe('finalizeRunOnSessionEnd', () => {
  it('marks the run completed, auto-saves a Context Pack (DB + FS), and syncs the linked Work Pack', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite handle');
    migrateSqlite(db.db);

    await db.db.insert(sqliteSchema.projects).values({
      id: PROJECT_ID,
      slug: 'finalize-test',
      orgId: '__solo__',
      name: 'finalize-test',
    });

    const workPackId = 'work_finalize_1';
    await db.db.insert(sqliteSchema.workPacks).values({
      id: workPackId,
      projectId: PROJECT_ID,
      slug: 'cood-99',
      title: 'COOD-99',
      packType: 'task',
      status: 'draft',
      specMarkdown: '',
      implementationMarkdown: '',
      syncMarkdown: 'Existing sync notes.',
      metadataJson: '{}',
    });

    const runId = `run:${PROJECT_ID}:sess-finalize:11111111-2222-3333-4444-555555555555`;
    await db.db.insert(sqliteSchema.runs).values({
      id: runId,
      projectId: PROJECT_ID,
      sessionId: 'sess-finalize',
      agentType: 'codex',
      mode: 'solo',
      status: 'in_progress',
      workPackId,
    });

    const packsRoot = await mkdtemp(join(tmpdir(), 'finalize-lifecycle-'));

    const result = await finalizeRunOnSessionEnd({
      db,
      runId,
      projectId: PROJECT_ID,
      contextPacksRoot: packsRoot,
      now: new Date('2026-08-08T12:00:00Z'),
    });

    expect(result.savedAutoContextPack).toBe(true);
    expect(result.updatedLinkedWorkPack).toBe(true);

    const runRows = await db.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId)).limit(1);
    expect(runRows[0]?.status).toBe('completed');
    expect(runRows[0]?.endedAt).not.toBeNull();

    const packRows = await db.db
      .select({ id: sqliteSchema.contextPacks.id })
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, runId))
      .limit(1);
    expect(packRows).toHaveLength(1);

    const today = new Date().toISOString().slice(0, 10);
    expect(existsSync(join(packsRoot, `${today}-run-00000000-000.md`))).toBe(true);

    const workPackRows = await db.db
      .select({ syncMarkdown: sqliteSchema.workPacks.syncMarkdown })
      .from(sqliteSchema.workPacks)
      .where(eq(sqliteSchema.workPacks.id, workPackId))
      .limit(1);
    expect(workPackRows[0]?.syncMarkdown).toContain('<!-- coodra:work-pack-session-overview:start -->');
    expect(workPackRows[0]?.syncMarkdown).toContain('Existing sync notes.');
  });

  it('still marks the run completed when projectId is absent, but skips the auto Context Pack save', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite handle');
    migrateSqlite(db.db);

    const runId = `run:${PROJECT_ID}:sess-finalize:22222222-3333-4444-5555-666666666666`;
    await seedProjectAndRun(db, runId);

    const result = await finalizeRunOnSessionEnd({ db, runId, now: new Date('2026-08-08T12:00:00Z') });

    expect(result.savedAutoContextPack).toBe(false);
    expect(result.updatedLinkedWorkPack).toBe(false);

    const runRows = await db.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId)).limit(1);
    expect(runRows[0]?.status).toBe('completed');
  });

  it('sweeps an unresolved `ask` policy decision to `not_executed` when sessionId is given', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite handle');
    migrateSqlite(db.db);

    const runId = `run:${PROJECT_ID}:sess-finalize:33333333-4444-5555-6666-777777777777`;
    await seedProjectAndRun(db, runId);

    db.raw
      .prepare(
        `INSERT INTO policy_decisions
           (id, idempotency_key, session_id, project_id, agent_type, event_type, tool_name,
            tool_input_snapshot, permission_decision, reason, run_id)
         VALUES (?, ?, ?, ?, 'codex', 'PreToolUse', 'Bash', '{}', 'ask', 'rule_matched', ?)`,
      )
      .run('pd_1', 'idem_pd_1', 'sess-finalize', PROJECT_ID, runId);

    await finalizeRunOnSessionEnd({ db, runId, sessionId: 'sess-finalize', now: new Date('2026-08-08T12:00:00Z') });

    const rows = db.raw.prepare('SELECT ask_outcome FROM policy_decisions WHERE id = ?').get('pd_1') as
      | { ask_outcome: string | null }
      | undefined;
    expect(rows?.ask_outcome).toBe('not_executed');
  });
});
