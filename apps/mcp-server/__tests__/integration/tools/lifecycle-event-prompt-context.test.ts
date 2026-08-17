import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../../src/lib/context-pack.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createRunRecorder } from '../../../src/lib/run-recorder.js';
import { createLifecycleEventToolRegistration } from '../../../src/tools/lifecycle-event/manifest.js';
import { createRecordDecisionToolRegistration } from '../../../src/tools/record-decision/manifest.js';
import { createSaveContextPackToolRegistration } from '../../../src/tools/save-context-pack/manifest.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';
import { drainOutbox } from '../_helpers/drain-outbox.js';

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly cwd: string;
  readonly deps: ContextDeps;
  readonly contextPacksRoot: string;
}

async function openHarness(projectSlug: string): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-prompt-context-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-prompt-context-packs-'));
  const store = createContextPackStore({ db: handle, contextPacksRoot });
  const baseDeps = makeFakeDeps({ runRecorder: createRunRecorder({ db: handle }) });
  const deps: ContextDeps = Object.freeze({ ...baseDeps, contextPack: store });

  return {
    close: async () => {
      await client.close();
    },
    handle,
    cwd,
    deps,
    contextPacksRoot,
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(
    createLifecycleEventToolRegistration({ db: h.handle, mode: 'solo', contextPacksRoot: h.contextPacksRoot }),
  );
  registry.register(createRecordDecisionToolRegistration({ db: h.handle }));
  registry.register(createSaveContextPackToolRegistration({ db: h.handle }));
  return registry;
}

function unwrapHook(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): {
  hookSpecificOutput?: { additionalContext?: string };
} {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

async function sessionStart(
  registry: ToolRegistry,
  h: Harness,
  sessionId: string,
  agentType = 'codex',
): Promise<string> {
  const rawPayload =
    agentType === 'cursor'
      ? { hook_event_name: 'sessionStart', session_id: sessionId, cwd: h.cwd }
      : { hook_event_name: 'SessionStart', session_id: sessionId, cwd: h.cwd };
  const result = await registry.handleCall('lifecycle_event', { agentType, rawPayload }, 'mcp-session', {
    agentType,
  });
  await drainOutbox(h.handle);
  const runId = (result.structuredContent as { runId?: string | null } | undefined)?.runId;
  if (runId === undefined || runId === null) throw new Error('expected runId');
  return runId;
}

async function userPromptSubmit(args: {
  readonly registry: ToolRegistry;
  readonly h: Harness;
  readonly sessionId: string;
  readonly prompt: string;
  readonly agentType?: string;
}): Promise<string | undefined> {
  const agentType = args.agentType ?? 'codex';
  const rawPayload =
    agentType === 'cursor'
      ? {
          hook_event_name: 'beforeSubmitPrompt',
          session_id: args.sessionId,
          cwd: args.h.cwd,
          prompt: args.prompt,
        }
      : {
          hook_event_name: 'UserPromptSubmit',
          session_id: args.sessionId,
          cwd: args.h.cwd,
          prompt: args.prompt,
        };
  const result = await args.registry.handleCall('lifecycle_event', { agentType, rawPayload }, 'mcp-session', {
    agentType,
  });
  return unwrapHook(result).hookSpecificOutput?.additionalContext;
}

describe('lifecycle_event — prompt-relevant context', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness('proj-prompt-context');
  });
  afterEach(async () => {
    await h.close();
  });

  it('injects relevant decisions and Context Packs on UserPromptSubmit after SessionStart', async () => {
    const registry = buildRegistry(h);
    const runId = await sessionStart(registry, h, 'sess_prompt');

    await registry.handleCall(
      'record_decision',
      {
        runId,
        description: 'Use prompt hook relevance refresh for stale SessionStart snapshots',
        rationale: 'The daemon is warm, so per-prompt context lookup is cheap enough when bounded',
      },
      'sess_prompt',
    );
    await registry.handleCall(
      'save_context_pack',
      {
        runId,
        title: 'Prompt hook relevance refresh',
        content:
          'UserPromptSubmit should fetch prompt-relevant Coodra decisions and context packs instead of relying only on stale SessionStart snapshots.',
      },
      'sess_prompt',
    );

    const additionalContext = await userPromptSubmit({
      registry,
      h,
      sessionId: 'sess_prompt',
      prompt:
        'Please implement the prompt hook relevance refresh so stale SessionStart snapshots do not guide this work.',
    });

    expect(additionalContext).toContain('## Prompt-relevant Coodra context');
    expect(additionalContext).toContain('Use prompt hook relevance refresh');
    expect(additionalContext).toContain('Prompt hook relevance refresh');
    expect(additionalContext).not.toContain('## Coodra session contract');
  });

  it('uses Graphify file impact decisions when the prompt mentions a file', async () => {
    const registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_file_prompt');
    h.handle.raw.prepare('UPDATE projects SET cwd = ? WHERE slug = ?').run(h.cwd, 'proj-prompt-context');

    const graphRoot = join(h.cwd, '.coodra', 'graphify', 'out');
    await mkdir(graphRoot, { recursive: true });
    await writeFile(
      join(graphRoot, 'graph.json'),
      JSON.stringify({
        nodes: [
          { id: 'hook_handler', source_file: 'apps/mcp-server/src/tools/lifecycle-event/handler.ts' },
          { id: 'prompt_context', source_file: 'apps/mcp-server/src/lib/prompt-context.ts' },
        ],
        links: [{ source: 'hook_handler', target: 'prompt_context' }],
      }),
      'utf8',
    );

    h.handle.raw
      .prepare(
        `INSERT INTO decisions (id, project_id, idempotency_key, run_id, description, rationale, created_at)
         VALUES (?, (SELECT id FROM projects WHERE slug = ?), ?, (SELECT id FROM runs WHERE session_id = ?), ?, ?, ?)`,
      )
      .run(
        'dec_prompt_file',
        'proj-prompt-context',
        'idem_prompt_file',
        'sess_file_prompt',
        'Keep prompt relevance code isolated in prompt-context.ts',
        'The lifecycle handler should stay focused on hook normalization and output shaping',
        1000,
      );
    h.handle.raw
      .prepare(
        `INSERT INTO decision_edges (id, project_id, from_decision_id, edge_type, target_type, target_id)
         VALUES (?, (SELECT id FROM projects WHERE slug = ?), ?, ?, ?, ?)`,
      )
      .run('de_prompt_file', 'proj-prompt-context', 'dec_prompt_file', 'affects', 'graph_node', 'prompt_context');

    const additionalContext = await userPromptSubmit({
      registry,
      h,
      sessionId: 'sess_file_prompt',
      prompt:
        'Before editing apps/mcp-server/src/tools/lifecycle-event/handler.ts, what decisions are in the Graphify blast radius?',
    });

    expect(additionalContext).toContain('File impact for apps/mcp-server/src/tools/lifecycle-event/handler.ts');
    expect(additionalContext).toContain('Graphify blast radius');
    expect(additionalContext).toContain('Keep prompt relevance code isolated');
  });

  it('skips tiny acknowledgement prompts', async () => {
    const registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_ack');
    const additionalContext = await userPromptSubmit({ registry, h, sessionId: 'sess_ack', prompt: 'ok' });
    expect(additionalContext).toBeUndefined();
  });

  it('does not attempt UserPromptSubmit injection for Cursor', async () => {
    const registry = buildRegistry(h);
    await sessionStart(registry, h, 'sess_cursor', 'cursor');
    const additionalContext = await userPromptSubmit({
      registry,
      h,
      sessionId: 'sess_cursor',
      agentType: 'cursor',
      prompt: 'Please implement prompt hook relevance refresh for stale SessionStart snapshots.',
    });
    expect(additionalContext).toBeUndefined();
  });
});
