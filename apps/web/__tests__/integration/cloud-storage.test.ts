import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _clearWebDbCache, createWebDb } from '@/lib/db';

/**
 * Integration test — apps/web's storage adapter against the live
 * Supabase Postgres cluster after M04 S2's schema apply.
 *
 * GATED: only runs when `LIVE_SUPABASE_TEST=1`. CI does not flip this;
 * it runs locally on demand and on the nightly main-branch build that
 * has cloud secrets.
 *
 * What this proves (S2 acceptance criterion 5a):
 *   - The 8 Drizzle Postgres migrations applied cleanly
 *   - The web's `createWebDb()` resolves a Postgres handle in team mode
 *   - That handle can SELECT from each of the 11 expected tables
 *   - The `vector` extension is installed (required by the
 *     context_packs_vec table from migration 0000)
 */

const LIVE = process.env.LIVE_SUPABASE_TEST === '1';
const describeIfLive = LIVE ? describe : describe.skip;

const EXPECTED_TABLES = [
  'context_packs',
  'decisions',
  'feature_packs',
  'kill_switches',
  'pending_jobs',
  'policies',
  'policy_decisions',
  'policy_rules',
  'projects',
  'run_events',
  'runs',
] as const;

describeIfLive('apps/web storage adapter against live Supabase (LIVE_SUPABASE_TEST=1)', () => {
  const originalMode = process.env.COODRA_MODE;

  beforeEach(() => {
    _clearWebDbCache();
    process.env.COODRA_MODE = 'team';
    if (process.env.DATABASE_URL === undefined) {
      throw new Error('LIVE_SUPABASE_TEST requires DATABASE_URL to be set in the test env');
    }
  });

  afterEach(() => {
    if (originalMode !== undefined) process.env.COODRA_MODE = originalMode;
    else delete process.env.COODRA_MODE;
    _clearWebDbCache();
  });

  it('createWebDb returns a Postgres handle in team mode', async () => {
    const handle = createWebDb();
    expect(handle.kind).toBe('postgres');
  });

  it('can query each of the 11 expected tables', async () => {
    const handle = createWebDb();
    expect(handle.kind).toBe('postgres');
    if (handle.kind !== 'postgres') return;
    for (const tableName of EXPECTED_TABLES) {
      const result = await handle.db.execute(sql.raw(`SELECT COUNT(*) AS n FROM ${tableName}`));
      // Postgres returns rows as { n: bigint } strings via postgres.js;
      // existence + parseable count is what we're asserting, not the value.
      expect(Array.from(result).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('the vector extension is installed (required by context_packs_vec)', async () => {
    const handle = createWebDb();
    expect(handle.kind).toBe('postgres');
    if (handle.kind !== 'postgres') return;
    const rows = await handle.db.execute(sql.raw(`SELECT extname FROM pg_extension WHERE extname='vector'`));
    expect(Array.from(rows).length).toBe(1);
  });

  it('migrations log contains 8 entries (0000 through 0007)', async () => {
    const handle = createWebDb();
    expect(handle.kind).toBe('postgres');
    if (handle.kind !== 'postgres') return;
    const rows = await handle.db.execute(sql.raw(`SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations`));
    const arr = Array.from(rows) as Array<{ n: string }>;
    expect(arr[0]?.n).toBe('8');
  });
});
