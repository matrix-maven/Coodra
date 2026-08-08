import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../../src/lib/context-pack.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createRunRecorder } from '../../../src/lib/run-recorder.js';
import { createLifecycleEventToolRegistration } from '../../../src/tools/lifecycle-event/manifest.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';
import { drainOutbox } from '../_helpers/drain-outbox.js';

/**
 * Regression test for the Codex TOOL_MATCHER fix (2026-08-08): Codex's
 * matcher regex engine rejects look-around, so `mcp__(?!coodra__|
 * graphify__).*` made Codex reject the whole hooks.json and PreToolUse/
 * PostToolUse/PermissionRequest never registered at all — see
 * codex-plugin.ts's TOOL_MATCHER docblock. The fix widens the CLI-side
 * matcher to plain `mcp__.*` (every MCP tool call, including Coodra's own)
 * and relies entirely on the server-side `isCoodraOwnMcpTool` filter here
 * to skip Coodra's own two managed servers — previously that filter only
 * gated the policy check; it now also has to gate `run_events` recording,
 * since self-calls can genuinely reach this handler for the first time.
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

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-self-call-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-self-call-packs-'));
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
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(createLifecycleEventToolRegistration({ db: h.handle, mode: 'solo' }));
  return registry;
}

async function fireToolEvent(
  registry: ToolRegistry,
  h: Harness,
  args: { readonly hookEventName: 'PreToolUse' | 'PostToolUse'; readonly toolName: string; readonly toolUseId: string },
): Promise<void> {
  await registry.handleCall(
    'lifecycle_event',
    {
      agentType: 'codex',
      rawPayload: {
        hook_event_name: args.hookEventName,
        session_id: 'sess_self_call',
        cwd: h.cwd,
        tool_name: args.toolName,
        tool_use_id: args.toolUseId,
        tool_input: {},
      },
    },
    'mcp-session',
    { agentType: 'codex' },
  );
  await drainOutbox(h.handle);
}

async function runEventToolNames(handle: SqliteHandle): Promise<string[]> {
  const rows = await handle.db.select({ toolName: sqliteSchema.runEvents.toolName }).from(sqliteSchema.runEvents);
  return rows.map((r) => r.toolName);
}

describe('lifecycle_event — self-call filtering after the broad Codex TOOL_MATCHER', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness('proj-self-call');
  });
  afterEach(async () => {
    await h.close();
  });

  it("does not record run_events for Coodra's own mcp__coodra__*/mcp__graphify__* tool calls", async () => {
    const registry = buildRegistry(h);
    await fireToolEvent(registry, h, {
      hookEventName: 'PreToolUse',
      toolName: 'mcp__coodra__record_decision',
      toolUseId: 'tu_coodra_pre',
    });
    await fireToolEvent(registry, h, {
      hookEventName: 'PostToolUse',
      toolName: 'mcp__coodra__record_decision',
      toolUseId: 'tu_coodra_post',
    });
    await fireToolEvent(registry, h, {
      hookEventName: 'PreToolUse',
      toolName: 'mcp__graphify__query_graph',
      toolUseId: 'tu_graphify_pre',
    });

    const toolNames = await runEventToolNames(h.handle);
    expect(toolNames).not.toContain('mcp__coodra__record_decision');
    expect(toolNames).not.toContain('mcp__graphify__query_graph');
  });

  it('still records run_events for real tool calls (Bash, third-party MCP) once the broad matcher lets them through', async () => {
    const registry = buildRegistry(h);
    await fireToolEvent(registry, h, { hookEventName: 'PreToolUse', toolName: 'Bash', toolUseId: 'tu_bash_pre' });
    await fireToolEvent(registry, h, {
      hookEventName: 'PreToolUse',
      toolName: 'mcp__jira__create_issue',
      toolUseId: 'tu_jira_pre',
    });

    const toolNames = await runEventToolNames(h.handle);
    expect(toolNames).toContain('Bash');
    expect(toolNames).toContain('mcp__jira__create_issue');
  });
});
