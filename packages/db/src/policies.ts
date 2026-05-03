import { randomUUID } from 'node:crypto';

import { and, asc, eq, isNull, or } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { GLOBAL_PROJECT_ID } from './ensure-global-project.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/policies` — admin-side helpers for the
 * `policies` + `policy_rules` tables. Backs Module 08b S9's
 * `contextos policy {list, show, add, enable, disable}` CLI surface.
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
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
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
  readonly matchAgentType: string | null;
  readonly decision: PolicyDecisionKind;
  readonly reason: string;
  readonly createdAt: Date;
}

export interface PolicyWithRules extends PolicyRow {
  readonly rules: ReadonlyArray<PolicyRuleRow>;
}

type RawPolicyRow = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
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
  matchAgentType: string | null;
  decision: string;
  reason: string;
  createdAt: Date;
};

function toPolicyRow(row: RawPolicyRow): PolicyRow {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
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
    matchAgentType: row.matchAgentType,
    decision: row.decision as PolicyDecisionKind,
    reason: row.reason,
    createdAt: row.createdAt,
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
  /** Defaults to max(existing rule priority on the policy) + 10, or 100 if first rule. */
  readonly priority?: number;
  /** Defaults to 'PreToolUse'. */
  readonly matchEventType?: string;
  readonly matchToolName: string;
  readonly matchPathGlob?: string | null;
  readonly matchAgentType?: string | null;
  readonly decision: PolicyDecisionKind;
  /** Required — operators need attribution context for every deny/ask. */
  readonly reason: string;
}

export interface AddPolicyRuleResult {
  readonly policyId: string;
  readonly policyCreated: boolean;
  readonly ruleId: string;
  readonly priority: number;
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
  const matchEventType = args.matchEventType ?? 'PreToolUse';
  const matchAgentType = args.matchAgentType ?? '*';
  const matchPathGlob = args.matchPathGlob ?? null;

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
        description: `Auto-created by addPolicyRule (no '${policyName}' policy existed for project)`,
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
      matchAgentType,
      decision: args.decision,
      reason: args.reason,
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
      description: `Auto-created by addPolicyRule (no '${policyName}' policy existed for project)`,
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
    matchAgentType,
    decision: args.decision,
    reason: args.reason,
  });
  return { policyId, policyCreated, ruleId, priority };
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
  if (updated.length === 0) return null;
  return toPolicyRow(updated[0] as RawPolicyRow);
}

void isNull; // kept for future "active-only" filter variants
