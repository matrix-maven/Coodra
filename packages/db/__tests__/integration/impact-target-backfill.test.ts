import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { looksLikeFilePath } from '@coodra/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, migrateSqlite, type SqliteHandle } from '../../src/index.js';

/**
 * COOD-90 — the backfill must agree with the code that replaced it.
 *
 * `looksLikeFilePath` (TypeScript, used by `record_decision` from now
 * on) and the migration's SQL predicate (used once, over rows written
 * before it) are two implementations of one rule. If they disagree, the
 * database ends up with a classification the writer would never produce
 * — and nothing downstream would notice, because both `'file'` and
 * `'concept'` are valid values.
 *
 * So this runs the ACTUAL shipped SQL, not a paraphrase of it, and
 * asserts the outcome matches the predicate for every case.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, '../../drizzle/sqlite/0038_impact_target_classification.sql');

/** Paths and prose, including every real target id observed in this repo. */
const CASES: ReadonlyArray<string> = [
  // paths
  'apps/mcp-server/src/tools/record-decision/handler.ts',
  'packages/db/src/schema/sqlite.ts',
  'packages/shared/src/decision-targets.ts',
  'src/run-diff-runner.ts',
  'docs/PRD-memory-utilization.md',
  'apps/web-v2/app/memory/page.tsx',
  'packages/db/drizzle/sqlite/0038_impact_target_classification.sql',
  'scripts/build.mjs',
  'a/b.c',
  // prose seen in real rows
  'identity',
  'licensing',
  'Navbar.tsx and the mobile drawer',
  // shapes that must not be mistaken for paths
  'handler.ts',
  'apps/mcp-server/src/tools',
  'apps/.../handler.ts',
  'apps/…/handler.ts',
  'see apps/foo and consider.everything',
  'v1.2.3',
];

let cwd: string;
let handle: SqliteHandle;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'impact-backfill-test-'));
  const opened = createDb({ kind: 'local', sqlite: { path: join(cwd, 'data.db') } });
  if (opened.kind !== 'sqlite') throw new Error('expected sqlite');
  handle = opened;
  migrateSqlite(handle.db);

  handle.raw
    .prepare(`INSERT INTO projects (id, slug, org_id, name, cwd) VALUES (?, ?, ?, ?, ?)`)
    .run('proj_backfill', 'backfill', 'org_dev_local', 'backfill', cwd);
  handle.raw
    .prepare(
      `INSERT INTO decisions (id, project_id, idempotency_key, run_id, description, rationale, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('dec_backfill', 'proj_backfill', 'idem_backfill', null, 'seed', 'seed', 1000);
  handle.raw
    .prepare(
      `INSERT INTO decisions (id, project_id, idempotency_key, run_id, description, rationale, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('dec_other', 'proj_backfill', 'idem_other', null, 'other', 'other', 1000);

  const insertEdge = handle.raw.prepare(
    `INSERT INTO decision_edges (id, project_id, from_decision_id, edge_type, target_type, target_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  CASES.forEach((target, i) => {
    // Seeded as the old writer would have: everything labelled 'file'.
    insertEdge.run(`de_${i}`, 'proj_backfill', 'dec_backfill', 'affects', 'file', target);
  });
  // Rows the migration must not touch.
  insertEdge.run('de_super', 'proj_backfill', 'dec_backfill', 'supersedes', 'decision', 'dec_other');
  insertEdge.run('de_wp', 'proj_backfill', 'dec_backfill', 'affects', 'work_pack', 'cood-77');
  insertEdge.run('de_gn', 'proj_backfill', 'dec_backfill', 'affects', 'graph_node', 'node-1');

  // Run the migration exactly as shipped.
  handle.raw.exec(readFileSync(MIGRATION, 'utf8'));
});

afterAll(() => {
  handle?.close();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

function typeOf(targetId: string): string {
  const row = handle.raw
    .prepare(`SELECT target_type FROM decision_edges WHERE target_id = ? AND edge_type = 'affects'`)
    .get(targetId) as { target_type: string } | undefined;
  if (row === undefined) throw new Error(`no edge seeded for ${targetId}`);
  return row.target_type;
}

describe('COOD-90 backfill', () => {
  it.each(CASES)('classifies %j the same way looksLikeFilePath does', (target) => {
    expect(typeOf(target)).toBe(looksLikeFilePath(target) ? 'file' : 'concept');
  });

  it('reclassifies the prose that motivated the ticket', () => {
    expect(typeOf('identity')).toBe('concept');
    expect(typeOf('licensing')).toBe('concept');
  });

  it('leaves real paths alone', () => {
    expect(typeOf('packages/db/src/schema/sqlite.ts')).toBe('file');
  });

  it('never touches supersession edges', () => {
    // These carry decision ids under target_type='decision'. A backfill
    // that caught them would silently un-supersede decisions, since
    // every activeOnly query derives from `edge_type='supersedes'`.
    const row = handle.raw.prepare(`SELECT target_type FROM decision_edges WHERE id = 'de_super'`).get() as {
      target_type: string;
    };
    expect(row.target_type).toBe('decision');
  });

  it('never touches work_pack or graph_node targets', () => {
    const rows = handle.raw
      .prepare(`SELECT id, target_type FROM decision_edges WHERE id IN ('de_wp','de_gn') ORDER BY id`)
      .all() as Array<{ id: string; target_type: string }>;
    expect(rows).toEqual([
      { id: 'de_gn', target_type: 'graph_node' },
      { id: 'de_wp', target_type: 'work_pack' },
    ]);
  });

  it('is idempotent — a second run changes nothing', () => {
    const before = handle.raw.prepare(`SELECT id, target_type FROM decision_edges ORDER BY id`).all();
    handle.raw.exec(readFileSync(MIGRATION, 'utf8'));
    const after = handle.raw.prepare(`SELECT id, target_type FROM decision_edges ORDER BY id`).all();
    expect(after).toEqual(before);
  });
});
