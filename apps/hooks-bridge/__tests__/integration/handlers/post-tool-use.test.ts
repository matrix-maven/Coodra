import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, type DbHandle, migrateSqlite, sqliteSchema } from '@coodra/db';
import { createPolicyClient } from '@coodra/policy';
import type { AuthEnv } from '@coodra/shared/auth';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { createPostToolUseHandler } from '../../../src/handlers/post-tool-use.js';
import { createPreToolUseHandler } from '../../../src/handlers/pre-tool-use.js';
import { composeDispatch } from '../../../src/lib/dispatch.js';
import { createProjectSlugResolver } from '../../../src/lib/resolve-project-slug.js';
import { createRunRecorder } from '../../../src/lib/run-recorder.js';
import { drainOutbox } from '../_helpers/drain-outbox.js';

/**
 * Idempotency under retry storm — the §4.3 contract: ten POST
 * requests with the same (sessionId, toolUseId, phase) triple
 * produce exactly one `run_events` row.
 *
 * The test uses a synchronous schedule override on the recorder so
 * the assertion is deterministic — production setImmediate() is
 * proven idempotent by the SQL layer (ON CONFLICT DO NOTHING on the
 * primary key). Sync schedule just removes timing flakiness.
 */

interface Harness {
  readonly cwd: string;
  readonly handle: DbHandle;
  readonly hono: ReturnType<typeof buildApp>['hono'];
  readonly drain: () => Promise<void>;
}

let h: Harness;

function makeEnv(): AuthEnv {
  return {
    COODRA_MODE: 'solo',
    CLERK_SECRET_KEY: 'sk_test_replace_me',
  };
}

beforeAll(async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'post-tool-test-'));
  const sqlitePath = join(cwd, 'data.db');
  const handle = createDb({ kind: 'local', sqlite: { path: sqlitePath } });
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
  migrateSqlite(handle.db);

  // The test calls `drain()` before assertions; the helper ticks the
  // OutboxWorker until pending_jobs is empty so the destination rows
  // are visible. Mirrors the production drain path exactly.
  const policy = createPolicyClient({ db: handle, cacheTtlMs: 100 });
  const projectSlugResolver = createProjectSlugResolver({ cacheTtlMs: 100 });
  const runRecorder = createRunRecorder({ db: handle });
  const drain = (): Promise<void> => drainOutbox(handle);
  const preToolUse = createPreToolUseHandler({ policy, projectSlugResolver, db: handle, runRecorder });
  const postToolUse = createPostToolUseHandler({ runRecorder, projectSlugResolver, db: handle });
  // session_start / session_end stubs — not exercised in this suite.
  const stubAllow = async (): Promise<{ permissionDecision: 'allow' }> => ({ permissionDecision: 'allow' });
  const dispatch = composeDispatch({
    preToolUse,
    postToolUse,
    sessionStart: stubAllow,
    sessionEnd: stubAllow,
    userPromptSubmit: stubAllow,
  });

  const { hono } = buildApp({ env: makeEnv(), dispatch });
  h = { cwd, handle, hono, drain };
}, 30_000);

afterAll(() => {
  if (h?.handle?.kind === 'sqlite') h.handle.close();
  if (h?.cwd) rmSync(h.cwd, { recursive: true, force: true });
});

describe('post-tool-use idempotency (run_events)', () => {
  it('10× same (sessionId, toolUseId, phase) → exactly 1 row in run_events', async () => {
    const sessionId = 'sess-idem-1';
    const toolUseId = 'tool-xyz';

    const sends = Array.from({ length: 10 }, () =>
      h.hono.request('/v1/hooks/claude-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'PostToolUse',
          session_id: sessionId,
          tool_name: 'Write',
          tool_input: { file_path: 'src/x.ts', content: 'hello' },
          tool_use_id: toolUseId,
        }),
      }),
    );
    const responses = await Promise.all(sends);
    for (const res of responses) {
      expect(res.status).toBe(200);
      // M04 S11 cleanup (2026-05-04): PostToolUse allow is the spec-correct
      // plain `{ok:true}` body — no `hookSpecificOutput` (Claude Code silently
      // ignored a misplaced wrapper pre-cleanup; the bridge now ships the
      // right shape). On deny it would be `{ok:true, decision:'block', reason}`.
      const body = (await res.json()) as { ok: boolean; decision?: string };
      expect(body.ok).toBe(true);
      expect(body.decision).toBeUndefined();
    }
    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.runEvents)
      .where(eq(sqliteSchema.runEvents.toolUseId, toolUseId));
    expect(rows.length).toBe(1);
    expect(rows[0]?.phase).toBe('post');
    expect(rows[0]?.toolName).toBe('Write');
  });

  it('different sessions / turns produce distinct rows', async () => {
    const responses = await Promise.all([
      h.hono.request('/v1/hooks/claude-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'PostToolUse',
          session_id: 'sess-A',
          tool_name: 'Write',
          tool_input: {},
          tool_use_id: 'tool-A1',
        }),
      }),
      h.hono.request('/v1/hooks/claude-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'PostToolUse',
          session_id: 'sess-A',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          tool_use_id: 'tool-A2',
        }),
      }),
    ]);
    expect(responses.every((r) => r.status === 200)).toBe(true);
    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.runEvents)
      .where(eq(sqliteSchema.runEvents.toolUseId, 'tool-A1'));
    expect(rows.length).toBe(1);
    const rows2 = await h.handle.db
      .select()
      .from(sqliteSchema.runEvents)
      .where(eq(sqliteSchema.runEvents.toolUseId, 'tool-A2'));
    expect(rows2.length).toBe(1);
  });

  it('huge tool_input is clamped to ≤ 8KB Unicode code points (no surrogate-pair split)', async () => {
    const huge = '🚀'.repeat(20_000); // 20K rocket emojis = ~80KB UTF-8
    const sessionId = 'sess-huge';
    const toolUseId = 'tool-huge-1';

    const res = await h.hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        tool_name: 'Write',
        tool_input: { content: huge },
        tool_use_id: toolUseId,
      }),
    });
    expect(res.status).toBe(200);
    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = await h.handle.db
      .select({ toolInput: sqliteSchema.runEvents.toolInput })
      .from(sqliteSchema.runEvents)
      .where(eq(sqliteSchema.runEvents.toolUseId, toolUseId));
    expect(rows.length).toBe(1);
    const stored = rows[0]?.toolInput ?? '';
    // Unicode code-point count, not byte count: Array.from yields code points.
    expect(Array.from(stored).length).toBeLessThanOrEqual(8 * 1024);
    // The clamp is on serialised JSON; stored string never starts mid-character.
    expect(stored.startsWith('{')).toBe(true);
  });
});
