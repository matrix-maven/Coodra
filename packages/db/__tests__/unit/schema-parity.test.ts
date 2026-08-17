import { type Column, getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import * as pg from '../../src/schema/postgres.js';
import * as sq from '../../src/schema/sqlite.js';

/**
 * Schema-parity CI test (per decision Q7 of the user-approved bootstrap plan,
 * carried forward into Module 02).
 *
 * This file fails the build if the SQLite and Postgres dialects drift on:
 *   - the set of tables (5-table Module-01 core + 5-table Module-02
 *     additions including `decisions` + 1 M08b-S1 addition `kill_switches`
 *     + 1 M06 addition `run_diffs` = 12 tables)
 *   - column names per table
 *   - notNull flags per column
 *   - Drizzle dataType category per column (with the architected exemption)
 *
 * Intentional dialect-specific columns — the exemption list MUST be reviewed
 * every time it grows. Each entry requires a comment naming the architectural
 * reason.
 *
 *   - `context_packs.summary_embedding` is TEXT in SQLite vs VECTOR(384)
 *     in Postgres. The SQLite dialect materialises the embedding index
 *     in a parallel `context_packs_vec` vec0 virtual table (created by
 *     a hand-appended block in migration 0001, sha256-locked in
 *     `packages/db/migrations.lock.json`). Postgres materialises the
 *     index directly on the main column via an HNSW index hand-appended
 *     to the same migration. See `docs/feature-packs/02-mcp-server/spec.md` §4.
 *
 * **History note:** the `decisions` table was added in M02 but was never
 * added to `tablePairs` below until M08b S1 (2026-05-03). Schema parity
 * for `decisions` was never enforced between M02 and M08b S1; future
 * migrations to that table that drift sqlite from postgres would have
 * gone undetected. M08b S1 adds both `decisions` and `kill_switches` to
 * the parity matrix in the same commit so the gap closes alongside the
 * M08b schema delta.
 */

const tablePairs = [
  ['projects', sq.projects, pg.projects],
  ['runs', sq.runs, pg.runs],
  ['run_events', sq.runEvents, pg.runEvents],
  ['context_packs', sq.contextPacks, pg.contextPacks],
  ['pending_jobs', sq.pendingJobs, pg.pendingJobs],
  ['policies', sq.policies, pg.policies],
  ['policy_rules', sq.policyRules, pg.policyRules],
  ['policy_versions', sq.policyVersions, pg.policyVersions],
  ['policy_exceptions', sq.policyExceptions, pg.policyExceptions],
  ['policy_grants', sq.policyGrants, pg.policyGrants],
  ['controls', sq.controls, pg.controls],
  ['control_attestations', sq.controlAttestations, pg.controlAttestations],
  ['policy_decisions', sq.policyDecisions, pg.policyDecisions],
  ['integration_connections', sq.integrationConnections, pg.integrationConnections],
  ['external_work_items', sq.externalWorkItems, pg.externalWorkItems],
  ['work_packs', sq.workPacks, pg.workPacks],
  ['work_pack_external_links', sq.workPackExternalLinks, pg.workPackExternalLinks],
  ['work_pack_relationships', sq.workPackRelationships, pg.workPackRelationships],
  ['sync_events', sq.syncEvents, pg.syncEvents],
  ['decisions', sq.decisions, pg.decisions],
  // COOD-58 — typed decision graph edges for supersession and affected
  // file/work-pack/graph-node relationships.
  ['decision_edges', sq.decisionEdges, pg.decisionEdges],
  // coodra-work redesign, round 2 (2026-08-03) — direct many-to-many
  // decision/context-pack <-> Work Pack links, added in the same commit
  // as the schema change so this table never repeats the `decisions`
  // parity gap documented above.
  ['work_pack_decision_links', sq.workPackDecisionLinks, pg.workPackDecisionLinks],
  ['work_pack_context_pack_links', sq.workPackContextPackLinks, pg.workPackContextPackLinks],
  ['kill_switches', sq.killSwitches, pg.killSwitches],
  ['run_diffs', sq.runDiffs, pg.runDiffs],
  ['audit_events', sq.auditEvents, pg.auditEvents],
  // M04 Phase 2 — team_invites (2026-05-11). Postgres-only at runtime
  // but dual-dialect for structural parity (see schema header comments).
  ['team_invites', sq.teamInvites, pg.teamInvites],
  // Phase F.1 — features (2026-05-11). Both dialects hold rows:
  // solo writes to local SQLite from filesystem walks; team mode keeps
  // both in sync via the sync-daemon's syncFeatures dispatch.
  ['features', sq.features, pg.features],
  // Module 10 — Deep Wiki (2026-06-06). Both dialects hold rows: solo
  // writes to local SQLite via the wiki_* MCP tools; team mode syncs to
  // cloud Postgres so the web /wiki render works cross-machine.
  ['wikis', sq.wikis, pg.wikis],
  ['wiki_pages', sq.wikiPages, pg.wikiPages],
  // COOD-78 — append-only, so it belongs in tablePairs but deliberately
  // NOT in `mutableTables` below (no updated_at / updated_by_user_id).
  ['memory_access_events', sq.memoryAccessEvents, pg.memoryAccessEvents],
  // COOD-79 rollups. Also append-only in effect (recomputed per day),
  // but they DO carry updated_at, so they are exempt from the
  // append-only convention check rather than the parity matrix.
  ['memory_access_daily', sq.memoryAccessDaily, pg.memoryAccessDaily],
  ['memory_cohorts', sq.memoryCohorts, pg.memoryCohorts],
] as const;

/** Columns whose dialect-specific type difference is architecturally intentional. */
const DIALECT_TYPE_EXEMPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['context_packs', new Set(['summaryEmbedding'])],
]);

function columnsOf(table: unknown): Record<string, Column> {
  return getTableColumns(table as Parameters<typeof getTableColumns>[0]) as Record<string, Column>;
}

describe('work-pack-aware schema is present in both dialects', () => {
  it('SQLite exports all expected tables', () => {
    expect(sq.projects).toBeDefined();
    expect(sq.runs).toBeDefined();
    expect(sq.runEvents).toBeDefined();
    expect(sq.contextPacks).toBeDefined();
    expect(sq.pendingJobs).toBeDefined();
    expect(sq.policies).toBeDefined();
    expect(sq.policyRules).toBeDefined();
    expect(sq.policyVersions).toBeDefined();
    expect(sq.policyExceptions).toBeDefined();
    expect(sq.policyGrants).toBeDefined();
    expect(sq.controls).toBeDefined();
    expect(sq.controlAttestations).toBeDefined();
    expect(sq.policyDecisions).toBeDefined();
    expect(sq.decisions).toBeDefined();
    expect(sq.killSwitches).toBeDefined();
    expect(sq.runDiffs).toBeDefined();
    expect(sq.teamInvites).toBeDefined();
    expect(sq.features).toBeDefined();
    expect(sq.integrationConnections).toBeDefined();
    expect(sq.externalWorkItems).toBeDefined();
    expect(sq.workPacks).toBeDefined();
    expect(sq.workPackExternalLinks).toBeDefined();
    expect(sq.workPackRelationships).toBeDefined();
    expect(sq.workPackDecisionLinks).toBeDefined();
    expect(sq.workPackContextPackLinks).toBeDefined();
    expect(sq.syncEvents).toBeDefined();
    expect(sq.wikis).toBeDefined();
    expect(sq.wikiPages).toBeDefined();
    expect(sq.decisionEdges).toBeDefined();
  });

  it('Postgres exports all expected tables', () => {
    expect(pg.projects).toBeDefined();
    expect(pg.runs).toBeDefined();
    expect(pg.runEvents).toBeDefined();
    expect(pg.contextPacks).toBeDefined();
    expect(pg.pendingJobs).toBeDefined();
    expect(pg.policies).toBeDefined();
    expect(pg.policyRules).toBeDefined();
    expect(pg.policyVersions).toBeDefined();
    expect(pg.policyExceptions).toBeDefined();
    expect(pg.policyGrants).toBeDefined();
    expect(pg.controls).toBeDefined();
    expect(pg.controlAttestations).toBeDefined();
    expect(pg.policyDecisions).toBeDefined();
    expect(pg.decisions).toBeDefined();
    expect(pg.killSwitches).toBeDefined();
    expect(pg.runDiffs).toBeDefined();
    expect(pg.teamInvites).toBeDefined();
    expect(pg.features).toBeDefined();
    expect(pg.integrationConnections).toBeDefined();
    expect(pg.externalWorkItems).toBeDefined();
    expect(pg.workPacks).toBeDefined();
    expect(pg.workPackExternalLinks).toBeDefined();
    expect(pg.workPackRelationships).toBeDefined();
    expect(pg.workPackDecisionLinks).toBeDefined();
    expect(pg.workPackContextPackLinks).toBeDefined();
    expect(pg.syncEvents).toBeDefined();
    expect(pg.wikis).toBeDefined();
    expect(pg.wikiPages).toBeDefined();
    expect(pg.decisionEdges).toBeDefined();
  });
});

describe('column-name parity per table', () => {
  for (const [name, sqliteTable, pgTable] of tablePairs) {
    it(`${name}: column names match exactly`, () => {
      const sqliteCols = Object.keys(columnsOf(sqliteTable)).sort();
      const pgCols = Object.keys(columnsOf(pgTable)).sort();
      expect(sqliteCols).toEqual(pgCols);
    });
  }
});

describe('notNull parity per column', () => {
  for (const [name, sqliteTable, pgTable] of tablePairs) {
    it(`${name}: every column has matching notNull flag`, () => {
      const sqliteCols = columnsOf(sqliteTable);
      const pgCols = columnsOf(pgTable);
      for (const field of Object.keys(sqliteCols)) {
        const sqliteCol = sqliteCols[field];
        const pgCol = pgCols[field];
        expect(sqliteCol).toBeDefined();
        expect(pgCol).toBeDefined();
        expect({ table: name, field, notNull: sqliteCol?.notNull }).toEqual({
          table: name,
          field,
          notNull: pgCol?.notNull,
        });
      }
    });
  }
});

describe('dataType parity per column (with architected exemptions)', () => {
  for (const [name, sqliteTable, pgTable] of tablePairs) {
    it(`${name}: dataType category matches (exempting intentional drift)`, () => {
      const sqliteCols = columnsOf(sqliteTable);
      const pgCols = columnsOf(pgTable);
      const exempt = DIALECT_TYPE_EXEMPTIONS.get(name) ?? new Set<string>();
      for (const field of Object.keys(sqliteCols)) {
        if (exempt.has(field)) {
          continue;
        }
        const s = sqliteCols[field]?.dataType;
        const p = pgCols[field]?.dataType;
        expect({ table: name, field, dataType: s }).toEqual({
          table: name,
          field,
          dataType: p,
        });
      }
    });
  }
});

describe('architected dialect drift', () => {
  it('context_packs.summary_embedding is TEXT in SQLite and vector(384) in Postgres', () => {
    const sqliteCols = columnsOf(sq.contextPacks);
    const pgCols = columnsOf(pg.contextPacks);
    expect(sqliteCols.summaryEmbedding?.dataType).toBe('string');
    // drizzle's pg vector column reports dataType 'array' — assert it's not 'string'
    // so silent regressions to plain text are caught.
    expect(pgCols.summaryEmbedding?.dataType).not.toBe('string');
  });
});

describe('schema conventions for audit-ready mutable tables', () => {
  const mutableTables = [
    ['projects', sq.projects],
    ['policies', sq.policies],
    ['policy_rules', sq.policyRules],
    ['policy_exceptions', sq.policyExceptions],
    ['controls', sq.controls],
    ['features', sq.features],
    ['integration_connections', sq.integrationConnections],
    ['work_packs', sq.workPacks],
    ['work_pack_external_links', sq.workPackExternalLinks],
    ['work_pack_relationships', sq.workPackRelationships],
    ['wikis', sq.wikis],
    ['wiki_pages', sq.wikiPages],
  ] as const;

  const systemMutableTables = new Set(['projects', 'external_work_items']);

  for (const [name, table] of mutableTables) {
    it(`${name}: updated_at has actor attribution unless system-owned`, () => {
      const cols = columnsOf(table);
      expect(cols.updatedAt).toBeDefined();
      if (!systemMutableTables.has(name)) {
        expect(cols.updatedByUserId).toBeDefined();
      }
    });
  }

  it('audit_events is append-only shaped', () => {
    const cols = columnsOf(sq.auditEvents);
    expect(cols.createdAt).toBeDefined();
    expect(cols.updatedAt).toBeUndefined();
  });
});
