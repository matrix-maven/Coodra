import { createSqliteDb, migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPolicyGrantFingerprint, createPolicyClient } from '../../src/index.js';

let handle: SqliteHandle;

beforeEach(() => {
  handle = createSqliteDb({ path: ':memory:' });
  migrateSqlite(handle.db);
});

afterEach(() => {
  handle.close();
});

async function seedPolicy(args: {
  decision: 'ask' | 'deny';
  enforcementMode: 'approval' | 'preventive';
}): Promise<void> {
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

async function seedSessionException(): Promise<void> {
  await handle.db.insert(sqliteSchema.policyExceptions).values({
    id: 'exception_session',
    projectId: 'proj_grants',
    policyId: 'pol_grants',
    ruleId: 'rule_grants',
    scopeType: 'session',
    scopeJson: JSON.stringify({ sessionId: 'sess_grants', toolName: 'Bash' }),
    decisionOverride: 'allow',
    reason: 'admin-approved preventive exception',
    justification: 'time-boxed admin exception for a planned operation',
    status: 'active',
  });
}

async function seedProjectGrant(): Promise<void> {
  await handle.db.insert(sqliteSchema.policyGrants).values({
    id: 'grant_project',
    projectId: 'proj_grants',
    scopeType: 'project',
    scopeJson: JSON.stringify({ projectId: 'proj_grants' }),
    grantKind: 'decision_override',
    targetRuleId: 'rule_grants',
    decisionOverride: 'allow',
    reason: 'approved for this project',
  });
}

async function seedSimilarTaskGrant(input: unknown): Promise<void> {
  const fingerprint = buildPolicyGrantFingerprint({ toolName: 'Bash', input });
  await handle.db.insert(sqliteSchema.policyGrants).values({
    id: 'grant_similar',
    projectId: 'proj_grants',
    scopeType: 'similar_task',
    scopeJson: JSON.stringify({ fingerprint, toolName: 'Bash' }),
    grantKind: 'decision_override',
    targetRuleId: 'rule_grants',
    grantFingerprint: fingerprint,
    decisionOverride: 'allow',
    reason: 'approved for similar task',
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

  it('does let an active admin exception override a preventive deny', async () => {
    await seedPolicy({ decision: 'deny', enforcementMode: 'preventive' });
    await seedSessionException();
    const client = createPolicyClient({ db: handle, cacheTtlMs: 0 });

    const result = await client.evaluate({
      toolName: 'Bash',
      phase: 'pre',
      sessionId: 'sess_grants',
      idempotencyKey: { kind: 'mutating', key: 'exception-deny' },
      input: { command: 'rm -rf prod' },
      projectId: 'proj_grants',
    });

    expect(result).toMatchObject({
      decision: 'allow',
      baseDecision: 'deny',
      matchedRuleId: 'rule_grants',
      matchedExceptionId: 'exception_session',
      matchedGrantId: null,
      reason: 'admin-approved preventive exception',
    });
  });

  it('applies a project-scoped grant to the matched rule without requiring the same session', async () => {
    await seedPolicy({ decision: 'ask', enforcementMode: 'approval' });
    await seedProjectGrant();
    const client = createPolicyClient({ db: handle, cacheTtlMs: 0 });

    const result = await client.evaluate({
      toolName: 'Bash',
      phase: 'pre',
      sessionId: 'another_session',
      idempotencyKey: { kind: 'mutating', key: 'grant-project' },
      input: { command: 'npm test' },
      projectId: 'proj_grants',
    });

    expect(result).toMatchObject({
      decision: 'allow',
      baseDecision: 'ask',
      matchedRuleId: 'rule_grants',
      matchedGrantId: 'grant_project',
      reason: 'approved for this project',
    });
  });

  it('applies a similar-task grant only to the same normalized tool input', async () => {
    await seedPolicy({ decision: 'ask', enforcementMode: 'approval' });
    await seedSimilarTaskGrant({ command: 'npm test', cwd: '.' });
    const client = createPolicyClient({ db: handle, cacheTtlMs: 0 });

    const repeated = await client.evaluate({
      toolName: 'Bash',
      phase: 'pre',
      sessionId: 'sess_grants',
      idempotencyKey: { kind: 'mutating', key: 'grant-similar-repeat' },
      input: { cwd: '.', command: 'npm test' },
      projectId: 'proj_grants',
    });
    const different = await client.evaluate({
      toolName: 'Bash',
      phase: 'pre',
      sessionId: 'sess_grants',
      idempotencyKey: { kind: 'mutating', key: 'grant-similar-different' },
      input: { command: 'npm run build', cwd: '.' },
      projectId: 'proj_grants',
    });

    expect(repeated).toMatchObject({
      decision: 'allow',
      matchedGrantId: 'grant_similar',
      reason: 'approved for similar task',
    });
    expect(different).toMatchObject({
      decision: 'ask',
      matchedGrantId: null,
    });
  });
});
