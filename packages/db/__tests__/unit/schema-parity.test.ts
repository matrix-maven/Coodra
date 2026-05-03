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
 *     = 11 tables)
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
  ['policy_decisions', sq.policyDecisions, pg.policyDecisions],
  ['feature_packs', sq.featurePacks, pg.featurePacks],
  ['decisions', sq.decisions, pg.decisions],
  ['kill_switches', sq.killSwitches, pg.killSwitches],
] as const;

/** Columns whose dialect-specific type difference is architecturally intentional. */
const DIALECT_TYPE_EXEMPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['context_packs', new Set(['summaryEmbedding'])],
]);

function columnsOf(table: unknown): Record<string, Column> {
  return getTableColumns(table as Parameters<typeof getTableColumns>[0]) as Record<string, Column>;
}

describe('eleven-table schema is present in both dialects', () => {
  it('SQLite exports all eleven tables', () => {
    expect(sq.projects).toBeDefined();
    expect(sq.runs).toBeDefined();
    expect(sq.runEvents).toBeDefined();
    expect(sq.contextPacks).toBeDefined();
    expect(sq.pendingJobs).toBeDefined();
    expect(sq.policies).toBeDefined();
    expect(sq.policyRules).toBeDefined();
    expect(sq.policyDecisions).toBeDefined();
    expect(sq.featurePacks).toBeDefined();
    expect(sq.decisions).toBeDefined();
    expect(sq.killSwitches).toBeDefined();
  });

  it('Postgres exports all eleven tables', () => {
    expect(pg.projects).toBeDefined();
    expect(pg.runs).toBeDefined();
    expect(pg.runEvents).toBeDefined();
    expect(pg.contextPacks).toBeDefined();
    expect(pg.pendingJobs).toBeDefined();
    expect(pg.policies).toBeDefined();
    expect(pg.policyRules).toBeDefined();
    expect(pg.policyDecisions).toBeDefined();
    expect(pg.featurePacks).toBeDefined();
    expect(pg.decisions).toBeDefined();
    expect(pg.killSwitches).toBeDefined();
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
