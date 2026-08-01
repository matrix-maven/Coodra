'use server';

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultWorkflowPolicy, workflowPolicyProfileSchema } from '@coodra/shared/workflow-policy';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { assertActorRole } from '@/lib/action-guards';
import { addPolicyRule, deletePolicyRule, setPolicyActive } from '@/lib/queries/policies';
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
  matchToolName: z.string().min(1, 'tool name is required'),
  matchPathGlob: z.string().optional(),
  matchAgentType: z.string().optional(),
  matchEventType: z.enum(['PreToolUse', 'PostToolUse']).optional(),
  decision: z.enum(['allow', 'deny', 'ask']),
  reason: z.string().min(1, 'reason is required'),
  priority: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : Number.parseInt(v, 10))),
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
    matchToolName: formData.get('matchToolName') ?? '',
    matchPathGlob: formData.get('matchPathGlob') ?? undefined,
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
  try {
    const result = await addPolicyRule({
      projectId: args.projectId,
      matchToolName: args.matchToolName,
      decision: args.decision,
      reason: args.reason,
      ...(args.policyName !== undefined && args.policyName !== '' ? { policyName: args.policyName } : {}),
      ...(args.matchPathGlob !== undefined && args.matchPathGlob !== '' ? { matchPathGlob: args.matchPathGlob } : {}),
      ...(args.matchAgentType !== undefined && args.matchAgentType !== ''
        ? { matchAgentType: args.matchAgentType }
        : {}),
      ...(args.matchEventType !== undefined ? { matchEventType: args.matchEventType } : {}),
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
