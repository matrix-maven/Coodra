import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSqliteDb, migrateSqlite, sqliteSchema, type SqliteHandle } from '@coodra/db';
import { createPolicyClient } from '../../src/index.js';

let handle: SqliteHandle;

beforeEach(() => {
  handle = createSqliteDb({ path: ':memory:' });
  migrateSqlite(handle.db);
});

afterEach(() => {
  handle.close();
});

async function seedPolicy(args: { decision: 'ask' | 'deny'; enforcementMode: 'approval' | 'preventive' }): Promise<void> {
  await handle.db.insert(sqliteSchema.projects).values({
    id: 'proj_grants',
    slug: 'grants',
    orgId: 'org_test',
    name: 'grants',
  });
  await handle.db.insert(sqliteSchema.policies).values({
    id: 'pol_grants',
    projectId: 'proj_grants',
    name: 'grants',
    isActive: true,
  });
  await handle.db.insert(sqliteSchema.policyRules).values({
    id: 'rule_grants',
    policyId: 'pol_grants',
    priority: 10,
    matchEventType: 'PreToolUse',
    matchToolName: 'Bash',
    decision: args.decision,
    enforcementDecision: args.decision,
    governanceVerdict: args.decision === 'deny' ? 'block' : 'confirm',
    enforcementMode: args.enforcementMode,
    reason: `${args.decision} bash`,
  });
}

async function seedSessionGrant(): Promise<void> {
  await handle.db.insert(sqliteSchema.policyGrants).values({
    id: 'grant_session',
    projectId: 'proj_grants',
    scopeType: 'session',
    scopeJson: JSON.stringify({ sessionId: 'sess_grants', toolName: 'Bash' }),
    grantKind: 'decision_override',
    targetRuleId: 'rule_grants',
    decisionOverride: 'allow',
    reason: 'approved for this session',
  });
}

describe('policy grants', () => {
  it('applies a matching active grant before repeating an approval ask', async () => {
    await seedPolicy({ decision: 'ask', enforcementMode: 'approval' });
    await seedSessionGrant();
    const client = createPolicyClient({ db: handle, cacheTtlMs: 0 });

    const result = await client.evaluate({
      toolName: 'Bash',
      phase: 'pre',
      sessionId: 'sess_grants',
      idempotencyKey: { kind: 'mutating', key: 'grant-ask' },
      input: { command: 'npm test' },
      projectId: 'proj_grants',
    });

    expect(result).toMatchObject({
      decision: 'allow',
      baseDecision: 'ask',
      matchedRuleId: 'rule_grants',
      matchedGrantId: 'grant_session',
      reason: 'approved for this session',
    });
  });

  it('does not let a grant override a preventive deny', async () => {
    await seedPolicy({ decision: 'deny', enforcementMode: 'preventive' });
    await seedSessionGrant();
    const client = createPolicyClient({ db: handle, cacheTtlMs: 0 });

    const result = await client.evaluate({
      toolName: 'Bash',
      phase: 'pre',
      sessionId: 'sess_grants',
      idempotencyKey: { kind: 'mutating', key: 'grant-deny' },
      input: { command: 'rm -rf prod' },
      projectId: 'proj_grants',
    });

    expect(result).toMatchObject({
      decision: 'deny',
      baseDecision: 'deny',
      matchedRuleId: 'rule_grants',
      matchedGrantId: null,
    });
  });
});
