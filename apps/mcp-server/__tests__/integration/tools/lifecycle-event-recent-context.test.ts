import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../../src/lib/context-pack.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createLifecycleEventToolRegistration } from '../../../src/tools/lifecycle-event/manifest.js';
import { createRecordDecisionToolRegistration } from '../../../src/tools/record-decision/manifest.js';
import { createSaveContextPackToolRegistration } from '../../../src/tools/save-context-pack/manifest.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `lifecycle_event`'s SessionStart "recent context"
 * block — the replacement for the short-lived "Active Work Packs" block
 * (coodra-work redesign, round 2). SessionStart should inject substance
 * (recent Context Packs + recent decisions, project-wide) rather than
 * Work Pack metadata — Work Pack resume is the `coodra-work` skill's own
 * explicit job (`work_pack_status`), not something every session needs
 * pushed at it automatically.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly cwd: string;
  readonly deps: ContextDeps;
}

async function openHarness(projectSlug: string): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-recent-context-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-recent-context-packs-'));
  const store = createContextPackStore({ db: handle, contextPacksRoot });
  const baseDeps = makeFakeDeps();
  const deps: ContextDeps = Object.freeze({ ...baseDeps, contextPack: store });

  return {
    close: async () => {
      await client.close();
    },
    handle,
    cwd,
    deps,
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(createLifecycleEventToolRegistration({ db: h.handle, mode: 'solo' }));
  registry.register(createSaveContextPackToolRegistration({ db: h.handle }));
  registry.register(createRecordDecisionToolRegistration({ db: h.handle }));
  return registry;
}

function unwrapHook(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): {
  hookSpecificOutput?: { additionalContext?: string };
} {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

interface SessionStartResult {
  readonly additionalContext: string | undefined;
  readonly runId: string | null;
}

async function sessionStart(registry: ToolRegistry, h: Harness, sessionId: string): Promise<SessionStartResult> {
  const result = await registry.handleCall(
    'lifecycle_event',
    {
      agentType: 'claude_code',
      rawPayload: { hook_event_name: 'SessionStart', session_id: sessionId, cwd: h.cwd },
    },
    'mcp-session',
    { agentType: 'claude_code' },
  );
  const structured = result.structuredContent as { runId?: string | null } | undefined;
  return {
    additionalContext: unwrapHook(result).hookSpecificOutput?.additionalContext,
    runId: structured?.runId ?? null,
  };
}

describe('lifecycle_event — SessionStart recent context', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness('proj-lc-rc');
  });
  afterEach(async () => {
    await h.close();
  });

  it('omits the block when the project has no Context Packs or decisions yet', async () => {
    const registry = buildRegistry(h);
    const { additionalContext } = await sessionStart(registry, h, 'sess_empty');
    expect(additionalContext).toBeDefined();
    expect(additionalContext).not.toContain('## Recent context');
  });

  it('surfaces recent Context Pack titles/excerpts and recent decisions, not Work Pack metadata', async () => {
    const registry = buildRegistry(h);
    const seeded = await sessionStart(registry, h, 'sess_seed');
    if (seeded.runId === null) throw new Error('expected a runId from SessionStart structuredContent');

    await registry.handleCall(
      'save_context_pack',
      { runId: seeded.runId, title: 'Removed the UserPromptSubmit Jira hook', content: 'Full body here.' },
      'sess_seed',
    );
    await registry.handleCall(
      'record_decision',
      {
        runId: seeded.runId,
        description: 'Removed UserPromptSubmit Jira-key detection',
        rationale: 'Only worked for Claude/Codex and Cursor has no context field there',
      },
      'sess_seed',
    );

    const { additionalContext } = await sessionStart(registry, h, 'sess_seed');
    expect(additionalContext).toBeDefined();
    expect(additionalContext).toContain('## Recent context');
    expect(additionalContext).toContain('Removed the UserPromptSubmit Jira hook');
    expect(additionalContext).toContain('Removed UserPromptSubmit Jira-key detection');
    expect(additionalContext).not.toContain('## Active Work Packs');
  });

  it('does not inject the block on non-SessionStart events', async () => {
    const registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_pre');
    const result = await registry.handleCall(
      'lifecycle_event',
      {
        agentType: 'claude_code',
        rawPayload: {
          hook_event_name: 'PreToolUse',
          session_id: 'sess_pre',
          cwd: h.cwd,
          tool_name: 'Write',
          tool_use_id: 'toolu_1',
          tool_input: { file_path: 'x.ts' },
        },
      },
      'mcp-session',
      { agentType: 'claude_code' },
    );
    const text = unwrapHook(result);
    expect(text.hookSpecificOutput?.additionalContext).toBeUndefined();
  });
});
