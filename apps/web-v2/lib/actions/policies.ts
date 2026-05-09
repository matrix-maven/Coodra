'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { addPolicyRule, deletePolicyRule, setPolicyActive } from '@/lib/queries/policies';

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

export async function addRuleAction(formData: FormData): Promise<void> {
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
