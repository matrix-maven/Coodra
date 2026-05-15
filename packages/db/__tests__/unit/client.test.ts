import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { ValidationError } from '@coodra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, createSqliteDb, resolveSqlitePath } from '../../src/client.js';
import { migrateSqlite } from '../../src/migrate.js';
import * as sqliteSchema from '../../src/schema/sqlite.js';

describe('resolveSqlitePath', () => {
  it('passes through :memory:', () => {
    expect(resolveSqlitePath(':memory:')).toBe(':memory:');
  });

  it('expands a leading ~ to the home directory', () => {
    const resolved = resolveSqlitePath('~/.coodra/data.db');
    expect(resolved).toMatch(/\.coodra\/data\.db$/);
    expect(resolved.startsWith('~')).toBe(false);
  });

  it('resolves a relative path to an absolute one', () => {
    const resolved = resolveSqlitePath('./test.db');
    expect(resolved.endsWith('/test.db')).toBe(true);
    expect(resolved.startsWith('/')).toBe(true);
  });

  /**
   * Locks integration finding 2026-04-27 (post-08a walk): the bridge +
   * mcp-server daemons spawned by `coodra start` were ignoring the
   * COODRA_HOME plist env var and writing audit rows to the user's
   * real `~/.coodra/data.db`. Doctor read the test home, daemons
   * wrote elsewhere, the two surfaces silently disagreed.
   */
  describe('COODRA_HOME / COODRA_SQLITE_PATH precedence', () => {
    const originals: Record<string, string | undefined> = {};

    beforeEach(() => {
      originals.COODRA_SQLITE_PATH = process.env.COODRA_SQLITE_PATH;
      originals.COODRA_HOME = process.env.COODRA_HOME;
      delete process.env.COODRA_SQLITE_PATH;
      delete process.env.COODRA_HOME;
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });

    it('1) explicit `input` argument wins over both env vars', () => {
      process.env.COODRA_SQLITE_PATH = '/env/sqlite/path/data.db';
      process.env.COODRA_HOME = '/env/home/.coodra';
      expect(resolveSqlitePath('/explicit/data.db')).toBe('/explicit/data.db');
    });

    it('2) COODRA_SQLITE_PATH env var wins over COODRA_HOME', () => {
      process.env.COODRA_SQLITE_PATH = '/env/sqlite/path/data.db';
      process.env.COODRA_HOME = '/env/home/.coodra';
      expect(resolveSqlitePath(undefined)).toBe('/env/sqlite/path/data.db');
    });

    it('3) COODRA_HOME env var resolves to <home>/data.db when no other override', () => {
      process.env.COODRA_HOME = '/env/home/.coodra';
      expect(resolveSqlitePath(undefined)).toBe('/env/home/.coodra/data.db');
    });

    it('4) falls back to ~/.coodra/data.db when neither env var is set', () => {
      const resolved = resolveSqlitePath(undefined);
      expect(resolved).toMatch(/\.coodra\/data\.db$/);
      // Must not be the test-home value when env was cleared.
      expect(resolved.startsWith('/env/')).toBe(false);
    });

    it('treats empty-string env values as unset (defensive)', () => {
      process.env.COODRA_SQLITE_PATH = '';
      process.env.COODRA_HOME = '/env/home/.coodra';
      expect(resolveSqlitePath(undefined)).toBe('/env/home/.coodra/data.db');
    });

    it('COODRA_SQLITE_PATH=:memory: passes through even with COODRA_HOME set', () => {
      process.env.COODRA_SQLITE_PATH = ':memory:';
      process.env.COODRA_HOME = '/env/home/.coodra';
      expect(resolveSqlitePath(undefined)).toBe(':memory:');
    });
  });
});

describe('createSqliteDb (in-memory)', () => {
  it('returns a SqliteHandle with a working raw handle', () => {
    const handle = createSqliteDb({ path: ':memory:' });
    try {
      expect(handle.kind).toBe('sqlite');
      expect(handle.db).toBeDefined();
      expect(handle.raw).toBeDefined();
      const row = handle.raw.prepare('SELECT 1 AS n').get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      handle.close();
    }
  });

  it('applies the recommended PRAGMAs by default', () => {
    const handle = createSqliteDb({ path: ':memory:' });
    try {
      // `cache_size = -64000` is one of our recommended PRAGMAs and is a
      // value no better-sqlite3 default would ever produce, so seeing it
      // back confirms our PRAGMA loop ran.
      const cacheSize = handle.raw.pragma('cache_size', { simple: true });
      expect(cacheSize).toBe(-64000);
      const fk = handle.raw.pragma('foreign_keys', { simple: true });
      expect(fk).toBe(1);
    } finally {
      handle.close();
    }
  });

  it('skips PRAGMAs when skipPragmas: true (cache_size stays at the driver default)', () => {
    const handle = createSqliteDb({ path: ':memory:', skipPragmas: true });
    try {
      const cacheSize = handle.raw.pragma('cache_size', { simple: true });
      // Driver default is -2000 (2 MiB). The key assertion is that it is
      // *not* our custom -64000, which would indicate we ran PRAGMAs anyway.
      expect(cacheSize).not.toBe(-64000);
    } finally {
      handle.close();
    }
  });
});

describe('createSqliteDb + migrateSqlite on a file-backed DB', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'coodra-db-'));
    dbPath = join(tmp, 'test.db');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('applies the generated migrations and creates the fifteen-object logical schema', () => {
    const handle = createSqliteDb({ path: dbPath });
    try {
      migrateSqlite(handle.db);
      // sqlite_master rows for vec0 shadow tables (context_packs_vec_chunks,
      // context_packs_vec_rowids, context_packs_vec_vector_chunks00,
      // context_packs_vec_info, etc.) are implementation details of
      // sqlite-vec 0.1.9; filter them out while keeping the virtual table
      // context_packs_vec itself so this test locks the hand-written
      // preserve block inside 0001_chief_turbo.sql.
      const rows = handle.raw
        .prepare(
          `SELECT name FROM sqlite_master
             WHERE type IN ('table')
               AND name NOT LIKE '__drizzle%'
               AND name NOT LIKE 'sqlite_%'
               AND name NOT LIKE '\\_%' ESCAPE '\\'
               AND substr(name, 1, 18) <> 'context_packs_vec_'
             ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      const tables = rows.map((r) => r.name);
      expect(tables).toEqual([
        'context_packs',
        'context_packs_vec',
        'decisions',
        'feature_packs',
        // Phase F.1 (2026-05-11) — pull-on-trigger skill recipes
        // (Anthropic Skills pattern). Dual-dialect; sync-daemon
        // round-trips file ↔ cloud in team mode.
        'features',
        'kill_switches',
        'pending_jobs',
        'policies',
        'policy_decisions',
        'policy_rules',
        'projects',
        'run_diffs',
        'run_events',
        'runs',
        // M04 Phase 2 (2026-05-11) — invitation rows for team-hosted
        // mode. SQLite mirror exists for structural parity even though
        // only cloud Postgres ever populates rows in practice.
        'team_invites',
      ]);
    } finally {
      handle.close();
    }
  });

  it('re-applying migrations is a no-op (idempotent)', () => {
    const first = createSqliteDb({ path: dbPath });
    try {
      migrateSqlite(first.db);
      migrateSqlite(first.db); // second call must not throw or duplicate schema
      const rows = first.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master
             WHERE type IN ('table')
               AND name NOT LIKE '__drizzle%'
               AND name NOT LIKE 'sqlite_%'
               AND name NOT LIKE '\\_%' ESCAPE '\\'
               AND substr(name, 1, 18) <> 'context_packs_vec_'`,
        )
        .get() as { n: number };
      // 14 schema tables + context_packs_vec virtual table = 15.
      expect(rows.n).toBe(15);
    } finally {
      first.close();
    }
  });

  it('accepts inserts + selects through the Drizzle client on the migrated schema', () => {
    const handle = createSqliteDb({ path: dbPath });
    try {
      migrateSqlite(handle.db);
      const now = new Date();
      handle.db
        .insert(sqliteSchema.projects)
        .values({ id: 'proj_1', slug: 'acme', orgId: 'org_dev_local', name: 'Acme', createdAt: now, updatedAt: now })
        .run();
      // M04 Phase 2 S1 (F3 backfill, migration 0008): the migration
      // INSERT OR IGNOREs the `__global__` sentinel project so the
      // backfill UPDATE has a valid FK target. Post-migration baseline
      // has 1 row (`__global__`); after the test insert the table holds
      // 2 rows (`__global__` + `acme`).
      const projects = handle.db.select().from(sqliteSchema.projects).all();
      expect(projects).toHaveLength(2);
      const slugs = projects.map((p) => p.slug).sort();
      expect(slugs).toEqual(['__global__', 'acme']);
    } finally {
      handle.close();
    }
  });
});

describe('createDb (kind discriminator — Module 03 S4)', () => {
  it("kind: 'local' returns a sqlite handle regardless of mode (mode is an auth-strategy hint only)", () => {
    const handleSolo = createDb({ kind: 'local', mode: 'solo', sqlite: { path: ':memory:' } });
    try {
      expect(handleSolo.kind).toBe('sqlite');
    } finally {
      if (handleSolo.kind === 'sqlite') handleSolo.close();
    }
    const handleTeam = createDb({ kind: 'local', mode: 'team', sqlite: { path: ':memory:' } });
    try {
      expect(handleTeam.kind).toBe('sqlite');
    } finally {
      if (handleTeam.kind === 'sqlite') handleTeam.close();
    }
  });

  it("kind: 'cloud' without databaseUrl throws ValidationError", () => {
    const previousUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => createDb({ kind: 'cloud', mode: 'team' })).toThrow(ValidationError);
    } finally {
      if (previousUrl !== undefined) process.env.DATABASE_URL = previousUrl;
    }
  });

  it("defaults to kind: 'local' when no options are supplied", () => {
    const previousMode = process.env.COODRA_MODE;
    const previousPath = process.env.COODRA_SQLITE_PATH;
    delete process.env.COODRA_MODE;
    process.env.COODRA_SQLITE_PATH = ':memory:';
    try {
      const handle = createDb();
      try {
        expect(handle.kind).toBe('sqlite');
      } finally {
        if (handle.kind === 'sqlite') handle.close();
      }
    } finally {
      if (previousMode !== undefined) process.env.COODRA_MODE = previousMode;
      if (previousPath !== undefined) {
        process.env.COODRA_SQLITE_PATH = previousPath;
      } else {
        delete process.env.COODRA_SQLITE_PATH;
      }
    }
  });
});
