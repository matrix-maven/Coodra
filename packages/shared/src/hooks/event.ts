import { z } from 'zod';

import { runKeySegmentSchema } from '../idempotency.js';

/**
 * `@coodra/contextos-shared/hooks/event` — the canonical normalized hook
 * shape per `system-architecture.md` §3.4. Every per-agent adapter in
 * `adapters/` produces one of these. Every downstream handler in
 * `apps/hooks-bridge/src/handlers/` consumes one of these.
 *
 * Adding a new agent in the future is one new payload schema + one
 * new adapter + one new shell script. Zero agent-specific code
 * downstream of the adapter (per §16 pattern 12).
 *
 * Field shapes:
 *   - `agentType` — discriminator, set by the adapter.
 *   - `eventPhase` — normalized lifecycle stage. Cross-agent mapping:
 *       Claude Code        Windsurf              Cursor          → eventPhase
 *       PreToolUse         pre_*                 pre_tool_use    → 'pre'
 *       PostToolUse        post_*                post_tool_use   → 'post'
 *       SessionStart       (synthetic on conn)   session_start   → 'session_start'
 *       SessionEnd         post_cascade_response session_end     → 'session_end'
 *       Stop               (n/a)                 (n/a)           → 'turn_end'
 *       UserPromptSubmit   pre_user_prompt       (n/a today)     → 'user_prompt'
 *
 *     Phase 3 Fix A (2026-05-02): Stop and SessionEnd are distinct in
 *     Claude Code's hook taxonomy. Stop fires per-turn-end; SessionEnd
 *     fires once per session-termination. The auto-Context-Pack save
 *     binds to 'session_end', not 'turn_end' — replaying Stop N times
 *     a session no longer wakes the saveAutoContextPack path. 'turn_end'
 *     is acked at the dispatch boundary today (no per-turn telemetry
 *     consumer); future per-turn signals can attach a handler without
 *     re-shaping the phase enum.
 *   - `sessionId` — already passed through `normalizeSessionId` by the
 *      adapter; `runKeySegmentSchema.parse` re-validates here as a
 *      defence-in-depth check.
 *   - `turnId` — Claude Code `tool_use_id` / Windsurf `execution_id` /
 *      Cursor's tool-call id. Optional because session_start and
 *      session_end events don't carry a turn.
 *   - `toolName` — normalized to the simple form the policy engine
 *      compares against (Write, Edit, Bash, Read, MCP:github, …).
 *   - `filePath` — extracted from the agent's `tool_input` shape if
 *      present; lets policy rules' path-glob axis match.
 *   - `toolInput` — passthrough of the agent's payload.tool_input,
 *      shape unspecified (handlers Zod-validate per use).
 *   - `cwd` — extracted from the agent's payload when present, used to
 *      resolve `projectSlug` from `<cwd>/.contextos.json` later.
 *   - `projectSlug` — looked up by hooks-bridge AFTER the adapter, so
 *      always undefined when the adapter emits the HookEvent. Kept
 *      on the schema so downstream code has a stable place to put
 *      it without per-handler parameter passing.
 *   - `rawAt` — adapter-stamped ISO timestamp; useful for diagnostics
 *      when the agent's own timestamp field is missing or unreliable.
 */
export const HookEventSchema = z
  .object({
    agentType: z.enum(['claude_code', 'windsurf', 'cursor', 'unknown']),
    eventPhase: z.enum(['pre', 'post', 'session_start', 'session_end', 'turn_end', 'user_prompt']),
    sessionId: runKeySegmentSchema,
    turnId: z.string().optional(),
    toolName: z.string(),
    filePath: z.string().optional(),
    toolInput: z.unknown(),
    cwd: z.string().optional(),
    projectSlug: z.string().optional(),
    rawAt: z.string().datetime(),
  })
  .strict();

export type HookEvent = z.infer<typeof HookEventSchema>;

export type AgentType = HookEvent['agentType'];
export type EventPhase = HookEvent['eventPhase'];
