import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createGetRunIdToolRegistration } from '../../../src/tools/get-run-id/manifest.js';
import type { GetRunIdOutput } from '../../../src/tools/get-run-id/schema.js';
import { createLinkRunToIssueToolRegistration } from '../../../src/tools/link-run-to-issue/manifest.js';
import type { LinkRunToIssueOutput } from '../../../src/tools/link-run-to-issue/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__link_run_to_issue` (Module 09 Track 9A,
 * ADR-016 — Jira = Direct). Exercises the real handler end-to-end via the
 * `ToolRegistry` (the same dispatch path the stdio transport uses) against
 * an in-memory SQLite handle.
 *
 * Covers: bind a run to a Jira key (UPDATE runs.issue_ref); uppercase
 * normalisation; idempotent no-op when already bound; rebind reports the
 * previous key; run_not_found soft-failure for an unknown runId.
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
  return registry;
}

function unwrap<T>(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): T {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: T };
  if (!parsed.ok || parsed.data === undefined) {
    throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

/** Mint a run via get_run_id and return its runId. */
async function mintRun(registry: ToolRegistry, projectSlug: string, sessionId: string): Promise<string> {
  const result = await registry.handleCall(
    'get_run_id',
    { projectSlug, cwd: `/tmp/coodra-test/${projectSlug}`, confirmRegister: true },
    sessionId,
    { agentType: 'claude_code' },
  );
  const out = unwrap<GetRunIdOutput>(result);
  if (!out.ok) throw new Error(`get_run_id failed: ${JSON.stringify(out)}`);
  return out.runId;
}

describe('link_run_to_issue — binds runs.issue_ref', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('binds a run to a Jira key and persists it on the runs row', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'proj-a', 'sess_1');

    const out = unwrap<LinkRunToIssueOutput>(
      await registry.handleCall('link_run_to_issue', { runId, issueRef: 'PROJ-123' }, 'sess_1'),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.issueRef).toBe('PROJ-123');
      expect(out.previousIssueRef).toBeNull();
      expect(out.updated).toBe(true);
    }
    const rows = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId));
    expect(rows[0]?.issueRef).toBe('PROJ-123');
  });

  it('normalises a lowercase key to uppercase before storing', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'proj-b', 'sess_2');
    const out = unwrap<LinkRunToIssueOutput>(
      await registry.handleCall('link_run_to_issue', { runId, issueRef: 'proj-7' }, 'sess_2'),
    );
    expect(out.ok && out.issueRef).toBe('PROJ-7');
    const rows = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId));
    expect(rows[0]?.issueRef).toBe('PROJ-7');
  });

  it('is idempotent — re-binding the same key is updated:false with no write', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'proj-c', 'sess_3');
    await registry.handleCall('link_run_to_issue', { runId, issueRef: 'KAN-1' }, 'sess_3');
    const second = unwrap<LinkRunToIssueOutput>(
      await registry.handleCall('link_run_to_issue', { runId, issueRef: 'kan-1' }, 'sess_3'),
    );
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.updated).toBe(false);
      expect(second.previousIssueRef).toBe('KAN-1');
      expect(second.issueRef).toBe('KAN-1');
    }
  });

  it('rebind reports the previous key and overwrites', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'proj-d', 'sess_4');
    await registry.handleCall('link_run_to_issue', { runId, issueRef: 'PROJ-1' }, 'sess_4');
    const rebind = unwrap<LinkRunToIssueOutput>(
      await registry.handleCall('link_run_to_issue', { runId, issueRef: 'OTHER-9' }, 'sess_4'),
    );
    expect(rebind.ok).toBe(true);
    if (rebind.ok) {
      expect(rebind.previousIssueRef).toBe('PROJ-1');
      expect(rebind.issueRef).toBe('OTHER-9');
      expect(rebind.updated).toBe(true);
    }
    const rows = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId));
    expect(rows[0]?.issueRef).toBe('OTHER-9');
  });

  it('returns run_not_found (soft-failure) for an unknown runId', async () => {
    const registry = buildRegistry(h.handle);
    const out = unwrap<LinkRunToIssueOutput>(
      await registry.handleCall('link_run_to_issue', { runId: 'run_does_not_exist', issueRef: 'PROJ-1' }, 'sess_5'),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBe('run_not_found');
      expect(out.howToFix).toContain('get_run_id');
    }
  });
});
