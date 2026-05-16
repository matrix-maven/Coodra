import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, type DbHandle, migrateSqlite, sqliteSchema } from '@coodra/db';
import { createPolicyClient } from '@coodra/policy';
import type { AuthEnv } from '@coodra/shared/auth';
import {
  ALL_REAL_ENVELOPES,
  REAL_ENVELOPE_POST_TOOL_USE,
  REAL_ENVELOPE_PRE_TOOL_USE,
  REAL_ENVELOPE_SESSION_END,
  REAL_ENVELOPE_SESSION_START,
  REAL_ENVELOPE_STOP,
  REAL_ENVELOPE_USER_PROMPT_SUBMIT,
} from '@coodra/shared/test-utils';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { createPostToolUseHandler } from '../../src/handlers/post-tool-use.js';
import { createPreToolUseHandler } from '../../src/handlers/pre-tool-use.js';
import { createSessionEndHandler } from '../../src/handlers/session-end.js';
import { createSessionStartHandler } from '../../src/handlers/session-start.js';
import { createUserPromptSubmitHandler } from '../../src/handlers/user-prompt-submit.js';
import { composeDispatch } from '../../src/lib/dispatch.js';
import { createProjectSlugResolver } from '../../src/lib/resolve-project-slug.js';
import { createRunRecorder } from '../../src/lib/run-recorder.js';
import { drainOutbox } from './_helpers/drain-outbox.js';

/**
 * `apps/hooks-bridge/__tests__/integration/real-envelope.test.ts` —
 * locks Phase 3 Fix A's wire contract against canonical Claude Code
 * envelopes.
 *
 * Phase 2 verification (2026-04-28) found that every real Claude
 * Code envelope was rejected by the bridge with
 * `permissionDecisionReason: 'invalid_hook_payload'` — the
 * `.strict()` payload schema rejected unknown fields like
 * `transcript_path`, `permission_mode`, `source`, `model`, and the
 * `SessionEnd` event was missing from the enum entirely. Policy was
 * silently bypassed via fail-open for every real install. Phase 3
 * Fix A (2026-05-02 — `dec_ea32e7ed`) widened the schema to
 * `.passthrough()`, added `SessionEnd`, and rewired Stop to phase
 * `'turn_end'` so auto-Context-Pack save no longer fires per turn.
 *
 * This suite asserts:
 *   1. All six canonical envelopes parse and dispatch cleanly (HTTP
 *      200, no `invalid_hook_payload` reason on any response).
 *   2. SessionEnd closes the runs row to `completed` and writes
 *      exactly one Context Pack via the auto-save path.
 *   3. Stop is a plain ack — does NOT close runs and does NOT
 *      produce a Context Pack.
 *   4. Replaying SessionEnd is idempotent (no second pack created).
 *
 * Per-suite shared bridge: boot once in beforeAll, reuse across
 * tests. Each test uses a unique `session_id` to avoid
 * cross-pollution with the prior test's runs / run_events / packs.
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

async function postEvent(body: Record<string, unknown>): Promise<Response> {
  return h.hono.request('/v1/hooks/claude-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'real-envelope-test-'));
  const slug = `real-envelope-${randomUUID().slice(0, 8)}`;
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
    name: 'real-envelope-test',
  });

  const policy = createPolicyClient({ db: handle, cacheTtlMs: 100 });
  const projectSlugResolver = createProjectSlugResolver({ cacheTtlMs: 100 });
  const runRecorder = createRunRecorder({ db: handle });
  const drain = (): Promise<void> => drainOutbox(handle);

  const preToolUse = createPreToolUseHandler({ policy, projectSlugResolver, db: handle, runRecorder });
  const postToolUse = createPostToolUseHandler({ runRecorder, projectSlugResolver, db: handle });
  const sessionStart = createSessionStartHandler({ runRecorder, projectSlugResolver, db: handle, mode: 'solo' });
  const sessionEnd = createSessionEndHandler({ runRecorder, projectSlugResolver, db: handle });
  const userPromptSubmit = createUserPromptSubmitHandler({ runRecorder, projectSlugResolver, db: handle });
  const dispatch = composeDispatch({ preToolUse, postToolUse, sessionStart, sessionEnd, userPromptSubmit });

  const { hono } = buildApp({ env: makeEnv(), dispatch });
  h = { cwd, slug, handle, hono, drain, projectId };
}, 30_000);

afterAll(() => {
  if (h?.handle?.kind === 'sqlite') h.handle.close();
  if (h?.cwd) rmSync(h.cwd, { recursive: true, force: true });
});

describe('real Claude Code envelopes — schema acceptance (Phase 3 Fix A)', () => {
  it('all six canonical envelopes parse and return without invalid_hook_payload', async () => {
    // Use a per-test session id; we don't care about lifecycle here,
    // only that the schema accepts the wire payload.
    const sessionId = `schema-${randomUUID().slice(0, 8)}`;
    const overrideSessionId = (env: Record<string, unknown>): Record<string, unknown> => ({
      ...env,
      session_id: sessionId,
      cwd: h.cwd,
    });

    // M04 S11 cleanup (2026-05-04) made `shapeClaudeCodeResponse`
    // event-type-specific: only PreToolUse + SessionStart + UserPromptSubmit
    // carry `hookSpecificOutput`; PostToolUse / Stop / SubagentStop /
    // SessionEnd return a plain `{ok:true}` body on allow. The fail-open
    // path (which is what we're really guarding against here) ALWAYS
    // emits `hookSpecificOutput.permissionDecisionReason === 'invalid_hook_payload'`
    // regardless of event type — so the canonical regression check is
    // "did fail-open fire?" and it's robust to the missing wrapper.
    for (const envelope of ALL_REAL_ENVELOPES) {
      const body = overrideSessionId(envelope as unknown as Record<string, unknown>);
      const res = await postEvent(body);
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(json.hookSpecificOutput?.permissionDecisionReason).not.toBe('invalid_hook_payload');
    }
  });

  it('PreToolUse with permission_mode + transcript_path passes through to the policy handler', async () => {
    const sessionId = `pre-${randomUUID().slice(0, 8)}`;
    // Open a run first so the policy handler has something to bind to.
    await postEvent({ ...REAL_ENVELOPE_SESSION_START, session_id: sessionId, cwd: h.cwd });
    await h.drain();

    const res = await postEvent({ ...REAL_ENVELOPE_PRE_TOOL_USE, session_id: sessionId, cwd: h.cwd });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
    };
    expect(json.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(json.hookSpecificOutput.permissionDecisionReason).not.toBe('invalid_hook_payload');
  });

  it('UserPromptSubmit with prompt + transcript_path passes through to the prompt handler', async () => {
    const sessionId = `prompt-${randomUUID().slice(0, 8)}`;
    await postEvent({ ...REAL_ENVELOPE_SESSION_START, session_id: sessionId, cwd: h.cwd });
    await h.drain();
    const res = await postEvent({ ...REAL_ENVELOPE_USER_PROMPT_SUBMIT, session_id: sessionId, cwd: h.cwd });
    expect(res.status).toBe(200);
    // M04 S11: UserPromptSubmit's allow shape is `{ok:true, hookSpecificOutput:{hookEventName}}` —
    // no `permissionDecision` on allow (only `{decision:'block', reason}` on deny). So the
    // pass-through check is "ok:true + no fail-open reason".
    const json = (await res.json()) as {
      ok: boolean;
      decision?: string;
      hookSpecificOutput?: { permissionDecisionReason?: string };
    };
    expect(json.ok).toBe(true);
    expect(json.decision).toBeUndefined();
    expect(json.hookSpecificOutput?.permissionDecisionReason).not.toBe('invalid_hook_payload');
  });
});

describe('real Claude Code envelopes — Stop vs SessionEnd routing (Phase 3 Fix A)', () => {
  it('Stop is a plain ack — does not close runs and writes no context_packs', async () => {
    const sessionId = `stop-${randomUUID().slice(0, 8)}`;
    await postEvent({ ...REAL_ENVELOPE_SESSION_START, session_id: sessionId, cwd: h.cwd });
    await postEvent({ ...REAL_ENVELOPE_POST_TOOL_USE, session_id: sessionId, cwd: h.cwd });
    await h.drain();

    const stopRes = await postEvent({ ...REAL_ENVELOPE_STOP, session_id: sessionId, cwd: h.cwd });
    expect(stopRes.status).toBe(200);
    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const runs = await h.handle.db
      .select()
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, sessionId)));
    expect(runs.length).toBe(1);
    expect(runs[0]?.status).toBe('in_progress');

    const packs = await h.handle.db
      .select()
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, runs[0]?.id ?? ''));
    expect(packs.length).toBe(0);
  });

  it('SessionEnd closes the runs row to completed and auto-saves exactly one Context Pack', async () => {
    const sessionId = `send-${randomUUID().slice(0, 8)}`;
    await postEvent({ ...REAL_ENVELOPE_SESSION_START, session_id: sessionId, cwd: h.cwd });
    await postEvent({ ...REAL_ENVELOPE_POST_TOOL_USE, session_id: sessionId, cwd: h.cwd });
    await h.drain();

    const endRes = await postEvent({ ...REAL_ENVELOPE_SESSION_END, session_id: sessionId, cwd: h.cwd });
    expect(endRes.status).toBe(200);
    // SessionEnd's auto-save is fire-and-forget; we wait one drain
    // cycle plus a tiny event-loop yield to let it land.
    await h.drain();
    await new Promise((r) => setTimeout(r, 100));

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const runs = await h.handle.db
      .select()
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, sessionId)));
    expect(runs.length).toBe(1);
    expect(runs[0]?.status).toBe('completed');
    expect(runs[0]?.endedAt).toBeTruthy();

    const packs = await h.handle.db
      .select()
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, runs[0]?.id ?? ''));
    expect(packs.length).toBe(1);
  });

  it('replaying SessionEnd is idempotent — still exactly one Context Pack', async () => {
    const sessionId = `dedupe-${randomUUID().slice(0, 8)}`;
    await postEvent({ ...REAL_ENVELOPE_SESSION_START, session_id: sessionId, cwd: h.cwd });
    await h.drain();

    // Two SessionEnd posts back-to-back.
    await postEvent({ ...REAL_ENVELOPE_SESSION_END, session_id: sessionId, cwd: h.cwd });
    await postEvent({ ...REAL_ENVELOPE_SESSION_END, session_id: sessionId, cwd: h.cwd });
    await h.drain();
    await new Promise((r) => setTimeout(r, 100));

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const runs = await h.handle.db
      .select()
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, h.projectId), eq(sqliteSchema.runs.sessionId, sessionId)));
    expect(runs.length).toBe(1);

    const packs = await h.handle.db
      .select()
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, runs[0]?.id ?? ''));
    expect(packs.length).toBe(1);
  });
});
