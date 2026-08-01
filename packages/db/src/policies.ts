import { createHash, randomUUID } from 'node:crypto';

import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';

import { insertAuditEvent } from './audit-events.js';
import type { DbHandle } from './client.js';
import { GLOBAL_PROJECT_ID } from './ensure-global-project.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/policies` — admin-side helpers for the
 * `policies` + `policy_rules` tables. Backs Module 08b S9's
 * `coodra policy {list, show, add, enable, disable}` CLI surface.
 *
 * Read paths (`listPolicies`, `getPolicy`) are pure SELECTs.
 *
 * Write paths (`addPolicyRule`, `setPolicyActive`):
 *   - `addPolicyRule` mirrors `ensureDefaultPolicy`'s posture: when
 *     no `__default__` policy exists for the target project, it
 *     auto-creates one and lands the rule on it. This keeps the
 *     "add a rule, see it work" UX from requiring two commands.
 *   - `setPolicyActive` is idempotent: setting the same value as
 *     current is a no-op (returns the policy as-is).
 *
 * No append-only semantics on these tables (unlike `decisions` and
 * `context_packs`). Callers can disable + re-enable a policy freely.
 *
 * Local-only contract: no sync surface. The MCP server reads policies
 * via `check_policy`'s evaluator path; the CLI surface here mutates
 * them. The 60s policy cache in `createPolicyClient` means CLI mutations
 * take up to 60s to be visible to a running bridge — documented in
 * the M08b S9 commit + spec.md §4.2 footnote.
 */

export const DEFAULT_POLICY_NAME = '__default__' as const;

export type PolicyDecisionKind = 'allow' | 'deny' | 'ask';

export interface PolicyRow {
  readonly id: string;
  readonly orgId: string | null;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly groupKey: string;
  readonly profile: string;
  readonly enforcementMode: string;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PolicyRuleRow {
  readonly id: string;
  readonly policyId: string;
  readonly priority: number;
  readonly matchEventType: string;
  readonly matchToolName: string;
  readonly matchPathGlob: string | null;
  readonly matchCommandPattern: string | null;
  readonly matchAgentType: string | null;
  readonly decision: PolicyDecisionKind;
  readonly reason: string;
  readonly controlKey: string | null;
  readonly ruleType: string;
  readonly severity: string;
  readonly details: string | null;
  readonly createdAt: Date;
}

export interface PolicyWithRules extends PolicyRow {
  readonly rules: ReadonlyArray<PolicyRuleRow>;
}

type RawPolicyRow = {
  id: string;
  orgId: string | null;
  projectId: string;
  name: string;
  description: string | null;
  groupKey: string;
  profile: string;
  enforcementMode: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type RawRuleRow = {
  id: string;
  policyId: string;
  priority: number;
  matchEventType: string;
  matchToolName: string;
  matchPathGlob: string | null;
  matchCommandPattern: string | null;
  matchAgentType: string | null;
  decision: string;
  reason: string;
  controlKey: string | null;
  ruleType: string;
  severity: string;
  details: string | null;
  createdAt: Date;
};

function toPolicyRow(row: RawPolicyRow): PolicyRow {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    groupKey: row.groupKey,
    profile: row.profile,
    enforcementMode: row.enforcementMode,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRuleRow(row: RawRuleRow): PolicyRuleRow {
  return {
    id: row.id,
    policyId: row.policyId,
    priority: row.priority,
    matchEventType: row.matchEventType,
    matchToolName: row.matchToolName,
    matchPathGlob: row.matchPathGlob,
    matchCommandPattern: row.matchCommandPattern,
    matchAgentType: row.matchAgentType,
    decision: row.decision as PolicyDecisionKind,
    reason: row.reason,
    controlKey: row.controlKey,
    ruleType: row.ruleType,
    severity: row.severity,
    details: row.details,
    createdAt: row.createdAt,
  };
}

export type PolicyVersionStatus = 'draft' | 'active' | 'retired';
export type PolicyExceptionStatus = 'requested' | 'active' | 'expired' | 'revoked' | 'rejected';
export type PolicyExceptionScopeType =
  | 'org'
  | 'project'
  | 'repo'
  | 'user'
  | 'agent'
  | 'session'
  | 'work_pack'
  | 'path'
  | 'tool';

export interface PolicyVersionRow {
  readonly id: string;
  readonly orgId: string | null;
  readonly projectId: string | null;
  readonly policyId: string;
  readonly versionNumber: number;
  readonly status: PolicyVersionStatus;
  readonly snapshotJson: string;
  readonly snapshotHash: string;
  readonly createdByUserId: string | null;
  readonly activatedByUserId: string | null;
  readonly changeSummary: string | null;
  readonly createdAt: Date;
  readonly activatedAt: Date | null;
  readonly retiredAt: Date | null;
}

export interface PolicyExceptionRow {
  readonly id: string;
  readonly orgId: string | null;
  readonly projectId: string | null;
  readonly policyId: string;
  readonly policyVersionId: string | null;
  readonly ruleId: string | null;
  readonly scopeType: PolicyExceptionScopeType;
  readonly scopeJson: string;
  readonly decisionOverride: PolicyDecisionKind;
  readonly reason: string;
  readonly justification: string;
  readonly requestedByUserId: string | null;
  readonly approvedByUserId: string | null;
  readonly updatedByUserId: string | null;
  readonly status: PolicyExceptionStatus;
  readonly startsAt: Date | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedByUserId: string | null;
}

function toPolicyVersionRow(row: typeof sqliteSchema.policyVersions.$inferSelect): PolicyVersionRow {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    policyId: row.policyId,
    versionNumber: row.versionNumber,
    status: row.status as PolicyVersionStatus,
    snapshotJson: row.snapshotJson,
    snapshotHash: row.snapshotHash,
    createdByUserId: row.createdByUserId,
    activatedByUserId: row.activatedByUserId,
    changeSummary: row.changeSummary,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    retiredAt: row.retiredAt,
  };
}

function toPolicyExceptionRow(row: typeof sqliteSchema.policyExceptions.$inferSelect): PolicyExceptionRow {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    policyId: row.policyId,
    policyVersionId: row.policyVersionId,
    ruleId: row.ruleId,
    scopeType: row.scopeType as PolicyExceptionScopeType,
    scopeJson: row.scopeJson,
    decisionOverride: row.decisionOverride as PolicyDecisionKind,
    reason: row.reason,
    justification: row.justification,
    requestedByUserId: row.requestedByUserId,
    approvedByUserId: row.approvedByUserId,
    updatedByUserId: row.updatedByUserId,
    status: row.status as PolicyExceptionStatus,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revokedAt: row.revokedAt,
    revokedByUserId: row.revokedByUserId,
  };
}

/**
 * List every policy (with its rules attached) for a single project,
 * or every policy across all projects when `projectId === null`.
 *
 * Order: by project_id, then by policy name. Rules within a policy
 * sort by priority ASC then created_at ASC for stable display.
 */
export async function listPolicies(db: DbHandle, projectId: string | null): Promise<PolicyWithRules[]> {
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.policies;
    const policies =
      projectId === null
        ? await db.db.select().from(t).orderBy(asc(t.projectId), asc(t.name))
        : await db.db.select().from(t).where(eq(t.projectId, projectId)).orderBy(asc(t.name));
    const rt = sqliteSchema.policyRules;
    const out: PolicyWithRules[] = [];
    for (const p of policies) {
      const rules = await db.db
        .select()
        .from(rt)
        .where(eq(rt.policyId, p.id))
        .orderBy(asc(rt.priority), asc(rt.createdAt));
      out.push({ ...toPolicyRow(p as RawPolicyRow), rules: rules.map((r) => toRuleRow(r as RawRuleRow)) });
    }
    return out;
  }

  const t = postgresSchema.policies;
  const policies =
    projectId === null
      ? await db.db.select().from(t).orderBy(asc(t.projectId), asc(t.name))
      : await db.db.select().from(t).where(eq(t.projectId, projectId)).orderBy(asc(t.name));
  const rt = postgresSchema.policyRules;
  const out: PolicyWithRules[] = [];
  for (const p of policies) {
    const rules = await db.db
      .select()
      .from(rt)
      .where(eq(rt.policyId, p.id))
      .orderBy(asc(rt.priority), asc(rt.createdAt));
    out.push({ ...toPolicyRow(p as RawPolicyRow), rules: rules.map((r) => toRuleRow(r as RawRuleRow)) });
  }
  return out;
}

/**
 * Look up one policy by id OR name. Name lookups are scoped to the
 * project when `projectId` is provided; when undefined, the lookup
 * matches any project (intended for `policy show <name>` from any
 * cwd).
 *
 * Returns null when no row matches.
 */
export async function getPolicy(
  db: DbHandle,
  identifier: string,
  options: { projectId?: string } = {},
): Promise<PolicyWithRules | null> {
  if (identifier.length === 0) return null;

  if (db.kind === 'sqlite') {
    const t = sqliteSchema.policies;
    const conditions =
      options.projectId !== undefined
        ? and(or(eq(t.id, identifier), eq(t.name, identifier)), eq(t.projectId, options.projectId))
        : or(eq(t.id, identifier), eq(t.name, identifier));
    const rows = await db.db.select().from(t).where(conditions).limit(1);
    if (rows.length === 0) return null;
    const policy = rows[0] as RawPolicyRow;
    const rt = sqliteSchema.policyRules;
    const rules = await db.db
      .select()
      .from(rt)
      .where(eq(rt.policyId, policy.id))
      .orderBy(asc(rt.priority), asc(rt.createdAt));
    return { ...toPolicyRow(policy), rules: rules.map((r) => toRuleRow(r as RawRuleRow)) };
  }

  const t = postgresSchema.policies;
  const conditions =
    options.projectId !== undefined
      ? and(or(eq(t.id, identifier), eq(t.name, identifier)), eq(t.projectId, options.projectId))
      : or(eq(t.id, identifier), eq(t.name, identifier));
  const rows = await db.db.select().from(t).where(conditions).limit(1);
  if (rows.length === 0) return null;
  const policy = rows[0] as RawPolicyRow;
  const rt = postgresSchema.policyRules;
  const rules = await db.db
    .select()
    .from(rt)
    .where(eq(rt.policyId, policy.id))
    .orderBy(asc(rt.priority), asc(rt.createdAt));
  return { ...toPolicyRow(policy), rules: rules.map((r) => toRuleRow(r as RawRuleRow)) };
}

export interface AddPolicyRuleArgs {
  readonly projectId: string;
  /** Defaults to '__default__' — auto-created if absent. */
  readonly policyName?: string;
  readonly policyDescription?: string;
  /** UI grouping / governance domain. Defaults to agent guardrails. */
  readonly groupKey?: string;
  readonly profile?: string;
  readonly enforcementMode?: string;
  /** Defaults to max(existing rule priority on the policy) + 10, or 100 if first rule. */
  readonly priority?: number;
  /** Defaults to 'PreToolUse'. */
  readonly matchEventType?: string;
  readonly matchToolName: string;
  readonly matchPathGlob?: string | null;
  readonly matchCommandPattern?: string | null;
  readonly matchAgentType?: string | null;
  readonly decision: PolicyDecisionKind;
  /** Required — operators need attribution context for every deny/ask. */
  readonly reason: string;
  readonly controlKey?: string | null;
  readonly ruleType?: string;
  readonly severity?: string;
  readonly details?: string | null;
}

export interface AddPolicyRuleResult {
  readonly policyId: string;
  readonly policyCreated: boolean;
  readonly ruleId: string;
  readonly priority: number;
}

export interface UpdatePolicyRuleArgs {
  readonly ruleId: string;
  readonly priority: number;
  readonly matchEventType: string;
  readonly matchToolName: string;
  readonly matchPathGlob?: string | null;
  readonly matchCommandPattern?: string | null;
  readonly matchAgentType?: string | null;
  readonly decision: PolicyDecisionKind;
  readonly reason: string;
  readonly controlKey?: string | null;
  readonly ruleType?: string;
  readonly severity?: string;
  readonly details?: string | null;
}

/**
 * Insert a rule into the named policy on the target project. When the
 * named policy doesn't exist (default: `__default__`), it's
 * auto-created with `is_active=true`. Rules append rather than replace —
 * the policy_rules table has no UNIQUE constraint on user-meaningful
 * tuples for non-default rules, so a "duplicate" add returns a fresh
 * row id.
 *
 * Priority defaults to `max(existing) + 10`, or 100 when this is the
 * first rule on the policy. The default-policy seeded rules occupy
 * 10-95 (per `ensure-default-policy.ts` priority blocks), so 100+
 * stays out of their way and runs LATER in the evaluator's
 * priority-ASC scan.
 */
export async function addPolicyRule(db: DbHandle, args: AddPolicyRuleArgs): Promise<AddPolicyRuleResult> {
  if (args.reason.trim().length === 0) {
    throw new Error('addPolicyRule: reason must be a non-empty string (operator audit context)');
  }
  if (args.matchToolName.trim().length === 0) {
    throw new Error('addPolicyRule: matchToolName must be a non-empty string');
  }
  if (args.projectId === GLOBAL_PROJECT_ID) {
    // Allow but warn — global policies apply to events with no resolved
    // project; usually the operator wants a per-project rule.
  }

  const policyName = args.policyName ?? DEFAULT_POLICY_NAME;
  const groupKey = args.groupKey ?? (policyName === DEFAULT_POLICY_NAME ? 'agent_guardrails' : 'custom');
  const profile = args.profile ?? 'default';
  const enforcementMode = args.enforcementMode ?? 'detective';
  const matchEventType = args.matchEventType ?? 'PreToolUse';
  const matchAgentType = args.matchAgentType ?? '*';
  const matchPathGlob = args.matchPathGlob ?? null;
  const matchCommandPattern = args.matchCommandPattern ?? null;
  const controlKey = args.controlKey ?? null;
  const ruleType = args.ruleType ?? 'tool_call';
  const severity = args.severity ?? 'medium';
  const details = args.details ?? null;

  if (db.kind === 'sqlite') {
    const t = sqliteSchema.policies;
    const rt = sqliteSchema.policyRules;

    // Find or create the policy.
    let policyId: string;
    let policyCreated = false;
    const existing = await db.db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.projectId, args.projectId), eq(t.name, policyName)))
      .limit(1);
    if (existing.length > 0) {
      const found = existing[0];
      if (found === undefined) throw new Error('unreachable: existing[0] undefined after length check');
      policyId = found.id;
    } else {
      policyId = randomUUID();
      await db.db.insert(t).values({
        id: policyId,
        projectId: args.projectId,
        name: policyName,
        description:
          args.policyDescription ?? `Auto-created by addPolicyRule (no '${policyName}' policy existed for project)`,
        groupKey,
        profile,
        enforcementMode,
        isActive: true,
      });
      policyCreated = true;
    }

    // Compute priority.
    let priority = args.priority;
    if (priority === undefined) {
      const max = await db.db
        .select({ p: rt.priority })
        .from(rt)
        .where(eq(rt.policyId, policyId))
        .orderBy(asc(rt.priority));
      priority = max.length === 0 ? 100 : Math.max(...max.map((r) => r.p)) + 10;
    }

    const ruleId = randomUUID();
    await db.db.insert(rt).values({
      id: ruleId,
      policyId,
      priority,
      matchEventType,
      matchToolName: args.matchToolName,
      matchPathGlob,
      matchCommandPattern,
      matchAgentType,
      decision: args.decision,
      reason: args.reason,
      controlKey,
      ruleType,
      severity,
      details,
    });
    await publishPolicyVersion(db, policyId, {
      changeSummary: `Added ${args.decision} rule for ${args.matchToolName}`,
    });
    return { policyId, policyCreated, ruleId, priority };
  }

  const t = postgresSchema.policies;
  const rt = postgresSchema.policyRules;

  let policyId: string;
  let policyCreated = false;
  const existing = await db.db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.projectId, args.projectId), eq(t.name, policyName)))
    .limit(1);
  if (existing.length > 0) {
    const found = existing[0];
    if (found === undefined) throw new Error('unreachable: existing[0] undefined after length check');
    policyId = found.id;
  } else {
    policyId = randomUUID();
    await db.db.insert(t).values({
      id: policyId,
      projectId: args.projectId,
      name: policyName,
      description:
        args.policyDescription ?? `Auto-created by addPolicyRule (no '${policyName}' policy existed for project)`,
      groupKey,
      profile,
      enforcementMode,
      isActive: true,
    });
    policyCreated = true;
  }

  let priority = args.priority;
  if (priority === undefined) {
    const max = await db.db.select({ p: rt.priority }).from(rt).where(eq(rt.policyId, policyId));
    priority = max.length === 0 ? 100 : Math.max(...max.map((r) => r.p)) + 10;
  }

  const ruleId = randomUUID();
  await db.db.insert(rt).values({
    id: ruleId,
    policyId,
    priority,
    matchEventType,
    matchToolName: args.matchToolName,
    matchPathGlob,
    matchCommandPattern,
    matchAgentType,
    decision: args.decision,
    reason: args.reason,
    controlKey,
    ruleType,
    severity,
    details,
  });
  await publishPolicyVersion(db, policyId, { changeSummary: `Added ${args.decision} rule for ${args.matchToolName}` });
  return { policyId, policyCreated, ruleId, priority };
}

export async function updatePolicyRule(db: DbHandle, args: UpdatePolicyRuleArgs): Promise<PolicyRuleRow | null> {
  if (args.ruleId.trim().length === 0) {
    throw new Error('updatePolicyRule: ruleId must be a non-empty string');
  }
  if (args.reason.trim().length === 0) {
    throw new Error('updatePolicyRule: reason must be a non-empty string (operator audit context)');
  }
  if (args.matchToolName.trim().length === 0) {
    throw new Error('updatePolicyRule: matchToolName must be a non-empty string');
  }
  if (!Number.isFinite(args.priority)) {
    throw new Error('updatePolicyRule: priority must be a finite number');
  }

  const values = {
    priority: args.priority,
    matchEventType: args.matchEventType,
    matchToolName: args.matchToolName,
    matchPathGlob: args.matchPathGlob ?? null,
    matchCommandPattern: args.matchCommandPattern ?? null,
    matchAgentType: args.matchAgentType ?? '*',
    decision: args.decision,
    reason: args.reason,
    controlKey: args.controlKey ?? null,
    ruleType: args.ruleType ?? 'tool_call',
    severity: args.severity ?? 'medium',
    details: args.details ?? null,
  };

  if (db.kind === 'sqlite') {
    const t = sqliteSchema.policyRules;
    const existing = await db.db.select({ policyId: t.policyId }).from(t).where(eq(t.id, args.ruleId)).limit(1);
    const policyId = existing[0]?.policyId;
    if (policyId === undefined) return null;
    await db.db.update(t).set(values).where(eq(t.id, args.ruleId));
    await publishPolicyVersion(db, policyId, { changeSummary: `Updated rule ${args.ruleId.slice(0, 8)}` });
    const updated = await db.db.select().from(t).where(eq(t.id, args.ruleId)).limit(1);
    const row = updated[0];
    return row === undefined ? null : toRuleRow(row as RawRuleRow);
  }

  const t = postgresSchema.policyRules;
  const existing = await db.db.select({ policyId: t.policyId }).from(t).where(eq(t.id, args.ruleId)).limit(1);
  const policyId = existing[0]?.policyId;
  if (policyId === undefined) return null;
  const updated = await db.db.update(t).set(values).where(eq(t.id, args.ruleId)).returning();
  await publishPolicyVersion(db, policyId, { changeSummary: `Updated rule ${args.ruleId.slice(0, 8)}` });
  const row = updated[0];
  return row === undefined ? null : toRuleRow(row as RawRuleRow);
}

/**
 * Flip `policies.is_active`. Idempotent: setting to the current value
 * is a no-op (no UPDATE issued). Returns the post-flip row, or null
 * when the identifier doesn't match any policy.
 *
 * Identifier accepts id OR name (project-scoped via the optional
 * `projectId`). When name is used and `projectId` is undefined, the
 * first matching policy across all projects wins — useful for
 * single-project setups but ambiguous on multi-project stores. The
 * CLI's `policy disable <name>` prompts when ambiguity is detected
 * (S9 implementation).
 */
export async function setPolicyActive(
  db: DbHandle,
  identifier: string,
  active: boolean,
  options: { projectId?: string } = {},
): Promise<PolicyRow | null> {
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.policies;
    const conditions =
      options.projectId !== undefined
        ? and(or(eq(t.id, identifier), eq(t.name, identifier)), eq(t.projectId, options.projectId))
        : or(eq(t.id, identifier), eq(t.name, identifier));
    const rows = await db.db.select().from(t).where(conditions).limit(1);
    if (rows.length === 0) return null;
    const policy = rows[0] as RawPolicyRow;
    if (policy.isActive === active) {
      return toPolicyRow(policy); // no-op
    }
    await db.db.update(t).set({ isActive: active, updatedAt: new Date() }).where(eq(t.id, policy.id));
    await publishPolicyVersion(db, policy.id, { changeSummary: active ? 'Policy enabled' : 'Policy disabled' });
    const after = await db.db.select().from(t).where(eq(t.id, policy.id)).limit(1);
    const updated = after[0];
    if (updated === undefined) return null;
    return toPolicyRow(updated as RawPolicyRow);
  }

  const t = postgresSchema.policies;
  const conditions =
    options.projectId !== undefined
      ? and(or(eq(t.id, identifier), eq(t.name, identifier)), eq(t.projectId, options.projectId))
      : or(eq(t.id, identifier), eq(t.name, identifier));
  const rows = await db.db.select().from(t).where(conditions).limit(1);
  if (rows.length === 0) return null;
  const policy = rows[0] as RawPolicyRow;
  if (policy.isActive === active) {
    return toPolicyRow(policy);
  }
  const updated = await db.db
    .update(t)
    .set({ isActive: active, updatedAt: new Date() })
    .where(eq(t.id, policy.id))
    .returning();
  await publishPolicyVersion(db, policy.id, { changeSummary: active ? 'Policy enabled' : 'Policy disabled' });
  if (updated.length === 0) return null;
  return toPolicyRow(updated[0] as RawPolicyRow);
}

void isNull; // kept for future "active-only" filter variants

/**
 * Delete a single policy_rules row by id. Returns `true` if a row was
 * deleted, `false` if no row matched. Idempotent — re-deleting an
 * already-deleted rule returns `false` without error.
 *
 * Why this exists: pre-cleanup the only way to disable a rule was to
 * deactivate the parent policy, which silenced ALL its rules at once.
 * The web app needs per-rule delete for fine-grained CRUD.
 */
export async function deletePolicyRule(db: DbHandle, ruleId: string): Promise<boolean> {
  if (typeof ruleId !== 'string' || ruleId.length === 0) return false;
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.policyRules;
    const existing = await db.db.select({ policyId: t.policyId }).from(t).where(eq(t.id, ruleId)).limit(1);
    const result = await db.db.delete(t).where(eq(t.id, ruleId));
    const changes = (result as { changes?: number } | undefined)?.changes ?? 0;
    if (changes > 0 && existing[0]?.policyId !== undefined) {
      await publishPolicyVersion(db, existing[0].policyId, { changeSummary: `Deleted rule ${ruleId.slice(0, 8)}` });
    }
    return changes > 0;
  }
  const t = postgresSchema.policyRules;
  const existing = await db.db.select({ policyId: t.policyId }).from(t).where(eq(t.id, ruleId)).limit(1);
  const result = await db.db.delete(t).where(eq(t.id, ruleId)).returning({ id: t.id });
  if (result.length > 0 && existing[0]?.policyId !== undefined) {
    await publishPolicyVersion(db, existing[0].policyId, { changeSummary: `Deleted rule ${ruleId.slice(0, 8)}` });
  }
  return result.length > 0;
}

export interface PublishPolicyVersionOptions {
  readonly changeSummary?: string;
  readonly actorUserId?: string | null;
}

export async function publishPolicyVersion(
  db: DbHandle,
  policyId: string,
  options: PublishPolicyVersionOptions = {},
): Promise<PolicyVersionRow> {
  const policy = await getPolicy(db, policyId);
  if (policy === null) {
    throw new Error(`publishPolicyVersion: policy not found (${policyId})`);
  }
  const snapshot = {
    policy: {
      id: policy.id,
      orgId: policy.orgId,
      projectId: policy.projectId,
      name: policy.name,
      description: policy.description,
      groupKey: policy.groupKey,
      profile: policy.profile,
      enforcementMode: policy.enforcementMode,
      isActive: policy.isActive,
    },
    rules: policy.rules.map((rule) => ({
      id: rule.id,
      priority: rule.priority,
      matchEventType: rule.matchEventType,
      matchToolName: rule.matchToolName,
      matchPathGlob: rule.matchPathGlob,
      matchCommandPattern: rule.matchCommandPattern,
      matchAgentType: rule.matchAgentType,
      decision: rule.decision,
      reason: rule.reason,
      controlKey: rule.controlKey,
      ruleType: rule.ruleType,
      severity: rule.severity,
      details: rule.details,
    })),
  };
  const snapshotJson = JSON.stringify(snapshot);
  const snapshotHash = `sha256:${createHash('sha256').update(snapshotJson).digest('hex')}`;
  const now = new Date();

  if (db.kind === 'sqlite') {
    const vt = sqliteSchema.policyVersions;
    const latest = await db.db
      .select({ versionNumber: vt.versionNumber, snapshotHash: vt.snapshotHash, id: vt.id })
      .from(vt)
      .where(eq(vt.policyId, policy.id))
      .orderBy(desc(vt.versionNumber))
      .limit(1);
    if (latest[0]?.snapshotHash === snapshotHash) {
      const rows = await db.db.select().from(vt).where(eq(vt.id, latest[0].id)).limit(1);
      const row = rows[0];
      if (row !== undefined) return toPolicyVersionRow(row);
    }
    await db.db.update(vt).set({ status: 'retired', retiredAt: now }).where(eq(vt.policyId, policy.id));
    const row = {
      id: randomUUID(),
      orgId: policy.orgId,
      projectId: policy.projectId,
      policyId: policy.id,
      versionNumber: (latest[0]?.versionNumber ?? 0) + 1,
      status: 'active',
      snapshotJson,
      snapshotHash,
      createdByUserId: options.actorUserId ?? null,
      activatedByUserId: options.actorUserId ?? null,
      changeSummary: options.changeSummary ?? null,
      activatedAt: now,
    };
    await db.db.insert(vt).values(row);
    await insertAuditEvent(db, {
      orgId: policy.orgId,
      projectId: policy.projectId,
      actorUserId: options.actorUserId ?? null,
      eventType: 'policy.version.activated',
      subjectTable: 'policy_versions',
      subjectId: row.id,
      action: 'activate',
      reason: options.changeSummary ?? null,
      metadata: { policyId: policy.id, versionNumber: row.versionNumber, ruleCount: policy.rules.length },
      afterHash: snapshotHash,
    });
    const inserted = await db.db.select().from(vt).where(eq(vt.id, row.id)).limit(1);
    const out = inserted[0];
    if (out === undefined) throw new Error('publishPolicyVersion: inserted row not found');
    return toPolicyVersionRow(out);
  }

  const vt = postgresSchema.policyVersions;
  const latest = await db.db
    .select({ versionNumber: vt.versionNumber, snapshotHash: vt.snapshotHash, id: vt.id })
    .from(vt)
    .where(eq(vt.policyId, policy.id))
    .orderBy(desc(vt.versionNumber))
    .limit(1);
  if (latest[0]?.snapshotHash === snapshotHash) {
    const rows = await db.db.select().from(vt).where(eq(vt.id, latest[0].id)).limit(1);
    const row = rows[0];
    if (row !== undefined) return toPolicyVersionRow(row as typeof sqliteSchema.policyVersions.$inferSelect);
  }
  await db.db.update(vt).set({ status: 'retired', retiredAt: now }).where(eq(vt.policyId, policy.id));
  const inserted = await db.db
    .insert(vt)
    .values({
      id: randomUUID(),
      orgId: policy.orgId,
      projectId: policy.projectId,
      policyId: policy.id,
      versionNumber: (latest[0]?.versionNumber ?? 0) + 1,
      status: 'active',
      snapshotJson,
      snapshotHash,
      createdByUserId: options.actorUserId ?? null,
      activatedByUserId: options.actorUserId ?? null,
      changeSummary: options.changeSummary ?? null,
      activatedAt: now,
    })
    .returning();
  const out = inserted[0];
  if (out === undefined) throw new Error('publishPolicyVersion: insert returned no row');
  await insertAuditEvent(db, {
    orgId: policy.orgId,
    projectId: policy.projectId,
    actorUserId: options.actorUserId ?? null,
    eventType: 'policy.version.activated',
    subjectTable: 'policy_versions',
    subjectId: out.id,
    action: 'activate',
    reason: options.changeSummary ?? null,
    metadata: { policyId: policy.id, versionNumber: out.versionNumber, ruleCount: policy.rules.length },
    afterHash: snapshotHash,
  });
  return toPolicyVersionRow(out as typeof sqliteSchema.policyVersions.$inferSelect);
}

export async function listPolicyVersions(db: DbHandle, policyId: string): Promise<PolicyVersionRow[]> {
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.policyVersions;
    const rows = await db.db.select().from(t).where(eq(t.policyId, policyId)).orderBy(desc(t.versionNumber));
    return rows.map(toPolicyVersionRow);
  }
  const t = postgresSchema.policyVersions;
  const rows = await db.db.select().from(t).where(eq(t.policyId, policyId)).orderBy(desc(t.versionNumber));
  return rows.map((row) => toPolicyVersionRow(row as typeof sqliteSchema.policyVersions.$inferSelect));
}

export async function getActivePolicyVersion(db: DbHandle, policyId: string): Promise<PolicyVersionRow | null> {
  const versions = await listPolicyVersions(db, policyId);
  return versions.find((version) => version.status === 'active') ?? versions[0] ?? null;
}

export interface CreatePolicyExceptionArgs {
  readonly projectId: string;
  readonly policyId: string;
  readonly policyVersionId?: string | null;
  readonly ruleId?: string | null;
  readonly scopeType: PolicyExceptionScopeType;
  readonly scopeJson?: string;
  readonly decisionOverride: PolicyDecisionKind;
  readonly reason: string;
  readonly justification: string;
  readonly requestedByUserId?: string | null;
  readonly startsAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly status?: PolicyExceptionStatus;
}

export async function createPolicyException(
  db: DbHandle,
  args: CreatePolicyExceptionArgs,
): Promise<PolicyExceptionRow> {
  const row = {
    id: randomUUID(),
    projectId: args.projectId,
    policyId: args.policyId,
    policyVersionId: args.policyVersionId ?? null,
    ruleId: args.ruleId ?? null,
    scopeType: args.scopeType,
    scopeJson: args.scopeJson ?? '{}',
    decisionOverride: args.decisionOverride,
    reason: args.reason,
    justification: args.justification,
    requestedByUserId: args.requestedByUserId ?? null,
    status: args.status ?? 'requested',
    startsAt: args.startsAt ?? null,
    expiresAt: args.expiresAt ?? null,
  };
  if (db.kind === 'sqlite') {
    await db.db.insert(sqliteSchema.policyExceptions).values(row);
    await insertAuditEvent(db, {
      projectId: args.projectId,
      actorUserId: args.requestedByUserId ?? null,
      eventType: args.status === 'active' ? 'policy.exception.approved' : 'policy.exception.requested',
      subjectTable: 'policy_exceptions',
      subjectId: row.id,
      action: args.status === 'active' ? 'approve' : 'request',
      reason: args.reason,
      metadata: {
        policyId: args.policyId,
        policyVersionId: args.policyVersionId ?? null,
        ruleId: args.ruleId ?? null,
        scopeType: args.scopeType,
        decisionOverride: args.decisionOverride,
      },
    });
    const rows = await db.db
      .select()
      .from(sqliteSchema.policyExceptions)
      .where(eq(sqliteSchema.policyExceptions.id, row.id))
      .limit(1);
    const inserted = rows[0];
    if (inserted === undefined) throw new Error('createPolicyException: inserted row not found');
    return toPolicyExceptionRow(inserted);
  }
  const inserted = await db.db.insert(postgresSchema.policyExceptions).values(row).returning();
  const out = inserted[0];
  if (out === undefined) throw new Error('createPolicyException: insert returned no row');
  await insertAuditEvent(db, {
    projectId: args.projectId,
    actorUserId: args.requestedByUserId ?? null,
    eventType: args.status === 'active' ? 'policy.exception.approved' : 'policy.exception.requested',
    subjectTable: 'policy_exceptions',
    subjectId: out.id,
    action: args.status === 'active' ? 'approve' : 'request',
    reason: args.reason,
    metadata: {
      policyId: args.policyId,
      policyVersionId: args.policyVersionId ?? null,
      ruleId: args.ruleId ?? null,
      scopeType: args.scopeType,
      decisionOverride: args.decisionOverride,
    },
  });
  return toPolicyExceptionRow(out as typeof sqliteSchema.policyExceptions.$inferSelect);
}

export async function updatePolicyExceptionStatus(
  db: DbHandle,
  exceptionId: string,
  status: Extract<PolicyExceptionStatus, 'active' | 'revoked' | 'rejected'>,
  actorUserId: string | null = null,
): Promise<PolicyExceptionRow | null> {
  const now = new Date();
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.policyExceptions;
    const patch =
      status === 'active'
        ? { status, approvedByUserId: actorUserId, updatedByUserId: actorUserId, updatedAt: now }
        : status === 'revoked'
          ? { status, revokedByUserId: actorUserId, revokedAt: now, updatedByUserId: actorUserId, updatedAt: now }
          : { status, updatedByUserId: actorUserId, updatedAt: now };
    await db.db.update(t).set(patch).where(eq(t.id, exceptionId));
    const rows = await db.db.select().from(t).where(eq(t.id, exceptionId)).limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    await insertAuditEvent(db, {
      orgId: row.orgId,
      projectId: row.projectId,
      actorUserId,
      eventType:
        status === 'active'
          ? 'policy.exception.approved'
          : status === 'revoked'
            ? 'policy.exception.revoked'
            : 'policy.exception.rejected',
      subjectTable: 'policy_exceptions',
      subjectId: row.id,
      action: status,
      reason: row.reason,
      metadata: { policyId: row.policyId, policyVersionId: row.policyVersionId, ruleId: row.ruleId },
    });
    return toPolicyExceptionRow(row);
  }
  const t = postgresSchema.policyExceptions;
  const patch =
    status === 'active'
      ? { status, approvedByUserId: actorUserId, updatedByUserId: actorUserId, updatedAt: now }
      : status === 'revoked'
        ? { status, revokedByUserId: actorUserId, revokedAt: now, updatedByUserId: actorUserId, updatedAt: now }
        : { status, updatedByUserId: actorUserId, updatedAt: now };
  const rows = await db.db.update(t).set(patch).where(eq(t.id, exceptionId)).returning();
  const row = rows[0];
  if (row === undefined) return null;
  await insertAuditEvent(db, {
    orgId: row.orgId,
    projectId: row.projectId,
    actorUserId,
    eventType:
      status === 'active'
        ? 'policy.exception.approved'
        : status === 'revoked'
          ? 'policy.exception.revoked'
          : 'policy.exception.rejected',
    subjectTable: 'policy_exceptions',
    subjectId: row.id,
    action: status,
    reason: row.reason,
    metadata: { policyId: row.policyId, policyVersionId: row.policyVersionId, ruleId: row.ruleId },
  });
  return toPolicyExceptionRow(row as typeof sqliteSchema.policyExceptions.$inferSelect);
}

export async function listPolicyExceptions(
  db: DbHandle,
  projectId: string | null = null,
): Promise<PolicyExceptionRow[]> {
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.policyExceptions;
    const rows =
      projectId === null
        ? await db.db.select().from(t).orderBy(desc(t.createdAt))
        : await db.db.select().from(t).where(eq(t.projectId, projectId)).orderBy(desc(t.createdAt));
    return rows.map(toPolicyExceptionRow);
  }
  const t = postgresSchema.policyExceptions;
  const rows =
    projectId === null
      ? await db.db.select().from(t).orderBy(desc(t.createdAt))
      : await db.db.select().from(t).where(eq(t.projectId, projectId)).orderBy(desc(t.createdAt));
  return rows.map((row) => toPolicyExceptionRow(row as typeof sqliteSchema.policyExceptions.$inferSelect));
}
