import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../../src/lib/context-pack.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createQueryDecisionsByFileToolRegistration } from '../../../src/tools/query-decisions-by-file/manifest.js';
import type { QueryDecisionsByFileOutput } from '../../../src/tools/query-decisions-by-file/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
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
  handle.raw
    .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
    .run('proj_file', 'slug-file', 'org_test', 'file project');
  handle.raw
    .prepare(
      `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('run_file', 'proj_file', 'sess_file', 'claude_code', 'solo', 'in_progress');
  const contextPacksRoot = mkdtempSync(join(tmpdir(), 'qdbf-'));
  const deps = Object.freeze({
    ...makeFakeDeps(),
    contextPack: createContextPackStore({ db: handle, contextPacksRoot }),
  });
  return { close: async () => client.close(), handle, deps };
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(createQueryDecisionsByFileToolRegistration({ db: h.handle }));
  return registry;
}

function unwrap(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): QueryDecisionsByFileOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: QueryDecisionsByFileOutput };
  if (!parsed.ok || !parsed.data) throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  return parsed.data;
}

describe('query_decisions_by_file — COOD-58 reverse lookup', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns active decisions that affected a file and can include superseded history', async () => {
    h.handle.raw
      .prepare(
        `INSERT INTO decisions (id, project_id, idempotency_key, run_id, description, rationale, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('dec_old_file', 'proj_file', 'idem_old_file', 'run_file', 'old file choice', 'older', 1000);
    h.handle.raw
      .prepare(
        `INSERT INTO decisions (id, project_id, idempotency_key, run_id, description, rationale, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('dec_new_file', 'proj_file', 'idem_new_file', 'run_file', 'new file choice', 'newer', 2000);
    h.handle.raw
      .prepare(
        `INSERT INTO decision_edges (id, project_id, from_decision_id, edge_type, target_type, target_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('de_old_file', 'proj_file', 'dec_old_file', 'affects', 'file', 'apps/example.ts');
    h.handle.raw
      .prepare(
        `INSERT INTO decision_edges (id, project_id, from_decision_id, edge_type, target_type, target_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('de_new_file', 'proj_file', 'dec_new_file', 'affects', 'file', 'apps/example.ts');
    h.handle.raw
      .prepare(
        `INSERT INTO decision_edges (id, project_id, from_decision_id, edge_type, target_type, target_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('de_supersede_file', 'proj_file', 'dec_new_file', 'supersedes', 'decision', 'dec_old_file');

    const registry = buildRegistry(h);
    const active = unwrap(
      await registry.handleCall(
        'query_decisions_by_file',
        { projectSlug: 'slug-file', filePath: 'apps/example.ts' },
        'sess_file',
      ),
    );
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    expect(active.decisions.map((d) => d.id)).toEqual(['dec_new_file']);

    const all = unwrap(
      await registry.handleCall(
        'query_decisions_by_file',
        { projectSlug: 'slug-file', filePath: 'apps/example.ts', activeOnly: false },
        'sess_file',
      ),
    );
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.decisions.map((d) => [d.id, d.supersededBy])).toEqual([
      ['dec_new_file', null],
      ['dec_old_file', 'dec_new_file'],
    ]);
  });

  it('uses Graphify blast radius to include neighboring file and graph_node decision edges', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'qdbf-graphify-project-'));
    const graphRoot = join(projectRoot, '.coodra', 'graphify', 'out');
    mkdirSync(graphRoot, { recursive: true });
    writeFileSync(
      join(graphRoot, 'graph.json'),
      JSON.stringify({
        directed: true,
        multigraph: false,
        nodes: [
          { id: 'apps_root', label: 'root.ts', source_file: 'apps/root.ts' },
          { id: 'apps_neighbor', label: 'neighbor.ts', source_file: 'apps/neighbor.ts' },
          { id: 'symbol_label_collision', label: 'apps/root.ts', source_file: 'apps/unrelated.ts' },
        ],
        links: [{ source: 'apps_root', target: 'apps_neighbor', relation: 'imports_from' }],
      }),
    );
    h.handle.raw.prepare('UPDATE projects SET cwd = ? WHERE id = ?').run(projectRoot, 'proj_file');
    h.handle.raw
      .prepare(
        `INSERT INTO decisions (id, project_id, idempotency_key, run_id, description, rationale, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('dec_neighbor_file', 'proj_file', 'idem_neighbor_file', 'run_file', 'neighbor file choice', 'neighbor', 1000);
    h.handle.raw
      .prepare(
        `INSERT INTO decisions (id, project_id, idempotency_key, run_id, description, rationale, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('dec_neighbor_node', 'proj_file', 'idem_neighbor_node', 'run_file', 'neighbor graph choice', 'graph', 2000);
    h.handle.raw
      .prepare(
        `INSERT INTO decisions (id, project_id, idempotency_key, run_id, description, rationale, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('dec_label_collision', 'proj_file', 'idem_label_collision', 'run_file', 'label collision choice', 'collision', 3000);
    h.handle.raw
      .prepare(
        `INSERT INTO decision_edges (id, project_id, from_decision_id, edge_type, target_type, target_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('de_neighbor_file', 'proj_file', 'dec_neighbor_file', 'affects', 'file', 'apps/neighbor.ts');
    h.handle.raw
      .prepare(
        `INSERT INTO decision_edges (id, project_id, from_decision_id, edge_type, target_type, target_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('de_neighbor_node', 'proj_file', 'dec_neighbor_node', 'affects', 'graph_node', 'apps_neighbor');
    h.handle.raw
      .prepare(
        `INSERT INTO decision_edges (id, project_id, from_decision_id, edge_type, target_type, target_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('de_label_collision', 'proj_file', 'dec_label_collision', 'affects', 'graph_node', 'symbol_label_collision');

    const registry = buildRegistry(h);
    const result = unwrap(
      await registry.handleCall(
        'query_decisions_by_file',
        { projectSlug: 'slug-file', filePath: 'apps/root.ts' },
        'sess_file',
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blastRadius.graphAvailable).toBe(true);
    expect(result.blastRadius.rootNodeIds).toContain('apps_root');
    expect(result.blastRadius.rootNodeIds).not.toContain('symbol_label_collision');
    expect(result.blastRadius.graphNodeTargets).toEqual(expect.arrayContaining(['apps_root', 'apps_neighbor']));
    expect(result.blastRadius.fileTargets).toEqual(expect.arrayContaining(['apps/root.ts', 'apps/neighbor.ts']));
    expect(result.decisions.map((d) => d.id)).toEqual(['dec_neighbor_node', 'dec_neighbor_file']);
  });
});
