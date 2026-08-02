import {
  attestPolicyProjection,
  lookupProjectBySlug,
  renderPolicyProjectionDriftContext,
  type DbHandle,
} from '@coodra/db';
import { resolveAskOutcomeApproved } from '@coodra/policy';
import { createLogger, parseJiraWorkIntent, renderJiraWorkModeContext } from '@coodra/shared';
import {
  adaptClaudeCode,
  adaptCodex,
  ClaudeCodeHookPayloadSchema,
  CodexHookPayloadSchema,
  type HookEvent,
} from '@coodra/shared/hooks';
import { readCoodraProjectConfig } from '@coodra/shared/project-config';
import { renderWorkflowPolicyContext } from '@coodra/shared/workflow-policy';

import type { IdempotencyKey } from '../../framework/idempotency.js';
import type { ToolContext } from '../../framework/tool-context.js';
import { createCheckPolicyHandler } from '../check-policy/handler.js';
import { createGetRunIdHandler } from '../get-run-id/handler.js';
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

function sessionAdditionalContext(args: {
  readonly projectSlug: string | null;
  readonly runId: string | null;
  readonly workflowPolicy: unknown | null;
  readonly policyProjectionContext?: string | null;
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
    const parsed =
      input.agentType === 'claude_code'
        ? ClaudeCodeHookPayloadSchema.safeParse(rawPayload)
        : CodexHookPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) {
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

    const event =
      input.agentType === 'claude_code'
        ? adaptClaudeCode(parsed.data, { now: ctx.now })
        : adaptCodex(parsed.data, { now: ctx.now });
    const projectConfig = await readCoodraProjectConfig(event.cwd);
    const projectSlug = projectConfig?.projectSlug ?? null;
    const runId = await resolveRunId({ deps, projectSlug, event, ctx });

    let permissionDecision: 'allow' | 'ask' | 'deny' = 'allow';
    let reason = projectSlug === null ? 'project_config_missing' : 'lifecycle_recorded';

    if (projectSlug !== null && parsed.data.hook_event_name === 'PreToolUse' && event.toolName.length > 0) {
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
        toolName: event.toolName.length > 0 ? event.toolName : parsed.data.hook_event_name,
        phase: eventRecordPhase(event),
        sessionId: event.sessionId,
        idempotencyKey: idempotencyFor(event, parsed.data.hook_event_name),
        input: event.toolInput ?? {},
        decision: permissionDecision,
        reason,
      });
    }

    if (
      parsed.data.hook_event_name === 'PostToolUse' &&
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

    const hookEventName = parsed.data.hook_event_name;
    const workIntent = hookEventName === 'UserPromptSubmit' ? parseJiraWorkIntent(event.toolInput) : null;
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
    const workflowPolicyBlock =
      workIntent !== null && projectConfig !== null
        ? renderWorkflowPolicyContext(projectConfig?.workflowPolicy, {
            projectSlug,
            runId,
          })
        : null;
    const additionalContext =
      hookEventName === 'SessionStart'
        ? sessionAdditionalContext({
            projectSlug,
            runId,
            workflowPolicy: projectConfig?.workflowPolicy ?? null,
            policyProjectionContext,
          })
        : workIntent !== null
          ? [renderJiraWorkModeContext(workIntent), workflowPolicyBlock]
              .filter((block): block is string => block !== null)
              .join('\n\n---\n\n')
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
        ...(workIntent !== null ? { workPackSlug: workIntent.slug, jiraIssueKey: workIntent.issueKey } : {}),
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
