import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createGetRunIdToolRegistration } from '../../../src/tools/get-run-id/manifest.js';
import type { GetRunIdOutput } from '../../../src/tools/get-run-id/schema.js';
import { createLinkRunToIssueToolRegistration } from '../../../src/tools/link-run-to-issue/manifest.js';
import { createQueryDecisionsToolRegistration } from '../../../src/tools/query-decisions/manifest.js';
import type { QueryDecisionsOutput } from '../../../src/tools/query-decisions/schema.js';
import { createQueryRunHistoryToolRegistration } from '../../../src/tools/query-run-history/manifest.js';
import type { QueryRunHistoryOutput } from '../../../src/tools/query-run-history/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for the Module 09 J2 "Jira-aware history" payoff
 * (ADR-016). `link_run_to_issue` binds runs to a Jira key; the read-path
 * tools then answer "what touched PROJ-412?":
 *   - query_run_history filters runs by issueRef (case-insensitive).
 *   - query_decisions filters decisions whose run is bound to the issue.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
}

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);
  return {
    close: async () => {
      await client.close();
    },
    handle,
  };
}

function buildRegistry(handle: SqliteHandle): ToolRegistry {
  const registry = new ToolRegistry({ deps: makeFakeDeps() });
  registry.register(createGetRunIdToolRegistration({ db: handle, mode: 'solo' }));
  registry.register(createLinkRunToIssueToolRegistration({ db: handle }));
  registry.register(createQueryRunHistoryToolRegistration({ db: handle }));
  registry.register(createQueryDecisionsToolRegistration({ db: handle }));
  return registry;
}

function unwrap<T>(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): T {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: T };
  if (!parsed.ok || parsed.data === undefined) throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  return parsed.data;
}

async function mintRun(registry: ToolRegistry, projectSlug: string, sessionId: string): Promise<string> {
  const out = unwrap<GetRunIdOutput>(
    await registry.handleCall(
      'get_run_id',
      { projectSlug, cwd: `/tmp/coodra-test/${projectSlug}`, confirmRegister: true },
      sessionId,
      { agentType: 'claude_code' },
    ),
  );
  if (!out.ok) throw new Error('get_run_id failed');
  return out.runId;
}

describe('issue-aware queries — what touched PROJ-412?', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('query_run_history filters runs by issueRef (case-insensitive); no filter returns all', async () => {
    const registry = buildRegistry(h.handle);
    const slug = 'jira-history';
    const runA = await mintRun(registry, slug, 'sess_a');
    const runB = await mintRun(registry, slug, 'sess_b');
    await mintRun(registry, slug, 'sess_c'); // unlinked

    await registry.handleCall('link_run_to_issue', { runId: runA, issueRef: 'PROJ-412' }, 'sess_a');
    await registry.handleCall('link_run_to_issue', { runId: runB, issueRef: 'OTHER-1' }, 'sess_b');

    // Filtered — lowercase input proves case-insensitivity.
    const filtered = unwrap<QueryRunHistoryOutput>(
      await registry.handleCall('query_run_history', { projectSlug: slug, issueRef: 'proj-412' }, 'sess_q'),
    );
    expect(filtered.ok).toBe(true);
    if (filtered.ok) {
      expect(filtered.runs).toHaveLength(1);
      expect(filtered.runs[0]?.runId).toBe(runA);
      expect(filtered.runs[0]?.issueRef).toBe('PROJ-412');
    }

    // Unfiltered — all three runs.
    const all = unwrap<QueryRunHistoryOutput>(
      await registry.handleCall('query_run_history', { projectSlug: slug }, 'sess_q'),
    );
    expect(all.ok && all.runs.length).toBe(3);
  });

  it('query_decisions filters decisions whose run is bound to the issue', async () => {
    const registry = buildRegistry(h.handle);
    const slug = 'jira-decisions';
    const runA = await mintRun(registry, slug, 'sess_a');
    const runB = await mintRun(registry, slug, 'sess_b');
    await registry.handleCall('link_run_to_issue', { runId: runA, issueRef: 'PROJ-412' }, 'sess_a');
    await registry.handleCall('link_run_to_issue', { runId: runB, issueRef: 'OTHER-1' }, 'sess_b');

    // Insert decisions directly (bypasses record_decision's auth path — we
    // are testing the read-side issueRef filter, not the write tool).
    await h.handle.db.insert(sqliteSchema.decisions).values([
      { id: 'dec_a', idempotencyKey: 'k_a', runId: runA, description: 'Chose X for the ticket', rationale: 'r' },
      { id: 'dec_b', idempotencyKey: 'k_b', runId: runB, description: 'Unrelated decision', rationale: 'r' },
    ]);

    const filtered = unwrap<QueryDecisionsOutput>(
      await registry.handleCall('query_decisions', { projectSlug: slug, issueRef: 'PROJ-412' }, 'sess_q'),
    );
    expect(filtered.ok).toBe(true);
    if (filtered.ok) {
      expect(filtered.decisions).toHaveLength(1);
      expect(filtered.decisions[0]?.description).toBe('Chose X for the ticket');
    }

    const all = unwrap<QueryDecisionsOutput>(
      await registry.handleCall('query_decisions', { projectSlug: slug }, 'sess_q'),
    );
    expect(all.ok && all.decisions.length).toBe(2);
  });
});
