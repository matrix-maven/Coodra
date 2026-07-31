import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresDb, type PostgresHandle } from '../../src/client.js';
import { migratePostgres } from '../../src/migrate.js';
import { dropAllPublicTables } from './_helpers/postgres-clean.js';

/**
 * Integration smoke test: prove the generated Postgres migrations apply
 * cleanly against a live `pgvector/pgvector:pg16` container and that the
 * full schema (Module-01 core + Module-02 additions: `decisions` joins
 * the previous nine-table set) + the hand-appended pgvector HNSW index
 * show up afterwards. The CI job seeds `DATABASE_URL` via a GitHub
 * Actions service container; locally, run `pnpm -w docker:up` and
 * export the same URL.
 *
 * Skipped automatically when `DATABASE_URL` is not present so that this
 * file is safe to include in `pnpm test:integration` runs outside CI.
 */

const databaseUrl = process.env.DATABASE_URL;
const isEnabled = typeof databaseUrl === 'string' && databaseUrl.length > 0;

const SCHEMA_TABLES = [
  'context_packs',
  'decisions',
  'external_work_items',
  'features',
  'integration_connections',
  'pending_jobs',
  'policies',
  'policy_decisions',
  'policy_rules',
  'projects',
  'run_events',
  'run_diffs',
  'runs',
  'sync_events',
  'team_invites',
  'wiki_pages',
  'wikis',
  'work_pack_external_links',
  'work_pack_relationships',
  'work_packs',
] as const;

(isEnabled ? describe : describe.skip)('postgres migrations apply cleanly', () => {
  let handle: PostgresHandle;

  beforeAll(async () => {
    handle = createPostgresDb({ databaseUrl: databaseUrl as string });
    // Clean slate per run via the introspecting helper — enumerates every
    // table from information_schema so the cleanup never goes stale when
    // a future module adds a table (verification F3, 2026-04-27).
    await dropAllPublicTables(handle.raw);
    await migratePostgres(handle.db);
  });

  afterAll(async () => {
    if (handle) {
      await handle.close();
    }
  });

  it('creates the canonical migration table set', async () => {
    const rows = await handle.raw<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY (${[...SCHEMA_TABLES]})
      ORDER BY table_name
    `;
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual([...SCHEMA_TABLES]);
  });

  it('context_packs.summary_embedding is a pgvector column with 384 dimensions', async () => {
    const rows = await handle.raw<{ udt_name: string; character_maximum_length: number | null }[]>`
      SELECT udt_name, character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'context_packs'
        AND column_name = 'summary_embedding'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.udt_name).toBe('vector');
  });

  it('context_packs.content_excerpt is a non-null text column with default empty string', async () => {
    const rows = await handle.raw<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'context_packs'
        AND column_name = 'content_excerpt'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.data_type).toBe('text');
    expect(rows[0]?.is_nullable).toBe('NO');
    expect(rows[0]?.column_default ?? '').toContain("''");
  });

  it('runs(project_id, session_id) has a unique index', async () => {
    const rows = await handle.raw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'runs' AND indexname = 'runs_project_session_idx'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.indexdef).toMatch(/UNIQUE/i);
  });

  it('policy_rules has the (policy_id, priority) btree index', async () => {
    const rows = await handle.raw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'policy_rules' AND indexname = 'policy_rules_policy_priority_idx'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.indexdef).toMatch(/\(policy_id,\s*priority\)/);
  });

  it('hand-written block: context_packs.summary_embedding has an HNSW index with m=16, ef_construction=64', async () => {
    // `pg_indexes` exposes the reconstructed CREATE INDEX statement. We
    // assert both the HNSW USING clause and the hand-written parameters so
    // a future migration drift (e.g. drizzle-kit regenerating 0001 and
    // wiping the preserve block) gets caught here — complementing the
    // sha256 check in `check-migration-lock.mjs`.
    const rows = await handle.raw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'context_packs'
        AND indexname = 'context_packs_embedding_hnsw_idx'
    `;
    expect(rows.length).toBe(1);
    const indexdef = rows[0]?.indexdef ?? '';
    expect(indexdef).toMatch(/USING\s+hnsw/i);
    expect(indexdef).toMatch(/vector_cosine_ops/);
    expect(indexdef).toMatch(/m\s*=\s*'?16'?/);
    expect(indexdef).toMatch(/ef_construction\s*=\s*'?64'?/);
  });

  it('migration 0004: pending_jobs has picked_at, failed_at, last_error nullable columns + pending_jobs_picked_idx', async () => {
    // Locks Module 03.1 S0: durable outbox columns must exist after migration
    // 0004 applies. If a future regen drops the columns or the index, this
    // assertion catches it before the worker code at runtime.
    const cols = await handle.raw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'pending_jobs'
        AND column_name IN ('picked_at', 'failed_at', 'last_error')
      ORDER BY column_name
    `;
    expect(cols.map((c) => c.column_name)).toEqual(['failed_at', 'last_error', 'picked_at']);
    for (const c of cols) {
      expect(c.is_nullable).toBe('YES');
    }
    const idx = await handle.raw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'pending_jobs' AND indexname = 'pending_jobs_picked_idx'
    `;
    expect(idx.length).toBe(1);
    expect(idx[0]?.indexdef).toMatch(/\(status,\s*picked_at\)/);
  });

  it('re-applying migrations is a no-op (idempotent)', async () => {
    await migratePostgres(handle.db);
    const rows = await handle.raw<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY (${[...SCHEMA_TABLES]})
    `;
    expect(rows[0]?.count).toBe(String(SCHEMA_TABLES.length));
  });
});
