import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DbHandle } from '@coodra/db';
import type { HookEvent } from '@coodra/shared/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionStartHandler } from '../../../src/handlers/session-start.js';
import type { ProjectSlugResolver } from '../../../src/lib/resolve-project-slug.js';
import type { RunRecorder } from '../../../src/lib/run-recorder.js';

/**
 * Locks the SessionStart context contract:
 *
 *   1. With a resolved projectSlug AND skills index on disk,
 *      the handler returns `permissionDecision: 'allow'` AND
 *      `additionalContext` containing the skills index.
 *
 *   2. With a resolved projectSlug but no optional context files,
 *      the handler still returns 'allow' plus the session contract.
 *
 *   3. Without a resolved projectSlug (no `.coodra.json`), the
 *      handler returns 'allow' with contract-only additionalContext and logs
 *      `session_start_no_project_slug`.
 *
 *   4. The runs row audit (`runRecorder.recordSessionStart`) is
 *      always scheduled.
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

describe('createSessionStartHandler — SessionStart context', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-session-start-test-'));
    vi.clearAllMocks();
  });
  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('injects additionalContext with the Agent Recipes index when slug + index resolve', async () => {
    const slug = 'auto-inject-target';
    const recipesDir = join(cwd, '.coodra', 'recipes');
    await mkdir(recipesDir, { recursive: true });
    await mkdir(join(recipesDir, 'ship-cleanly'), { recursive: true });
    await writeFile(
      join(recipesDir, 'ship-cleanly', 'recipe.md'),
      [
        '---',
        'name: ship-cleanly',
        'description: Use this when preparing Coodra release checks for `packages/cli`.',
        'maturity: stable',
        'tags:',
        '  - release',
        '---',
        '',
        '# Ship Cleanly',
      ].join('\n'),
      'utf8',
    );

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
    expect(result.additionalContext ?? '').toContain('Available Agent Recipes');
    expect(result.additionalContext ?? '').toContain('ship-cleanly');
    expect(result.additionalContext ?? '').toContain('Session contract');
    expect(stubRecorder.recordSessionStart).toHaveBeenCalledTimes(1);
  });

  it('returns allow + contract-only additionalContext when optional files are missing', async () => {
    // M05 reshape (2026-05-08): the SessionStart handler ALWAYS pushes
    // the session-contract block onto `additionalContext` so every
    // Claude Code session is reminded of `record_decision` /
    // `save_context_pack` discipline regardless of whether a feature
    // skills index / recent decisions block is available.
    // Pre-M05 this test asserted `additionalContext === undefined`;
    // that expectation was stale — the contract block is intentional.
    // The test now verifies the contract surfaces AND the optional
    // optional dynamic blocks do NOT.
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
    expect(result.additionalContext ?? '').not.toContain('Available Agent Recipes');
    expect(stubRecorder.recordSessionStart).toHaveBeenCalledTimes(1);
  });

  it('returns allow + contract-only additionalContext when projectSlug is unresolved', async () => {
    // Same M05 invariant: the contract block always renders, even when
    // the cwd has no `.coodra.json` and the resolver returns
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
    // Agent Recipes block not present.
    expect(result.additionalContext ?? '').not.toContain('Available Agent Recipes');
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
