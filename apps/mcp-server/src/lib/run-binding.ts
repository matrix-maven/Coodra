/**
 * `apps/mcp-server/src/lib/run-binding` — COOD-79 follow-up.
 *
 * Binds a **transport** session to the **agent** run it is serving, so
 * pull telemetry can attribute a tool call to the run that made it.
 *
 * ## The gap this closes
 *
 * `ctx.sessionId` is minted by the transport — `stdio-<uuid>` in
 * `index.ts`, per-connection on HTTP. `runs.session_id` holds the
 * AGENT's session id, written by the lifecycle push path from the hook
 * payload. The two are different namespaces, so
 * `lookupRunId(projectId, ctx.sessionId)` never matches and COOD-80's
 * attribution chain writes `run_id = NULL` on every pull.
 *
 * `memory_cohorts` requires `run_id IS NOT NULL`, so pulls never joined
 * the cohort their own manifest push created: pull-through rate had a
 * denominator and no numerator, permanently reading zero.
 *
 * ## Why the fix is a binding and not a lookup
 *
 * There is no derivation from `stdio-<uuid>` to an agent session — the
 * id is random and carries nothing. But the agent already holds its
 * canonical run id: the SessionStart manifest injects
 * ``Run id: `run:{projectId}:{sessionId}:{uuid}` `` into its context,
 * and the agent hands that id back on every attribution tool it calls.
 * Those calls arrive on the SAME transport connection the pull tools
 * use, so one of them is enough to learn the mapping for the rest of
 * the session.
 *
 * The hook path cannot supply it: `command-hook-runner` spawns its own
 * short-lived MCP child per hook, with its own `initialize` and its own
 * `stdio-<uuid>`. Push and pull are different processes, which is why
 * an in-process map has to be fed by agent-initiated calls.
 *
 * ## What may and may not bind
 *
 * Only tools where `runId` means *"this is who I am"*. COOD-80's
 * central constraint is that the same field name means different
 * things on different tools — on `query_decisions`, `runId` is
 * documented as "Optional narrower filter to a single run", so an agent
 * searching another run's history would bind this session to that run
 * and misattribute every later pull. {@link RUN_BINDING_SOURCES} is an
 * explicit allowlist for exactly that reason; adding a tool to it is a
 * claim that its `runId` is identity, not a filter.
 *
 * Binding is captured only from a call that SUCCEEDED. `record_decision`
 * and `save_context_pack` return `{ ok: false, error: 'run_not_found' }`
 * for an id that names no row, so an agent cannot bind this session to a
 * fabricated run by asking for one — the id is validated by the handler
 * before it is ever trusted here.
 */

/** Where a canonical run id may be read from, and out of which field. */
type BindingSource =
  | { readonly from: 'output'; readonly field: 'runId' }
  | { readonly from: 'input'; readonly field: 'runId' };

/**
 * Tools whose `runId` is attribution rather than a retrieval filter.
 *
 * `get_run_id` is the minting point — its OUTPUT is the run this
 * session is, by definition. The other two require the caller to name
 * the run it is writing on behalf of, and reject an unknown one.
 *
 * Deliberately absent: `query_decisions`, `query_run_history`,
 * `query_run_diff`, `read_context_pack` — on all of these `runId` is a
 * filter naming a run the caller wants to read ABOUT, frequently not
 * its own.
 */
const RUN_BINDING_SOURCES: Readonly<Record<string, BindingSource>> = {
  get_run_id: { from: 'output', field: 'runId' },
  record_decision: { from: 'input', field: 'runId' },
  save_context_pack: { from: 'input', field: 'runId' },
};

/**
 * Cap on remembered sessions.
 *
 * stdio is one session per process and never approaches this. HTTP
 * serves many connections from one long-lived daemon, and an unbounded
 * map there is a leak that grows for as long as the daemon is up —
 * which, for a daemon meant to run for weeks, is the whole point of the
 * bound. Eviction is oldest-insertion-first, which for this access
 * pattern (a session binds once, early, then reads) is close enough to
 * LRU to not be worth a heavier structure.
 */
const MAX_TRACKED_SESSIONS = 512;

export interface RunBindingRegistry {
  /**
   * Learn the mapping from a completed tool call. No-op for a tool that
   * is not an attribution source, or a call that did not succeed.
   */
  observe(args: {
    readonly sessionId: string;
    readonly toolName: string;
    readonly input: unknown;
    readonly output: unknown;
  }): void;
  /** The run this transport session is serving, if one is known yet. */
  resolve(sessionId: string): string | null;
  /** Bound sessions currently tracked. Exposed for logging and tests. */
  size(): number;
}

function readStringField(source: unknown, field: string): string | null {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return null;
  const value = (source as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A call counts as successful when it did not report `ok: false`.
 *
 * Tools in the allowlist all return a discriminated `ok`, but treating
 * a missing `ok` as success rather than failure keeps this from
 * silently going dead if one of them ever returns a bare shape.
 */
function succeeded(output: unknown): boolean {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return false;
  return (output as { ok?: unknown }).ok !== false;
}

export function createRunBindingRegistry(): RunBindingRegistry {
  const bySession = new Map<string, string>();

  return {
    observe({ sessionId, toolName, input, output }) {
      const source = RUN_BINDING_SOURCES[toolName];
      if (source === undefined) return;
      if (!succeeded(output)) return;

      const runId = readStringField(source.from === 'output' ? output : input, source.field);
      if (runId === null) return;

      // Re-binding is allowed and intentional: a resumed session, or an
      // agent that switches projects mid-session, should attribute to
      // the run it most recently asserted rather than the first one it
      // ever mentioned. Delete-then-set also refreshes insertion order
      // so an active session is not the one evicted.
      bySession.delete(sessionId);
      bySession.set(sessionId, runId);

      while (bySession.size > MAX_TRACKED_SESSIONS) {
        const oldest = bySession.keys().next();
        if (oldest.done === true) break;
        bySession.delete(oldest.value);
      }
    },

    resolve(sessionId) {
      return bySession.get(sessionId) ?? null;
    },

    size() {
      return bySession.size;
    },
  };
}
