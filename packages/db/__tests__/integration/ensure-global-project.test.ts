import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDb,
  type DbHandle,
  ensureGlobalProject,
  GLOBAL_PROJECT_ID,
  GLOBAL_PROJECT_SLUG,
  migrateSqlite,
  sqliteSchema,
} from '../../src/index.js';

/**
 * Locks F7 closure (verification 2026-04-27) — the `__global__` sentinel
 * project is seeded at boot so the bridge can audit decisions made in
 * unregistered cwds (no `.coodra.json`) without violating
 * `policy_decisions.project_id` NOT NULL FK.
 */

let cwd: string;
let handle: DbHandle;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ensure-global-project-test-'));
  const opened = createDb({ kind: 'local', sqlite: { path: join(cwd, 'data.db') } });
  if (opened.kind !== 'sqlite') throw new Error('expected sqlite');
  handle = opened;
  migrateSqlite(handle.db);
});

afterAll(() => {
  if (handle?.kind === 'sqlite') handle.close();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('@coodra/db::ensureGlobalProject', () => {
  it('inserts the __global__ row on a fresh DB', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    await ensureGlobalProject(handle);
    const rows = await handle.db
      .select({ id: sqliteSchema.projects.id, slug: sqliteSchema.projects.slug, name: sqliteSchema.projects.name })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.id, GLOBAL_PROJECT_ID));
    expect(rows.length).toBe(1);
    expect(rows[0]?.slug).toBe(GLOBAL_PROJECT_SLUG);
    expect(rows[0]?.name).toBe('Global Policy Rules');
  });

  it('is idempotent on repeated calls', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    await ensureGlobalProject(handle);
    await ensureGlobalProject(handle);
    await ensureGlobalProject(handle);
    const rows = await handle.db
      .select({ id: sqliteSchema.projects.id })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.id, GLOBAL_PROJECT_ID));
    expect(rows.length).toBe(1);
  });

  it('does NOT overwrite a mutated existing row (defensive — admins can rename it)', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    // Mutate the name to simulate an admin renaming the row.
    await handle.db
      .update(sqliteSchema.projects)
      .set({ name: 'Renamed Global Policy' })
      .where(eq(sqliteSchema.projects.id, GLOBAL_PROJECT_ID));

    await ensureGlobalProject(handle);

    const rows = await handle.db
      .select({ name: sqliteSchema.projects.name })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.id, GLOBAL_PROJECT_ID));
    expect(rows[0]?.name).toBe('Renamed Global Policy');
  });
});
