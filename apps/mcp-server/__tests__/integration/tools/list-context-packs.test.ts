import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { describe, expect, it } from 'vitest';
import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../../src/lib/context-pack.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createListContextPacksToolRegistration } from '../../../src/tools/list-context-packs/manifest.js';
import type { ListContextPacksOutput } from '../../../src/tools/list-context-packs/schema.js';
import { createSaveContextPackToolRegistration } from '../../../src/tools/save-context-pack/manifest.js';
import type { SaveContextPackOutput } from '../../../src/tools/save-context-pack/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration tests for `coodra__list_context_packs`'s append-only
 * redesign (2026-08-05) additions: the `workPackSlug` filter (a real
 * filter, unlike the existing attribution-only `runId` param) and the
 * new `kind` output field. No dedicated test file existed for this
 * tool before this pass — coverage was previously incidental via
 * `boot.test.ts`/`reuse-runid-instrumentation.test.ts`.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly projectId: string;
  readonly runId: string;
  readonly deps: ContextDeps;
}

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const projectId = 'proj_lcp';
  const runId = 'run_lcp_primary';
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run(projectId, 'slug-lcp', 'org_test', 'lcp harness');
  handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(runId, projectId, 'sess_lcp', 'claude_code', 'solo', 'in_progress');
  handle.raw
    .prepare(
      `INSERT INTO work_packs
        (id, project_id, slug, title, pack_type, status, spec_markdown, implementation_markdown, sync_markdown, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('work_lcp', projectId, 'mt-3', 'MT-3', 'task', 'draft', '', '', '', '{}');

  const contextPacksRoot = mkdtempSync(join(tmpdir(), 'lcp-'));
  const store = createContextPackStore({ db: handle, contextPacksRoot });
  const baseDeps = makeFakeDeps();
  const deps: ContextDeps = Object.freeze({ ...baseDeps, contextPack: store });

  return {
    close: async () => {
      await client.close();
    },
    handle,
    projectId,
    runId,
    deps,
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(createSaveContextPackToolRegistration({ db: h.handle }));
  registry.register(createListContextPacksToolRegistration({ db: h.handle }));
  return registry;
}

function unwrapSave(result: {
  readonly content: ReadonlyArray<{ type: string; text: string }>;
}): SaveContextPackOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: SaveContextPackOutput };
  if (!parsed.ok || !parsed.data) throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  return parsed.data;
}

function unwrapList(result: {
  readonly content: ReadonlyArray<{ type: string; text: string }>;
}): ListContextPacksOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: ListContextPacksOutput };
  if (!parsed.ok || !parsed.data) throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  return parsed.data;
}

describe('list_context_packs — workPackSlug filter (append-only redesign, 2026-08-05)', () => {
  it('with no workPackSlug, returns every pack for the project regardless of Work Pack linkage', async () => {
    const h = await openHarness();
    try {
      const registry = buildRegistry(h);
      await registry.handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'Jira sync', content: 'synced mt-3', workPackSlug: 'mt-3', kind: 'sync' },
        'sess_lcp',
      );
      await registry.handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'Security audit', content: 'audit findings', kind: 'audit_findings' },
        'sess_lcp',
      );
      const listed = unwrapList(
        await registry.handleCall('list_context_packs', { projectSlug: 'slug-lcp' }, 'sess_lcp'),
      );
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.packs).toHaveLength(2);
    } finally {
      await h.close();
    }
  });

  it('with workPackSlug set, returns only packs linked to that Work Pack', async () => {
    const h = await openHarness();
    try {
      const registry = buildRegistry(h);
      const synced = unwrapSave(
        await registry.handleCall(
          'save_context_pack',
          { runId: h.runId, title: 'Jira sync', content: 'synced mt-3', workPackSlug: 'mt-3', kind: 'sync' },
          'sess_lcp',
        ),
      );
      await registry.handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'Security audit', content: 'audit findings, no work pack', kind: 'audit_findings' },
        'sess_lcp',
      );
      const listed = unwrapList(
        await registry.handleCall('list_context_packs', { projectSlug: 'slug-lcp', workPackSlug: 'mt-3' }, 'sess_lcp'),
      );
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.packs).toHaveLength(1);
      expect(listed.packs[0]?.id).toBe(synced.ok ? synced.contextPackId : undefined);
      expect(listed.packs[0]?.kind).toBe('sync');
    } finally {
      await h.close();
    }
  });

  it('a workPackSlug that does not resolve to a real Work Pack returns an empty page, not every pack', async () => {
    const h = await openHarness();
    try {
      const registry = buildRegistry(h);
      await registry.handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'Jira sync', content: 'synced mt-3', workPackSlug: 'mt-3' },
        'sess_lcp',
      );
      const listed = unwrapList(
        await registry.handleCall(
          'list_context_packs',
          { projectSlug: 'slug-lcp', workPackSlug: 'does-not-exist' },
          'sess_lcp',
        ),
      );
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.packs).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('kind is null on the output row when the save did not supply one', async () => {
    const h = await openHarness();
    try {
      const registry = buildRegistry(h);
      await registry.handleCall(
        'save_context_pack',
        { runId: h.runId, title: 'No kind supplied', content: 'body' },
        'sess_lcp',
      );
      const listed = unwrapList(
        await registry.handleCall('list_context_packs', { projectSlug: 'slug-lcp' }, 'sess_lcp'),
      );
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.packs[0]?.kind).toBeNull();
    } finally {
      await h.close();
    }
  });

  it("a pack linked to a Work Pack only via alsoLinkWorkPackSlugs (secondary, m2m link table) is still returned by that Work Pack's workPackSlug filter", async () => {
    // Regression coverage for a review finding: save-context-pack writes
    // work_pack_context_pack_links for alsoLinkWorkPackSlugs, but this
    // filter previously read only context_packs.work_pack_id (the
    // primary column) — a pack whose ONLY connection to a Work Pack was
    // the secondary m2m link was invisible to `{ workPackSlug }`.
    const h = await openHarness();
    try {
      h.handle.raw
        .prepare(
          `INSERT INTO work_packs
            (id, project_id, slug, title, pack_type, status, spec_markdown, implementation_markdown, sync_markdown, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('work_audit', h.projectId, 'security-audit', 'Security audit', 'task', 'draft', '', '', '', '{}');

      const registry = buildRegistry(h);
      // Primary Work Pack is mt-3; secondarily linked to security-audit.
      const saved = unwrapSave(
        await registry.handleCall(
          'save_context_pack',
          {
            runId: h.runId,
            title: 'Cross-cutting pack',
            content: 'touches both mt-3 and the security audit',
            workPackSlug: 'mt-3',
            alsoLinkWorkPackSlugs: ['security-audit'],
          },
          'sess_lcp',
        ),
      );

      const listedByPrimary = unwrapList(
        await registry.handleCall('list_context_packs', { projectSlug: 'slug-lcp', workPackSlug: 'mt-3' }, 'sess_lcp'),
      );
      expect(listedByPrimary.ok).toBe(true);
      if (listedByPrimary.ok)
        expect(listedByPrimary.packs.map((p) => p.id)).toEqual([saved.ok ? saved.contextPackId : undefined]);

      const listedBySecondary = unwrapList(
        await registry.handleCall(
          'list_context_packs',
          { projectSlug: 'slug-lcp', workPackSlug: 'security-audit' },
          'sess_lcp',
        ),
      );
      expect(listedBySecondary.ok).toBe(true);
      if (!listedBySecondary.ok) return;
      expect(listedBySecondary.packs).toHaveLength(1);
      expect(listedBySecondary.packs[0]?.id).toBe(saved.ok ? saved.contextPackId : undefined);
    } finally {
      await h.close();
    }
  });
});
