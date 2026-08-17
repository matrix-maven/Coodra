import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createWorkPackUpdateToolRegistration } from '../../../src/tools/work-pack-update/manifest.js';
import type { WorkPackUpdateOutput } from '../../../src/tools/work-pack-update/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly projectRoot: string;
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
  const projectRoot = mkdtempSync(join(tmpdir(), 'wpu-project-'));
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name, cwd) VALUES (?, ?, ?, ?, ?)')
    .run('proj_wpu', 'slug-wpu', 'org_test', 'Work Pack update project', projectRoot);
  handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('run_wpu', 'proj_wpu', 'sess_wpu', 'codex', 'solo', 'in_progress');
  const deps: ContextDeps = Object.freeze({ ...makeFakeDeps() });
  return {
    close: async () => {
      await client.close();
      rmSync(projectRoot, { recursive: true, force: true });
    },
    handle,
    projectRoot,
    deps,
  };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps, clock: () => new Date('2026-08-09T08:00:00.000Z') });
  registry.register(createWorkPackUpdateToolRegistration({ db: h.handle }));
  return registry;
}

function unwrap(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): WorkPackUpdateOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: WorkPackUpdateOutput };
  if (!parsed.ok || !parsed.data) throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  return parsed.data;
}

function seedWorkPack(h: Harness, withExternalLink: boolean): void {
  h.handle.raw
    .prepare(
      `INSERT INTO work_packs
        (id, project_id, slug, title, pack_type, status, spec_markdown, implementation_markdown, sync_markdown, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'wp_wpu',
      'proj_wpu',
      'cood-100',
      'Original scope',
      'story',
      'draft',
      'Old spec',
      'Old impl',
      'Old sync',
      '{"risk":"low"}',
    );
  h.handle.raw
    .prepare(
      `INSERT INTO work_pack_relationships
        (id, project_id, source_work_pack_id, source_external_key, target_external_key, relationship_type, sync_level, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'rel_wpu',
      'proj_wpu',
      'wp_wpu',
      withExternalLink ? 'COOD-100' : null,
      'COOD-99',
      'Relates',
      'summary',
      '{"why":"nearby"}',
    );
  if (!withExternalLink) return;
  h.handle.raw
    .prepare(
      `INSERT INTO external_work_items
        (id, project_id, provider, external_key, issue_type, title, status, url, raw_external_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'ext_wpu',
      'proj_wpu',
      'atlassian',
      'COOD-100',
      'Story',
      'Original scope',
      'To Do',
      'https://example.atlassian.net/browse/COOD-100',
      '{"updated":"2026-08-08T00:00:00.000Z"}',
    );
  h.handle.raw
    .prepare(
      `INSERT INTO work_pack_external_links
        (id, project_id, work_pack_id, external_work_item_id, sync_direction, sync_state)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('link_wpu', 'proj_wpu', 'wp_wpu', 'ext_wpu', 'bidirectional', 'synced');
}

describe('work_pack_update — local Work Pack patching and sync state', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('patches selected fields, preserves omitted relationships, marks external links local_ahead, and records sync intent', async () => {
    seedWorkPack(h, true);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'work_pack_update',
        {
          runId: 'run_wpu',
          slug: 'cood-100',
          patch: {
            title: 'Revised scope',
            specMarkdown: 'New acceptance criteria',
            metadataJson: { priority: 'high' },
          },
          changeReason: 'Scope clarified after review',
        },
        'sess_wpu',
      ),
    );

    expect(out).toMatchObject({
      ok: true,
      workPackId: 'wp_wpu',
      slug: 'cood-100',
      syncState: 'local_ahead',
      externalLinkCount: 1,
      relationshipCount: 1,
    });
    if (!out.ok) return;
    expect(out.fieldsChanged).toEqual(expect.arrayContaining(['title', 'specMarkdown', 'metadataJson']));

    const wp = h.handle.raw
      .prepare('SELECT title, spec_markdown, implementation_markdown, metadata_json FROM work_packs WHERE id = ?')
      .get('wp_wpu') as {
      title: string;
      spec_markdown: string;
      implementation_markdown: string;
      metadata_json: string;
    };
    expect(wp.title).toBe('Revised scope');
    expect(wp.spec_markdown).toBe('New acceptance criteria');
    expect(wp.implementation_markdown).toBe('Old impl');
    expect(JSON.parse(wp.metadata_json)).toEqual({ risk: 'low', priority: 'high' });

    const link = h.handle.raw
      .prepare('SELECT sync_state, conflict_state FROM work_pack_external_links WHERE id = ?')
      .get('link_wpu') as { sync_state: string; conflict_state: string | null };
    expect(link).toEqual({ sync_state: 'local_ahead', conflict_state: null });

    const sync = h.handle.raw
      .prepare(
        'SELECT provider, direction, action, result, external_key, summary, metadata_json FROM sync_events WHERE work_pack_id = ?',
      )
      .get('wp_wpu') as {
      provider: string;
      direction: string;
      action: string;
      result: string;
      external_key: string;
      summary: string;
      metadata_json: string;
    };
    expect(sync.provider).toBe('atlassian');
    expect(sync.direction).toBe('coodra_to_external');
    expect(sync.action).toBe('work_pack_update');
    expect(sync.result).toBe('pending_review');
    expect(sync.external_key).toBe('COOD-100');
    expect(sync.summary).toContain('Scope clarified after review');
    expect(JSON.parse(sync.metadata_json).fieldsChanged).toEqual(
      expect.arrayContaining(['title', 'specMarkdown', 'metadataJson']),
    );

    const mirrorDir = join(h.projectRoot, '.coodra', 'work-packs', 'cood-100');
    expect(existsSync(mirrorDir)).toBe(true);
    expect(readFileSync(join(mirrorDir, 'spec.md'), 'utf8')).toBe('New acceptance criteria');
    const relationships = JSON.parse(readFileSync(join(mirrorDir, 'relationships.json'), 'utf8')) as unknown[];
    expect(relationships).toHaveLength(1);
  });

  it('updates local-only packs without requiring an external link', async () => {
    seedWorkPack(h, false);

    const registry = buildRegistry(h);
    const out = unwrap(
      await registry.handleCall(
        'work_pack_update',
        {
          runId: 'run_wpu',
          slug: 'cood-100',
          patch: { status: 'in_review' },
          relationships: [],
        },
        'sess_wpu',
      ),
    );

    expect(out).toMatchObject({
      ok: true,
      syncState: 'local_only',
      externalLinkCount: 0,
      relationshipCount: 0,
    });
    if (!out.ok) return;
    expect(out.fieldsChanged).toEqual(expect.arrayContaining(['status', 'relationships']));
    const sync = h.handle.raw
      .prepare('SELECT provider, direction, result, external_key FROM sync_events WHERE work_pack_id = ?')
      .get('wp_wpu') as { provider: string; direction: string; result: string; external_key: string | null };
    expect(sync).toEqual({ provider: 'coodra', direction: 'local', result: 'local_only', external_key: null });
  });
});
