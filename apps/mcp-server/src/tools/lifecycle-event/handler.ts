import {
  type DbHandle,
  getRunActiveCapabilities,
  getRunCompactionNudgedAt,
  hasContextPackForRun,
  hasSessionStartEventForRun,
  lookupProjectBySlug,
  markRunCompactionNudged,
  markRunFailed,
  normalizeRunCapabilities,
  serializeRunCapabilities,
  updateRunActiveCapabilities,
} from '@coodra/db';
import { captureBaseSha, finalizeRunOnSessionEnd } from '@coodra/lifecycle';
import { resolveAskOutcomeApproved } from '@coodra/policy';
import { COODRA_MCP_TOOL_NAMES, createLogger, GRAPHIFY_MCP_TOOL_NAMES } from '@coodra/shared';
import {
  AntigravityHookPayloadSchema,
  adaptAntigravity,
  adaptClaudeCode,
  adaptCodex,
  adaptCursor,
  adaptDevin,
  ClaudeCodeHookPayloadSchema,
  CodexHookPayloadSchema,
  CursorHookPayloadSchema,
  canonicalizeAntigravityEventName,
  DevinHookPayloadSchema,
  type HookEvent,
} from '@coodra/shared/hooks';
import { readCoodraProjectConfig } from '@coodra/shared/project-config';
import { renderWorkflowPolicyContext } from '@coodra/shared/workflow-policy';

import type { IdempotencyKey } from '../../framework/idempotency.js';
import type { ToolContext } from '../../framework/tool-context.js';
import { getActorIdentity } from '../../lib/actor-identity.js';
import { selectDiversifiedRecentContextPacks } from '../../lib/context-pack.js';
import { selectPromptRelevantContext } from '../../lib/prompt-context.js';
import { createCheckPolicyHandler } from '../check-policy/handler.js';
import { createGetRunIdHandler } from '../get-run-id/handler.js';
import { createQueryDecisionsHandler } from '../query-decisions/handler.js';
import type { LifecycleEventInput, LifecycleEventOutput } from './schema.js';

const logger = createLogger('mcp-server.tool.lifecycle_event');

const SESSION_CONTRACT = [
  '## Coodra session contract',
  '',
  'Use Coodra context before making material code changes. When you make a design or implementation decision,',
  'record it with `record_decision`. Before ending substantial work, call `save_context_pack` with a concise',
  'recap of what changed, what was decided, and what remains open.',
].join('\n');

export interface LifecycleEventHandlerDeps {
  readonly db: DbHandle;
  readonly mode: 'solo' | 'team';
  /**
   * Overrides the on-disk root for SessionEnd's auto-saved Context Pack
   * `.md` file (passed through to `finalizeRunOnSessionEnd`). Production
   * wires `env.COODRA_CONTEXT_PACKS_ROOT` here (same source `save_context_pack`'s
   * store already reads — see `index.ts`), falling through to
   * `defaultContextPacksRoot()` when unset. Tests pass a tmpdir so the
   * auto-save doesn't write into a real home directory.
   */
  readonly contextPacksRoot?: string;
}

function shapeHookOutput(
  agentType: LifecycleEventInput['agentType'],
  hookEventName: string,
  result: {
    readonly permissionDecision: 'allow' | 'ask' | 'deny';
    readonly reason?: string;
    readonly additionalContext?: string;
    readonly autoApprovePermissionRequest?: boolean;
  },
): Record<string, unknown> {
  const reason = result.reason;
  if (agentType === 'claude_code') {
    switch (hookEventName) {
      case 'PreToolUse':
        return {
          ok: true,
          hookSpecificOutput: {
            hookEventName,
            permissionDecision: result.permissionDecision,
            ...(reason !== undefined ? { permissionDecisionReason: reason } : {}),
            ...(result.additionalContext !== undefined ? { additionalContext: result.additionalContext } : {}),
          },
        };
      case 'SessionStart':
        return {
          ok: true,
          hookSpecificOutput: {
            hookEventName,
            ...(result.additionalContext !== undefined ? { additionalContext: result.additionalContext } : {}),
          },
        };
      case 'UserPromptSubmit': {
        const isBlock = result.permissionDecision === 'deny';
        return {
          ok: true,
          ...(isBlock ? { decision: 'block', reason } : {}),
          hookSpecificOutput: {
            hookEventName,
            ...(result.additionalContext !== undefined ? { additionalContext: result.additionalContext } : {}),
          },
        };
      }
      case 'PostToolUse':
      case 'Stop':
      // PreCompact shares this shape (2026-08-04): `decision: 'block'`
      // is how the one-shot nudge vetoes compaction; no additionalContext
      // channel exists for this event (see payloads/claude-code.ts).
      case 'PreCompact': {
        const out: Record<string, unknown> = { ok: true };
        if (result.permissionDecision === 'deny') {
          out.decision = 'block';
          if (reason !== undefined) out.reason = reason;
        }
        return out;
      }
      case 'SessionEnd':
        return { ok: true };
      // ConfigChange remains acknowledged for lifecycle parity. Policy state
      // is now DB/cache-backed instead of projected into agent config files.
      case 'ConfigChange':
        return {
          ok: true,
          hookSpecificOutput: {
            hookEventName,
            ...(result.additionalContext !== undefined ? { additionalContext: result.additionalContext } : {}),
          },
        };
      // PermissionRequest added 2026-08-04 — unlike PreToolUse, its
      // `decision` field is binary (allow/deny only, no three-way `ask`),
      // so an ambiguous `ask` from Coodra's own policy check must NOT
      // force an answer — omit `decision` entirely and let Claude's
      // native permission prompt still show.
      case 'PermissionRequest': {
        if (result.permissionDecision === 'deny') {
          return {
            ok: true,
            hookSpecificOutput: {
              hookEventName,
              decision: { behavior: 'deny', ...(reason !== undefined ? { message: reason } : {}) },
            },
          };
        }
        if (result.autoApprovePermissionRequest === true) {
          return { ok: true, hookSpecificOutput: { hookEventName, decision: { behavior: 'allow' } } };
        }
        return { ok: true };
      }
      // PermissionDenied / SubagentStart / SubagentStop / PostCompact /
      // PostToolUseFailure / StopFailure (2026-08-04): all pure logging
      // per Claude's own docs — no decision control Coodra uses today
      // (SubagentStop technically supports `decision: 'block'`, left
      // unused — no policy reason yet to force a subagent to keep
      // working). All fall through to the plain ack below.
      default:
        return { ok: true };
    }
  }

  if (agentType === 'cursor') {
    // Cursor's hook output schema is narrower than Claude/Codex's:
    // `preToolUse` has no `"ask"` permission value (an upstream `ask`
    // decision is already collapsed to `allow` before this function is
    // called — see the `ask` → `allow` note in `packages/cli/src/lib/
    // agents/cursor-plugin.ts`), `beforeSubmitPrompt`
    // (canonicalized here as `UserPromptSubmit`) has no
    // context-injection field at all (only `continue`/`user_message`,
    // so Jira-work-intent context that Claude/Codex inject here is lost
    // for Cursor — SessionStart still carries the main session
    // contract), and `stop`'s only field is `followup_message` (no way
    // to force a block the way Claude/Codex's `decision:'block'` can).
    switch (hookEventName) {
      case 'PreToolUse':
        return {
          permission: result.permissionDecision === 'deny' ? 'deny' : 'allow',
          ...(result.permissionDecision === 'deny' && reason !== undefined
            ? { user_message: reason, agent_message: reason }
            : {}),
        };
      case 'SessionStart':
      case 'PostToolUse':
        return result.additionalContext !== undefined ? { additional_context: result.additionalContext } : {};
      case 'UserPromptSubmit':
        return {
          continue: result.permissionDecision !== 'deny',
          ...(result.permissionDecision === 'deny' && reason !== undefined ? { user_message: reason } : {}),
        };
      // Four events added (Cursor hook coverage expansion, mirroring
      // Claude Code's 91e8803 / Codex's a96e042 — see
      // cursor.com/docs/hooks).
      case 'PostToolUseFailure':
        // Fire-and-forget per Cursor's own docs — no documented
        // output/decision control for this event, matches the existing
        // Stop/SessionEnd/default pure-ack pattern.
        return {};
      case 'SubagentStart':
        // Cursor's subagentStart genuinely CAN block subagent launch
        // (`permission: "allow"|"deny"`) — unlike Claude Code (confirmed
        // cannot block) or Codex (continue:false parsed but confirmed
        // inert). Left unused this round: a real, unique capability
        // with no policy driver yet, same scope-discipline call already
        // made for Codex's SubagentStart additionalContext capability.
        return {};
      case 'SubagentStop':
        // Cursor's subagentStop can auto-submit a followup_message to
        // continue the loop — also genuinely capable, also left unused
        // this round for the same reason.
        return {};
      case 'PreCompact': {
        // DIVERGES from both Claude Code (decision:'block') and Codex
        // (continue:false): Cursor's preCompact has NO blocking field
        // at all, confirmed via direct docs quote ("Fire-and-forget; no
        // blocking response") — only `user_message`. The one-shot-nudge
        // detection logic already runs (agent-agnostic, see handler
        // body) and sets permissionDecision:'deny' when there's unsaved
        // material; for Cursor that can only surface as a user-facing
        // message, not an agent-facing block — advisory only, cannot
        // force a save. Whether Cursor even reinjects context via a
        // fresh sessionStart after compaction the way Claude Code does
        // is unconfirmed — do not assume "next SessionStart already
        // handles reinjection" holds here.
        return result.permissionDecision === 'deny' && reason !== undefined ? { user_message: reason } : {};
      }
      default:
        return {};
    }
  }

  if (agentType === 'devin') {
    // Devin's output shapes (confirmed against Devin's own docs,
    // 2026-08-05): block/approve is a TOP-LEVEL `{decision:'block'|
    // 'approve', reason}` — unlike Claude's nested
    // `hookSpecificOutput.decision.behavior` or Cursor's `permission`
    // field. A positive `approve` is never emitted (matches every other
    // agent's "omit rather than force allow" precedent) — omitting
    // `decision` entirely already means "continue normally" per Devin's
    // own exit-code semantics (0 = continue, 2 = block). Context
    // injection is `hookSpecificOutput.additionalContext`, documented
    // as valid only for UserPromptSubmit/SessionStart/PostToolUse —
    // NOT PostCompaction, despite compaction-context-reinjection being
    // mentioned as a use case in prose (the field table is more
    // authoritative than the prose example). No PreCompact-equivalent
    // exists at all, so Coodra's PreCompact one-shot nudge simply never
    // fires for Devin (hookEventName never equals 'PreCompact' here).
    switch (hookEventName) {
      case 'PreToolUse':
      case 'PermissionRequest':
        return result.permissionDecision === 'deny' && reason !== undefined ? { decision: 'block', reason } : {};
      case 'SessionStart':
      case 'PostToolUse':
        return result.additionalContext !== undefined
          ? { hookSpecificOutput: { hookEventName, additionalContext: result.additionalContext } }
          : {};
      case 'UserPromptSubmit':
        return {
          ...(result.permissionDecision === 'deny' && reason !== undefined ? { decision: 'block', reason } : {}),
          hookSpecificOutput: {
            hookEventName,
            ...(result.additionalContext !== undefined ? { additionalContext: result.additionalContext } : {}),
          },
        };
      case 'Stop':
        return result.permissionDecision === 'deny' && reason !== undefined ? { decision: 'block', reason } : {};
      default:
        return {};
    }
  }

  if (agentType === 'antigravity') {
    // Antigravity's output shapes (confirmed against Google's own
    // bundled docs, 2026-08-06 — see packages/shared/src/hooks/
    // payloads/antigravity.ts's docblock for sourcing). `PreToolUse`'s
    // `decision` is the richest vocabulary of any agent Coodra supports
    // (allow/deny/ask/force_ask) — `ask` has matching semantics to
    // Coodra's own three-way `permissionDecision`, so this is the one
    // agent where 'ask' maps onto a real wire value instead of being
    // collapsed to allow (Cursor) or omitted (Devin/Claude/Codex).
    switch (hookEventName) {
      case 'PreToolUse':
        if (result.permissionDecision === 'deny') return reason !== undefined ? { decision: 'deny', reason } : {};
        if (result.permissionDecision === 'ask') return reason !== undefined ? { decision: 'ask', reason } : {};
        return {};
      // 'SessionStart' is only ever reached here via
      // canonicalizeAntigravityEventName's synthetic first-PreInvocation
      // rewrite (see adapters/antigravity.ts) — Antigravity has no real
      // SessionStart event. Context injection is structurally different
      // from every other agent's flat `additionalContext` string:
      // `injectSteps` is an array of typed step objects
      // ({toolCall}/{userMessage}/{ephemeralMessage}) — `ephemeralMessage`
      // is the closest match to a transient system-message injection.
      case 'SessionStart':
      case 'PreInvocation':
        return result.additionalContext !== undefined
          ? { injectSteps: [{ ephemeralMessage: result.additionalContext }] }
          : {};
      // Confirmed gap, not a design choice: Antigravity's own docs give
      // PostToolUse a bare `{}` output contract — no context-injection
      // field exists for this event at all, unlike every other agent
      // Coodra supports (all four already inject additionalContext on
      // PostToolUse). Never attempt to force it through a nonexistent
      // field.
      case 'PostToolUse':
        return {};
      // PostInvocation's terminationBehavior (force_continue/terminate)
      // and injectSteps are real, unique capabilities — left unused this
      // pass, no policy driver today, same scope-discipline precedent as
      // Devin's updatedInput / Codex's SubagentStart.additionalContext.
      case 'PostInvocation':
        return {};
      // Inverted wire shape, same semantics as everywhere else: every
      // other agent's Stop/turn-end hook uses a block/deny-shaped field
      // to mean "don't let it stop" (absence = agent stops). Antigravity
      // uses a POSITIVE decision:'continue' to mean the same thing — any
      // other value (including omission) lets the agent stop. Coodra's
      // own 'deny' still means "prevent the thing" here, just wired to a
      // differently-shaped field.
      case 'Stop':
        return result.permissionDecision === 'deny' && reason !== undefined ? { decision: 'continue', reason } : {};
      default:
        return {};
    }
  }

  switch (hookEventName) {
    case 'PreToolUse':
      return {
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: result.permissionDecision,
          ...(reason !== undefined ? { permissionDecisionReason: reason } : {}),
          ...(result.additionalContext !== undefined ? { additionalContext: result.additionalContext } : {}),
        },
      };
    case 'SessionStart':
    case 'UserPromptSubmit':
      return {
        ...(result.permissionDecision === 'deny' ? { decision: 'block', reason } : {}),
        hookSpecificOutput: {
          hookEventName,
          ...(result.additionalContext !== undefined ? { additionalContext: result.additionalContext } : {}),
        },
      };
    case 'PostToolUse': {
      const out: Record<string, unknown> = {};
      if (result.permissionDecision === 'deny') {
        out.decision = 'block';
        if (reason !== undefined) out.reason = reason;
      }
      if (result.additionalContext !== undefined) {
        out.hookSpecificOutput = { hookEventName, additionalContext: result.additionalContext };
      }
      return out;
    }
    // Five events added (Codex hook coverage expansion, mirroring
    // Claude Code's 91e8803 — see learn.chatgpt.com/docs/hooks).
    // Codex's decision-control shapes are NOT a copy of Claude Code's:
    case 'PermissionRequest': {
      // Codex supports allow/deny here, but rejects Claude-only fields
      // such as updatedPermissions. Only emit allow when Coodra matched
      // an intentional approval artifact; a default allow should leave
      // Codex's native prompt flow intact.
      if (result.permissionDecision !== 'deny' && result.autoApprovePermissionRequest !== true) return {};
      return {
        hookSpecificOutput: {
          hookEventName,
          decision:
            result.permissionDecision === 'deny'
              ? { behavior: 'deny', ...(reason !== undefined ? { message: reason } : {}) }
              : { behavior: 'allow' },
        },
      };
    }
    case 'PreCompact': {
      // DIVERGES from Claude Code: Claude vetoes PreCompact via
      // `decision:'block'`+`reason`; Codex's docs document
      // `continue:false` instead — a different top-level field
      // entirely. The `reason` key alongside it is assumed parallel to
      // Claude's shape, not confirmed by the docs — verify live.
      const out: Record<string, unknown> = {};
      if (result.permissionDecision === 'deny') {
        out.continue = false;
        if (reason !== undefined) out.reason = reason;
      }
      if (result.additionalContext !== undefined) {
        out.hookSpecificOutput = { hookEventName, additionalContext: result.additionalContext };
      }
      return out;
    }
    case 'PostCompact':
      // Pure ack, same choice as Claude Code's PostCompact: compaction
      // has already happened by this point, "stops after compacting"
      // has murky practical value, no policy driver today.
      return {};
    case 'SubagentStart':
      // Codex docs: continue:false is parsed but does NOT stop the
      // subagent from starting — no real veto exists. additionalContext
      // IS documented as working here, but left unused for parity with
      // Claude Code's SubagentStart (which has no such capability at
      // all) — a genuine follow-up opportunity, not silently built.
      return {};
    case 'SubagentStop':
      // Never emits `decision`. Codex's own docs describe SubagentStop's
      // `decision:'block'` as meaning "make Codex CONTINUE the
      // subagent" — inverted vs. every other block=deny convention this
      // codebase uses (PreToolUse, PreCompact, Claude's
      // UserPromptSubmit, ...). Wiring this to `permissionDecision`
      // would silently invert Coodra's own semantics.
      return {};
    default:
      return {};
  }
}

/**
 * Claude Code's and Codex's own native hook systems both already emit
 * `hook_event_name` values in this exact canonical vocabulary
 * (`PreToolUse`, `SessionStart`, ...), so every other check in this
 * handler compares directly against `parsed.data.hook_event_name`
 * without any translation. Cursor's real wire vocabulary is different
 * (camelCase: `preToolUse`, `beforeSubmitPrompt`, ...) — `CursorHookPayloadSchema`
 * keeps that real vocabulary for schema fidelity rather than forcing a
 * lossy rename inside the hook-runner script, so this is the one place
 * that translates it to the shared canonical name every other check in
 * this handler (and `shapeHookOutput`'s per-agent dispatch) relies on.
 */
const CURSOR_EVENT_NAME_MAP: Readonly<Record<string, string>> = {
  sessionStart: 'SessionStart',
  beforeSubmitPrompt: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  stop: 'Stop',
  sessionEnd: 'SessionEnd',
  postToolUseFailure: 'PostToolUseFailure',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  preCompact: 'PreCompact',
};

function canonicalHookEventName(agentType: LifecycleEventInput['agentType'], raw: string): string {
  return agentType === 'cursor' ? (CURSOR_EVENT_NAME_MAP[raw] ?? raw) : raw;
}

/**
 * Parses `rawPayload` with the schema for `agentType` and adapts it into
 * a `HookEvent` in one step. Doing parse+adapt together (rather than two
 * separate `agentType === '...' ? ... : ...` ternaries sharing one
 * `parsed` variable) is required, not stylistic — with four agent
 * branches TypeScript can no longer correlate the discriminant across
 * two separately-evaluated ternaries the way it can for a two-way
 * boolean check, so `parsed.data` stops narrowing to the right payload
 * type for `adaptClaudeCode`/`adaptCodex`/`adaptCursor`/`adaptDevin`.
 */
function parseAndAdapt(
  agentType: LifecycleEventInput['agentType'],
  rawPayload: Record<string, unknown>,
  now: () => Date,
): { readonly event: HookEvent; readonly hookEventName: string } | null {
  if (agentType === 'claude_code') {
    const parsed = ClaudeCodeHookPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) return null;
    return { event: adaptClaudeCode(parsed.data, { now }), hookEventName: parsed.data.hook_event_name };
  }
  if (agentType === 'cursor') {
    const parsed = CursorHookPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) return null;
    return {
      event: adaptCursor(parsed.data, { now }),
      hookEventName: canonicalHookEventName('cursor', parsed.data.hook_event_name),
    };
  }
  if (agentType === 'devin') {
    // No event-name translation needed — Devin's hook_event_name values
    // are already the canonical PascalCase vocabulary (unlike Cursor's
    // camelCase), so canonicalHookEventName's no-op passthrough applies.
    const parsed = DevinHookPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) return null;
    return { event: adaptDevin(parsed.data, { now }), hookEventName: parsed.data.hook_event_name };
  }
  if (agentType === 'antigravity') {
    // The one agent whose event-name translation is data-dependent, not
    // a static lookup (unlike Cursor's CURSOR_EVENT_NAME_MAP) — see
    // canonicalizeAntigravityEventName's docblock in
    // adapters/antigravity.ts. This is the ONLY place the translation
    // happens; everything downstream (the SessionStart-gated blocks in
    // the handler body below) needs zero changes since it already keys
    // off the same string literal every other agent produces statically.
    const parsed = AntigravityHookPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) return null;
    const canonicalName = canonicalizeAntigravityEventName(parsed.data);
    return { event: adaptAntigravity(parsed.data, canonicalName, { now }), hookEventName: canonicalName };
  }
  const parsed = CodexHookPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) return null;
  return { event: adaptCodex(parsed.data, { now }), hookEventName: parsed.data.hook_event_name };
}

function compactHookPayload(rawPayload: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawPayload)) {
    if (value === undefined || value === null || value === '') continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested = compactHookPayload(value as Record<string, unknown>);
      if (Object.keys(nested).length > 0) compacted[key] = nested;
      continue;
    }
    compacted[key] = value;
  }
  return compacted;
}

function eventRecordPhase(event: HookEvent): 'pre' | 'post' | 'mcp_call' {
  if (event.eventPhase === 'pre') return 'pre';
  if (event.eventPhase === 'post') return 'post';
  return 'mcp_call';
}

function idempotencyFor(event: HookEvent, hookEventName: string): IdempotencyKey {
  const turnId = typeof event.turnId === 'string' && event.turnId.length > 0 ? event.turnId : 'no-turn';
  const tool = event.toolName.length > 0 ? event.toolName : hookEventName;
  return {
    kind: 'mutating',
    key: `lifecycle_event:${event.agentType}:${event.sessionId}:${hookEventName}:${tool}:${turnId}`.slice(0, 200),
  };
}

/**
 * True for `mcp__coodra__*` / `mcp__graphify__*` tool names — Coodra's
 * own two managed MCP servers (2026-08-04). Server-side backstop for the
 * `mcp__(?!coodra__|graphify__).*` matcher exclusion in `hooksConfig()`
 * (`claude-plugin.ts`): even if a caller somehow reaches this handler
 * with one of these tool names — a matcher-regex edge case, a future
 * host without matcher support, a direct/manual invocation — Coodra
 * must never run its own policy engine against its own tool calls.
 * Beyond the wasted round-trip, a future broad `mcp__*`-matching policy
 * rule could otherwise silently gate Coodra's own tool surface.
 */
const COODRA_OWN_BARE_TOOL_NAMES: ReadonlySet<string> = new Set([...COODRA_MCP_TOOL_NAMES, ...GRAPHIFY_MCP_TOOL_NAMES]);

/**
 * Claude Code/Codex report `mcp__<server>__<tool>` — a structural prefix
 * match suffices. Cursor reports `MCP:<tool_name>` with no server
 * qualifier at all, so that shape falls back to a maintained name-list
 * match instead (see `COODRA_MCP_TOOL_NAMES`/`GRAPHIFY_MCP_TOOL_NAMES` in
 * `@coodra/shared` for why this can't be prefix-based for Cursor).
 */
function isCoodraOwnMcpTool(toolName: string): boolean {
  if (toolName.startsWith('mcp__coodra__') || toolName.startsWith('mcp__graphify__')) return true;
  if (toolName.startsWith('MCP:')) return COODRA_OWN_BARE_TOOL_NAMES.has(toolName.slice('MCP:'.length));
  return false;
}

function toolInputRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : { value: input };
}

function parseActiveCapabilitiesFromEnv(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  return normalizeRunCapabilities(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

async function resolveRunId(args: {
  readonly deps: LifecycleEventHandlerDeps;
  readonly projectSlug: string | null;
  readonly event: HookEvent;
  readonly ctx: ToolContext;
}): Promise<string | null> {
  if (args.projectSlug === null) return null;
  const getRunId = createGetRunIdHandler(args.deps);
  const result = await getRunId(
    { projectSlug: args.projectSlug, agentSessionId: args.event.sessionId, agentType: args.event.agentType },
    args.ctx,
  );
  return result.ok ? result.runId : null;
}

// Append-only redesign (2026-08-05): was a flat slice count (3). Now
// the *startup budget* passed into `selectDiversifiedRecentContextPacks`
// — a run can produce several packs across different Work Packs in one
// sitting, so a flat "3 most recent, project-wide" slice could be
// dominated entirely by one chatty run and silently drop everything
// from earlier sessions. See selectDiversifiedRecentContextPacks's
// docblock (apps/mcp-server/src/lib/context-pack.ts) for the
// diversify-by-Work-Pack selection policy this now drives.
const MAX_RECENT_CONTEXT_PACKS_SHOWN = 6;
const MAX_RECENT_DECISIONS_SHOWN = 5;

/**
 * Renders a compact "recent context" block for SessionStart: the
 * project's most-recently-active Context Packs, diversified by Work
 * Pack (see `selectDiversifiedRecentContextPacks`), and its most
 * recently recorded decisions, project-wide (unchanged — decisions
 * never had the one-per-run problem this diversification fixes for
 * packs). Replaces the old `UserPromptSubmit`-time `parseJiraWorkIntent`
 * phrase-detection mechanism AND a short-lived predecessor that
 * surfaced Work Pack *metadata* here instead — that was the wrong
 * content for an every-session automatic injection. Work Pack metadata
 * (slug/status) is navigational and belongs to the `coodra-work`
 * skill's own explicit resume flow (`work_pack_status`, called from its
 * own step 2); what SessionStart should inject automatically is
 * substance — what was already built and decided — so a fresh or
 * long-running session doesn't rediscover or contradict prior
 * reasoning. Cursor-safe like its predecessor, since SessionStart
 * already carries context for every agent.
 */
function renderRecentContext(
  packs: ReadonlyArray<{
    readonly title: string;
    readonly excerpt: string;
    readonly workPackSlugs: ReadonlyArray<string>;
    readonly tier: 'hot' | 'warm';
  }>,
  overflow: ReadonlyArray<{ readonly workPackSlug: string; readonly hiddenCount: number }>,
  decisions: ReadonlyArray<{ readonly description: string; readonly rationale: string }>,
): string | null {
  if (packs.length === 0 && decisions.length === 0) return null;
  const lines = ['## Recent context'];
  const hotPacks = packs.filter((p) => p.tier === 'hot');
  const warmPacks = packs.filter((p) => p.tier === 'warm');
  if (hotPacks.length > 0) {
    lines.push('', 'Hot Context Packs (active or recent, injected with excerpts):');
    for (const pack of hotPacks) {
      // A pack can be linked to more than one Work Pack (primary +
      // save_context_pack's alsoLinkWorkPackSlugs) — tag with all of them.
      const tag = pack.workPackSlugs.length > 0 ? `[${pack.workPackSlugs.join(', ')}]` : '[no work pack]';
      lines.push(`- **${tag}** ${pack.title} — ${pack.excerpt}`);
    }
    for (const note of overflow) {
      lines.push(
        `  (${note.workPackSlug} has ${note.hiddenCount} more earlier pack${note.hiddenCount === 1 ? '' : 's'} — ` +
          '`coodra__list_context_packs { workPackSlug }`)',
      );
    }
  }
  if (warmPacks.length > 0) {
    lines.push('', 'Warm Context Packs (closed Work Packs, one-line only):');
    for (const pack of warmPacks) {
      const tag = pack.workPackSlugs.length > 0 ? `[${pack.workPackSlugs.join(', ')}]` : '[no work pack]';
      lines.push(`- **${tag}** ${pack.title}`);
    }
  }
  if (decisions.length > 0) {
    lines.push('', 'Hot decisions (active, non-superseded):');
    for (const decision of decisions.slice(0, MAX_RECENT_DECISIONS_SHOWN)) {
      lines.push(`- ${decision.description} — ${decision.rationale}`);
    }
  }
  lines.push(
    '',
    'Check this before making a design or implementation decision that might already be settled. Full history: ' +
      '`coodra__query_decisions` / `coodra__list_context_packs`. Resuming a specific Work Pack: use the `coodra-work` skill.',
  );
  return lines.join('\n');
}

function sessionAdditionalContext(args: {
  readonly projectSlug: string | null;
  readonly runId: string | null;
  readonly workflowPolicy: unknown | null;
  readonly recentContext?: string | null;
}): string {
  const lines = [SESSION_CONTRACT];
  if (args.projectSlug !== null) {
    lines.push('', `Project slug: \`${args.projectSlug}\``);
  }
  if (args.runId !== null) {
    lines.push(`Run id: \`${args.runId}\``);
  }
  if (args.workflowPolicy !== null) {
    const workflowPolicy = renderWorkflowPolicyContext(args.workflowPolicy, {
      projectSlug: args.projectSlug,
      runId: args.runId,
    });
    if (workflowPolicy !== null) lines.push('', '---', '', workflowPolicy);
  }
  if (args.recentContext !== undefined && args.recentContext !== null) {
    lines.push('', '---', '', args.recentContext);
  }
  return lines.join('\n');
}

function promptTextFromEvent(event: HookEvent): string | null {
  if (event.eventPhase !== 'user_prompt') return null;
  if (event.toolInput === null || typeof event.toolInput !== 'object' || Array.isArray(event.toolInput)) return null;
  const prompt = (event.toolInput as { readonly prompt?: unknown }).prompt;
  return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : null;
}

function joinAdditionalContext(parts: ReadonlyArray<string | null | undefined>): string | undefined {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part.length > 0);
  return kept.length > 0 ? kept.join('\n\n---\n\n') : undefined;
}

export function createLifecycleEventHandler(deps: LifecycleEventHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createLifecycleEventHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createLifecycleEventHandler: deps.db must be a DbHandle');
  }
  if (deps.mode !== 'solo' && deps.mode !== 'team') {
    throw new TypeError(`createLifecycleEventHandler: deps.mode must be 'solo' | 'team', got '${String(deps.mode)}'`);
  }

  return async function lifecycleEventHandler(
    input: LifecycleEventInput,
    ctx: ToolContext,
  ): Promise<LifecycleEventOutput> {
    const rawPayload = compactHookPayload(input.rawPayload);
    const adapted = parseAndAdapt(input.agentType, rawPayload, ctx.now);
    if (adapted === null) {
      const hookOutput = shapeHookOutput(input.agentType, 'Unknown', {
        permissionDecision: 'allow',
        reason: 'invalid_hook_payload',
      });
      return {
        ok: true,
        hookEventName: 'Unknown',
        projectSlug: null,
        runId: null,
        permissionDecision: 'allow',
        reason: 'invalid_hook_payload',
        hookOutput,
      };
    }

    const { event, hookEventName } = adapted;
    const projectConfig = await readCoodraProjectConfig(event.cwd);
    const projectSlug = projectConfig?.projectSlug ?? null;
    const runId = await resolveRunId({ deps, projectSlug, event, ctx });
    const isSessionStartEquivalent =
      hookEventName === 'SessionStart' ||
      (hookEventName === 'UserPromptSubmit' &&
        runId !== null &&
        projectSlug !== null &&
        !(await hasSessionStartEventForRun(deps.db, runId)));
    let activeCapabilities: readonly string[] = [];

    if (runId !== null && isSessionStartEquivalent) {
      activeCapabilities = parseActiveCapabilitiesFromEnv(process.env.COODRA_ACTIVE_CAPABILITIES);
      try {
        await updateRunActiveCapabilities(deps.db, { runId, capabilities: activeCapabilities });
      } catch (err) {
        logger.warn(
          {
            event: 'native_plugin_active_capabilities_update_failed',
            agentType: input.agentType,
            sessionId: event.sessionId,
            projectSlug,
            runId,
            err: err instanceof Error ? err.message : String(err),
          },
          'active capability bootstrap threw; continuing with request-local capability context',
        );
      }
    } else if (runId !== null) {
      try {
        activeCapabilities = await getRunActiveCapabilities(deps.db, { runId });
      } catch (err) {
        logger.warn(
          {
            event: 'native_plugin_active_capabilities_lookup_failed',
            agentType: input.agentType,
            sessionId: event.sessionId,
            projectSlug,
            runId,
            err: err instanceof Error ? err.message : String(err),
          },
          'active capability lookup threw; continuing without capability context',
        );
      }
    }

    let permissionDecision: 'allow' | 'ask' | 'deny' = 'allow';
    let reason = projectSlug === null ? 'project_config_missing' : 'lifecycle_recorded';
    let autoApprovePermissionRequest = false;

    // Pure-logging events added 2026-08-04 — surface the agent-reported
    // reason/error text into the audit `reason` field instead of the
    // generic default, so it's visible in the run_events ledger.
    if (hookEventName === 'PermissionDenied' && event.denialReason !== undefined) {
      reason = event.denialReason;
    } else if (hookEventName === 'PostToolUseFailure' && event.toolError !== undefined) {
      reason = event.toolError;
    } else if (hookEventName === 'StopFailure' && event.errorType !== undefined) {
      reason = event.errorMessage !== undefined ? `${event.errorType}: ${event.errorMessage}` : event.errorType;
    }

    // PermissionRequest (2026-08-04) asks the exact same policy question
    // PreToolUse does, for the same tool call, at a later intercept point
    // (right before Claude's native permission prompt would otherwise
    // show) — reuses `eventType: 'PreToolUse'` deliberately; check-policy's
    // schema only accepts PreToolUse/PostToolUse and there's no separate
    // rule surface for this event.
    // Antigravity's MCP tool-name shape in the matcher namespace is
    // genuinely unconfirmed from docs (see adapters/antigravity.ts's
    // module docblock) — its own client-side matcher stays broad ('*')
    // rather than guessing a prefix convention that might be wrong, so
    // this server-side bare-name check is the REAL filter preventing
    // Coodra from policy-checking its own tool calls for this agent.
    const isAntigravityOwnBareTool =
      input.agentType === 'antigravity' && COODRA_OWN_BARE_TOOL_NAMES.has(event.toolName);
    // Hoisted (2026-08-08, Codex matcher fix): this used to be a pure
    // policy-check gate, but Codex's CLI-side matcher can no longer exclude
    // Coodra's own two managed MCP servers itself — its regex engine
    // rejects the look-around that expressed "all mcp__ tools except
    // these" (see codex-plugin.ts's TOOL_MATCHER docblock), so the matcher
    // now broadly matches every `mcp__*` call and self-calls genuinely
    // reach this handler for the first time. Reused below to also skip
    // recording Coodra's own calls to `run_events` — without this, every
    // `record_decision`/`save_context_pack`/... call would show up
    // redundantly as its own PreToolUse/PostToolUse audit row alongside
    // the real one it already writes (decisions/context_packs).
    const isSelfCall = isCoodraOwnMcpTool(event.toolName) || isAntigravityOwnBareTool;
    if (
      projectSlug !== null &&
      (hookEventName === 'PreToolUse' || hookEventName === 'PermissionRequest') &&
      event.toolName.length > 0 &&
      !isSelfCall
    ) {
      const checkPolicy = createCheckPolicyHandler({ db: deps.db });
      const policy = await checkPolicy(
        {
          projectSlug,
          sessionId: event.sessionId,
          agentType: input.agentType,
          eventType: 'PreToolUse',
          toolName: event.toolName,
          toolInput: toolInputRecord(event.toolInput),
          ...(runId !== null ? { runId } : {}),
          ...(activeCapabilities.length > 0 ? { activeCapabilities: [...activeCapabilities] } : {}),
          ...(typeof event.turnId === 'string' && event.turnId.length > 0 ? { toolUseId: event.turnId } : {}),
        },
        ctx,
      );
      if (policy.ok) {
        permissionDecision = policy.permissionDecision;
        reason = policy.ruleReason ?? policy.reason;
        autoApprovePermissionRequest =
          hookEventName === 'PermissionRequest' &&
          policy.permissionDecision === 'allow' &&
          (policy.matchedGrantId != null || policy.matchedExceptionId != null);
      } else {
        reason = policy.error;
      }
    }

    // PreCompact one-shot nudge (2026-08-04): block the first compaction
    // attempt for a run that has recorded decisions but no saved Context
    // Pack yet, so that material isn't silently lost — never block twice
    // for the same run (see `markRunCompactionNudged`). Reinjection after
    // compaction needs no code here: Claude Code fires a genuine new
    // SessionStart (source: "compact") right after, and that hook already
    // re-runs `renderRecentContext` unconditionally (no matcher on
    // SessionStart) — see hooksConfig() in claude-plugin.ts.
    if (hookEventName === 'PreCompact' && runId !== null && projectSlug !== null) {
      const alreadyNudged = await getRunCompactionNudgedAt(deps.db, runId);
      if (alreadyNudged === null) {
        const queryDecisions = createQueryDecisionsHandler({ db: deps.db });
        const decisionsResult = await queryDecisions(
          { projectSlug, runId, includeRelated: false, activeOnly: true, limit: 1 },
          ctx,
        );
        const hasUnsavedDecisions = decisionsResult.ok && decisionsResult.decisions.length > 0;
        const hasContextPack = hasUnsavedDecisions ? await hasContextPackForRun(deps.db, runId) : false;
        if (hasUnsavedDecisions && !hasContextPack) {
          permissionDecision = 'deny';
          reason =
            'This run recorded decisions with no Context Pack saved yet. Call coodra__record_decision for ' +
            'anything new since, then coodra__save_context_pack, before compacting — this is a one-time nudge.';
          await markRunCompactionNudged(deps.db, runId, ctx.now());
        }
      }
    }

    if (hookEventName === 'SessionEnd' && runId !== null) {
      // Phase 1 lifecycle extraction (2026-08-08): native plugin
      // SessionEnd now gets the same finalization the HTTP Hooks
      // Bridge has always given Claude Code — run-diff capture, an
      // auto-saved Context Pack, a synced linked Work Pack, and the
      // unexecuted-`ask`-outcome sweep — not just the run-completion
      // status flip. This MUST be awaited (not fire-and-forget like
      // the bridge does it): `hook-runner.mjs` is a short-lived
      // subprocess killed right after the hook response, so there is
      // no persistent process left to finish background work.
      const finalizeProject = projectSlug !== null ? await lookupProjectBySlug(deps.db, projectSlug) : null;
      const actor = await getActorIdentity();
      await finalizeRunOnSessionEnd({
        db: deps.db,
        runId,
        sessionId: event.sessionId,
        agentType: input.agentType,
        now: ctx.now(),
        ...(typeof event.cwd === 'string' && event.cwd.length > 0 ? { cwd: event.cwd } : {}),
        ...(finalizeProject !== null ? { projectId: finalizeProject.id } : {}),
        ...(actor !== null ? { createdByUserId: actor.userId } : {}),
        ...(deps.contextPacksRoot !== undefined ? { contextPacksRoot: deps.contextPacksRoot } : {}),
      });
    }
    if (hookEventName === 'StopFailure' && runId !== null) {
      await markRunFailed(deps.db, runId, ctx.now());
    }

    if (runId !== null && !isSelfCall) {
      const isSubagentEvent = hookEventName === 'SubagentStart' || hookEventName === 'SubagentStop';
      await ctx.runRecorder.record({
        runId,
        toolName:
          event.toolName.length > 0
            ? event.toolName
            : isSubagentEvent && event.subagentType !== undefined
              ? event.subagentType
              : hookEventName,
        phase: eventRecordPhase(event),
        sessionId: event.sessionId,
        idempotencyKey: idempotencyFor(event, hookEventName),
        input:
          hookEventName === 'SubagentStop' && event.lastAssistantMessage !== undefined
            ? { lastAssistantMessage: event.lastAssistantMessage }
            : (event.toolInput ?? {}),
        decision: permissionDecision,
        reason,
      });
    }

    if (
      hookEventName === 'PostToolUse' &&
      typeof event.turnId === 'string' &&
      event.turnId.length > 0 &&
      event.toolName.length > 0
    ) {
      await resolveAskOutcomeApproved(deps.db, {
        sessionId: event.sessionId,
        toolUseId: event.turnId,
        toolName: event.toolName,
      });
    }

    // Fallback-visibility gap (found investigating a Codex Desktop report,
    // 2026-08-08): `SessionStart` is the only event that injects the
    // session contract/runId/recent-context block below. That's fine when
    // `SessionStart` reliably fires first — but Codex Desktop gates
    // plugin-bundled hooks behind a one-time user trust review, so a
    // session can run with `SessionStart` silently skipped while later
    // hooks (`UserPromptSubmit`, `PreToolUse`, ...) still fire once
    // trusted. `resolveRunId` above already opens/reuses a run for EVERY
    // event unconditionally, so the run exists and events are being
    // recorded either way — the agent just never sees the contract/runId,
    // and has no way to recover it. Treat `UserPromptSubmit` as a
    // SessionStart-equivalent whenever no `SessionStart` row has ever been
    // recorded for this runId (checked AFTER this event's own
    // `runRecorder.record` call above, so it never matches against itself).
    // Deliberately NOT a one-shot: if `SessionStart` never fires for the
    // whole session (hook trust never granted), every `UserPromptSubmit`
    // keeps reinjecting rather than the agent losing visibility again after
    // a single recovery — the moment a real `SessionStart` is ever
    // recorded, this stops taking the fallback path for good. Cursor's
    // `UserPromptSubmit` output shape has no context-injection field at all
    // (see `shapeHookOutput`), so this is a no-op there — safe to compute
    // unconditionally for every agent.
    let recentContext: string | null = null;
    if (isSessionStartEquivalent && projectSlug !== null) {
      try {
        const recentContextProject = await lookupProjectBySlug(deps.db, projectSlug);
        const queryDecisions = createQueryDecisionsHandler({ db: deps.db });
        const [diversified, decisionsResult] = await Promise.all([
          recentContextProject !== null
            ? selectDiversifiedRecentContextPacks(deps.db, {
                projectId: recentContextProject.id,
                startupBudget: MAX_RECENT_CONTEXT_PACKS_SHOWN,
              })
            : Promise.resolve({ packs: [], overflow: [] }),
          queryDecisions(
            { projectSlug, includeRelated: false, activeOnly: true, limit: MAX_RECENT_DECISIONS_SHOWN },
            ctx,
          ),
        ]);
        recentContext = renderRecentContext(
          diversified.packs,
          diversified.overflow,
          decisionsResult.ok ? decisionsResult.decisions : [],
        );
      } catch (err) {
        logger.warn(
          {
            event: 'native_plugin_recent_context_lookup_failed',
            agentType: input.agentType,
            sessionId: event.sessionId,
            projectSlug,
            runId,
            err: err instanceof Error ? err.message : String(err),
          },
          'recent context lookup failed; SessionStart proceeding without it',
        );
      }
    }

    // COOD-60 (2026-08-09): `git rev-parse HEAD` capture at SessionStart
    // used to be hooks-bridge-only (apps/hooks-bridge/src/lib/capture-base-sha.ts,
    // now a re-export of this same function from @coodra/lifecycle). COOD-53
    // routed every native plugin's SessionStart through this handler instead
    // of the bridge, but nothing here ever called captureBaseSha — so
    // `runs.base_sha` stayed NULL forever for native-plugin sessions and
    // every run-diff landed `error='no_base_sha'`, regardless of whether the
    // project was actually a git repo. Gated on isSessionStartEquivalent for
    // the same reason as the recent-context block above: Codex Desktop can
    // silently skip a real `SessionStart` until hooks are trusted, so the
    // fallback path (first UserPromptSubmit with no prior SessionStart row)
    // needs the same capture attempt. Idempotent via captureBaseSha's own
    // `WHERE base_sha IS NULL` — safe to attempt on every qualifying event.
    if (
      isSessionStartEquivalent &&
      projectSlug !== null &&
      runId !== null &&
      typeof event.cwd === 'string' &&
      event.cwd.length > 0
    ) {
      try {
        const baseShaProject = await lookupProjectBySlug(deps.db, projectSlug);
        if (baseShaProject !== null) {
          await captureBaseSha({
            db: deps.db,
            projectId: baseShaProject.id,
            sessionId: event.sessionId,
            cwd: event.cwd,
          });
        }
      } catch (err) {
        logger.warn(
          {
            event: 'native_plugin_capture_base_sha_failed',
            agentType: input.agentType,
            sessionId: event.sessionId,
            projectSlug,
            runId,
            err: err instanceof Error ? err.message : String(err),
          },
          'base-sha capture threw; SessionEnd run-diff runner will land error=no_base_sha',
        );
      }
    }
    let promptRelevantContext: string | null = null;
    const promptText = promptTextFromEvent(event);
    if (
      hookEventName === 'UserPromptSubmit' &&
      promptText !== null &&
      projectSlug !== null &&
      input.agentType !== 'cursor' &&
      input.agentType !== 'antigravity'
    ) {
      const promptContext = await selectPromptRelevantContext(
        { db: deps.db },
        { projectSlug, prompt: promptText, runId, ctx },
      );
      promptRelevantContext = promptContext.additionalContext;
    }

    const sessionContext = isSessionStartEquivalent
      ? sessionAdditionalContext({
          projectSlug,
          runId,
          workflowPolicy: projectConfig?.workflowPolicy ?? null,
          recentContext,
        })
      : null;
    const additionalContext = joinAdditionalContext([sessionContext, promptRelevantContext]);
    const hookOutput = shapeHookOutput(input.agentType, hookEventName, {
      permissionDecision,
      reason,
      autoApprovePermissionRequest,
      ...(additionalContext !== undefined ? { additionalContext } : {}),
    });

    logger.info(
      {
        event: 'native_plugin_lifecycle_event',
        agentType: input.agentType,
        hookEventName,
        sessionId: event.sessionId,
        projectSlug,
        runId,
        permissionDecision,
        activeCapabilitiesJson: serializeRunCapabilities(activeCapabilities),
      },
      'handled native plugin lifecycle event via MCP',
    );

    return {
      ok: true,
      hookEventName,
      projectSlug,
      runId,
      permissionDecision,
      reason,
      hookOutput,
    };
  };
}
