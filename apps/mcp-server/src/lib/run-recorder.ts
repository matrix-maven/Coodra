import type { RunEventPayloadV1, RunIdResolution } from '@coodra/contextos-cli/lib/outbox';
import { type DbHandle, scheduleAuditWriteWithSync } from '@coodra/contextos-db';
import { type Logger, ValidationError } from '@coodra/contextos-shared';

import type { RunRecorder } from '../framework/tool-context.js';
import { createMcpLogger } from './logger.js';

/**
 * `apps/mcp-server/src/lib/run-recorder` — durable + idempotent
 * audit writer for `run_events` rows.
 *
 * Module 03.1: every audit write goes through `pending_jobs` via
 * `scheduleDurableWrite` (the durable outbox). The OutboxWorker
 * (`@coodra/contextos-cli/lib/outbox`) drains the queue and applies each
 * row to the destination via the canonical dispatcher. The
 * recorder's only job is to build the queue payload and enqueue
 * durably.
 *
 * Pre-resolved runId. Unlike the bridge's run-recorder which
 * defers `lookupRunId` to dispatch (because the agent's
 * SessionStart may not have hit the destination table yet), the
 * mcp-server's caller already knows `runId` (it was returned by
 * `get_run_id` earlier in the session). The payload uses the
 * `pre_resolved` resolution kind so the dispatcher uses the
 * caller-supplied value directly without a lookup round-trip.
 *
 * Idempotency. The `run_events.id` is `re_<idempotency-key>_<phase>`,
 * matching the historical shape and using `ON CONFLICT (id) DO
 * NOTHING` at the destination. Per the M02 freeze, the structured
 * idempotency key surfaces from `RunRecorder.record()` directly.
 *
 * Crash safety. Once `scheduleDurableWrite` resolves, the audit row
 * is durable in `pending_jobs`. If the mcp-server dies before the
 * worker drains, the worker on next boot picks up the row.
 */

const recorderLogger = createMcpLogger('lib-run-recorder');

export interface CreateRunRecorderDeps {
  readonly db: DbHandle;
  /** Optional `worker.kick()` for low-latency drain after enqueue. */
  readonly kick?: () => void;
  readonly logger?: Logger;
}

function assertArgs(args: Parameters<RunRecorder['record']>[0]): void {
  if (typeof args.toolName !== 'string' || args.toolName.length === 0) {
    throw new ValidationError('run-recorder.record: toolName is required');
  }
  if (args.phase !== 'pre' && args.phase !== 'post' && args.phase !== 'mcp_call') {
    throw new ValidationError(
      `run-recorder.record: phase must be 'pre' | 'post' | 'mcp_call', got '${String(args.phase)}'`,
    );
  }
  if (typeof args.sessionId !== 'string' || args.sessionId.length === 0) {
    throw new ValidationError('run-recorder.record: sessionId is required');
  }
  if (!args.idempotencyKey || typeof args.idempotencyKey !== 'object' || typeof args.idempotencyKey.key !== 'string') {
    throw new ValidationError('run-recorder.record: idempotencyKey must be a structured IdempotencyKey');
  }
}

export function createRunRecorder(deps: CreateRunRecorderDeps): RunRecorder {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createRunRecorder requires an options object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createRunRecorder: deps.db must be a DbHandle from @coodra/contextos-db');
  }
  const log = deps.logger ?? recorderLogger;
  const kick = deps.kick;

  log.info(
    { event: 'run_recorder_wired', mode: deps.db.kind === 'sqlite' ? 'solo' : 'team' },
    'createRunRecorder: run_events recorder wired (durable outbox via scheduleDurableWrite).',
  );

  return {
    async record(args) {
      assertArgs(args);
      const eventId = `re_${args.idempotencyKey.key}_${args.phase}`;
      const payloadObj = {
        input: args.input,
        output: args.output ?? null,
        decision: args.decision ?? null,
        reason: args.reason ?? null,
        idempotencyKind: args.idempotencyKey.kind,
      };
      const resolution: RunIdResolution = { kind: 'pre_resolved', runId: args.runId };
      const queuePayload: RunEventPayloadV1 = {
        v: 1,
        rowId: eventId,
        resolution,
        phase: args.phase,
        toolName: args.toolName,
        toolUseId: args.idempotencyKey.key,
        toolInput: JSON.stringify(payloadObj),
        outcome: args.decision ?? null,
      };
      try {
        await scheduleAuditWriteWithSync(deps.db, {
          audit: { queue: 'run_event', payload: queuePayload },
          sync: { table: 'run_events', lookup: { kind: 'id', value: eventId } },
        });
        kick?.();
      } catch (err) {
        log.warn(
          {
            event: 'run_event_enqueue_failed',
            runId: args.runId,
            sessionId: args.sessionId,
            toolName: args.toolName,
            phase: args.phase,
            idempotencyKey: args.idempotencyKey.key,
            err: err instanceof Error ? err.message : String(err),
          },
          'run_event durable enqueue failed — event lost',
        );
      }
    },
  };
}
