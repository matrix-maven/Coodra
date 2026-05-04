import { createHash } from 'node:crypto';
import type {
  PolicyDecisionPayloadV1,
  RunEventPayloadV1,
  RunIdResolution,
  SessionClosePayloadV1,
  SessionOpenPayloadV1,
} from '@coodra/contextos-cli/lib/outbox';
import { type DbHandle, GLOBAL_PROJECT_ID, insertRun, scheduleAuditWriteWithSync } from '@coodra/contextos-db';
import { buildPolicyDecisionIdempotencyKey } from '@coodra/contextos-policy';
import { createLogger, generateRunKey } from '@coodra/contextos-shared';
import type { HookEvent } from '@coodra/contextos-shared/hooks';

/**
 * `apps/hooks-bridge/src/lib/run-recorder` — durable + idempotent
 * audit writer for `run_events`, `runs`, and `policy_decisions`.
 *
 * Module 03.1 — every audit write goes through `pending_jobs` via
 * `scheduleDurableWrite` (the durable outbox). The OutboxWorker
 * (`@coodra/contextos-cli/lib/outbox`) drains the queue and applies each
 * row to its destination table. This recorder's only job is to
 * build the queue payload and enqueue durably; on success the
 * caller's HTTP response can return immediately without waiting
 * on the destination INSERT.
 *
 * Crash safety. The big AC for Module 03.1: SIGTERM mid-PreToolUse
 * with a queued audit write must result in the row landing AFTER
 * restart, not being lost. The flow:
 *   1. Caller invokes `recordX(...)` — synchronously builds payload
 *      and fire-and-forgets `scheduleDurableWrite(...)`. The
 *      enqueue runs as a single atomic INSERT in SQLite WAL; once
 *      it returns, the row is durable.
 *   2. The OutboxWorker (started by the bridge boot path in S3)
 *      drains the queue.
 *   3. If the bridge dies between (1) and (2), the row stays in
 *      `pending_jobs` and is picked up by the worker on next boot.
 *
 * RunId resolution. The `runId` for `run_events` and
 * `policy_decisions` rows is resolved at DISPATCH time, not at
 * enqueue time. This closes the SessionStart-vs-PreToolUse race:
 * if PreToolUse fires before SessionStart's worker tick has
 * inserted the `runs` row, the lookup at enqueue would return
 * null. By the time the worker dispatches the policy_decision job
 * (~1s later), the session_open job has likely landed and the
 * lookup succeeds. The dispatcher in
 * `@coodra/contextos-cli/lib/outbox::dispatcher` performs the
 * `lookupRunId(projectId, sessionId)` call.
 *
 * Idempotency.
 *   run_events.id   = `re_` + sha256(sessionId + '|' + toolUseId + '|' + phase).slice(0, 32)
 *                     The destination INSERT uses `ON CONFLICT DO NOTHING` on this id.
 *   policy_decisions.idempotency_key
 *                  = `pd:{sessionId}:{toolUseId}:{toolName}:{eventType}` (F14 4-segment shape).
 *                     The destination INSERT uses `ON CONFLICT DO NOTHING` on this key.
 *   runs            = `ON CONFLICT (projectId, sessionId) DO NOTHING`.
 * The `pending_jobs.id` itself is generated fresh per enqueue (UUID),
 * so a retry of the SAME audit (e.g. PreToolUse fires twice for the
 * same toolUseId) lands TWO `pending_jobs` rows that BOTH dispatch —
 * the destination idempotency catches the duplicate.
 *
 * `tool_input` snapshot is 8KB-clamped (Unicode code-point safe so a
 * multi-byte char at the boundary stays intact).
 */

const recorderLogger = createLogger('hooks-bridge.run-recorder');

const TOOL_INPUT_MAX_CODE_POINTS = 8 * 1024;

function clampToolInput(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value ?? null);
  } catch {
    serialized = '"<unserialisable>"';
  }
  // Unicode code-point safe: Array.from yields code points, not UTF-16
  // surrogate pairs. A multi-byte char at the boundary stays intact.
  const codePoints = Array.from(serialized);
  if (codePoints.length <= TOOL_INPUT_MAX_CODE_POINTS) return serialized;
  return codePoints.slice(0, TOOL_INPUT_MAX_CODE_POINTS).join('');
}

export interface CreateRunRecorderDeps {
  readonly db: DbHandle;
  /**
   * Optional kick callback — called after each successful enqueue
   * so a freshly-enqueued audit row drains immediately rather than
   * waiting for the next worker tick. Production wiring (S3) injects
   * `() => worker.kick()`. Tests may omit it; the row still drains
   * on the next tick (or on a manual `worker.tick()`).
   */
  readonly kick?: () => void;
  /**
   * M04 Phase 2 S1 (F3 root-cause fix). Mode used for the implicit
   * `session_open` payload that fires on the FIRST audit-write for
   * a (projectId, sessionId) tuple — closes the SessionStart-missed
   * orphan path. Defaults to `'solo'` if omitted (matches the
   * conservative bridge default elsewhere). The runs row is opened
   * with this mode value; if a real SessionStart later fires with a
   * different mode, ON CONFLICT DO NOTHING keeps the first value.
   */
  readonly mode?: 'solo' | 'team';
}

export interface RunRecorder {
  /**
   * Enqueue a `run_events` row for a PostToolUse event. Returns
   * synchronously; durability is guaranteed once `scheduleDurableWrite`
   * resolves. Failure is WARN-logged (audit-only path).
   *
   * `projectId` (when defined) lets the dispatcher resolve `runs.id`
   * so the row's `run_id` FK is populated. Pass `undefined` when no
   * project resolves (no `.contextos.json` in cwd) — the dispatcher
   * falls back to `__global__` and the row still lands.
   */
  recordPostToolUse(event: HookEvent, projectId?: string): void;
  /** Same as `recordPostToolUse` for UserPromptSubmit (`phase = 'user_prompt'`). */
  recordUserPromptSubmit(event: HookEvent, projectId?: string): void;
  /**
   * Enqueue a `policy_decisions` row for a pre-tool decision.
   * Idempotent at the destination via the F14 4-segment key.
   */
  recordPolicyDecision(args: {
    readonly event: HookEvent;
    readonly projectId: string | undefined;
    readonly decision: 'allow' | 'deny';
    readonly reason: string;
    readonly matchedRuleId: string | null;
  }): void;
  /**
   * Enqueue a `runs` row open when SessionStart fires. Idempotent at
   * the destination via the (projectId, sessionId) unique index.
   */
  recordSessionStart(args: {
    readonly event: HookEvent;
    readonly projectId: string | undefined;
    readonly mode: 'solo' | 'team';
  }): void;
  /**
   * Enqueue a `runs` close UPDATE when Stop / session_end fires.
   * Idempotent: the dispatcher's WHERE clause is keyed on
   * (projectId, sessionId) with no `status != 'completed'` guard —
   * a double-close stamps the same `endedAt` twice but is harmless.
   */
  recordSessionEnd(args: { readonly event: HookEvent; readonly projectId: string | undefined }): void;
}

export function createRunRecorder(deps: CreateRunRecorderDeps): RunRecorder {
  const kick = deps.kick;
  const mode = deps.mode ?? 'solo';

  /**
   * M04 Phase 2 S1 (F3 root-cause fix). In-memory set of
   * (projectId | __global__) + sessionId tuples we've already opened
   * a synthetic session_open for in this bridge process. First touch
   * fires session_open; subsequent calls skip. Reset on bridge
   * restart — that's OK because the destination INSERT uses
   * ON CONFLICT (projectId, sessionId) DO NOTHING, so a re-fire
   * after restart is a no-op at the runs table.
   *
   * Closes the case where PreToolUse / PostToolUse / UserPromptSubmit
   * fire without a preceding SessionStart (audit-style traffic from
   * the bridge-direct test path, agents that skipped SessionStart, or
   * just events that arrived before SessionStart due to ordering).
   * Pre-fix: every such event landed with `run_id=NULL` because the
   * dispatcher's `lookupRunId` couldn't find a runs row.
   */
  const sessionsOpened = new Set<string>();

  function ensureSessionOpenInflight(event: HookEvent, projectId: string | undefined): void {
    const effectiveProjectId = projectId ?? GLOBAL_PROJECT_ID;
    const key = `${effectiveProjectId}|${event.sessionId}`;
    if (sessionsOpened.has(key)) return;
    sessionsOpened.add(key);
    const rowId = generateRunKey({ projectId: effectiveProjectId, sessionId: event.sessionId });
    // M04 Phase 2 S1 (F3 root-cause fix). Direct insertRun (NOT via
    // the durable queue) so the runs row exists synchronously
    // before the subsequent run_event / policy_decision enqueue.
    // Going through the queue produced a race: both rows landed in
    // pending_jobs in the same microsecond, the worker tick picked
    // them up in the same batch, and the dispatcher's lookupRunId
    // for the run_event sometimes ran before the session_open
    // dispatch had inserted the runs row. ON CONFLICT (project_id,
    // session_id) DO NOTHING makes the direct insert idempotent
    // against any later explicit recordSessionStart.
    //
    // The audit trail is the runs row itself + the run_events
    // rows that follow; we do NOT also enqueue a session_open
    // queue payload (that would be wasted work — the dispatcher's
    // INSERT would no-op against the row this function just put
    // in place).
    void insertRun(deps.db, {
      id: rowId,
      projectId: effectiveProjectId,
      sessionId: event.sessionId,
      agentType: event.agentType,
      mode,
    }).catch((err) => {
      recorderLogger.warn(
        {
          event: 'implicit_session_open_insert_failed',
          sessionId: event.sessionId,
          projectId: effectiveProjectId,
          err: err instanceof Error ? err.message : String(err),
        },
        'implicit session_open direct insertRun threw; swallowing — run_event may end up with NULL run_id',
      );
      sessionsOpened.delete(key);
    });
  }

  /**
   * Hash the (sessionId, turnId, phase) triple as the row id.
   * Architecture §4.3 specifies `{sessionId}-{toolUseId}-{phase}`
   * but `normalizeSessionId` emits hyphen-rich session ids by
   * design, so the hash captures the uniqueness contract while
   * accepting any input. Prefix `re_` is grep-friendly in audit
   * dumps.
   */
  function buildRunEventId(sessionId: string, turnId: string | undefined, phase: string): string {
    const hash = createHash('sha256');
    hash.update(sessionId);
    hash.update('|');
    hash.update(turnId ?? 'no-turn');
    hash.update('|');
    hash.update(phase);
    return `re_${hash.digest('hex').slice(0, 32)}`;
  }

  function enqueueRunEvent(args: {
    readonly event: HookEvent;
    readonly phase: string;
    readonly logEvent: string;
    readonly projectId: string | undefined;
  }): void {
    const rowId = buildRunEventId(args.event.sessionId, args.event.turnId, args.phase);
    const effectiveProjectId = args.projectId ?? GLOBAL_PROJECT_ID;
    const resolution: RunIdResolution = {
      kind: 'session_lookup',
      sessionId: args.event.sessionId,
      projectId: effectiveProjectId,
    };
    const payload: RunEventPayloadV1 = {
      v: 1,
      rowId,
      resolution,
      phase: args.phase,
      toolName: args.event.toolName,
      toolUseId: args.event.turnId ?? 'no-turn',
      toolInput: clampToolInput(args.event.toolInput),
      outcome: null,
    };
    void scheduleAuditWriteWithSync(deps.db, {
      audit: { queue: 'run_event', payload },
      sync: { table: 'run_events', lookup: { kind: 'id', value: rowId } },
    })
      .then(() => {
        kick?.();
      })
      .catch((err) => {
        recorderLogger.warn(
          {
            event: args.logEvent,
            sessionId: args.event.sessionId,
            toolName: args.event.toolName,
            turnId: args.event.turnId,
            phase: args.phase,
            projectId: args.projectId ?? 'unresolved',
            err: err instanceof Error ? err.message : String(err),
          },
          'run_event durable enqueue threw; swallowing (audit-only path)',
        );
      });
  }

  return {
    recordPostToolUse(event, projectId) {
      // M04 Phase 2 S1 (F3 root-cause fix): defensive session_open
      // before the first event for this (projectId, sessionId).
      // Idempotent at the destination + memoized in-process.
      ensureSessionOpenInflight(event, projectId);
      enqueueRunEvent({ event, phase: 'post', logEvent: 'run_event_enqueue_failed', projectId });
    },
    recordUserPromptSubmit(event, projectId) {
      ensureSessionOpenInflight(event, projectId);
      enqueueRunEvent({
        event,
        phase: 'user_prompt',
        logEvent: 'user_prompt_enqueue_failed',
        projectId,
      });
    },

    recordSessionStart({ event, projectId, mode }) {
      // F7 closure (2026-04-27): when no .contextos.json resolved a
      // projectId, fall back to the __global__ sentinel so the runs
      // row still lands. This preserves the audit trail for agents
      // operating in unregistered cwds.
      const effectiveProjectId = projectId ?? GLOBAL_PROJECT_ID;
      // M04 Phase 2 S1 (F3 root-cause fix): mark this session as
      // "opened" so subsequent recordPostToolUse / recordPolicyDecision
      // / recordUserPromptSubmit calls skip the defensive implicit
      // session_open. The explicit recordSessionStart payload below
      // is the authoritative one.
      sessionsOpened.add(`${effectiveProjectId}|${event.sessionId}`);
      // Module 04a finding #9 (2026-04-28): use the canonical
      // `run:{projectId}:{sessionId}:{uuid}` shape so bridge-auto-created
      // runs match the format MCP `get_run_id` produces. Pre-fix the
      // bridge minted bare UUIDs that didn't carry their session
      // affiliation in the id, breaking grep-based audit cross-refs.
      const rowId = generateRunKey({ projectId: effectiveProjectId, sessionId: event.sessionId });
      const payload: SessionOpenPayloadV1 = {
        v: 1,
        rowId,
        projectId: effectiveProjectId,
        sessionId: event.sessionId,
        agentType: event.agentType,
        mode,
      };
      void scheduleAuditWriteWithSync(deps.db, {
        audit: { queue: 'session_open', payload },
        sync: { table: 'runs', lookup: { kind: 'id', value: rowId } },
      })
        .then(() => {
          kick?.();
        })
        .catch((err) => {
          recorderLogger.warn(
            {
              event: 'session_start_enqueue_failed',
              sessionId: event.sessionId,
              projectId: effectiveProjectId,
              fallbackToGlobal: projectId === undefined,
              err: err instanceof Error ? err.message : String(err),
            },
            'session_open durable enqueue threw; swallowing',
          );
        });
    },

    recordSessionEnd({ event, projectId }) {
      const effectiveProjectId = projectId ?? GLOBAL_PROJECT_ID;
      const payload: SessionClosePayloadV1 = {
        v: 1,
        projectId: effectiveProjectId,
        sessionId: event.sessionId,
      };
      // session_close updates the EXISTING runs row (status='completed',
      // ended_at=now). The paired sync uses a project_session lookup so
      // the daemon SELECTs the (now-updated) local runs row at dispatch
      // time and pushes the fresh state to cloud. The cloud INSERT uses
      // ON CONFLICT (project_id, session_id) DO UPDATE so a second push
      // for the same run UPDATES status + ended_at without duplicating.
      void scheduleAuditWriteWithSync(deps.db, {
        audit: { queue: 'session_close', payload },
        sync: {
          table: 'runs',
          lookup: { kind: 'project_session', projectId: effectiveProjectId, sessionId: event.sessionId },
        },
      })
        .then(() => {
          kick?.();
        })
        .catch((err) => {
          recorderLogger.warn(
            {
              event: 'session_end_enqueue_failed',
              sessionId: event.sessionId,
              projectId: effectiveProjectId,
              fallbackToGlobal: projectId === undefined,
              err: err instanceof Error ? err.message : String(err),
            },
            'session_close durable enqueue threw; swallowing',
          );
        });
    },

    recordPolicyDecision({ event, projectId, decision, reason, matchedRuleId }) {
      // M04 Phase 2 S1 (F3 root-cause fix): defensive session_open
      // before the first audit row for this (projectId, sessionId).
      ensureSessionOpenInflight(event, projectId);
      // F7 closure (2026-04-27): no projectId resolved → __global__ FK fallback.
      const effectiveProjectId = projectId ?? GLOBAL_PROJECT_ID;
      const resolution: RunIdResolution = {
        kind: 'session_lookup',
        sessionId: event.sessionId,
        projectId: effectiveProjectId,
      };
      const payload: PolicyDecisionPayloadV1 = {
        v: 1,
        resolution,
        projectId: effectiveProjectId,
        sessionId: event.sessionId,
        agentType: event.agentType,
        eventType: 'PreToolUse',
        toolName: event.toolName,
        // F14 closure (2026-04-27): include toolUseId for the 4-segment key.
        ...(event.turnId !== undefined ? { toolUseId: event.turnId } : {}),
        toolInputSnapshot: clampToolInput(event.toolInput),
        permissionDecision: decision,
        matchedRuleId,
        reason,
      };
      const idempotencyKey = buildPolicyDecisionIdempotencyKey({
        sessionId: event.sessionId,
        ...(event.turnId !== undefined ? { toolUseId: event.turnId } : {}),
        toolName: event.toolName,
        eventType: 'PreToolUse',
      });
      void scheduleAuditWriteWithSync(deps.db, {
        audit: { queue: 'policy_decision', payload },
        sync: { table: 'policy_decisions', lookup: { kind: 'idempotency_key', value: idempotencyKey } },
      })
        .then(() => {
          kick?.();
        })
        .catch((err) => {
          recorderLogger.warn(
            {
              event: 'policy_decision_enqueue_failed',
              sessionId: event.sessionId,
              toolName: event.toolName,
              eventType: 'PreToolUse',
              matchedRuleId,
              projectId: effectiveProjectId,
              err: err instanceof Error ? err.message : String(err),
            },
            'policy_decision durable enqueue threw; swallowing (audit-only path)',
          );
        });
    },
  };
}
