import { migrateSqlite } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunRecorder } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { getFeatureInputSchema } from '../../../src/tools/get-feature/schema.js';
import { getFeaturePackInputSchema } from '../../../src/tools/get-feature-pack/schema.js';
import { listContextPacksInputSchema } from '../../../src/tools/list-context-packs/schema.js';
import { createQueryRunHistoryToolRegistration } from '../../../src/tools/query-run-history/manifest.js';
import { queryRunHistoryInputSchema } from '../../../src/tools/query-run-history/schema.js';
import { searchPacksNlInputSchema } from '../../../src/tools/search-packs-nl/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * ROI instrumentation (2026-06-21) — proves the reuse-read knowledge tools
 * accept an optional `runId` AND that the ToolRegistry records an `mcp_call`
 * `run_events` row when it's supplied (the durable reuse signal counted by
 * the `/roi` dashboard + `coodra roi`). Without `runId` no row is recorded
 * (the registry's runId-gated audit hook, tool-registry.ts ~L469-498).
 */

describe('reuse-read schemas accept + retain optional runId', () => {
  it('search_packs_nl keeps runId in the parsed input', () => {
    const parsed = searchPacksNlInputSchema.safeParse({ projectSlug: 'p', query: 'q', runId: 'run_abc' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.runId).toBe('run_abc');
  });
  it('get_feature_pack keeps runId', () => {
    const parsed = getFeaturePackInputSchema.safeParse({ projectSlug: 'p', runId: 'run_abc' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.runId).toBe('run_abc');
  });
  it('query_run_history keeps runId', () => {
    const parsed = queryRunHistoryInputSchema.safeParse({ projectSlug: 'p', runId: 'run_abc' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.runId).toBe('run_abc');
  });
  it('list_context_packs keeps runId', () => {
    const parsed = listContextPacksInputSchema.safeParse({ projectSlug: 'p', runId: 'run_abc' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.runId).toBe('run_abc');
  });
  it('get_feature keeps runId', () => {
    const parsed = getFeatureInputSchema.safeParse({ projectSlug: 'p', slug: 'my-feature', runId: 'run_abc' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.runId).toBe('run_abc');
  });
  it('still parses without runId (it is optional)', () => {
    expect(searchPacksNlInputSchema.safeParse({ projectSlug: 'p', query: 'q' }).success).toBe(true);
  });
  it('still rejects truly-unknown fields (strict preserved)', () => {
    expect(searchPacksNlInputSchema.safeParse({ projectSlug: 'p', query: 'q', bogus: 1 }).success).toBe(false);
  });
});

describe('ToolRegistry records an mcp_call reuse event when runId is supplied', () => {
  let close: () => Promise<void>;
  // biome-ignore lint/suspicious/noExplicitAny: SqliteHandle from createDbClient is narrowed at runtime.
  let handle: any;
  let recordSpy: ReturnType<typeof vi.fn>;
  let registry: ToolRegistry;

  beforeEach(() => {
    const { client, asInternalHandle } = createDbClient({
      mode: 'solo',
      sqlite: { path: ':memory:', skipPragmas: true },
    });
    handle = asInternalHandle();
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
    migrateSqlite(handle.db);
    handle.raw
      .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
      .run('p1', 'slug-x', 'org_test', 'reuse harness');

    recordSpy = vi.fn().mockResolvedValue(undefined);
    // The registry fire-and-forgets `runRecorder.record(...).catch(...)`, so the
    // spy must return a promise; cast the loosely-typed vi.fn to the record sig.
    const runRecorder: RunRecorder = { record: recordSpy as unknown as RunRecorder['record'] };
    registry = new ToolRegistry({ deps: makeFakeDeps({ runRecorder }) });
    registry.register(createQueryRunHistoryToolRegistration({ db: handle }));
    close = async () => {
      await client.close();
    };
  });

  afterEach(async () => {
    await close();
  });

  it('records phase=mcp_call with the supplied runId on a reuse read', async () => {
    await registry.handleCall('query_run_history', { projectSlug: 'slug-x', runId: 'run_abc' }, 'sess1');
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy.mock.calls[0]?.[0]).toMatchObject({
      phase: 'mcp_call',
      toolName: 'coodra__query_run_history',
      runId: 'run_abc',
    });
  });

  it('records nothing when runId is omitted (project-scoped read stays invisible)', async () => {
    await registry.handleCall('query_run_history', { projectSlug: 'slug-x' }, 'sess1');
    expect(recordSpy).not.toHaveBeenCalled();
  });
});
