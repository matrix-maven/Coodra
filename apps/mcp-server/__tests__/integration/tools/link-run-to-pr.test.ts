import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createGetRunIdToolRegistration } from '../../../src/tools/get-run-id/manifest.js';
import type { GetRunIdOutput } from '../../../src/tools/get-run-id/schema.js';
import { createLinkRunToPrToolRegistration } from '../../../src/tools/link-run-to-pr/manifest.js';
import type { LinkRunToPrOutput } from '../../../src/tools/link-run-to-pr/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__link_run_to_pr`, mirroring
 * `link-run-to-issue.test.ts`. Exercises the real handler end-to-end via
 * the `ToolRegistry` against an in-memory SQLite handle.
 *
 * Covers: bind a run to a PR ref (UPDATE runs.pr_ref); no case
 * normalisation; idempotent no-op when already bound; rebind reports the
 * previous ref; run_not_found soft-failure for an unknown runId.
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
  registry.register(createLinkRunToPrToolRegistration({ db: handle }));
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
  const result = await registry.handleCall('get_run_id', { projectSlug }, sessionId, { agentType: 'claude_code' });
  const out = unwrap<GetRunIdOutput>(result);
  if (!out.ok) throw new Error(`get_run_id failed: ${JSON.stringify(out)}`);
  return out.runId;
}

describe('link_run_to_pr — binds runs.pr_ref', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('binds a run to a PR reference and persists it on the runs row', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'proj-a', 'sess_1');

    const out = unwrap<LinkRunToPrOutput>(
      await registry.handleCall('link_run_to_pr', { runId, prRef: 'owner/repo#88' }, 'sess_1'),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.prRef).toBe('owner/repo#88');
      expect(out.previousPrRef).toBeNull();
      expect(out.updated).toBe(true);
    }
    const rows = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId));
    expect(rows[0]?.prRef).toBe('owner/repo#88');
  });

  it('does not case-normalise the reference', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'proj-b', 'sess_2');
    const out = unwrap<LinkRunToPrOutput>(
      await registry.handleCall('link_run_to_pr', { runId, prRef: 'MR!12' }, 'sess_2'),
    );
    expect(out.ok && out.prRef).toBe('MR!12');
    const rows = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId));
    expect(rows[0]?.prRef).toBe('MR!12');
  });

  it('is idempotent — re-binding the same ref is updated:false with no write', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'proj-c', 'sess_3');
    await registry.handleCall('link_run_to_pr', { runId, prRef: '42' }, 'sess_3');
    const second = unwrap<LinkRunToPrOutput>(
      await registry.handleCall('link_run_to_pr', { runId, prRef: '42' }, 'sess_3'),
    );
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.updated).toBe(false);
      expect(second.previousPrRef).toBe('42');
      expect(second.prRef).toBe('42');
    }
  });

  it('rebind reports the previous ref and overwrites', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'proj-d', 'sess_4');
    await registry.handleCall('link_run_to_pr', { runId, prRef: '1' }, 'sess_4');
    const rebind = unwrap<LinkRunToPrOutput>(
      await registry.handleCall('link_run_to_pr', { runId, prRef: '9' }, 'sess_4'),
    );
    expect(rebind.ok).toBe(true);
    if (rebind.ok) {
      expect(rebind.previousPrRef).toBe('1');
      expect(rebind.prRef).toBe('9');
      expect(rebind.updated).toBe(true);
    }
    const rows = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId));
    expect(rows[0]?.prRef).toBe('9');
  });

  it('returns run_not_found (soft-failure) for an unknown runId', async () => {
    const registry = buildRegistry(h.handle);
    const out = unwrap<LinkRunToPrOutput>(
      await registry.handleCall('link_run_to_pr', { runId: 'run_does_not_exist', prRef: '1' }, 'sess_5'),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBe('run_not_found');
      expect(out.howToFix).toContain('get_run_id');
    }
  });

  it('binding a PR ref does not disturb an independently-bound issue ref', async () => {
    const registry = new ToolRegistry({ deps: makeFakeDeps() });
    registry.register(createGetRunIdToolRegistration({ db: h.handle, mode: 'solo' }));
    registry.register(createLinkRunToPrToolRegistration({ db: h.handle }));
    const { createLinkRunToIssueToolRegistration } = await import('../../../src/tools/link-run-to-issue/manifest.js');
    registry.register(createLinkRunToIssueToolRegistration({ db: h.handle }));

    const runId = await mintRun(registry, 'proj-e', 'sess_6');
    await registry.handleCall('link_run_to_issue', { runId, issueRef: 'PROJ-1' }, 'sess_6');
    await registry.handleCall('link_run_to_pr', { runId, prRef: '55' }, 'sess_6');

    const rows = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId));
    expect(rows[0]?.issueRef).toBe('PROJ-1');
    expect(rows[0]?.prRef).toBe('55');
  });
});
