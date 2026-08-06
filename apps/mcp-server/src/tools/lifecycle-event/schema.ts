import { z } from 'zod';

export const lifecycleEventInputSchema = z
  .object({
    agentType: z.enum(['codex', 'claude_code', 'cursor', 'devin']).default('codex'),
    rawPayload: z
      .record(z.string(), z.unknown())
      .describe('Original native-agent hook payload. The tool validates the stable subset for the selected agent.'),
  })
  .strict()
  .describe('Input for coodra__lifecycle_event.');

const hookOutputSchema = z.record(z.string(), z.unknown());

export const lifecycleEventOutputSchema = z
  .object({
    ok: z.literal(true),
    hookEventName: z.string().min(1),
    projectSlug: z.string().min(1).nullable(),
    runId: z.string().min(1).nullable(),
    permissionDecision: z.enum(['allow', 'ask', 'deny']),
    reason: z.string().min(1),
    hookOutput: hookOutputSchema,
  })
  .strict();

export type LifecycleEventInput = z.infer<typeof lifecycleEventInputSchema>;
export type LifecycleEventOutput = z.infer<typeof lifecycleEventOutputSchema>;
