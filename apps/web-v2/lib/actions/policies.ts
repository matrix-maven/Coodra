'use server';

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildPolicyGrantFingerprint } from '@coodra/policy';
import { getPolicyEvaluator, policyDecisionForStorage, policyGovernanceVerdictForStorage } from '@coodra/shared';
import { defaultWorkflowPolicy, workflowPolicyProfileSchema } from '@coodra/shared/workflow-policy';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { assertActorRole } from '@/lib/action-guards';
import {
  addPolicyRule,
  createPolicyException,
  createPolicyGrant,
  deletePolicyRule,
  getActivePolicyVersion,
  publishPolicyVersion,
  revokePolicyGrant,
  setPolicyActive,
  updatePolicyExceptionStatus,
  updatePolicyRule,
} from '@/lib/queries/policies';
import { getProject } from '@/lib/queries/projects';

/**
 * web-v2 server actions for policy admin.
 *
 * Both actions are wired to `<form action={fn}>`. Errors land in the
 * /policies querystring as `?error=...` so the page can re-render an
 * inline banner. v2 has a flat IA — there's no /policies/[id] page —
 * so success/failure both redirect back to /policies.
 */

const ADD_RULE_FORM_SCHEMA = z.object({
  projectId: z.string().min(1),
  policyName: z.string().optional(),
  groupKey: z.string().optional(),
  controlKey: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  evaluator: z.string().optional(),
  matchToolName: z.string().optional(),
  matchPathGlob: z.string().optional(),
  matchCommandPattern: z.string().optional(),
  matchAgentType: z.string().optional(),
  matchEventType: z
    .enum(['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'ConfigChange', 'SessionStart', 'SessionEnd'])
    .optional(),
  decision: z.enum(['allow', 'deny', 'ask', 'record', 'flag', 'block', 'warn', 'pass']),
  reason: z.string().min(1, 'reason is required'),
  priority: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : Number.parseInt(v, 10))),
});

const UPDATE_RULE_FORM_SCHEMA = z.object({
  ruleId: z.string().min(1),
  controlKey: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  evaluator: z.string().optional(),
  matchToolName: z.string().optional(),
  matchPathGlob: z.string().optional(),
  matchCommandPattern: z.string().optional(),
  matchAgentType: z.string().optional(),
  matchEventType: z.enum([
    'PreToolUse',
    'PostToolUse',
    'Stop',
    'SubagentStop',
    'ConfigChange',
    'SessionStart',
    'SessionEnd',
  ]),
  decision: z.enum(['allow', 'deny', 'ask', 'record', 'flag', 'block', 'warn', 'pass']),
  reason: z.string().min(1, 'reason is required'),
  priority: z.string().transform((v) => Number.parseInt(v, 10)),
});

const PUBLISH_POLICY_FORM_SCHEMA = z.object({
  policyId: z.string().min(1),
  changeSummary: z.string().optional(),
  returnTo: z.string().optional(),
});

const REQUEST_EXCEPTION_FORM_SCHEMA = z.object({
  projectId: z.string().min(1),
  policyId: z.string().min(1),
  ruleId: z.string().optional(),
  scopeType: z.enum(['project', 'session', 'work_pack', 'path', 'tool', 'agent', 'user', 'repo', 'org']),
  scopeValue: z.string().optional(),
  decisionOverride: z.enum(['allow', 'deny', 'ask']),
  reason: z.string().min(1),
  justification: z.string().min(1),
  expiresAt: z.string().optional(),
  activateNow: z.boolean(),
});

const EXCEPTION_STATUS_FORM_SCHEMA = z.object({
  exceptionId: z.string().min(1),
  status: z.enum(['active', 'revoked', 'rejected']),
  returnTo: z.string().optional(),
});

const CREATE_GRANT_FORM_SCHEMA = z.object({
  decisionId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().optional(),
  sessionId: z.string().min(1),
  toolName: z.string().min(1),
  toolUseId: z.string().optional(),
  toolInputSnapshot: z.string(),
  matchedRuleId: z.string().optional(),
  scopeType: z.enum(['similar_task', 'session', 'project']),
  returnTo: z.string().optional(),
});

const REVOKE_GRANT_FORM_SCHEMA = z.object({
  grantId: z.string().min(1),
  returnTo: z.string().optional(),
});

const WORKFLOW_POLICY_FORM_SCHEMA = z.object({
  projectSlug: z.string().min(1),
  enabled: z.boolean(),
  profile: workflowPolicyProfileSchema,
  requireBranch: z.boolean(),
  requireDecisionLog: z.boolean(),
  requireContextPack: z.boolean(),
  requireTests: z.boolean(),
  requireCommit: z.boolean(),
  requirePush: z.boolean(),
  requirePrLink: z.boolean(),
  allowAutoMerge: z.boolean(),
  updateWorkPackOnCompletion: z.boolean(),
});

export async function addRuleAction(formData: FormData): Promise<void> {
  // RBAC: only admins can edit policy rules. Phase 1 of team-mode auth
  // (see docs/team-hosted-web-and-cli-install-plan.md §4). In local-solo
  // and local-team the actor is implicitly admin (one user per machine).
  await assertActorRole('admin');

  const parsed = ADD_RULE_FORM_SCHEMA.safeParse({
    projectId: formData.get('projectId') ?? '',
    policyName: formData.get('policyName') ?? undefined,
    groupKey: formData.get('groupKey') ?? undefined,
    controlKey: formData.get('controlKey') ?? undefined,
    severity: formData.get('severity') ?? undefined,
    evaluator: formData.get('evaluator') ?? undefined,
    matchToolName: formData.get('matchToolName') ?? undefined,
    matchPathGlob: formData.get('matchPathGlob') ?? undefined,
    matchCommandPattern: formData.get('matchCommandPattern') ?? undefined,
    matchAgentType: formData.get('matchAgentType') ?? undefined,
    matchEventType: formData.get('matchEventType') ?? undefined,
    decision: formData.get('decision') ?? '',
    reason: formData.get('reason') ?? '',
    priority: formData.get('priority') ?? undefined,
  });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    redirect(`/policies?error=${encodeURIComponent(msg)}`);
  }
  const args = parsed.data;
  const evaluator = getPolicyEvaluator(args.evaluator);
  if (
    evaluator.requiresTool &&
    evaluator.key !== 'bash_command' &&
    (args.matchToolName === undefined || args.matchToolName.trim().length === 0)
  ) {
    redirect('/policies?error=tool_name_required_for_evaluator');
  }
  const matchToolName =
    args.matchToolName !== undefined && args.matchToolName !== ''
      ? args.matchToolName
      : evaluator.key === 'bash_command'
        ? 'Bash'
        : '*';
  if (evaluator.requiresPath && (args.matchPathGlob === undefined || args.matchPathGlob.trim().length === 0)) {
    redirect('/policies?error=path_glob_required_for_evaluator');
  }
  if (
    evaluator.requiresCommand &&
    (args.matchCommandPattern === undefined || args.matchCommandPattern.trim().length === 0)
  ) {
    redirect('/policies?error=command_pattern_required_for_evaluator');
  }
  try {
    const result = await addPolicyRule({
      projectId: args.projectId,
      matchToolName,
      decision: policyDecisionForStorage(args.decision),
      enforcementDecision: policyDecisionForStorage(args.decision),
      governanceVerdict: policyGovernanceVerdictForStorage(args.decision, args.severity),
      reason: args.reason,
      ...(args.policyName !== undefined && args.policyName !== '' ? { policyName: args.policyName } : {}),
      ...(args.groupKey !== undefined && args.groupKey !== '' ? { groupKey: args.groupKey } : {}),
      ...(args.controlKey !== undefined && args.controlKey !== '' ? { controlKey: args.controlKey } : {}),
      ...(args.severity !== undefined ? { severity: args.severity } : {}),
      ...(args.matchPathGlob !== undefined && args.matchPathGlob !== '' ? { matchPathGlob: args.matchPathGlob } : {}),
      ...(args.matchCommandPattern !== undefined && args.matchCommandPattern !== ''
        ? { matchCommandPattern: args.matchCommandPattern }
        : {}),
      ...(args.matchAgentType !== undefined && args.matchAgentType !== ''
        ? { matchAgentType: args.matchAgentType }
        : {}),
      matchEventType: args.matchEventType ?? evaluator.events[0] ?? 'PreToolUse',
      ruleType: evaluator.key,
      details: `${evaluator.label}: ${evaluator.description}`,
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
    });
    revalidatePath('/policies');
    redirect(`/policies?added=${encodeURIComponent(result.ruleId)}`);
  } catch (err) {
    // Re-throw redirect errors so Next.js can handle them.
    if (err instanceof Error && err.message === 'NEXT_REDIRECT') throw err;
    redirect(`/policies?error=${encodeURIComponent((err as Error).message)}`);
  }
}

export async function updateRuleAction(formData: FormData): Promise<void> {
  await assertActorRole('admin');
  const parsed = UPDATE_RULE_FORM_SCHEMA.safeParse({
    ruleId: formData.get('ruleId') ?? '',
    controlKey: formData.get('controlKey') ?? undefined,
    severity: formData.get('severity') ?? undefined,
    evaluator: formData.get('evaluator') ?? undefined,
    matchToolName: formData.get('matchToolName') ?? undefined,
    matchPathGlob: formData.get('matchPathGlob') ?? undefined,
    matchCommandPattern: formData.get('matchCommandPattern') ?? undefined,
    matchAgentType: formData.get('matchAgentType') ?? undefined,
    matchEventType: formData.get('matchEventType') ?? '',
    decision: formData.get('decision') ?? '',
    reason: formData.get('reason') ?? '',
    priority: formData.get('priority') ?? '',
  });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    redirect(`/policies?error=${encodeURIComponent(msg)}`);
  }
  const args = parsed.data;
  const evaluator = getPolicyEvaluator(args.evaluator);
  if (!Number.isFinite(args.priority)) {
    redirect('/policies?error=priority_must_be_a_number');
  }
  if (
    evaluator.requiresTool &&
    evaluator.key !== 'bash_command' &&
    (args.matchToolName === undefined || args.matchToolName.trim().length === 0)
  ) {
    redirect('/policies?error=tool_name_required_for_evaluator');
  }
  if (evaluator.requiresPath && (args.matchPathGlob === undefined || args.matchPathGlob.trim().length === 0)) {
    redirect('/policies?error=path_glob_required_for_evaluator');
  }
  if (
    evaluator.requiresCommand &&
    (args.matchCommandPattern === undefined || args.matchCommandPattern.trim().length === 0)
  ) {
    redirect('/policies?error=command_pattern_required_for_evaluator');
  }
  const matchToolName =
    args.matchToolName !== undefined && args.matchToolName !== ''
      ? args.matchToolName
      : evaluator.key === 'bash_command'
        ? 'Bash'
        : '*';
  try {
    const updated = await updatePolicyRule({
      ruleId: args.ruleId,
      priority: args.priority,
      matchEventType: args.matchEventType,
      matchToolName,
      decision: policyDecisionForStorage(args.decision),
      enforcementDecision: policyDecisionForStorage(args.decision),
      governanceVerdict: policyGovernanceVerdictForStorage(args.decision, args.severity),
      reason: args.reason,
      ...(args.controlKey !== undefined && args.controlKey !== '' ? { controlKey: args.controlKey } : {}),
      ...(args.severity !== undefined ? { severity: args.severity } : {}),
      ...(args.matchPathGlob !== undefined && args.matchPathGlob !== '' ? { matchPathGlob: args.matchPathGlob } : {}),
      ...(args.matchCommandPattern !== undefined && args.matchCommandPattern !== ''
        ? { matchCommandPattern: args.matchCommandPattern }
        : {}),
      ...(args.matchAgentType !== undefined && args.matchAgentType !== ''
        ? { matchAgentType: args.matchAgentType }
        : {}),
      ruleType: evaluator.key,
      details: `${evaluator.label}: ${evaluator.description}`,
    });
    if (updated === null) redirect('/policies?error=rule_not_found');
    revalidatePath('/policies');
    redirect(`/policies?toggled=${encodeURIComponent(`rule-${args.ruleId.slice(0, 8)}`)}`);
  } catch (err) {
    if (err instanceof Error && err.message === 'NEXT_REDIRECT') throw err;
    redirect(`/policies?error=${encodeURIComponent((err as Error).message)}`);
  }
}

export async function publishPolicyVersionAction(formData: FormData): Promise<void> {
  await assertActorRole('admin');
  const parsed = PUBLISH_POLICY_FORM_SCHEMA.safeParse({
    policyId: formData.get('policyId') ?? '',
    changeSummary: formData.get('changeSummary') ?? undefined,
    returnTo: formData.get('returnTo') ?? undefined,
  });
  const returnTo = parsed.success && parsed.data.returnTo !== undefined ? parsed.data.returnTo : '/policies';
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    redirect(`${returnTo}?error=${encodeURIComponent(msg)}`);
  }
  try {
    const version = await publishPolicyVersion(parsed.data.policyId, parsed.data.changeSummary);
    revalidatePath('/policies');
    redirect(`${returnTo}?toggled=${encodeURIComponent(`version-${version.versionNumber}`)}`);
  } catch (err) {
    if (err instanceof Error && err.message === 'NEXT_REDIRECT') throw err;
    redirect(`${returnTo}?error=${encodeURIComponent((err as Error).message)}`);
  }
}

export async function requestPolicyExceptionAction(formData: FormData): Promise<void> {
  await assertActorRole('admin');
  const parsed = REQUEST_EXCEPTION_FORM_SCHEMA.safeParse({
    projectId: formData.get('projectId') ?? '',
    policyId: formData.get('policyId') ?? '',
    ruleId: formData.get('ruleId') ?? undefined,
    scopeType: formData.get('scopeType') ?? 'project',
    scopeValue: formData.get('scopeValue') ?? undefined,
    decisionOverride: formData.get('decisionOverride') ?? '',
    reason: formData.get('reason') ?? '',
    justification: formData.get('justification') ?? '',
    expiresAt: formData.get('expiresAt') ?? undefined,
    activateNow: formData.get('activateNow') === 'on',
  });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    redirect(`/policies?error=${encodeURIComponent(msg)}`);
  }
  const activeVersion = await getActivePolicyVersion(parsed.data.policyId);
  const scopeJson = buildExceptionScopeJson(parsed.data.scopeType, parsed.data.scopeValue);
  const expiresAt =
    parsed.data.expiresAt !== undefined && parsed.data.expiresAt !== '' ? new Date(parsed.data.expiresAt) : null;
  try {
    const exception = await createPolicyException({
      projectId: parsed.data.projectId,
      policyId: parsed.data.policyId,
      policyVersionId: activeVersion?.id ?? null,
      ...(parsed.data.ruleId !== undefined && parsed.data.ruleId !== '' ? { ruleId: parsed.data.ruleId } : {}),
      scopeType: parsed.data.scopeType,
      scopeJson,
      decisionOverride: parsed.data.decisionOverride,
      reason: parsed.data.reason,
      justification: parsed.data.justification,
      expiresAt,
      status: parsed.data.activateNow ? 'active' : 'requested',
    });
    revalidatePath('/policies');
    redirect(`/policies?added=${encodeURIComponent(`exception-${exception.id.slice(0, 8)}`)}`);
  } catch (err) {
    if (err instanceof Error && err.message === 'NEXT_REDIRECT') throw err;
    redirect(`/policies?error=${encodeURIComponent((err as Error).message)}`);
  }
}

export async function updatePolicyExceptionStatusAction(formData: FormData): Promise<void> {
  await assertActorRole('admin');
  const parsed = EXCEPTION_STATUS_FORM_SCHEMA.safeParse({
    exceptionId: formData.get('exceptionId') ?? '',
    status: formData.get('status') ?? '',
    returnTo: formData.get('returnTo') ?? undefined,
  });
  const returnTo = parsed.success && parsed.data.returnTo !== undefined ? parsed.data.returnTo : '/policies';
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    redirect(`${returnTo}?error=${encodeURIComponent(msg)}`);
  }
  await updatePolicyExceptionStatus(parsed.data.exceptionId, parsed.data.status);
  revalidatePath('/policies');
  redirect(`${returnTo}?toggled=${encodeURIComponent(`exception-${parsed.data.status}`)}`);
}

export async function createPolicyGrantFromDecisionAction(formData: FormData): Promise<void> {
  await assertActorRole('admin');
  const parsed = CREATE_GRANT_FORM_SCHEMA.safeParse({
    decisionId: formData.get('decisionId') ?? '',
    projectId: formData.get('projectId') ?? '',
    runId: formData.get('runId') ?? undefined,
    sessionId: formData.get('sessionId') ?? '',
    toolName: formData.get('toolName') ?? '',
    toolUseId: formData.get('toolUseId') ?? undefined,
    toolInputSnapshot: formData.get('toolInputSnapshot') ?? '',
    matchedRuleId: formData.get('matchedRuleId') ?? undefined,
    scopeType: formData.get('scopeType') ?? '',
    returnTo: formData.get('returnTo') ?? undefined,
  });
  const returnTo = parsed.success && parsed.data.returnTo !== undefined ? parsed.data.returnTo : '/policies';
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    redirect(`${returnTo}?error=${encodeURIComponent(msg)}`);
  }
  const args = parsed.data;
  let toolInput: unknown = {};
  try {
    toolInput = args.toolInputSnapshot.length > 0 ? JSON.parse(args.toolInputSnapshot) : {};
  } catch {
    toolInput = { raw: args.toolInputSnapshot };
  }
  const fingerprint = buildPolicyGrantFingerprint({ toolName: args.toolName, input: toolInput });
  const scopeJson =
    args.scopeType === 'similar_task'
      ? JSON.stringify({ fingerprint, toolName: args.toolName })
      : args.scopeType === 'session'
        ? JSON.stringify({ sessionId: args.sessionId, toolName: args.toolName })
        : JSON.stringify({ projectId: args.projectId });

  try {
    const grant = await createPolicyGrant({
      projectId: args.projectId,
      ...(args.runId !== undefined && args.runId !== '' ? { runId: args.runId } : {}),
      scopeType: args.scopeType,
      scopeJson,
      grantKind: 'decision_override',
      ...(args.matchedRuleId !== undefined && args.matchedRuleId !== '' ? { targetRuleId: args.matchedRuleId } : {}),
      grantFingerprint: args.scopeType === 'similar_task' ? fingerprint : null,
      decisionOverride: 'allow',
      sourcePolicyDecisionId: args.decisionId,
      reason: `Approved ${args.scopeType.replace(/_/g, ' ')} from policy decision ${args.decisionId.slice(0, 12)}`,
    });
    revalidatePath('/policies');
    redirect(`${returnTo}?added=${encodeURIComponent(`grant-${grant.id.slice(0, 8)}`)}`);
  } catch (err) {
    if (err instanceof Error && err.message === 'NEXT_REDIRECT') throw err;
    redirect(`${returnTo}?error=${encodeURIComponent((err as Error).message)}`);
  }
}

export async function revokePolicyGrantAction(formData: FormData): Promise<void> {
  await assertActorRole('admin');
  const parsed = REVOKE_GRANT_FORM_SCHEMA.safeParse({
    grantId: formData.get('grantId') ?? '',
    returnTo: formData.get('returnTo') ?? undefined,
  });
  const returnTo = parsed.success && parsed.data.returnTo !== undefined ? parsed.data.returnTo : '/policies';
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    redirect(`${returnTo}?error=${encodeURIComponent(msg)}`);
  }
  const revoked = await revokePolicyGrant(parsed.data.grantId);
  revalidatePath('/policies');
  redirect(
    revoked !== null
      ? `${returnTo}?toggled=${encodeURIComponent(`grant-revoked-${parsed.data.grantId.slice(0, 8)}`)}`
      : `${returnTo}?error=grant_not_found`,
  );
}

function buildExceptionScopeJson(scopeType: string, scopeValue: string | undefined): string {
  const value = scopeValue?.trim();
  if (value === undefined || value.length === 0) return '{}';
  switch (scopeType) {
    case 'path':
      return JSON.stringify({ pathGlob: value });
    case 'tool':
      return JSON.stringify({ toolName: value });
    case 'agent':
      return JSON.stringify({ agentType: value });
    case 'work_pack':
      return JSON.stringify({ workPack: value });
    case 'session':
      return JSON.stringify({ sessionId: value });
    default:
      return JSON.stringify({ ref: value });
  }
}

export async function setActiveAction(formData: FormData): Promise<void> {
  await assertActorRole('admin');

  const identifier = String(formData.get('identifier') ?? '');
  const active = formData.get('active') === 'true';
  const projectId = formData.get('projectId');
  if (identifier.length === 0) {
    redirect('/policies?error=missing_identifier');
  }
  await setPolicyActive(
    identifier,
    active,
    typeof projectId === 'string' && projectId.length > 0 ? projectId : undefined,
  );
  revalidatePath('/policies');
  redirect(`/policies?toggled=${active ? 'enabled' : 'disabled'}`);
}

/**
 * Delete a single policy_rules row by id. The web app's row-level
 * delete affordance — closes the CRUD gap where the only previous
 * way to remove a rule was to deactivate the parent policy.
 */
export async function deleteRuleAction(formData: FormData): Promise<void> {
  await assertActorRole('admin');

  const ruleId = String(formData.get('ruleId') ?? '');
  const returnTo = String(formData.get('returnTo') ?? '/policies');
  if (ruleId.length === 0) {
    redirect(`${returnTo}?error=missing_rule_id`);
  }
  try {
    const deleted = await deletePolicyRule(ruleId);
    revalidatePath('/policies');
    if (deleted) {
      redirect(`${returnTo}?deleted=${encodeURIComponent(ruleId.slice(0, 12))}`);
    }
    redirect(`${returnTo}?error=rule_not_found`);
  } catch (err) {
    if (err instanceof Error && err.message === 'NEXT_REDIRECT') throw err;
    redirect(`${returnTo}?error=${encodeURIComponent((err as Error).message)}`);
  }
}

export async function saveWorkflowPolicyAction(formData: FormData): Promise<void> {
  await assertActorRole('admin');

  const parsed = WORKFLOW_POLICY_FORM_SCHEMA.safeParse({
    projectSlug: String(formData.get('projectSlug') ?? ''),
    enabled: formData.get('enabled') === 'on',
    profile: String(formData.get('profile') ?? 'solo'),
    requireBranch: formData.get('requireBranch') === 'on',
    requireDecisionLog: formData.get('requireDecisionLog') === 'on',
    requireContextPack: formData.get('requireContextPack') === 'on',
    requireTests: formData.get('requireTests') === 'on',
    requireCommit: formData.get('requireCommit') === 'on',
    requirePush: formData.get('requirePush') === 'on',
    requirePrLink: formData.get('requirePrLink') === 'on',
    allowAutoMerge: formData.get('allowAutoMerge') === 'on',
    updateWorkPackOnCompletion: formData.get('updateWorkPackOnCompletion') === 'on',
  });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    redirect(`/policies?error=${encodeURIComponent(msg)}`);
  }

  const project = await getProject(parsed.data.projectSlug);
  if (project === null) {
    redirect(`/policies?error=${encodeURIComponent(`project ${parsed.data.projectSlug} not found`)}`);
  }
  if (project.cwd === null || project.cwd.length === 0) {
    redirect(`/policies?error=${encodeURIComponent(`project ${project.slug} has no cwd; run coodra init again`)}`);
  }

  const configPath = join(project.cwd, '.coodra', 'config.json');
  const existing = await readJsonObject(configPath);
  const defaults = defaultWorkflowPolicy(parsed.data.profile);
  const next: Record<string, unknown> = {
    ...(existing ?? {}),
    version: 1,
    projectSlug: project.slug,
    workflowPolicy: {
      ...defaults,
      enabled: parsed.data.enabled,
      profile: parsed.data.profile,
      requireBranch: parsed.data.requireBranch,
      requireDecisionLog: parsed.data.requireDecisionLog,
      requireContextPack: parsed.data.requireContextPack,
      requireTests: parsed.data.requireTests,
      requireCommit: parsed.data.requireCommit,
      requirePush: parsed.data.requirePush,
      requirePrLink: parsed.data.requirePrLink,
      allowAutoMerge: parsed.data.allowAutoMerge,
      updateWorkPackOnCompletion: parsed.data.updateWorkPackOnCompletion,
    },
    updatedAt: new Date().toISOString(),
  };
  if (typeof next.createdAt !== 'string') next.createdAt = next.updatedAt;
  await writeJsonAtomic(configPath, next);

  revalidatePath('/policies');
  redirect(`/policies?project=${encodeURIComponent(project.slug)}&toggled=workflow-policy`);
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.web.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}
