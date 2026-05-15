import { createHash } from 'node:crypto';
import type {
  PolicyDecisionPayloadV1,
  RunEventPayloadV1,
  RunIdResolution,
  SessionClosePayloadV1,
  SessionOpenPayloadV1,
} from '@coodra/cli/lib/outbox';
import {
  type DbHandle,
  GLOBAL_PROJECT_ID,
  insertRun,
  scheduleAuditWriteWithSync,
  scheduleDurableWrite,
} from '@coodra/db';
import { buildPolicyDecisionIdempotencyKey } from '@coodra/policy';
import { createLogger, generateRunKey } from '@coodra/shared';
import type { HookEvent } from '@coodra/shared/hooks';

/**
 * `apps/hooks-bridge/src/lib/run-recorder` — durable + idempotent
 * audit writer for `run_events`, `runs`, and `policy_decisions`.
 *
 * Module 03.1 — every audit write goes through `pending_jobs` via
 * `scheduleDurableWrite` (the durable outbox). The OutboxWorker
 * (`@coodra/cli/lib/outbox`) drains the queue and applies each
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
 * `@coodra/cli/lib/outbox::dispatcher` performs the
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
  /**
   * Module 04 Phase 4. Resolver for the active human-actor identity.
   * Bridge boot wires `() => getActorIdentity()` so every audit-write
   * path picks up the current user's clerk id from `~/.coodra/
   * config.json`. Returning null → no `createdByUserId` stamped (solo
   * mode + pre-team-join state).
   */
  readonly resolveActorIdentity?: () => { readonly userId: string; readonly orgId: string } | null;
}

export interface RunRecorder {
  /**
   * Enqueue a `run_events` row for a PostToolUse event. Returns
   * synchronously; durability is guaranteed once `scheduleDurableWrite`
   * resolves. Failure is WARN-logged (audit-only path).
   *
   * `projectId` (when defined) lets the dispatcher resolve `runs.id`
   * so the row's `run_id` FK is populated. Pass `undefined` when no
   * project resolves (no `.coodra.json` in cwd) — the dispatcher
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
  const resolveActorIdentity = deps.resolveActorIdentity ?? (() => null);

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
  /**
   * Per-session inflight insertRun promises. The dispatcher's lookupRunId
   * runs against the persisted DB; if the runs row insert hasn't landed
   * yet (Drizzle's INSERT is async), the lookup misses and the event
   * lands with `run_id = NULL`.
   *
   * Storing the promise here lets `enqueueRunEvent` await it before
   * scheduling the audit write, closing the race. Cleared on insert
   * settle (success or failure) so memory can't grow unbounded across a
   * long-lived bridge process.
   */
  const sessionInflightInserts = new Map<string, Promise<unknown>>();

  function ensureSessionOpenInflight(event: HookEvent, projectId: string | undefined): Promise<void> {
    const effectiveProjectId = projectId ?? GLOBAL_PROJECT_ID;
    const key = `${effectiveProjectId}|${event.sessionId}`;
    if (sessionsOpened.has(key)) {
      // Either the insert already completed OR another call is in flight.
      // Return the inflight promise if present, else a resolved promise.
      const inflight = sessionInflightInserts.get(key);
      return inflight !== undefined ? inflight.then(() => undefined).catch(() => undefined) : Promise.resolve();
    }
    sessionsOpened.add(key);
    const rowId = generateRunKey({ projectId: effectiveProjectId, sessionId: event.sessionId });
    // M04 Phase 2 S1 (F3 root-cause fix) + M05/post-cleanup race-close
    // (2026-05-08). Direct insertRun (NOT via the durable queue) so the
    // runs row lands synchronously before the next run_event lookup.
    // ON CONFLICT (project_id, session_id) DO NOTHING makes the direct
    // insert idempotent against any later explicit recordSessionStart.
    //
    // Pre-cleanup the inflight promise was discarded (`void insertRun(...)`)
    // so a fast-arriving PostToolUse could schedule its audit write
    // before the runs row landed → the dispatcher's lookupRunId returned
    // null → run_event landed with `run_id = NULL`. Storing the promise
    // here lets enqueueRunEvent await it.
    const actorIdentity = resolveActorIdentity();
    const insertPromise = insertRun(deps.db, {
      id: rowId,
      projectId: effectiveProjectId,
      sessionId: event.sessionId,
      agentType: event.agentType,
      mode,
      ...(actorIdentity !== null ? { createdByUserId: actorIdentity.userId } : {}),
    })
      .then(async () => {
        // M04 Phase 4 / Phase G+H verification: the implicit session_open
        // path bypasses scheduleAuditWriteWithSync (it inserts the runs
        // row directly to close the F3 race), so it must enqueue the
        // paired sync_to_cloud job by hand. Without this the runs row
        // lives only in local SQLite and every dependent FK push
        // (run_events, policy_decisions, decisions, context_packs)
        // fails forever against cloud Postgres.
        recorderLogger.info(
          {
            event: 'implicit_session_open_completed',
            sessionId: event.sessionId,
            projectId: effectiveProjectId,
            rowId,
            mode,
          },
          'implicit session_open insertRun completed; team-mode sync enqueue next',
        );
        if (mode === 'team') {
          try {
            // CRITICAL: insertRun uses ON CONFLICT(projectId, sessionId)
            // DO NOTHING — when a runs row already exists for this
            // (projectId, sessionId), the freshly-minted `rowId` was
            // never inserted; the existing row keeps its old id. Using
            // `kind: 'id'` here would point dispatch at a non-existent
            // local row. Use `project_session` so dispatch resolves the
            // canonical row regardless of which id ended up winning.
            const result = await scheduleDurableWrite(deps.db, {
              queue: 'sync_to_cloud',
              payload: {
                v: 1 as const,
                table: 'runs',
                lookup: { kind: 'project_session', projectId: effectiveProjectId, sessionId: event.sessionId },
              },
            });
            recorderLogger.info(
              {
                event: 'implicit_session_open_sync_enqueued',
                sessionId: event.sessionId,
                projectId: effectiveProjectId,
                rowId,
                jobId: result.id,
              },
              'sync_to_cloud runs job enqueued successfully',
            );
          } catch (err) {
            recorderLogger.warn(
              {
                event: 'implicit_session_open_sync_enqueue_failed',
                sessionId: event.sessionId,
                projectId: effectiveProjectId,
                err: err instanceof Error ? err.message : String(err),
              },
              'sync_to_cloud enqueue threw after implicit insertRun — runs row will not reach cloud until next session_open',
            );
          }
        }
      })
      .catch((err) => {
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
    sessionInflightInserts.set(key, insertPromise);
    void insertPromise.finally(() => {
      // Drop the entry so the map doesn't grow without bound. Future
      // calls for this same (project, session) will see `sessionsOpened`
      // already true and short-circuit.
      sessionInflightInserts.delete(key);
    });
    return insertPromise.then(() => undefined).catch(() => undefined);
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
    // Race-close (2026-05-08): wait for any inflight implicit
    // session_open insert for this (projectId, sessionId) before the
    // audit write goes onto the queue. Otherwise the outbox dispatch
    // can fire its lookupRunId before the runs row exists, and the
    // event lands with run_id=NULL. The wait is at most a few ms in
    // the slow case (insertRun is a single-row UPSERT against local
    // SQLite); in the fast case the inflight map is empty and the
    // wait is a resolved-promise no-op.
    const inflightKey = `${effectiveProjectId}|${args.event.sessionId}`;
    const inflight = sessionInflightInserts.get(inflightKey);
    const wait = inflight !== undefined ? inflight.then(() => undefined).catch(() => undefined) : Promise.resolve();

    void wait
      .then(() =>
        scheduleAuditWriteWithSync(deps.db, {
          audit: { queue: 'run_event', payload },
          sync: { table: 'run_events', lookup: { kind: 'id', value: rowId } },
        }),
      )
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
      // F7 closure (2026-04-27): when no .coodra.json resolved a
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
      const actorIdentity = resolveActorIdentity();
      const payload: SessionOpenPayloadV1 = {
        v: 1,
        rowId,
        projectId: effectiveProjectId,
        sessionId: event.sessionId,
        agentType: event.agentType,
        mode,
        ...(actorIdentity !== null ? { createdByUserId: actorIdentity.userId } : {}),
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
