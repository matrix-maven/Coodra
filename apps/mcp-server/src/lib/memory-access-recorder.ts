import { randomUUID } from 'node:crypto';

import type { MemoryAccessPayloadV1 } from '@coodra/cli/lib/outbox';
import {
  type DbHandle,
  freshnessForMemoryIds,
  lookupProjectBySlug,
  lookupRunById,
  lookupRunBySessionId,
  lookupRunId,
  scheduleDurableWrite,
} from '@coodra/db';
import { type Logger, queryHashForTool } from '@coodra/shared';

import { createMcpLogger } from './logger.js';

/**
 * `apps/mcp-server/src/lib/memory-access-recorder` — COOD-80.
 *
 * Records the **pull** half of `memory_access_events`: every time an
 * agent explicitly asks Coodra for a memory item, rather than Coodra
 * pushing one at it.
 *
 * Push only proves Coodra spent tokens. Pull proves the agent wanted
 * the item enough to ask — the first real utilization signal, and the
 * numerator of pull-through rate.
 *
 * ## Three concepts that must not be conflated
 *
 * The single most important constraint in this epic. Today they are
 * partially overloaded through an optional `runId` tool input, and the
 * telemetry layer must not repeat that pattern:
 *
 *   1. **Current-run attribution** — *which run is this call part of?*
 *      A property of the caller's session, never of the tool's
 *      arguments.
 *   2. **Retrieval filter inputs** — *what is the caller asking for?*
 *      `query_decisions.runId` is documented as "Optional narrower
 *      filter to a single run". Telling agents to pass the current run
 *      id so telemetry could read it would **silently change retrieval
 *      semantics**, narrowing every result set to one run.
 *   3. **Item-level access rows** — *what came back, at what rank and
 *      cost?* Extracted from the tool's OUTPUT, never its input.
 *
 * So attribution is resolved here, from
 * `projectSlug` (a scope argument these tools already require, not an
 * attribution field) → `project_id` → `lookupRunId(projectId,
 * sessionId)`. The tool's own `runId` input is never consulted.
 *
 * ## Why a miss writes NULL instead of failing
 *
 * `packages/db/src/lookup-run.ts` records a bug Coodra already shipped
 * once: the bridge's `scheduleRunEventInsert` called its lookup with
 * `projectSlug = undefined`, "a hardcoded short-circuit that made every
 * `run_events` row write `run_id IS NULL`" — silently, for months.
 *
 * The lesson taken here is not "never write NULL" but "never write NULL
 * *silently*". An unattributed pull is still evidence that the agent
 * wanted something, so the row is written with `run_id = NULL` and a
 * counter is incremented, making attribution loss itself observable
 * rather than a hole in the data nobody can see.
 */

const recorderLogger = createMcpLogger('lib-memory-access-recorder');

/** What one tool's output contributes to the log. */
interface ExtractedItems {
  readonly memoryType: string;
  /** Item ids in result order. Empty means "asked, got nothing". */
  readonly ids: readonly string[];
  /** Per-item byte cost, parallel to `ids`. */
  readonly bytes: readonly number[];
  /** Total results the tool reported, which may exceed `ids.length`. */
  readonly resultCount: number;
}

function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Pull an id list out of an array-shaped result field.
 *
 * `idKey` differs per tool (`id` for packs/decisions, `pageId` for wiki
 * pages, `slug` for recipes) because these schemas were designed
 * independently long before this log existed. Normalising them here
 * keeps `memory_id` uniform without touching eight public tool
 * contracts.
 */
function fromArray(output: unknown, field: string, idKey: string, memoryType: string): ExtractedItems | null {
  if (!isObj(output)) return null;
  const arr = output[field];
  if (!Array.isArray(arr)) return null;
  const ids: string[] = [];
  const bytes: number[] = [];
  for (const entry of arr) {
    if (!isObj(entry)) continue;
    const id = entry[idKey];
    if (typeof id !== 'string' || id.length === 0) continue;
    ids.push(id);
    bytes.push(sizeOf(entry));
  }
  return { memoryType, ids, bytes, resultCount: arr.length };
}

/**
 * Per-tool adapters. Keyed by the bare tool name as registered (no
 * `coodra__` prefix).
 *
 * A tool absent from this map is simply not instrumented — push sites
 * (COOD-83/84) and write tools do not belong here.
 */
const PULL_ADAPTERS: Record<string, (output: unknown) => ExtractedItems | null> = {
  read_context_pack: (output) => {
    if (!isObj(output)) return null;
    // Discriminated on `found`; a miss is a real access event with no item.
    if (output.ok !== true) return null;
    if (output.found !== true) return { memoryType: 'context_pack', ids: [], bytes: [], resultCount: 0 };
    const id = output.id;
    if (typeof id !== 'string') return null;
    return { memoryType: 'context_pack', ids: [id], bytes: [sizeOf(output.content)], resultCount: 1 };
  },
  search_packs_nl: (output) => fromArray(output, 'packs', 'id', 'context_pack'),
  list_context_packs: (output) => fromArray(output, 'packs', 'id', 'context_pack'),
  query_decisions: (output) => fromArray(output, 'decisions', 'id', 'decision'),
  query_decisions_by_file: (output) => fromArray(output, 'decisions', 'id', 'decision'),
  wiki_ask: (output) => fromArray(output, 'results', 'pageId', 'wiki_page'),
  list_recipes: (output) => fromArray(output, 'features', 'slug', 'recipe'),
  get_recipe: (output) => {
    if (!isObj(output) || output.ok !== true) return null;
    const slug = output.slug;
    if (typeof slug !== 'string') return null;
    return { memoryType: 'recipe', ids: [slug], bytes: [sizeOf(output.body)], resultCount: 1 };
  },
};

export function isInstrumentedPullTool(toolName: string): boolean {
  return Object.hasOwn(PULL_ADAPTERS, toolName);
}

export interface RecordPullArgs {
  /** Bare registered tool name, e.g. `search_packs_nl`. */
  readonly toolName: string;
  /** Scope argument from the tool input — NOT an attribution field. */
  readonly projectSlug: string | null;
  readonly sessionId: string;
  readonly agentType?: string | null;
  /** Stable per-call key, used to make row ids idempotent under retry. */
  readonly idempotencyKey: string;
  readonly output: unknown;
  /**
   * COOD-102 — the validated tool INPUT, used only to derive
   * `query_hash`. Never stored: the recorder hashes the question field
   * and drops the rest, so a pull row can group repeated questions
   * without the log holding anyone's prose.
   */
  readonly input?: unknown;
  /**
   * The run this transport session has been bound to, from
   * `lib/run-binding`. Consulted only when the (projectSlug, sessionId)
   * chain above comes up empty, which on stdio is always: `sessionId`
   * is a transport-minted `stdio-<uuid>` and can never match
   * `runs.session_id`.
   *
   * This is evidence, not a guess. The agent asserted this exact run id
   * on an earlier attribution call over this same connection, and the
   * handler validated it against a real row before the call succeeded.
   * It is emphatically NOT "the most recent live run for the project" —
   * that would manufacture attributions indistinguishable from real
   * ones and make pull-through quietly wrong rather than visibly low.
   */
  readonly boundRunId?: string | null;
  readonly latencyMs: number;
}

/**
 * COOD-83 — the push side.
 *
 * Simpler than a pull: the caller (the lifecycle handler) already knows
 * the run and project, so there is no attribution chain to walk and no
 * miss to count. What it does carry is the SURFACED side of a cohort —
 * without these rows, `memory_cohorts.surfaced_count` is always zero
 * and pull-through rate has no denominator.
 */
export interface RecordPushArgs {
  readonly site: string;
  readonly triggerType: string;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly projectId: string | null;
  readonly orgId: string | null;
  readonly agentType?: string | null;
  readonly idempotencyKey: string;
  readonly baselineGeneration?: number;
  readonly items: ReadonlyArray<{
    readonly memoryType: string;
    readonly memoryId: string;
    readonly position: number;
    readonly bytes: number;
  }>;
}

export interface MemoryAccessRecorder {
  recordPull(args: RecordPullArgs): Promise<void>;
  recordPush(args: RecordPushArgs): Promise<void>;
  /** Attribution misses since boot — surfaced so silent loss is visible. */
  attributionMisses(): number;
}

export interface CreateMemoryAccessRecorderDeps {
  readonly db: DbHandle;
  /** Optional `worker.kick()` for low-latency drain after enqueue. */
  readonly kick?: () => void;
  readonly logger?: Logger;
}

export function createMemoryAccessRecorder(deps: CreateMemoryAccessRecorderDeps): MemoryAccessRecorder {
  if (!deps?.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createMemoryAccessRecorder: deps.db must be a DbHandle from @coodra/db');
  }
  const log = deps.logger ?? recorderLogger;
  const kick = deps.kick;
  let misses = 0;

  return {
    attributionMisses: () => misses,

    async recordPush(args: RecordPushArgs): Promise<void> {
      // COOD-85: same point-in-time snapshot as the pull path. Grouped
      // by type because packs and decisions live in different tables.
      const freshnessByType = new Map<string, ReadonlyMap<string, string>>();
      for (const type of new Set(args.items.map((item) => item.memoryType))) {
        freshnessByType.set(
          type,
          await freshnessForMemoryIds(
            deps.db,
            type,
            args.items.filter((item) => item.memoryType === type).map((item) => item.memoryId),
          ),
        );
      }

      for (const [i, item] of args.items.entries()) {
        const payload: MemoryAccessPayloadV1 = {
          v: 1,
          rowId: `mae_${args.idempotencyKey}_${item.memoryType}_${i}`,
          resolution: { kind: 'pre_resolved', runId: args.runId },
          channel: 'push',
          site: args.site,
          memoryType: item.memoryType,
          triggerType: args.triggerType,
          orgId: args.orgId,
          projectId: args.projectId,
          sessionId: args.sessionId,
          agentType: args.agentType ?? null,
          memoryId: item.memoryId,
          position: item.position,
          bytes: item.bytes,
          resultCount: args.items.length,
          freshnessStatusAtAccess: freshnessByType.get(item.memoryType)?.get(item.memoryId) ?? 'unverified',
          ...(args.baselineGeneration !== undefined ? { baselineGeneration: args.baselineGeneration } : {}),
        };
        try {
          await scheduleDurableWrite(deps.db, { queue: 'memory_access', payload });
        } catch (err) {
          log.warn(
            {
              event: 'memory_access_push_enqueue_failed',
              site: args.site,
              sessionId: args.sessionId,
              err: err instanceof Error ? err.message : String(err),
            },
            'memory_access push enqueue failed; surfaced row lost',
          );
          return;
        }
      }
      kick?.();
    },

    async recordPull(args: RecordPullArgs): Promise<void> {
      const adapter = PULL_ADAPTERS[args.toolName];
      if (adapter === undefined) return;
      const extracted = adapter(args.output);
      if (extracted === null) return;

      // ---- attribution, resolved from session context only ----------
      let projectId: string | null = null;
      let orgId: string | null = null;
      let runId: string | null = null;
      if (args.projectSlug !== null && args.projectSlug.length > 0) {
        const project = await lookupProjectBySlug(deps.db, args.projectSlug);
        if (project !== null) {
          projectId = project.id;
          orgId = project.orgId ?? null;
          runId = await lookupRunId(deps.db, project.id, args.sessionId);
        }
      } else {
        // `read_context_pack` has no `projectSlug` — its schema is
        // strict with exactly one of packId/runId. Resolving from the
        // session alone keeps the most important pull for manifest
        // pull-through (COOD-83) attributable; without it the cohort
        // rollup, which requires run_id, would never pair a surfaced
        // pack with its own retrieval.
        const bySession = await lookupRunBySessionId(deps.db, args.sessionId);
        if (bySession !== null) {
          runId = bySession.runId;
          projectId = bySession.projectId;
          orgId = bySession.orgId;
        }
      }
      // Last resort before an unattributed row: the run this connection
      // was bound to. On stdio the two lookups above cannot succeed at
      // all, so without this every pull is a miss and `memory_cohorts`
      // — which requires `run_id IS NOT NULL` — never pairs a surfaced
      // item with its own retrieval.
      if (runId === null && typeof args.boundRunId === 'string' && args.boundRunId.length > 0) {
        const bound = await lookupRunById(deps.db, args.boundRunId);
        if (bound !== null) {
          runId = bound.runId;
          projectId = projectId ?? bound.projectId;
          orgId = orgId ?? bound.orgId;
        }
      }
      if (runId === null) {
        misses += 1;
        log.debug(
          {
            event: 'memory_access_attribution_miss',
            tool: args.toolName,
            projectSlug: args.projectSlug,
            sessionId: args.sessionId,
            misses,
          },
          'pull recorded without a run id; row written unattributed',
        );
      }

      // One row per returned item; a zero-result pull still writes a
      // single row with a NULL memory_id, because "the agent asked and
      // got nothing" is exactly the evidence wiki empty-answer rate and
      // "recipe never invoked" are built from.
      const rows: Array<{ memoryId: string | null; position: number | null; bytes: number | null }> =
        extracted.ids.length > 0
          ? extracted.ids.map((id, i) => ({ memoryId: id, position: i, bytes: extracted.bytes[i] ?? null }))
          : [{ memoryId: null, position: null, bytes: null }];

      // COOD-85: snapshot freshness AT ACCESS TIME. Joining it at read
      // time instead would let an item that goes stale next week rewrite
      // how it looked when it was actually surfaced — and "what fraction
      // of surfaced memory had already gone stale?" is a question about
      // the moment of surfacing.
      const freshness = await freshnessForMemoryIds(
        deps.db,
        extracted.memoryType,
        rows.flatMap((r) => (r.memoryId === null ? [] : [r.memoryId])),
      );

      for (const [i, row] of rows.entries()) {
        const payload: MemoryAccessPayloadV1 = {
          v: 1,
          // COOD-97 — a UUID per row, minted HERE at enqueue time.
          //
          // This used to be `mae_${args.idempotencyKey}_${i}`, but the
          // registry's `readonly` idempotency key is derived purely from
          // tool INPUT — `search_packs_nl`'s is project slug plus a
          // 60-char query prefix, and its own comment says collisions
          // are "fine for log-correlation (not dedup-critical)". It was
          // never an event identity. With `insertMemoryAccessEvent`'s
          // ON CONFLICT DO NOTHING, the second access with the same
          // inputs was silently dropped: two sessions running one query
          // wrote one row, and `read_context_pack` — keyed on pack id
          // alone — collapsed EVERY read of a pack, across all sessions,
          // forever. That is the numerator of pull-through.
          //
          // Retry safety is unaffected. The id lives inside the payload
          // that `scheduleDurableWrite` persists to `pending_jobs`, so a
          // redelivered job replays the same id and ON CONFLICT still
          // does its real job: collapsing retries, not distinct events.
          rowId: `mae_${randomUUID()}`,
          // pre_resolved: attribution was settled above from session
          // context. Deferring to dispatch would re-introduce exactly
          // the ambiguity this design removes.
          resolution: { kind: 'pre_resolved', runId },
          channel: 'pull',
          site: args.toolName,
          memoryType: extracted.memoryType,
          triggerType: 'tool_call',
          orgId,
          projectId,
          sessionId: args.sessionId,
          agentType: args.agentType ?? null,
          memoryId: row.memoryId,
          position: row.position,
          bytes: row.bytes,
          // Latency is per CALL, not per item — attributing the whole
          // call's cost to each of N rows would inflate totals N-fold
          // in the daily rollup, so only the first row carries it.
          latencyMs: i === 0 ? args.latencyMs : null,
          resultCount: extracted.resultCount,
          // COOD-102 — lets "40 empty wiki answers" be read as one
          // repeated question rather than 40 distinct gaps. Only the
          // hash lands; see @coodra/shared/query-hash for what that does
          // and does not protect.
          queryHash: queryHashForTool(args.toolName, args.input),
          // Absent from the map means never verified — reported as
          // `unverified`, never silently upgraded to `fresh`.
          freshnessStatusAtAccess: row.memoryId === null ? null : (freshness.get(row.memoryId) ?? 'unverified'),
        };
        try {
          await scheduleDurableWrite(deps.db, { queue: 'memory_access', payload });
        } catch (err) {
          // Telemetry must never break a tool call. The pull already
          // succeeded and its result is on its way to the agent.
          log.warn(
            {
              event: 'memory_access_enqueue_failed',
              tool: args.toolName,
              sessionId: args.sessionId,
              err: err instanceof Error ? err.message : String(err),
            },
            'memory_access enqueue failed; utilization row lost',
          );
          return;
        }
      }
      kick?.();
    },
  };
}
