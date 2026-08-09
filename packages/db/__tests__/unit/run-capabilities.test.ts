import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSqliteDb,
  getRunActiveCapabilitiesForSession,
  migrateSqlite,
  normalizeRunCapabilities,
  sqliteSchema,
  updateRunActiveCapabilities,
  type SqliteHandle,
} from '../../src/index.js';

let handle: SqliteHandle;

beforeEach(() => {
  handle = createSqliteDb({ path: ':memory:' });
  migrateSqlite(handle.db);
});

afterEach(() => {
  handle.close();
});

async function seedRun(): Promise<void> {
  await handle.db.insert(sqliteSchema.projects).values({
    id: 'proj_caps',
    slug: 'caps',
    orgId: 'org_test',
    name: 'caps',
  });
  await handle.db.insert(sqliteSchema.runs).values({
    id: 'run_caps',
    projectId: 'proj_caps',
    sessionId: 'sess_caps',
    agentType: 'codex',
    mode: 'solo',
  });
}

describe('run capabilities', () => {
  it('normalizes capability ids deterministically', () => {
    expect(normalizeRunCapabilities([' Deployment ', 'deployment', 'cloud_admin', 'bad space'])).toEqual([
      'deployment',
      'cloud_admin',
    ]);
  });

  it('persists active capabilities and reads them by exact session identity', async () => {
    await seedRun();

    const update = await updateRunActiveCapabilities(handle, {
      runId: 'run_caps',
      capabilities: ['deployment', 'cloud_admin', 'deployment'],
    });

    expect(update).toEqual({ status: 'updated', capabilities: ['deployment', 'cloud_admin'] });
    await expect(
      getRunActiveCapabilitiesForSession(handle, {
        projectId: 'proj_caps',
        sessionId: 'sess_caps',
      }),
    ).resolves.toEqual(['deployment', 'cloud_admin']);
    await expect(
      getRunActiveCapabilitiesForSession(handle, {
        projectId: 'proj_caps',
        sessionId: 'other_session',
      }),
    ).resolves.toEqual([]);
  });
});
