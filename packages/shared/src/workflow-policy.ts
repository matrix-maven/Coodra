import { z } from 'zod';

export const workflowPolicyProfileSchema = z.enum(['solo', 'team', 'manual']);
export type WorkflowPolicyProfile = z.infer<typeof workflowPolicyProfileSchema>;

export const workflowPolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    profile: workflowPolicyProfileSchema.default('solo'),
    requireBranch: z.boolean().default(true),
    requireDecisionLog: z.boolean().default(true),
    requireContextPack: z.boolean().default(true),
    requireTests: z.boolean().default(true),
    requireCommit: z.boolean().default(true),
    requirePush: z.boolean().default(false),
    requirePrLink: z.boolean().default(false),
    allowAutoMerge: z.boolean().default(false),
    updateWorkPackOnCompletion: z.boolean().default(true),
  })
  .loose();

export type WorkflowPolicy = z.infer<typeof workflowPolicySchema>;

export function defaultWorkflowPolicy(profile: WorkflowPolicyProfile = 'solo'): WorkflowPolicy {
  if (profile === 'team') {
    return workflowPolicySchema.parse({
      profile: 'team',
      requirePush: true,
      requirePrLink: true,
      allowAutoMerge: false,
    });
  }
  if (profile === 'manual') {
    return workflowPolicySchema.parse({
      profile: 'manual',
      requireBranch: false,
      requireTests: false,
      requireCommit: false,
      requirePush: false,
      requirePrLink: false,
      allowAutoMerge: false,
    });
  }
  return workflowPolicySchema.parse({
    profile: 'solo',
    requirePush: true,
    requirePrLink: false,
    allowAutoMerge: true,
  });
}

export function parseWorkflowPolicy(input: unknown, fallbackProfile: WorkflowPolicyProfile = 'solo'): WorkflowPolicy {
  const fallback = defaultWorkflowPolicy(fallbackProfile);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fallback;
  const parsed = workflowPolicySchema.safeParse(input);
  return parsed.success ? parsed.data : fallback;
}

export interface RenderWorkflowPolicyOptions {
  readonly projectSlug?: string | null;
  readonly runId?: string | null;
  readonly includeTitle?: boolean;
}

function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}

export function renderWorkflowPolicyContext(
  policyInput: unknown,
  options: RenderWorkflowPolicyOptions = {},
): string | null {
  const policy = parseWorkflowPolicy(policyInput);
  if (!policy.enabled) return null;
  const title = options.includeTitle === false ? [] : ['## Coodra Workflow Policy', ''];
  const projectLine =
    typeof options.projectSlug === 'string' && options.projectSlug.length > 0
      ? [`Project slug: \`${options.projectSlug}\``]
      : [];
  const runLine = typeof options.runId === 'string' && options.runId.length > 0 ? [`Run id: \`${options.runId}\``] : [];
  const modeGuidance =
    policy.profile === 'team'
      ? 'Team mode: create a branch, push it, open a PR for review, and do not auto-merge.'
      : policy.profile === 'manual'
        ? 'Manual mode: keep Coodra records current, but do not push, open PRs, or merge unless the user explicitly asks.'
        : 'Solo mode: create a branch, test, commit, push, and auto-merge only when allowed and tests pass.';

  return [
    ...title,
    ...projectLine,
    ...runLine,
    projectLine.length > 0 || runLine.length > 0 ? '' : undefined,
    'This project uses Coodra policy to govern agent workflow, not only tool allow/deny checks.',
    modeGuidance,
    '',
    'Required workflow:',
    `- Branch before editing: ${yesNo(policy.requireBranch)}`,
    `- Record material decisions with \`coodra__record_decision\`: ${yesNo(policy.requireDecisionLog)}`,
    `- Save a Context Pack before finishing substantial work: ${yesNo(policy.requireContextPack)}`,
    `- Run focused tests or explain why tests were not run: ${yesNo(policy.requireTests)}`,
    `- Commit focused changes: ${yesNo(policy.requireCommit)}`,
    `- Push the branch: ${yesNo(policy.requirePush)}`,
    `- Link or create a PR before completion: ${yesNo(policy.requirePrLink)}`,
    `- Auto-merge permitted after passing tests: ${yesNo(policy.allowAutoMerge)}`,
    `- Update linked Work Pack on completion: ${yesNo(policy.updateWorkPackOnCompletion)}`,
    '',
    'Instruction files such as `AGENTS.md` and `CLAUDE.md` are render targets for this policy; `.coodra/config.json` is the source of truth.',
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');
}
