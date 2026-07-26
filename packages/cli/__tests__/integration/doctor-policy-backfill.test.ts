import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type DbHandle, ensureDefaultPolicy, listProjects, migrateSqlite, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { backfillDefaultPolicies } from '../../src/commands/doctor.js';

/**
 * Regression for the 2026-07-18 fail-open defect. On the maintainer
 * machine, 51 of 55 registered projects had NO `__default__` policy
 * because an older `get_run_id`/bridge auto-create minted the row
 * without seeding one — so the MCP evaluator waved through every tool
 * call (`coodra doctor` check 29 red). `coodra doctor --fix` now
 * backfills the baseline policy for every policy-less project. This
 * test locks that heal end-to-end against a real SQLite store.
 */

let dir: string;
let handle: DbHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doctor-policy-backfill-'));
  const opened = createDb({ kind: 'local', sqlite: { path: join(dir, 'data.db') } });
  if (opened.kind !== 'sqlite') throw new Error('expected sqlite');
  handle = opened;
  migrateSqlite(handle.db);
});

afterEach(() => {
  if (handle?.kind === 'sqlite') handle.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function insertBareProject(slug: string): Promise<string> {
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
  const id = `proj_${slug}`;
  await handle.db.insert(sqliteSchema.projects).values({ id, slug, orgId: '__solo__', name: slug });
  return id;
}

describe('coodra doctor --fix — default-policy backfill', () => {
  it('seeds a policy for every policy-less project and skips the __global__ sentinel', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    // Two fail-open projects (bare rows, no policy). The `__global__`
    // sentinel is already present from migrations (the F7 invariant).
    await insertBareProject('alpha');
    await insertBareProject('beta');

    const report = await backfillDefaultPolicies(handle, await listProjects(handle));

    expect(report.seeded.map((s) => s.slug).sort()).toEqual(['alpha', 'beta']);
    expect(report.repaired).toHaveLength(0);
    expect(report.failed).toHaveLength(0);
    // __global__ must NOT be seeded or repaired — it never runs agents.
    expect(report.seeded.some((s) => s.slug === '__global__')).toBe(false);
    expect(report.repaired.some((s) => s.slug === '__global__')).toBe(false);

    // Both real projects now carry the enforcing policy.
    for (const slug of ['alpha', 'beta']) {
      const projRow = await handle.db
        .select({ id: sqliteSchema.projects.id })
        .from(sqliteSchema.projects)
        .where(eq(sqliteSchema.projects.slug, slug));
      const policies = await handle.db
        .select({ id: sqliteSchema.policies.id, name: sqliteSchema.policies.name })
        .from(sqliteSchema.policies)
        .where(eq(sqliteSchema.policies.projectId, projRow[0]?.id as string));
      expect(policies).toHaveLength(1);
      expect(policies[0]?.name).toBe('__default__');
      const rules = await handle.db
        .select({ id: sqliteSchema.policyRules.id })
        .from(sqliteSchema.policyRules)
        .where(eq(sqliteSchema.policyRules.policyId, policies[0]?.id as string));
      expect(rules).toHaveLength(25);
    }
  });

  it('is idempotent — a second pass reports nothing to heal', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    await insertBareProject('gamma');
    await backfillDefaultPolicies(handle, await listProjects(handle));
    const second = await backfillDefaultPolicies(handle, await listProjects(handle));
    expect(second.seeded).toHaveLength(0);
    expect(second.repaired).toHaveLength(0);
    expect(second.failed).toHaveLength(0);
  });

  it('additively repairs a project whose policy is missing baseline rules', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const projectId = await insertBareProject('delta');
    // Seed a full policy, then delete one rule to simulate a pre-Fix-F
    // (or hand-edited) install that lost a baseline rule.
    await ensureDefaultPolicy(handle, projectId);
    const policy = await handle.db
      .select({ id: sqliteSchema.policies.id })
      .from(sqliteSchema.policies)
      .where(eq(sqliteSchema.policies.projectId, projectId));
    const policyId = policy[0]?.id as string;
    const oneRule = await handle.db
      .select({ id: sqliteSchema.policyRules.id })
      .from(sqliteSchema.policyRules)
      .where(eq(sqliteSchema.policyRules.policyId, policyId))
      .limit(1);
    await handle.db.delete(sqliteSchema.policyRules).where(eq(sqliteSchema.policyRules.id, oneRule[0]?.id as string));

    const report = await backfillDefaultPolicies(handle, await listProjects(handle));
    expect(report.seeded).toHaveLength(0);
    expect(report.repaired).toEqual([{ slug: 'delta', projectId, rulesInserted: 1 }]);
  });
});
