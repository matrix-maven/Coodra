import { z } from 'zod';

import { runKeySegmentSchema } from '../idempotency.js';

/**
 * `@coodra/shared/hooks/event` — the canonical normalized hook
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
 *       Claude Code        Codex                 Cursor               → eventPhase
 *       PreToolUse         PreToolUse            preToolUse           → 'pre'
 *       PostToolUse        PostToolUse           postToolUse          → 'post'
 *       SessionStart       SessionStart          sessionStart         → 'session_start'
 *       SessionEnd         SessionEnd            sessionEnd           → 'session_end'
 *       Stop               Stop                  stop                 → 'turn_end'
 *       UserPromptSubmit   UserPromptSubmit      beforeSubmitPrompt   → 'user_prompt'
 *       ConfigChange       ConfigChange          (none)               → 'config_change'
 *       PermissionRequest  (none)                (none)               → 'permission_request'
 *       PermissionDenied   (none)                (none)               → 'permission_denied'
 *       SubagentStart      (none)                (none)               → 'subagent_start'
 *       SubagentStop       (none)                (none)               → 'subagent_stop'
 *       PreCompact         (none)                (none)               → 'pre_compact'
 *       PostCompact        (none)                (none)               → 'post_compact'
 *       PostToolUseFailure (none)                (none)               → 'post_tool_use_failure'
 *       StopFailure        (none)                (none)               → 'stop_failure'
 *
 *     Cursor has no ConfigChange-equivalent hook event — a Cursor
 *     `HookEvent` never has `eventPhase: 'config_change'`. The eight
 *     events added 2026-08-04 are Claude-Code-only for now (see
 *     `apps/mcp-server/src/tools/lifecycle-event/handler.ts`) — Codex/
 *     Cursor `HookEvent`s never carry these phases either, though the
 *     literals live in the shared enum since it's one union all three
 *     adapters draw from.
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
 *   - `turnId` — Claude Code `tool_use_id`. Optional because
 *      session_start and session_end events don't carry a turn.
 *   - `toolName` — normalized to the simple form the policy engine
 *      compares against (Write, Edit, Bash, Read, MCP:github, …).
 *   - `filePath` — extracted from the agent's `tool_input` shape if
 *      present; lets policy rules' path-glob axis match.
 *   - `toolInput` — passthrough of the agent's payload.tool_input,
 *      shape unspecified (handlers Zod-validate per use).
 *   - `permissionMode` — agent-reported effective permission mode
 *      when present. Claude Code emits this on tool-call events after
 *      resolving settings/local/CLI precedence, so it is better audit
 *      evidence than parsing config files.
 *   - `cwd` — extracted from the agent's payload when present, used to
 *      resolve `projectSlug` from `<cwd>/.coodra.json` later.
 *   - `projectSlug` — looked up by hooks-bridge AFTER the adapter, so
 *      always undefined when the adapter emits the HookEvent. Kept
 *      on the schema so downstream code has a stable place to put
 *      it without per-handler parameter passing.
 *   - `rawAt` — adapter-stamped ISO timestamp; useful for diagnostics
 *      when the agent's own timestamp field is missing or unreliable.
 *   - `subagentType` / `subagentId` — set on `SubagentStart`/`SubagentStop`
 *      only (Claude Code's `agent_type`/`agent_id`). No correlator back
 *      to the parent `Task` tool call exists in Claude Code's payload.
 *   - `lastAssistantMessage` — set on `SubagentStop` only.
 *   - `compactTrigger` — set on `PreCompact`/`PostCompact` only
 *      (`'manual'` or `'auto'`).
 *   - `toolError` — set on `PostToolUseFailure` only.
 *   - `errorType` / `errorMessage` — set on `StopFailure` only.
 *   - `denialReason` — set on `PermissionDenied` only.
 */
export const HookEventSchema = z
  .object({
    agentType: z.enum(['claude_code', 'codex', 'cursor', 'unknown']),
    eventPhase: z.enum([
      'pre',
      'post',
      'session_start',
      'session_end',
      'turn_end',
      'user_prompt',
      'config_change',
      'permission_request',
      'permission_denied',
      'subagent_start',
      'subagent_stop',
      'pre_compact',
      'post_compact',
      'post_tool_use_failure',
      'stop_failure',
    ]),
    sessionId: runKeySegmentSchema,
    turnId: z.string().optional(),
    toolName: z.string(),
    filePath: z.string().optional(),
    toolInput: z.unknown(),
    permissionMode: z.string().optional(),
    cwd: z.string().optional(),
    projectSlug: z.string().optional(),
    rawAt: z.string().datetime(),
    subagentType: z.string().optional(),
    subagentId: z.string().optional(),
    lastAssistantMessage: z.string().optional(),
    compactTrigger: z.string().optional(),
    toolError: z.string().optional(),
    errorType: z.string().optional(),
    errorMessage: z.string().optional(),
    denialReason: z.string().optional(),
  })
  .strict();

export type HookEvent = z.infer<typeof HookEventSchema>;

export type AgentType = HookEvent['agentType'];
export type EventPhase = HookEvent['eventPhase'];
