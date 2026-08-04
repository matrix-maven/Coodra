import {
  attestPolicyProjection,
  type DbHandle,
  lookupProjectBySlug,
  renderPolicyProjectionDriftContext,
} from '@coodra/db';
import { resolveAskOutcomeApproved } from '@coodra/policy';
import { createLogger } from '@coodra/shared';
import {
  adaptClaudeCode,
  adaptCodex,
  adaptCursor,
  ClaudeCodeHookPayloadSchema,
  CodexHookPayloadSchema,
  CursorHookPayloadSchema,
  type HookEvent,
} from '@coodra/shared/hooks';
import { readCoodraProjectConfig } from '@coodra/shared/project-config';
import { renderWorkflowPolicyContext } from '@coodra/shared/workflow-policy';

import type { IdempotencyKey } from '../../framework/idempotency.js';
import type { ToolContext } from '../../framework/tool-context.js';
import { createCheckPolicyHandler } from '../check-policy/handler.js';
import { createGetRunIdHandler } from '../get-run-id/handler.js';
import { createListContextPacksHandler } from '../list-context-packs/handler.js';
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
}

function shapeHookOutput(
  agentType: LifecycleEventInput['agentType'],
  hookEventName: string,
  result: {
    readonly permissionDecision: 'allow' | 'ask' | 'deny';
    readonly reason?: string;
    readonly additionalContext?: string;
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
      case 'Stop': {
        const out: Record<string, unknown> = { ok: true };
        if (result.permissionDecision === 'deny') {
          out.decision = 'block';
          if (reason !== undefined) out.reason = reason;
        }
        return out;
      }
      case 'SessionEnd':
        return { ok: true };
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
      case 'Stop':
      case 'SessionEnd':
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
};

function canonicalHookEventName(agentType: LifecycleEventInput['agentType'], raw: string): string {
  return agentType === 'cursor' ? (CURSOR_EVENT_NAME_MAP[raw] ?? raw) : raw;
}

/**
 * Parses `rawPayload` with the schema for `agentType` and adapts it into
 * a `HookEvent` in one step. Doing parse+adapt together (rather than two
 * separate `agentType === '...' ? ... : ...` ternaries sharing one
 * `parsed` variable) is required, not stylistic — with three agent
 * branches TypeScript can no longer correlate the discriminant across
 * two separately-evaluated ternaries the way it can for a two-way
 * boolean check, so `parsed.data` stops narrowing to the right payload
 * type for `adaptClaudeCode`/`adaptCodex`/`adaptCursor`.
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

function toolInputRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : { value: input };
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

const MAX_RECENT_CONTEXT_PACKS_SHOWN = 3;
const MAX_RECENT_DECISIONS_SHOWN = 5;

/**
 * Renders a compact "recent context" block for SessionStart: the
 * project's most-recently-saved Context Packs (title + excerpt) and its
 * most recently recorded decisions, project-wide. Replaces the old
 * `UserPromptSubmit`-time `parseJiraWorkIntent` phrase-detection
 * mechanism AND a short-lived predecessor that surfaced Work Pack
 * *metadata* here instead — that was the wrong content for an
 * every-session automatic injection. Work Pack metadata (slug/status) is
 * navigational and belongs to the `coodra-work` skill's own explicit
 * resume flow (`work_pack_status`, called from its own step 2); what
 * SessionStart should inject automatically is substance — what was
 * already built and decided — so a fresh or long-running session doesn't
 * rediscover or contradict prior reasoning. Cursor-safe like its
 * predecessor, since SessionStart already carries context for every agent.
 */
function renderRecentContext(
  packs: ReadonlyArray<{ readonly title: string; readonly excerpt: string }>,
  decisions: ReadonlyArray<{ readonly description: string; readonly rationale: string }>,
): string | null {
  if (packs.length === 0 && decisions.length === 0) return null;
  const lines = ['## Recent context'];
  if (packs.length > 0) {
    lines.push('', 'Recent Context Packs:');
    for (const pack of packs.slice(0, MAX_RECENT_CONTEXT_PACKS_SHOWN)) {
      lines.push(`- **${pack.title}** — ${pack.excerpt}`);
    }
  }
  if (decisions.length > 0) {
    lines.push('', 'Recent decisions:');
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
  readonly policyProjectionContext?: string | null;
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
  if (args.policyProjectionContext !== undefined && args.policyProjectionContext !== null) {
    lines.push('', '---', '', args.policyProjectionContext);
  }
  if (args.recentContext !== undefined && args.recentContext !== null) {
    lines.push('', '---', '', args.recentContext);
  }
  return lines.join('\n');
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

    let permissionDecision: 'allow' | 'ask' | 'deny' = 'allow';
    let reason = projectSlug === null ? 'project_config_missing' : 'lifecycle_recorded';

    if (projectSlug !== null && hookEventName === 'PreToolUse' && event.toolName.length > 0) {
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
          ...(typeof event.turnId === 'string' && event.turnId.length > 0 ? { toolUseId: event.turnId } : {}),
        },
        ctx,
      );
      if (policy.ok) {
        permissionDecision = policy.permissionDecision;
        reason = policy.ruleReason ?? policy.reason;
      } else {
        reason = policy.error;
      }
    }

    if (runId !== null) {
      await ctx.runRecorder.record({
        runId,
        toolName: event.toolName.length > 0 ? event.toolName : hookEventName,
        phase: eventRecordPhase(event),
        sessionId: event.sessionId,
        idempotencyKey: idempotencyFor(event, hookEventName),
        input: event.toolInput ?? {},
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

    let recentContext: string | null = null;
    if (hookEventName === 'SessionStart' && projectSlug !== null) {
      try {
        const listContextPacks = createListContextPacksHandler({ db: deps.db });
        const queryDecisions = createQueryDecisionsHandler({ db: deps.db });
        const [packsResult, decisionsResult] = await Promise.all([
          listContextPacks({ projectSlug, limit: MAX_RECENT_CONTEXT_PACKS_SHOWN }, ctx),
          queryDecisions({ projectSlug, includeRelated: false, limit: MAX_RECENT_DECISIONS_SHOWN }, ctx),
        ]);
        recentContext = renderRecentContext(
          packsResult.ok ? packsResult.packs : [],
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
    let policyProjectionContext: string | null = null;
    if (hookEventName === 'SessionStart' && projectSlug !== null && projectConfig !== null) {
      try {
        const project = await lookupProjectBySlug(deps.db, projectSlug);
        if (project !== null) {
          const attestation = await attestPolicyProjection(deps.db, {
            projectId: project.id,
            projectSlug,
            projectRoot: project.cwd ?? projectConfig.root,
            agentType: input.agentType,
            sessionId: event.sessionId,
            runId,
            now: ctx.now(),
          });
          policyProjectionContext = renderPolicyProjectionDriftContext(attestation);
        }
      } catch (err) {
        logger.warn(
          {
            event: 'native_plugin_policy_projection_attestation_failed',
            agentType: input.agentType,
            sessionId: event.sessionId,
            projectSlug,
            err: err instanceof Error ? err.message : String(err),
          },
          'policy projection attestation failed; SessionStart proceeding',
        );
      }
    }
    const additionalContext =
      hookEventName === 'SessionStart'
        ? sessionAdditionalContext({
            projectSlug,
            runId,
            workflowPolicy: projectConfig?.workflowPolicy ?? null,
            policyProjectionContext,
            recentContext,
          })
        : undefined;
    const hookOutput = shapeHookOutput(input.agentType, hookEventName, {
      permissionDecision,
      reason,
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
