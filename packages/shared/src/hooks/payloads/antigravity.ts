import { z } from 'zod';

/**
 * Antigravity (Google) lifecycle hook payloads.
 *
 * Field names/shapes are taken from Google's own bundled offline docs
 * (`~/.gemini/antigravity/builtin/skills/agy-customizations/docs/hooks.md`,
 * read 2026-08-06 directly off a real Antigravity install — materially
 * more complete than the public `antigravity.google/docs/hooks` page,
 * which this cross-checks against). Not verified against a live, driven
 * Antigravity session — this environment has the app installed but no
 * way to script its IDE/App UI — same "doc-derived, not live-verified"
 * discipline as every other agent's payload schema in this file.
 *
 * Antigravity's own vocabulary is the smallest and most different of
 * every supported agent — only 5 events: `PreToolUse`, `PostToolUse`,
 * `PreInvocation`, `PostInvocation`, `Stop`. No `SessionStart`/
 * `SessionEnd`/`UserPromptSubmit`/`PermissionRequest`-equivalent exists
 * at all (confirmed absent from the bundled doc's exhaustive event
 * table).
 *
 * `hookEventName` is a SYNTHETIC field — Antigravity's own stdin payload
 * never states which event just fired (unlike every other agent's
 * `hook_event_name`/per-script-invocation model). Coodra's own
 * `hook-runner.mjs` (see `packages/cli/src/lib/agents/
 * antigravity-plugin.ts`) reads the event name from its own `argv[2]`
 * (an extra arg Coodra controls in `hooks.json`'s own `command` string)
 * and injects it onto the payload before forwarding — so it's required
 * here, not optional, unlike every genuinely-agent-sent field below.
 *
 * Payload fields are camelCase (protojson encoding) — `conversationId`,
 * `stepIdx`, `toolCall: {name, args}`, `workspacePaths` (an array, not a
 * single `cwd` string) — not the snake_case shape every other agent uses.
 *
 * Confirmed from the bundled doc's own shown examples: `PostToolUse`'s
 * payload does NOT include `toolCall` at all (only `stepIdx`/`error`/
 * common fields) — every other agent restates the tool name on its
 * post-event; Antigravity's own documented example doesn't. `toolCall`
 * stays optional here to reflect that real gap, not assumed symmetry
 * with `PreToolUse`.
 *
 * `PreInvocation`/`PostInvocation` are turn-level, not tool-level —
 * they fire around each model invocation within a conversation, and
 * carry `invocationNum`/`initialNumSteps` instead of any tool context.
 */
export const AntigravityHookPayloadSchema = z
  .object({
    hookEventName: z.enum(['PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop']),
    conversationId: z.string().optional(),
    workspacePaths: z.array(z.string()).optional(),
    transcriptPath: z.string().optional(),
    artifactDirectoryPath: z.string().optional(),
    modelName: z.string().optional(),
    toolCall: z
      .object({
        name: z.string(),
        args: z.unknown().optional(),
      })
      .optional(),
    stepIdx: z.number().optional(),
    error: z.string().optional(),
    invocationNum: z.number().optional(),
    initialNumSteps: z.number().optional(),
    executionNum: z.number().optional(),
    terminationReason: z.string().optional(),
    fullyIdle: z.boolean().optional(),
  })
  .passthrough();

export type AntigravityHookPayload = z.infer<typeof AntigravityHookPayloadSchema>;
