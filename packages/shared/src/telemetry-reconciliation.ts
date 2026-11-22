/**
 * COOD-105 — reconcile tool operations observed by Coodra's hooks against the same session's
 * native harness telemetry. Pure: no I/O, no clock (callers pass `now`). Reusable by the web
 * UI today and by other adapters (Codex) once they supply their own telemetry rows.
 *
 * The unit of comparison is ONE native tool-use id. Session or time proximity never establishes
 * a match; an operation with no usable native id is reported as `not_comparable` with a reason,
 * never folded into another operation.
 *
 * Statuses:
 *  - `matched`           both channels saw the operation (agreement is reported separately)
 *  - `hook_only`         hooks saw it, no telemetry result, and the grace window has passed
 *  - `telemetry_only`    telemetry saw it, no hook rows, and the grace window has passed
 *  - `awaiting_arrival`  one side is missing but the grace window has not passed yet
 *  - `not_comparable`    the data cannot support a comparison (see `reason`)
 *
 * Absence is never proof. Native export is best effort and can drop data, and the hook channel
 * does not fire for every failure mode, so `hook_only` and `telemetry_only` are observations of
 * disagreement between channels, not findings about what actually executed.
 */

export type ReconciliationStatus = 'matched' | 'hook_only' | 'telemetry_only' | 'awaiting_arrival' | 'not_comparable';

export type NotComparableReason =
  | 'hook_key_without_native_id'
  | 'telemetry_without_tool_use_id'
  | 'telemetry_channel_not_observed'
  | 'harness_telemetry_unsupported';

export type DisagreementCode =
  /** Telemetry reports success but the hook channel has a PreToolUse and no PostToolUse. */
  | 'post_hook_missing'
  /** Telemetry reports failure but the hook channel recorded a PostToolUse. */
  | 'post_hook_after_failure'
  /** The hook channel has a PostToolUse but no PreToolUse. */
  | 'pre_hook_missing';

export interface HookObservation {
  /** `run_events.id`, kept as an evidence reference. */
  readonly rowId: string;
  readonly phase: 'pre' | 'post';
  readonly toolName: string;
  /** Coodra's stored key; for Claude Code it ends in `:<native tool_use_id>`. */
  readonly toolUseId: string;
  /** Policy outcome recorded by the hook (`allow` | `deny` | `ask` | null). Not execution status. */
  readonly outcome: string | null;
  readonly atMs: number;
}

export interface TelemetryToolResult {
  /** Row id in `native_telemetry_events`, kept as an evidence reference. */
  readonly evidenceId: string;
  readonly toolUseId: string | null;
  readonly toolName: string | null;
  /** Native execution status; null when the source did not report it. */
  readonly success: boolean | null;
  readonly durationMs: number | null;
  readonly sourceMs: number;
  readonly receivedMs: number;
}

export interface ReconcileInput {
  readonly harness: string;
  readonly hooks: ReadonlyArray<HookObservation>;
  readonly telemetry: ReadonlyArray<TelemetryToolResult>;
  /** Count of ALL accepted telemetry events for the session, any type. 0 = channel never observed. */
  readonly telemetryEventCount: number;
  /** Whether a Run exists for the session (hook rows can only exist when it does). */
  readonly hasRun: boolean;
  /** True once the Run has completed; closes the grace window immediately. */
  readonly runEnded: boolean;
  readonly nowMs: number;
  /** How long a one-sided operation may still be in flight. Default 120 s. */
  readonly graceMs?: number;
}

export interface ReconciledOperation {
  /** Native tool-use id, or null when `not_comparable` for lack of one. */
  readonly nativeToolUseId: string | null;
  readonly toolName: string | null;
  readonly status: ReconciliationStatus;
  readonly reason?: NotComparableReason;
  readonly disagreements: ReadonlyArray<DisagreementCode>;
  /** Informational: telemetry and hook tool names are both present and differ. */
  readonly toolNameDiffers: boolean;
  readonly hook: {
    readonly pre: boolean;
    readonly post: boolean;
    readonly outcome: string | null;
    readonly firstAtMs: number | null;
    /** `run_events.id` of each contributing hook row. */
    readonly rowIds: ReadonlyArray<string>;
  } | null;
  readonly telemetry: {
    readonly evidenceId: string;
    readonly success: boolean | null;
    readonly durationMs: number | null;
    readonly sourceMs: number;
    /** More than one telemetry row carried this id (distinct occurrences are kept, not merged). */
    readonly occurrences: number;
  } | null;
}

export interface ReconcileSummary {
  readonly matched: number;
  readonly hookOnly: number;
  readonly telemetryOnly: number;
  readonly awaitingArrival: number;
  readonly notComparable: number;
  /** Matched operations where the channels disagree about how it went. */
  readonly matchedWithDisagreement: number;
  readonly total: number;
}

export interface ReconcileResult {
  readonly operations: ReadonlyArray<ReconciledOperation>;
  readonly summary: ReconcileSummary;
  /** Plain-language caveats that apply to this result. Always shown with it. */
  readonly limitations: ReadonlyArray<string>;
}

export const DEFAULT_GRACE_MS = 120_000;

/**
 * Coodra's hook key for Claude Code: `lifecycle_event:<harness>:<session>:<Event>:<tool>:<native id>`.
 * The native id is the final segment. Returns null for any key that does not have that shape, so a
 * key without a usable native id is surfaced as not comparable rather than guessed at.
 */
export function nativeToolUseIdFromHookKey(key: string, harness: string): string | null {
  const prefix = `lifecycle_event:${harness}:`;
  if (!key.startsWith(prefix)) return null;
  const parts = key.slice(prefix.length).split(':');
  // <session>:<Event>:<tool>:<native id> — at least four segments, tool names can't be empty.
  if (parts.length < 4) return null;
  const native = parts[parts.length - 1] ?? '';
  const event = parts[parts.length - 3] ?? '';
  if (native.length === 0 || (event !== 'PreToolUse' && event !== 'PostToolUse')) return null;
  return native;
}

interface HookGroup {
  toolName: string;
  pre: boolean;
  post: boolean;
  outcome: string | null;
  firstAtMs: number;
  lastAtMs: number;
  rowIds: string[];
}

export function reconcileToolOperations(input: ReconcileInput): ReconcileResult {
  const grace = input.graceMs ?? DEFAULT_GRACE_MS;
  const limitations: string[] = [
    'Native telemetry export is best effort and can drop data before Coodra receives it; a missing telemetry row is not proof the operation did not run.',
    'The hook channel records policy outcomes, not execution results; execution status comes only from telemetry.',
  ];
  const operations: ReconciledOperation[] = [];

  const harnessSupported = input.harness === 'claude_code';
  if (!harnessSupported) {
    limitations.push(
      `No native telemetry adapter exists for harness "${input.harness}"; its operations cannot be compared.`,
    );
  }
  if (!input.hasRun) {
    limitations.push('No Run exists for this session, so there are no hook records to compare against.');
  }
  if (input.telemetryEventCount === 0) {
    limitations.push(
      'No native telemetry was received for this session; the telemetry channel may be disabled or unreachable.',
    );
  }

  // ---- group the hook side by native id -------------------------------------------------------
  const groups = new Map<string, HookGroup>();
  let unkeyed = 0;
  for (const hook of input.hooks) {
    const native = nativeToolUseIdFromHookKey(hook.toolUseId, input.harness);
    if (native === null) {
      unkeyed += 1;
      operations.push({
        nativeToolUseId: null,
        toolName: hook.toolName,
        status: 'not_comparable',
        reason: 'hook_key_without_native_id',
        disagreements: [],
        toolNameDiffers: false,
        hook: {
          pre: hook.phase === 'pre',
          post: hook.phase === 'post',
          outcome: hook.outcome,
          firstAtMs: hook.atMs,
          rowIds: [hook.rowId],
        },
        telemetry: null,
      });
      continue;
    }
    const g = groups.get(native);
    if (g === undefined) {
      groups.set(native, {
        toolName: hook.toolName,
        pre: hook.phase === 'pre',
        post: hook.phase === 'post',
        outcome: hook.outcome,
        firstAtMs: hook.atMs,
        lastAtMs: hook.atMs,
        rowIds: [hook.rowId],
      });
    } else {
      if (hook.phase === 'pre') {
        g.pre = true;
        // The policy verdict is recorded on the pre row.
        g.outcome = hook.outcome ?? g.outcome;
      } else {
        g.post = true;
      }
      g.rowIds.push(hook.rowId);
      g.firstAtMs = Math.min(g.firstAtMs, hook.atMs);
      g.lastAtMs = Math.max(g.lastAtMs, hook.atMs);
    }
  }
  if (unkeyed > 0) {
    limitations.push(
      `${unkeyed} hook record(s) have no native tool-use id in their key, so they cannot be matched to telemetry and are reported separately instead of being merged.`,
    );
  }

  // ---- group the telemetry side by native id --------------------------------------------------
  const telemetryById = new Map<string, TelemetryToolResult[]>();
  for (const row of input.telemetry) {
    if (row.toolUseId === null) {
      operations.push({
        nativeToolUseId: null,
        toolName: row.toolName,
        status: 'not_comparable',
        reason: 'telemetry_without_tool_use_id',
        disagreements: [],
        toolNameDiffers: false,
        hook: null,
        telemetry: {
          evidenceId: row.evidenceId,
          success: row.success,
          durationMs: row.durationMs,
          sourceMs: row.sourceMs,
          occurrences: 1,
        },
      });
      continue;
    }
    const list = telemetryById.get(row.toolUseId);
    if (list === undefined) telemetryById.set(row.toolUseId, [row]);
    else list.push(row);
  }

  // ---- join on the native id ------------------------------------------------------------------
  const ids = new Set<string>([...groups.keys(), ...telemetryById.keys()]);
  for (const id of ids) {
    const hook = groups.get(id) ?? null;
    const tele = telemetryById.get(id) ?? null;
    const first = tele?.slice().sort((a, b) => a.sourceMs - b.sourceMs)[0] ?? null;
    const hookView =
      hook === null
        ? null
        : { pre: hook.pre, post: hook.post, outcome: hook.outcome, firstAtMs: hook.firstAtMs, rowIds: hook.rowIds };
    const teleView =
      first === null
        ? null
        : {
            evidenceId: first.evidenceId,
            success: first.success,
            durationMs: first.durationMs,
            sourceMs: first.sourceMs,
            occurrences: tele?.length ?? 1,
          };
    const toolName = hook?.toolName ?? first?.toolName ?? null;
    const toolNameDiffers =
      hook !== null && first !== null && first.toolName !== null && hook.toolName !== first.toolName;

    if (!harnessSupported) {
      operations.push({
        nativeToolUseId: id,
        toolName,
        status: 'not_comparable',
        reason: 'harness_telemetry_unsupported',
        disagreements: [],
        toolNameDiffers,
        hook: hookView,
        telemetry: teleView,
      });
      continue;
    }

    if (hook !== null && first !== null) {
      const disagreements: DisagreementCode[] = [];
      if (first.success === true && hook.pre && !hook.post) disagreements.push('post_hook_missing');
      if (first.success === false && hook.post) disagreements.push('post_hook_after_failure');
      if (hook.post && !hook.pre) disagreements.push('pre_hook_missing');
      operations.push({
        nativeToolUseId: id,
        toolName,
        status: 'matched',
        disagreements,
        toolNameDiffers,
        hook: hookView,
        telemetry: teleView,
      });
      continue;
    }

    if (hook !== null) {
      // Hooks only. With no telemetry for the whole session this is not a disagreement, it is a
      // missing channel.
      if (input.telemetryEventCount === 0) {
        operations.push({
          nativeToolUseId: id,
          toolName,
          status: 'not_comparable',
          reason: 'telemetry_channel_not_observed',
          disagreements: [],
          toolNameDiffers: false,
          hook: hookView,
          telemetry: null,
        });
        continue;
      }
      const open = !input.runEnded && input.nowMs - hook.lastAtMs < grace;
      operations.push({
        nativeToolUseId: id,
        toolName,
        status: open ? 'awaiting_arrival' : 'hook_only',
        disagreements: [],
        toolNameDiffers: false,
        hook: hookView,
        telemetry: null,
      });
      continue;
    }

    // Telemetry only.
    const receivedMs = Math.max(...(tele ?? []).map((t) => t.receivedMs));
    const open = !input.runEnded && input.hasRun && input.nowMs - receivedMs < grace;
    operations.push({
      nativeToolUseId: id,
      toolName,
      status: open ? 'awaiting_arrival' : 'telemetry_only',
      disagreements: [],
      toolNameDiffers: false,
      hook: null,
      telemetry: teleView,
    });
  }

  operations.sort(
    (a, b) => (a.hook?.firstAtMs ?? a.telemetry?.sourceMs ?? 0) - (b.hook?.firstAtMs ?? b.telemetry?.sourceMs ?? 0),
  );

  const count = (status: ReconciliationStatus) => operations.filter((o) => o.status === status).length;
  const summary: ReconcileSummary = {
    matched: count('matched'),
    hookOnly: count('hook_only'),
    telemetryOnly: count('telemetry_only'),
    awaitingArrival: count('awaiting_arrival'),
    notComparable: count('not_comparable'),
    matchedWithDisagreement: operations.filter((o) => o.status === 'matched' && o.disagreements.length > 0).length,
    total: operations.length,
  };
  return { operations, summary, limitations };
}
