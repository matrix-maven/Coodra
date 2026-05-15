import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle, ensureProject, migrateSqlite, SOLO_ORG_ID, sqliteSchema } from '../../src/index.js';

/**
 * Locks integration finding 2026-04-27 (post-08a walk): `coodra init`
 * must seed a real `projects` row for the user's slug, not just the
 * `__global__` sentinel. Without this row the bridge would fall back to
 * `__global__` for every audit and per-project filtering silently
 * breaks. Doctor check 12 is the runtime tripwire; this test is the
 * unit-level lock.
 */

let cwd: string;
let handle: DbHandle;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ensure-project-test-'));
  const opened = createDb({ kind: 'local', sqlite: { path: join(cwd, 'data.db') } });
  if (opened.kind !== 'sqlite') throw new Error('expected sqlite');
  handle = opened;
  migrateSqlite(handle.db);
});

afterAll(() => {
  if (handle?.kind === 'sqlite') handle.close();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('@coodra/db::ensureProject', () => {
  it('inserts a row on a fresh slug and returns created:true', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const result = await ensureProject(handle, { slug: 'fresh-slug' });
    expect(result.created).toBe(true);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await handle.db
      .select({
        id: sqliteSchema.projects.id,
        slug: sqliteSchema.projects.slug,
        orgId: sqliteSchema.projects.orgId,
        name: sqliteSchema.projects.name,
      })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'fresh-slug'));
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(result.id);
    expect(rows[0]?.orgId).toBe(SOLO_ORG_ID);
    expect(rows[0]?.name).toBe('fresh-slug');
  });

  it('is idempotent and returns created:false the second time with the same id', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const first = await ensureProject(handle, { slug: 'idempotent-slug' });
    const second = await ensureProject(handle, { slug: 'idempotent-slug' });
    const third = await ensureProject(handle, { slug: 'idempotent-slug' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);

    const rows = await handle.db
      .select({ id: sqliteSchema.projects.id })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'idempotent-slug'));
    expect(rows.length).toBe(1);
  });

  it('honours name + orgId overrides', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const result = await ensureProject(handle, {
      slug: 'team-slug',
      name: 'Team Display Name',
      orgId: 'org_123abc',
    });
    expect(result.created).toBe(true);

    const rows = await handle.db
      .select({ name: sqliteSchema.projects.name, orgId: sqliteSchema.projects.orgId })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'team-slug'));
    expect(rows[0]?.name).toBe('Team Display Name');
    expect(rows[0]?.orgId).toBe('org_123abc');
  });

  it("does NOT overwrite an existing row's name when called again with a different name", async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    await ensureProject(handle, { slug: 'preserved-slug', name: 'Original Name' });
    const second = await ensureProject(handle, { slug: 'preserved-slug', name: 'Different Name' });
    expect(second.created).toBe(false);

    const rows = await handle.db
      .select({ name: sqliteSchema.projects.name })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'preserved-slug'));
    expect(rows[0]?.name).toBe('Original Name');
  });
});
