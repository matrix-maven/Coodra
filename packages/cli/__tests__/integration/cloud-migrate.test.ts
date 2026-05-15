import { createPostgresDb, type PostgresHandle } from '@coodra/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runCloudMigrateCommand } from '../../src/commands/cloud-migrate.js';
import { EXIT_ENVIRONMENT_PROBLEM, EXIT_OK, EXIT_USER_ACTION_REQUIRED } from '../../src/exit-codes.js';

/**
 * Integration tests for `coodra cloud-migrate`. Skipped automatically
 * when `DATABASE_URL` is not set (CI provides a service container; locally
 * run `pnpm -w docker:up` and export DATABASE_URL).
 *
 * Coverage:
 * - happy path: empty DB → migrations apply → success
 * - idempotent: re-run → success, no errors
 * - preflight refusal: junk table with rows → refuses with EXIT_ENVIRONMENT_PROBLEM
 * - preflight tolerance: junk EMPTY table → proceeds
 * - missing DATABASE_URL: refuses with EXIT_USER_ACTION_REQUIRED
 * - dry-run: pre-flight only; migrations not applied
 */

const databaseUrl = process.env.DATABASE_URL;
const isEnabled = typeof databaseUrl === 'string' && databaseUrl.length > 0;

(isEnabled ? describe : describe.skip)('coodra cloud-migrate', () => {
  let handle: PostgresHandle;

  beforeAll(() => {
    handle = createPostgresDb({ databaseUrl: databaseUrl as string });
  });

  afterAll(async () => {
    if (handle) {
      await handle.close();
    }
  });

  beforeEach(async () => {
    // Clean slate per test: drop everything in public + the drizzle schema.
    const tables = await handle.raw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    for (const t of tables) {
      await handle.raw.unsafe(`DROP TABLE IF EXISTS "${t.table_name.replace(/"/g, '""')}" CASCADE`);
    }
    await handle.raw.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await handle.raw.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  });

  function makeIO(): {
    captured: { stdout: string; stderr: string; exitCode: number | undefined };
    io: Parameters<typeof runCloudMigrateCommand>[1];
  } {
    const captured = { stdout: '', stderr: '', exitCode: undefined as number | undefined };
    const io = {
      writeStdout: (chunk: string) => {
        captured.stdout += chunk;
      },
      writeStderr: (chunk: string) => {
        captured.stderr += chunk;
      },
      exit: ((code: number) => {
        captured.exitCode = code;
        throw new Error(`__exit__:${code}`);
      }) as never,
    } as Parameters<typeof runCloudMigrateCommand>[1];
    return { captured, io };
  }

  it('applies migrations against a fresh database', async () => {
    const cap = makeIO();
    await expect(runCloudMigrateCommand({ databaseUrl: databaseUrl as string, json: true }, cap.io)).rejects.toThrow(
      '__exit__:0',
    );
    expect(cap.captured.exitCode).toBe(EXIT_OK);
    const report = JSON.parse(cap.captured.stdout);
    expect(report.migrationsApplied).toBe(true);
    expect(report.preflight.unknownTablesWithRows).toEqual([]);
    // Verify the canonical 10 tables exist.
    const after = await handle.raw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const names = after.map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'context_packs',
        'decisions',
        'feature_packs',
        'pending_jobs',
        'policies',
        'policy_decisions',
        'policy_rules',
        'projects',
        'run_events',
        'runs',
      ]),
    );
  });

  it('is idempotent when re-run', async () => {
    // First run.
    const first = makeIO();
    await expect(runCloudMigrateCommand({ databaseUrl: databaseUrl as string }, first.io)).rejects.toThrow(
      '__exit__:0',
    );
    expect(first.captured.exitCode).toBe(EXIT_OK);
    // Second run.
    const second = makeIO();
    await expect(runCloudMigrateCommand({ databaseUrl: databaseUrl as string }, second.io)).rejects.toThrow(
      '__exit__:0',
    );
    expect(second.captured.exitCode).toBe(EXIT_OK);
    expect(second.captured.stderr).toBe('');
  });

  it('refuses when an unknown table has rows', async () => {
    // Plant a junk table with a row.
    await handle.raw.unsafe('CREATE TABLE legacy_widgets (id text PRIMARY KEY)');
    await handle.raw.unsafe(`INSERT INTO legacy_widgets (id) VALUES ('orphan-1')`);

    const cap = makeIO();
    await expect(runCloudMigrateCommand({ databaseUrl: databaseUrl as string, json: true }, cap.io)).rejects.toThrow(
      `__exit__:${EXIT_ENVIRONMENT_PROBLEM}`,
    );
    expect(cap.captured.exitCode).toBe(EXIT_ENVIRONMENT_PROBLEM);
    expect(cap.captured.stderr).toMatch(/legacy_widgets/);
    expect(cap.captured.stderr).toMatch(/refusing to run/);
    // No migrations should have been applied.
    const after = await handle.raw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'projects'
    `;
    expect(after).toHaveLength(0);
  });

  it('proceeds when an unknown table is empty', async () => {
    await handle.raw.unsafe('CREATE TABLE legacy_empty_widgets (id text PRIMARY KEY)');
    const cap = makeIO();
    await expect(runCloudMigrateCommand({ databaseUrl: databaseUrl as string, json: true }, cap.io)).rejects.toThrow(
      '__exit__:0',
    );
    expect(cap.captured.exitCode).toBe(EXIT_OK);
    const report = JSON.parse(cap.captured.stdout);
    expect(report.migrationsApplied).toBe(true);
    expect(report.preflight.unknownEmptyTables).toContain('legacy_empty_widgets');
  });

  it('refuses when DATABASE_URL is missing', async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = '';
    try {
      const cap = makeIO();
      await expect(runCloudMigrateCommand({}, cap.io)).rejects.toThrow(`__exit__:${EXIT_USER_ACTION_REQUIRED}`);
      expect(cap.captured.exitCode).toBe(EXIT_USER_ACTION_REQUIRED);
      expect(cap.captured.stderr).toMatch(/DATABASE_URL is required/);
    } finally {
      if (original !== undefined) {
        process.env.DATABASE_URL = original;
      }
    }
  });

  it('--dry-run runs preflight only and does not apply migrations', async () => {
    const cap = makeIO();
    await expect(
      runCloudMigrateCommand({ databaseUrl: databaseUrl as string, dryRun: true, json: true }, cap.io),
    ).rejects.toThrow('__exit__:0');
    expect(cap.captured.exitCode).toBe(EXIT_OK);
    const report = JSON.parse(cap.captured.stdout);
    expect(report.migrationsApplied).toBe(false);
    expect(report.dryRun).toBe(true);
    // No tables should exist.
    const after = await handle.raw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'projects'
    `;
    expect(after).toHaveLength(0);
  });
});
