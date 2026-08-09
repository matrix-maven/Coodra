import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  createSqliteDb,
  ensureNativeAdvisoryRules,
  migrateSqlite,
  NATIVE_ADVISORY_POLICY_NAME,
  NATIVE_ADVISORY_RULE_TEMPLATES,
  sqliteSchema,
  VXI_NATIVE_ADVISORY_CONTROLS,
  type DbHandle,
} from '../../src/index.js';

describe('native advisory rule templates', () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = createSqliteDb({ path: ':memory:' });
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
    migrateSqlite(handle.db);
    handle.db
      .insert(sqliteSchema.projects)
      .values({ id: 'proj_native_advisory', orgId: 'org_dev_local', slug: 'native-advisory', name: 'Native Advisory' })
      .run();
  });

  afterEach(() => {
    if (handle.kind === 'sqlite') handle.close();
  });

  it('ships one advisory template for every VXI Track A native control', () => {
    expect(NATIVE_ADVISORY_RULE_TEMPLATES).toHaveLength(VXI_NATIVE_ADVISORY_CONTROLS.size);
    expect(new Set(NATIVE_ADVISORY_RULE_TEMPLATES.map((template) => template.controlKey))).toEqual(
      VXI_NATIVE_ADVISORY_CONTROLS,
    );
    expect(NATIVE_ADVISORY_RULE_TEMPLATES.every((template) => template.priority >= 1000)).toBe(true);
  });

  it('installs a dedicated advisory policy idempotently', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
    const first = await ensureNativeAdvisoryRules(handle, 'proj_native_advisory');
    expect(first.created).toBe(true);
    expect(first.rulesInserted).toBe(20);
    expect(first.totalTemplates).toBe(20);

    const second = await ensureNativeAdvisoryRules(handle, 'proj_native_advisory');
    expect(second.created).toBe(false);
    expect(second.rulesInserted).toBe(0);
    expect(second.policyId).toBe(first.policyId);

    const policies = await handle.db
      .select({
        name: sqliteSchema.policies.name,
        enforcementMode: sqliteSchema.policies.enforcementMode,
        denyOnPolicyError: sqliteSchema.policies.denyOnPolicyError,
      })
      .from(sqliteSchema.policies)
      .where(eq(sqliteSchema.policies.id, first.policyId));
    expect(policies[0]).toMatchObject({
      name: NATIVE_ADVISORY_POLICY_NAME,
      enforcementMode: 'advisory',
      denyOnPolicyError: false,
    });

    const rules = await handle.db
      .select({
        decision: sqliteSchema.policyRules.decision,
        enforcementDecision: sqliteSchema.policyRules.enforcementDecision,
        governanceVerdict: sqliteSchema.policyRules.governanceVerdict,
        enforcementMode: sqliteSchema.policyRules.enforcementMode,
        controlKey: sqliteSchema.policyRules.controlKey,
      })
      .from(sqliteSchema.policyRules)
      .where(eq(sqliteSchema.policyRules.policyId, first.policyId));
    expect(rules).toHaveLength(20);
    expect(rules.every((rule) => rule.decision === 'allow')).toBe(true);
    expect(rules.every((rule) => rule.enforcementDecision === 'allow')).toBe(true);
    expect(rules.every((rule) => rule.enforcementMode === 'advisory')).toBe(true);
    expect(rules.every((rule) => rule.governanceVerdict !== 'pass')).toBe(true);
    expect(new Set(rules.map((rule) => rule.controlKey))).toEqual(VXI_NATIVE_ADVISORY_CONTROLS);
  });

});
