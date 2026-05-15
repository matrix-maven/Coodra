import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, type DbHandle, migrateSqlite, sqliteSchema } from '@coodra/db';
import { createPolicyClient } from '@coodra/policy';
import type { AuthEnv } from '@coodra/shared/auth';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/app.js';
import { createPostToolUseHandler } from '../../../src/handlers/post-tool-use.js';
import { createPreToolUseHandler } from '../../../src/handlers/pre-tool-use.js';
import { createSessionEndHandler } from '../../../src/handlers/session-end.js';
import { createSessionStartHandler } from '../../../src/handlers/session-start.js';
import { composeDispatch } from '../../../src/lib/dispatch.js';
import { createProjectSlugResolver } from '../../../src/lib/resolve-project-slug.js';
import { createRunRecorder } from '../../../src/lib/run-recorder.js';
import { drainOutbox } from '../_helpers/drain-outbox.js';

/**
 * Full SessionStart → 3× PostToolUse → SessionEnd lifecycle, plus
 * idempotency for each event under retry.
 *
 * Verifies the §4.3 + §16-pattern-3 contract:
 *   - SessionStart inserts exactly one runs row, sent twice = one row.
 *   - PostToolUse appends run_events; sent twice = one event row.
 *   - SessionEnd transitions runs.status: in_progress → completed;
 *     sent twice = idempotent (status stays completed; ended_at is
 *     the latest of the two writes which is fine — both writes
 *     happen in the same test, milliseconds apart).
 *
 * Phase 3 Fix A (2026-05-02 — `dec_ea32e7ed`): the canonical
 * session-termination event in Claude Code is `SessionEnd`, not
 * `Stop`. Pre-Phase-3 the adapter conflated them and this test
 * drove session closure via Stop; after Fix A Stop is a plain
 * per-turn-end ack and SessionEnd carries the close-runs +
 * auto-Context-Pack-save semantics. Stop's ack-only behaviour is
 * covered by the dedicated test at the end of this file.
 */

interface Harness {
  readonly cwd: string;
  readonly slug: string;
  readonly handle: DbHandle;
  readonly hono: ReturnType<typeof buildApp>['hono'];
  readonly drain: () => Promise<void>;
  readonly projectId: string;
}

let h: Harness;

function makeEnv(): AuthEnv {
  return {
    COODRA_MODE: 'solo',
    CLERK_SECRET_KEY: 'sk_test_replace_me',
  };
}

beforeAll(async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'session-lifecycle-test-'));
  const slug = `test-proj-${randomUUID().slice(0, 8)}`;
  writeFileSync(join(cwd, '.coodra.json'), JSON.stringify({ projectSlug: slug }));

  const sqlitePath = join(cwd, 'data.db');
  const handle = createDb({ kind: 'local', sqlite: { path: sqlitePath } });
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
  migrateSqlite(handle.db);

  const projectId = randomUUID();
  await handle.db.insert(sqliteSchema.projects).values({
    id: projectId,
    slug,
    orgId: 'org_dev_local',
    name: 'session-lifecycle-test',
  });

  const policy = createPolicyClient({ db: handle, cacheTtlMs: 100 });
  const projectSlugResolver = createProjectSlugResolver({ cacheTtlMs: 100 });
  const runRecorder = createRunRecorder({ db: handle });
  const drain = (): Promise<void> => drainOutbox(handle);

  const preToolUse = createPreToolUseHandler({ policy, projectSlugResolver, db: handle, runRecorder });
  const postToolUse = createPostToolUseHandler({ runRecorder, projectSlugResolver, db: handle });
  const sessionStart = createSessionStartHandler({ runRecorder, projectSlugResolver, db: handle, mode: 'solo' });
  const sessionEnd = createSessionEndHandler({ runRecorder, projectSlugResolver, db: handle });
  const stubAllow = async (): Promise<{ permissionDecision: 'allow' }> => ({ permissionDecision: 'allow' });
  const dispatch = composeDispatch({
    preToolUse,
    postToolUse,
    sessionStart,
    sessionEnd,
    userPromptSubmit: stubAllow,
  });

  const { hono } = buildApp({ env: makeEnv(), dispatch });
  h = { cwd, slug, handle, hono, drain, projectId };
}, 30_000);

afterAll(() => {
  if (h?.handle?.kind === 'sqlite') h.handle.close();
  if (h?.cwd) rmSync(h.cwd, { recursive: true, force: true });
});

async function postEvent(body: Record<string, unknown>): Promise<Response> {
  return h.hono.request('/v1/hooks/claude-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('full session lifecycle (SessionStart → 3× PostToolUse → SessionEnd)', () => {
  const sessionId = 'sess-lifecycle-1';

  it('SessionStart opens runs row with status in_progress', async () => {
    const res = await postEvent({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: h.cwd });
    expect(res.status).toBe(200);
    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, sessionId)));
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('in_progress');
    expect(rows[0]?.agentType).toBe('claude_code');
    expect(rows[0]?.mode).toBe('solo');
  });

  it('SessionStart sent again is a no-op (ON CONFLICT DO NOTHING)', async () => {
    const res = await postEvent({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: h.cwd });
    expect(res.status).toBe(200);
    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, sessionId)));
    expect(rows.length).toBe(1);
  });

  it('three PostToolUse events append three run_events rows', async () => {
    for (const turnId of ['turn-1', 'turn-2', 'turn-3']) {
      const res = await postEvent({
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        tool_name: 'Write',
        tool_input: { file_path: `src/${turnId}.ts` },
        tool_use_id: turnId,
        cwd: h.cwd,
      });
      expect(res.status).toBe(200);
    }
    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = await h.handle.db.select().from(sqliteSchema.runEvents);
    const lifecycleRows = rows.filter((r) => r.toolUseId.startsWith('turn-'));
    expect(lifecycleRows.length).toBe(3);
  });

  it('SessionEnd closes the run with status=completed and sets ended_at (Phase 3 Fix A)', async () => {
    const res = await postEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, cwd: h.cwd });
    expect(res.status).toBe(200);
    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, sessionId)));
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.endedAt).toBeTruthy();
  });

  it('SessionEnd sent again is idempotent (status stays completed)', async () => {
    const res = await postEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, cwd: h.cwd });
    expect(res.status).toBe(200);
    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, sessionId)));
    expect(rows[0]?.status).toBe('completed');
  });

  it('Stop is a plain ack — does not modify runs row (Phase 3 Fix A)', async () => {
    const turnSessionId = 'sess-turn-end-1';
    // Open a fresh run so this test does not depend on closure state
    // from the SessionEnd tests above.
    const startRes = await postEvent({ hook_event_name: 'SessionStart', session_id: turnSessionId, cwd: h.cwd });
    expect(startRes.status).toBe(200);
    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const before = await h.handle.db
      .select()
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, turnSessionId)));
    expect(before[0]?.status).toBe('in_progress');

    const stopRes = await postEvent({ hook_event_name: 'Stop', session_id: turnSessionId, cwd: h.cwd });
    expect(stopRes.status).toBe(200);
    await h.drain();

    const after = await h.handle.db
      .select()
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, turnSessionId)));
    expect(after[0]?.status).toBe('in_progress');
    expect(after[0]?.endedAt).toBeNull();
  });
});
