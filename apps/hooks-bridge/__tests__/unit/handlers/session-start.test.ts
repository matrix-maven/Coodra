import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DbHandle } from '@coodra/contextos-db';
import type { HookEvent } from '@coodra/contextos-shared/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionStartHandler } from '../../../src/handlers/session-start.js';
import type { ProjectSlugResolver } from '../../../src/lib/resolve-project-slug.js';
import type { RunRecorder } from '../../../src/lib/run-recorder.js';

/**
 * Locks the dec_83ba10c1 (2026-05-02) SessionStart auto-inject
 * contract — system-architecture §16 Pattern 20:
 *
 *   1. With a resolved projectSlug AND feature-pack files on disk,
 *      the handler returns `permissionDecision: 'allow'` AND
 *      `additionalContext` containing the project Feature Pack
 *      body (spec.md, implementation.md, techstack.md).
 *
 *   2. With a resolved projectSlug but NO feature-pack files,
 *      the handler still returns 'allow' but skips additionalContext.
 *
 *   3. Without a resolved projectSlug (no `.contextos.json`), the
 *      handler returns 'allow' with no additionalContext and logs
 *      `session_start_no_project_slug`.
 *
 *   4. The runs row audit (`runRecorder.recordSessionStart`) is
 *      always scheduled — Feature Pack absence does NOT disable
 *      audit.
 */

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    agentType: 'claude_code',
    eventPhase: 'session_start',
    sessionId: 'sess-ss',
    toolName: 'session_start',
    toolInput: {},
    rawAt: '2026-05-02T08:00:00.000Z',
    cwd: '/tmp/will-be-overridden',
    ...overrides,
  };
}

const stubRecorder: RunRecorder = {
  recordPostToolUse: vi.fn(),
  recordUserPromptSubmit: vi.fn(),
  recordPolicyDecision: vi.fn(),
  recordSessionStart: vi.fn(),
  recordSessionEnd: vi.fn(),
};

const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

describe('createSessionStartHandler — Pattern 20 auto-inject', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'contextos-session-start-test-'));
    vi.clearAllMocks();
  });
  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('injects additionalContext with the Feature Pack body when slug + files resolve', async () => {
    const slug = 'auto-inject-target';
    const packDir = join(cwd, 'docs', 'feature-packs', slug);
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'spec.md'), '# spec body line', 'utf8');
    await writeFile(join(packDir, 'implementation.md'), '# impl body line', 'utf8');
    await writeFile(join(packDir, 'techstack.md'), '# tech body line', 'utf8');

    // M04 Phase 2 S1 (F3): handler now calls resolveAndEnsure on the
    // audit path. Mock both to keep the test intent unchanged.
    const stubResolver: ProjectSlugResolver = {
      resolve: vi.fn().mockResolvedValue({ slug, projectId: 'proj_x' }),
      resolveAndEnsure: vi.fn().mockResolvedValue({ slug, projectId: 'proj_x' }),
      invalidate: vi.fn(),
    };
    const handler = createSessionStartHandler({
      runRecorder: stubRecorder,
      projectSlugResolver: stubResolver,
      db: fakeDb,
      mode: 'solo',
    });
    const result = await handler(makeEvent({ cwd }));

    expect(result.permissionDecision).toBe('allow');
    expect(typeof result.additionalContext).toBe('string');
    expect(result.additionalContext ?? '').toContain('# ContextOS Feature Pack — auto-inject-target');
    expect(result.additionalContext ?? '').toContain('# spec body line');
    expect(result.additionalContext ?? '').toContain('# impl body line');
    expect(result.additionalContext ?? '').toContain('# tech body line');
    expect(stubRecorder.recordSessionStart).toHaveBeenCalledTimes(1);
  });

  it('returns allow + contract-only additionalContext when feature-pack files are missing (M05 contract block always renders)', async () => {
    // M05 reshape (2026-05-08): the SessionStart handler ALWAYS pushes
    // the session-contract block onto `additionalContext` so every
    // Claude Code session is reminded of `record_decision` /
    // `save_context_pack` discipline regardless of whether a feature
    // pack / features index / recent decisions block is available.
    // Pre-M05 this test asserted `additionalContext === undefined`;
    // that expectation was stale — the contract block is intentional.
    // The test now verifies the contract surfaces AND the optional
    // pack-body block does NOT (since feature-pack files are missing).
    const stubResolver: ProjectSlugResolver = {
      resolve: vi.fn().mockResolvedValue({ slug: 'no-files-here', projectId: 'proj_y' }),
      resolveAndEnsure: vi.fn().mockResolvedValue({ slug: 'no-files-here', projectId: 'proj_y' }),
      invalidate: vi.fn(),
    };
    const handler = createSessionStartHandler({
      runRecorder: stubRecorder,
      projectSlugResolver: stubResolver,
      db: fakeDb,
      mode: 'solo',
    });
    const result = await handler(makeEvent({ cwd }));

    expect(result.permissionDecision).toBe('allow');
    expect(typeof result.additionalContext).toBe('string');
    // Contract block is present.
    expect(result.additionalContext ?? '').toContain('Session contract');
    expect(result.additionalContext ?? '').toContain('save_context_pack');
    // Pack body is absent — there were no feature-pack files on disk.
    expect(result.additionalContext ?? '').not.toContain('# spec body');
    expect(result.additionalContext ?? '').not.toContain('# impl body');
    expect(stubRecorder.recordSessionStart).toHaveBeenCalledTimes(1);
  });

  it('returns allow + contract-only additionalContext when projectSlug is unresolved', async () => {
    // Same M05 invariant: the contract block always renders, even when
    // the cwd has no `.contextos.json` and the resolver returns
    // undefined for both slug and projectId. The pack + features-index
    // + recent-decisions blocks are skipped (they all require a slug
    // to fetch their data) but the contract is the static
    // priming-reminder and is unaffected.
    const stubResolver: ProjectSlugResolver = {
      resolve: vi.fn().mockResolvedValue({ slug: undefined, projectId: undefined }),
      resolveAndEnsure: vi.fn().mockResolvedValue({ slug: undefined, projectId: undefined }),
      invalidate: vi.fn(),
    };
    const handler = createSessionStartHandler({
      runRecorder: stubRecorder,
      projectSlugResolver: stubResolver,
      db: fakeDb,
      mode: 'solo',
    });
    const result = await handler(makeEvent({ cwd }));

    expect(result.permissionDecision).toBe('allow');
    expect(typeof result.additionalContext).toBe('string');
    expect(result.additionalContext ?? '').toContain('Session contract');
    // Pack + features blocks not present.
    expect(result.additionalContext ?? '').not.toContain('Available features');
    expect(result.additionalContext ?? '').not.toContain('# spec body');
    expect(stubRecorder.recordSessionStart).toHaveBeenCalledTimes(1);
  });

  it('non-session_start event → defensive allow + reason event_phase_mismatch (no audit)', async () => {
    const stubResolver: ProjectSlugResolver = {
      resolve: vi.fn().mockResolvedValue({ slug: 'x', projectId: 'proj_z' }),
      resolveAndEnsure: vi.fn().mockResolvedValue({ slug: 'x', projectId: 'proj_z' }),
      invalidate: vi.fn(),
    };
    const handler = createSessionStartHandler({
      runRecorder: stubRecorder,
      projectSlugResolver: stubResolver,
      db: fakeDb,
      mode: 'solo',
    });
    const result = await handler(makeEvent({ eventPhase: 'pre' }));
    expect(result.permissionDecision).toBe('allow');
    expect(result.permissionDecisionReason).toBe('event_phase_mismatch');
    expect(stubRecorder.recordSessionStart).not.toHaveBeenCalled();
  });
});
