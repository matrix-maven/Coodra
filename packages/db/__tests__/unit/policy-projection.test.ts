import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildPolicyProjection,
  createPolicyGrant,
  createSqliteDb,
  type DbHandle,
  migrateSqlite,
  sqliteSchema,
} from '../../src/index.js';

describe('policy projection', () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = createSqliteDb({ path: ':memory:' });
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
    migrateSqlite(handle.db);
    handle.db
      .insert(sqliteSchema.projects)
      .values({ id: 'proj_projection', orgId: 'org_dev_local', slug: 'projection', name: 'Projection' })
      .run();
  });

  afterEach(() => {
    if (handle.kind === 'sqlite') handle.close();
  });

  it('includes active grant ids and capability names in the attested surface', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
    const policyId = randomUUID();
    const ruleId = randomUUID();
    await handle.db.insert(sqliteSchema.policies).values({
      id: policyId,
      projectId: 'proj_projection',
      name: '__projection_test__',
      description: 'projection test',
      groupKey: 'governance_advisory',
      profile: 'test',
      enforcementMode: 'advisory',
      isActive: true,
    });
    await handle.db.insert(sqliteSchema.policyRules).values({
      id: ruleId,
      policyId,
      priority: 100,
      matchEventType: 'PreToolUse',
      matchToolName: 'Bash',
      matchPathGlob: null,
      matchCommandPattern: '*deploy*',
      matchAgentType: '*',
      decision: 'allow',
      enforcementDecision: 'allow',
      governanceVerdict: 'warn',
      enforcementMode: 'advisory',
      requiredCapability: 'deployment',
      excludedCapability: 'break_glass',
      reason: 'deployment advisory',
    });
    const activeGrant = await createPolicyGrant(handle, {
      projectId: 'proj_projection',
      scopeType: 'session',
      scopeJson: '{"sessionId":"sess_projection"}',
      grantKind: 'capability_activation',
      targetCapability: 'deployment',
      reason: 'planned deployment session',
    });
    const expiredGrant = await createPolicyGrant(handle, {
      projectId: 'proj_projection',
      scopeType: 'session',
      scopeJson: '{"sessionId":"sess_projection"}',
      grantKind: 'capability_activation',
      targetCapability: 'old_deployment',
      expiresAt: new Date('2020-01-01T00:00:00Z'),
      reason: 'expired deployment session',
    });

    const projection = await buildPolicyProjection(handle, {
      projectId: 'proj_projection',
      projectSlug: 'projection',
      now: new Date('2026-08-09T00:00:00Z'),
    });

    expect(projection.activeGrantIds).toEqual([activeGrant.id]);
    expect(projection.activeGrantIds).not.toContain(expiredGrant.id);
    expect(projection.activeCapabilities).toEqual(['break_glass', 'deployment']);
    expect(projection.activeRuleIds).toContain(ruleId);
  });
});
