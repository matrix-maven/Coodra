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
import { createSessionEndHandler } from '../../../src/handlers/session-end.js';
import { createSessionStartHandler } from '../../../src/handlers/session-start.js';
import { createUserPromptSubmitHandler } from '../../../src/handlers/user-prompt-submit.js';
import { composeDispatch } from '../../../src/lib/dispatch.js';
import { createProjectSlugResolver } from '../../../src/lib/resolve-project-slug.js';
import { createRunRecorder } from '../../../src/lib/run-recorder.js';
import { drainOutbox } from '../_helpers/drain-outbox.js';

/**
 * UserPromptSubmit (Claude Code only today). Verifies the prompt
 * lands in `run_events` with phase='user_prompt' and toolName the
 * stable sentinel `'user_prompt'`. Idempotent on retry via the same
 * hashed-id scheme as PostToolUse.
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
  const cwd = mkdtempSync(join(tmpdir(), 'user-prompt-test-'));
  const sqlitePath = join(cwd, 'data.db');
  const handle = createDb({ kind: 'local', sqlite: { path: sqlitePath } });
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
  migrateSqlite(handle.db);

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
  h = { cwd, handle, hono, drain };
}, 30_000);

afterAll(() => {
  if (h?.handle?.kind === 'sqlite') h.handle.close();
  if (h?.cwd) rmSync(h.cwd, { recursive: true, force: true });
});

describe('UserPromptSubmit (Claude Code)', () => {
  it('prompt lands in run_events with phase=user_prompt and stable sentinel toolName', async () => {
    const sessionId = 'sess-prompt-1';
    const promptId = 'prompt-001';
    const res = await h.hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        prompt: 'rename the foo function to bar across the repo',
        prompt_id: promptId,
      }),
    });
    expect(res.status).toBe(200);
    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.runEvents)
      .where(eq(sqliteSchema.runEvents.phase, 'user_prompt'));
    expect(rows.length).toBe(1);
    expect(rows[0]?.toolName).toBe('user_prompt');
    expect(rows[0]?.toolInput).toContain('rename the foo function to bar');
    expect(rows[0]?.toolInput).toContain(promptId);
  });

  it('same UserPromptSubmit retried 5x → exactly one row (idempotent)', async () => {
    const sessionId = 'sess-prompt-retry';
    const promptId = 'prompt-retry-1';
    const sends = Array.from({ length: 5 }, () =>
      h.hono.request('/v1/hooks/claude-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          session_id: sessionId,
          prompt: 'idempotent prompt',
          prompt_id: promptId,
        }),
      }),
    );
    const responses = await Promise.all(sends);
    expect(responses.every((r) => r.status === 200)).toBe(true);
    await h.drain();

    if (h.handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = await h.handle.db
      .select()
      .from(sqliteSchema.runEvents)
      .where(eq(sqliteSchema.runEvents.toolUseId, 'no-turn'));
    // Filter to only this prompt's rows (toolInput is a JSON string
    // containing the promptId).
    const thisPrompt = rows.filter((r) => r.toolInput.includes(promptId));
    expect(thisPrompt.length).toBe(1);
  });
});
