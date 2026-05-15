import { closeRun, type DbHandle, insertRun, insertRunEvent, lookupRunId } from '@coodra/db';
import { recordPolicyDecision } from '@coodra/policy';
import { createLogger, type Logger } from '@coodra/shared';

import type { OutboxDispatchHandler, OutboxDispatchOutcome } from './types.js';

/**
 * `packages/cli/src/lib/outbox/dispatcher` — canonical dispatch
 * routing for the Module 03.1 durable audit outbox.
 *
 * The OutboxWorker (`./worker.ts`) calls this handler with each
 * claimed `pending_jobs` row. The handler validates the payload
 * shape per `pending_jobs.queue`, resolves a `runId` (lookup or
 * pre-supplied), and delegates the destination INSERT to the pure
 * helpers in `@coodra/db::destinations` (or
 * `@coodra/policy::recordPolicyDecision` for the audit row).
 *
 * Why central. Both `apps/hooks-bridge` and `apps/mcp-server` enqueue
 * into the same `pending_jobs` table; both run their own
 * OutboxWorker that drains it (OQ2). For the lease serialization to
 * be safe, the dispatch logic must be byte-identical across both
 * services — a shared central handler is the only way to guarantee
 * that. App-specific factories
 * (`apps/{hooks-bridge,mcp-server}/src/lib/outbox-dispatch.ts`) are
 * thin wrappers that inject the app-side logger.
 *
 * RunId resolution. The bridge enqueues with
 * `resolution: { kind: 'session_lookup' }` so the lookup happens at
 * dispatch (when the `runs` row is more likely to exist — closes
 * the SessionStart-vs-PreToolUse race within the worker tick
 * interval). The mcp-server enqueues with
 * `resolution: { kind: 'pre_resolved', runId }` because the caller
 * already knows the runId.
 *
 * Failure handling. Any thrown error is caught by the OutboxWorker
 * and treated as `transient_failure`. Payload-shape mismatches
 * (programming bug — payload schema drift) return
 * `permanent_failure` so a poisoned row is marked dead instead of
 * looping forever.
 */

export type RunIdResolution =
  | { readonly kind: 'pre_resolved'; readonly runId: string | null }
  | { readonly kind: 'session_lookup'; readonly sessionId: string; readonly projectId: string };

export interface RunEventPayloadV1 {
  readonly v: 1;
  readonly rowId: string;
  readonly resolution: RunIdResolution;
  readonly phase: string;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly toolInput: string;
  readonly outcome: string | null;
}

export interface PolicyDecisionPayloadV1 {
  readonly v: 1;
  readonly resolution: RunIdResolution;
  readonly projectId: string;
  readonly sessionId: string;
  readonly agentType: string;
  readonly eventType: string;
  readonly toolName: string;
  readonly toolUseId?: string;
  readonly toolInputSnapshot: string;
  readonly permissionDecision: 'allow' | 'deny';
  readonly matchedRuleId: string | null;
  readonly reason: string;
}

export interface SessionOpenPayloadV1 {
  readonly v: 1;
  readonly rowId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly agentType: string;
  readonly mode: string;
  /**
   * Module 04 Phase 4 — optional Clerk user id of the session owner.
   * Bridge populates from team config when COODRA_MODE=team. Solo
   * mode + pre-Phase-4 payloads omit the field (treated as null at
   * the destination).
   */
  readonly createdByUserId?: string | null;
}

export interface SessionClosePayloadV1 {
  readonly v: 1;
  readonly projectId: string;
  readonly sessionId: string;
}

export interface CreateOutboxDispatchHandlerDeps {
  readonly db: DbHandle;
  /** Override the default child logger (`outbox.dispatcher`). */
  readonly logger?: Logger;
}

const PERMANENT = (error: string): OutboxDispatchOutcome => ({ status: 'permanent_failure', error });
const TRANSIENT = (error: string): OutboxDispatchOutcome => ({ status: 'transient_failure', error });
const SUCCESS: OutboxDispatchOutcome = { status: 'success' };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readResolution(value: unknown): RunIdResolution | null {
  if (!isObject(value)) return null;
  const kind = value.kind;
  if (kind === 'pre_resolved') {
    const runId = value.runId;
    if (runId === null || typeof runId === 'string') return { kind, runId };
    return null;
  }
  if (kind === 'session_lookup') {
    const sessionId = value.sessionId;
    const projectId = value.projectId;
    if (typeof sessionId === 'string' && typeof projectId === 'string') {
      return { kind, sessionId, projectId };
    }
  }
  return null;
}

async function resolveRunId(db: DbHandle, resolution: RunIdResolution): Promise<string | null> {
  if (resolution.kind === 'pre_resolved') return resolution.runId;
  return lookupRunId(db, resolution.projectId, resolution.sessionId);
}

export function createOutboxDispatchHandler(deps: CreateOutboxDispatchHandlerDeps): OutboxDispatchHandler {
  if (!deps?.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createOutboxDispatchHandler: deps.db must be a DbHandle from @coodra/db');
  }
  const log = deps.logger ?? createLogger('outbox.dispatcher');

  return async function dispatchOutboxJob(job): Promise<OutboxDispatchOutcome> {
    const payload = job.payload;
    if (!isObject(payload)) {
      return PERMANENT(`payload not an object for queue=${job.queue}`);
    }
    if (payload.v !== 1) {
      return PERMANENT(`unsupported payload version ${String(payload.v)} for queue=${job.queue}`);
    }

    try {
      switch (job.queue) {
        case 'run_event': {
          const rowId = payload.rowId;
          const phase = payload.phase;
          const toolName = payload.toolName;
          const toolUseId = payload.toolUseId;
          const toolInput = payload.toolInput;
          const resolution = readResolution(payload.resolution);
          if (
            typeof rowId !== 'string' ||
            typeof phase !== 'string' ||
            typeof toolName !== 'string' ||
            typeof toolUseId !== 'string' ||
            typeof toolInput !== 'string' ||
            resolution === null
          ) {
            return PERMANENT('run_event payload missing required fields');
          }
          const outcome = payload.outcome === null || typeof payload.outcome === 'string' ? payload.outcome : null;
          const runId = await resolveRunId(deps.db, resolution);
          await insertRunEvent(deps.db, {
            id: rowId,
            runId,
            phase,
            toolName,
            toolUseId,
            toolInput,
            outcome,
          });
          log.debug(
            {
              event: 'outbox_dispatch_run_event',
              jobId: job.id,
              rowId,
              runId: runId ?? 'unresolved',
              phase,
              toolName,
            },
            'run_events row dispatched',
          );
          return SUCCESS;
        }

        case 'policy_decision': {
          const projectId = payload.projectId;
          const sessionId = payload.sessionId;
          const agentType = payload.agentType;
          const eventType = payload.eventType;
          const toolName = payload.toolName;
          const toolInputSnapshot = payload.toolInputSnapshot;
          const permissionDecision = payload.permissionDecision;
          const reason = payload.reason;
          const matchedRuleId =
            payload.matchedRuleId === null || typeof payload.matchedRuleId === 'string' ? payload.matchedRuleId : null;
          const resolution = readResolution(payload.resolution);
          if (
            typeof projectId !== 'string' ||
            typeof sessionId !== 'string' ||
            typeof agentType !== 'string' ||
            typeof eventType !== 'string' ||
            typeof toolName !== 'string' ||
            typeof toolInputSnapshot !== 'string' ||
            (permissionDecision !== 'allow' && permissionDecision !== 'deny') ||
            typeof reason !== 'string' ||
            resolution === null
          ) {
            return PERMANENT('policy_decision payload missing required fields');
          }
          const runId = await resolveRunId(deps.db, resolution);
          const toolUseId = typeof payload.toolUseId === 'string' ? payload.toolUseId : undefined;
          await recordPolicyDecision(deps.db, {
            projectId,
            sessionId,
            agentType,
            eventType,
            toolName,
            ...(toolUseId !== undefined ? { toolUseId } : {}),
            toolInputSnapshot,
            permissionDecision,
            reason,
            matchedRuleId,
            runId,
          });
          log.debug(
            {
              event: 'outbox_dispatch_policy_decision',
              jobId: job.id,
              sessionId,
              toolName,
              eventType,
              runId: runId ?? 'unresolved',
            },
            'policy_decisions row dispatched',
          );
          return SUCCESS;
        }

        case 'session_open': {
          const rowId = payload.rowId;
          const projectId = payload.projectId;
          const sessionId = payload.sessionId;
          const agentType = payload.agentType;
          const mode = payload.mode;
          if (
            typeof rowId !== 'string' ||
            typeof projectId !== 'string' ||
            typeof sessionId !== 'string' ||
            typeof agentType !== 'string' ||
            typeof mode !== 'string'
          ) {
            return PERMANENT('session_open payload missing required fields');
          }
          const createdByUserId =
            typeof payload.createdByUserId === 'string' && payload.createdByUserId.length > 0
              ? payload.createdByUserId
              : null;
          await insertRun(deps.db, {
            id: rowId,
            projectId,
            sessionId,
            agentType,
            mode,
            createdByUserId,
          });
          log.debug(
            { event: 'outbox_dispatch_session_open', jobId: job.id, sessionId, projectId, createdByUserId },
            'runs row dispatched (SessionStart)',
          );
          return SUCCESS;
        }

        case 'session_close': {
          const projectId = payload.projectId;
          const sessionId = payload.sessionId;
          if (typeof projectId !== 'string' || typeof sessionId !== 'string') {
            return PERMANENT('session_close payload missing required fields');
          }
          await closeRun(deps.db, { projectId, sessionId });
          log.debug(
            { event: 'outbox_dispatch_session_close', jobId: job.id, sessionId, projectId },
            'runs row closed (SessionEnd)',
          );
          return SUCCESS;
        }

        default:
          return PERMANENT(`unknown queue '${job.queue}'`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // FK violation on the destination INSERT can be permanent in a sense,
      // but we treat all transport errors as transient — by the time a retry
      // fires (1s later), an in-flight session_open from the same outbox
      // tick may have landed and made the FK satisfied. The maxAttempts
      // give-up is the safety net for genuinely permanent FK issues.
      return TRANSIENT(msg);
    }
  };
}
