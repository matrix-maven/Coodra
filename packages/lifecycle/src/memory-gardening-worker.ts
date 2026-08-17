import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  type DbHandle,
  type MemoryFreshnessStatus,
  markContextPackFreshness,
  markDecisionFreshness,
  sqliteSchema,
} from '@coodra/db';
import { createLogger, isElidedPath, looksLikeFilePath } from '@coodra/shared';
import { eq } from 'drizzle-orm';

/**
 * `packages/lifecycle/src/memory-gardening-worker` — COOD-86.
 *
 * The DB analogue of OpenAI's doc-gardening agent: a background pass
 * that looks for memory which no longer describes the code, and says so.
 *
 * Coodra had no equivalent. COOD-58's supersede edges only exist when
 * an agent volunteers one, so packs referencing `apps/hooks-bridge`
 * stayed authoritative for weeks after COOD-67 deleted that tree.
 * Ranking a stale pack into position 1 is worse than not retrieving it
 * at all, which is why this runs before COOD-87 reports a stale share.
 *
 * ## It marks and proposes. It never rewrites.
 *
 * The hard constraint. Gardening updates `freshness_status` and
 * `stale_reason` and nothing else — it never edits pack content,
 * decision text, or rationale. Memory the user did not write and cannot
 * see changing is worse than stale memory: at least stale memory is
 * still what somebody actually decided.
 *
 * ## How staleness is detected without a new authoring contract
 *
 * `verified_against_files` is the eventual mechanism, but nothing
 * populates it yet — so a gardener that only read that column would
 * find nothing and report everything clean, which is the most
 * dangerous possible answer.
 *
 * Instead this pass derives dependencies from what already exists:
 *
 *   - **Decisions** — `decision_edges` rows with `target_type='file'`.
 *     There are real ones (113 in the author's local DB at time of
 *     writing), written by `record_decision`'s `impact` array.
 *   - **Context packs** — repo-relative paths mentioned in the pack
 *     body. Coarse, but it is exactly what catches the motivating case:
 *     a pack that talks about `apps/hooks-bridge/src/index.ts` when
 *     that file no longer exists.
 *
 * A path that no longer resolves marks the artifact `stale` with
 * `files_deleted:`. Existence is the only check made here: "this file
 * changed" needs a commit baseline the artifacts do not yet carry, and
 * guessing would produce false staleness — worse than none, because it
 * would train people to ignore the flag.
 *
 * ## Audit note on graph-node references (COOD-86 AC)
 *
 * `decision_edges` CAN hold `target_type='graph_node'` with
 * path-derived Graphify ids, which would dangle silently on any rename.
 * Audited: those rows only appear when an agent explicitly writes
 * `graph_node:<id>` in `impact` — bare strings default to `file` — and
 * the live database contains **zero** of them. The risk is latent, not
 * accumulating, so no migration is warranted. If they ever appear, the
 * fix is to resolve them at read time and record the outcome rather
 * than treating them as foreign keys.
 */

const gardenLogger = createLogger('lifecycle.memory-gardening');

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Bounded so one pass cannot stall the daemon on a huge project. */
const DEFAULT_BATCH = 200;

/**
 * Repo-ROOTED paths inside pack prose.
 *
 * The prefix list is deliberately short, and the omissions are the
 * important part. An earlier version also accepted `src/`,
 * `__tests__/` and `scripts/` — and on this repo's real packs that
 * produced a ~20% false-stale rate, because prose overwhelmingly
 * writes those package-relative: a pack says `src/run-diff-runner.ts`
 * meaning `packages/lifecycle/src/run-diff-runner.ts`, and
 * `__tests__/unit/claude-permissions.test.ts` meaning the one under
 * `packages/db/`. Neither resolves from the repo root, so both were
 * reported deleted while sitting happily on disk.
 *
 * Only `apps/`, `packages/` and `docs/` are unambiguously rooted in a
 * pnpm workspace. Fewer detections, but every one is trustworthy —
 * and a staleness flag that cries wolf is worse than no flag, because
 * people learn to ignore it and then miss the real ones.
 */
const PATH_PATTERN = /\b((?:apps|packages|docs)\/[A-Za-z0-9._\-/]+\.(?:ts|tsx|js|mjs|json|sql|md|py))\b/g;

/**
 * COOD-90 moved the real fix upstream: `record_decision` now classifies
 * each `impact` entry, so prose lands as `target_type = 'concept'` and
 * never reaches the `'file'` query below. The shared `looksLikeFilePath`
 * is the same predicate the writer uses.
 *
 * It is still applied here, as defence in depth rather than as the
 * primary filter. Rows predating the backfill, or written by a teammate
 * running an older client against a shared Postgres, can still carry
 * prose under `'file'` — and the cost of being wrong is asymmetric: a
 * skipped check loses one freshness verdict, while a bogus one reports
 * code deleted that never existed. On this repo that mistake accounted
 * for 5 of 8 stale decisions, all spurious.
 */

export function extractReferencedPaths(text: string, limit = 20): readonly string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_PATTERN)) {
    const path = match[1];
    if (path !== undefined && !isElidedPath(path)) found.add(path);
    if (found.size >= limit) break;
  }
  return [...found];
}

async function exists(projectCwd: string, relPath: string): Promise<boolean> {
  try {
    await access(isAbsolute(relPath) ? relPath : join(projectCwd, relPath));
    return true;
  } catch {
    return false;
  }
}

export interface MemoryGardeningResult {
  readonly packsChecked: number;
  readonly packsMarkedStale: number;
  readonly decisionsChecked: number;
  readonly decisionsMarkedStale: number;
}

const EMPTY: MemoryGardeningResult = {
  packsChecked: 0,
  packsMarkedStale: 0,
  decisionsChecked: 0,
  decisionsMarkedStale: 0,
};

export interface MemoryGardeningOptions {
  readonly db: DbHandle;
  readonly projectCwd: string;
  readonly projectId: string;
  readonly batchSize?: number;
  /** Test seam — defaults to a real filesystem check. */
  readonly pathExists?: (projectCwd: string, relPath: string) => Promise<boolean>;
}

/**
 * One gardening pass over a project's packs and decisions.
 *
 * Idempotent: re-running re-derives the same verdicts. An artifact that
 * was marked stale and then had its file restored flips back to
 * `fresh`, because a verdict that could only ever get worse would drift
 * from reality in the one direction nobody would notice.
 */
export async function runMemoryGardeningOnce(opts: MemoryGardeningOptions): Promise<MemoryGardeningResult> {
  const { db, projectCwd, projectId } = opts;
  if (db.kind !== 'sqlite') return EMPTY;
  const batch = opts.batchSize ?? DEFAULT_BATCH;
  const pathExists = opts.pathExists ?? exists;

  let packsChecked = 0;
  let packsMarkedStale = 0;
  let decisionsChecked = 0;
  let decisionsMarkedStale = 0;

  try {
    // ---- context packs: paths mentioned in the body ----------------
    const packs = await db.db
      .select({
        id: sqliteSchema.contextPacks.id,
        content: sqliteSchema.contextPacks.content,
        freshnessStatus: sqliteSchema.contextPacks.freshnessStatus,
      })
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.projectId, projectId))
      .limit(batch);

    for (const pack of packs) {
      const referenced = extractReferencedPaths(pack.content);
      if (referenced.length === 0) {
        // Nothing verifiable. If a previous, looser pass left a verdict
        // here, retract it — a stale mark nobody can re-derive is a
        // claim we can no longer support.
        if (pack.freshnessStatus !== 'unverified') {
          await markContextPackFreshness(db, pack.id, { status: 'unverified', staleReason: null });
        }
        continue;
      }
      packsChecked += 1;

      const missing: string[] = [];
      for (const path of referenced) {
        if (!(await pathExists(projectCwd, path))) missing.push(path);
      }

      const status: MemoryFreshnessStatus = missing.length > 0 ? 'stale' : 'fresh';
      if (status === 'stale') packsMarkedStale += 1;
      await markContextPackFreshness(db, pack.id, {
        status,
        staleReason: missing.length > 0 ? `files_deleted:${missing.slice(0, 5).join(',')}` : null,
        verifiedAgainstFiles: referenced,
      });
    }

    // ---- decisions: file targets from decision_edges ---------------
    const edges = await db.db
      .select({
        decisionId: sqliteSchema.decisionEdges.fromDecisionId,
        targetId: sqliteSchema.decisionEdges.targetId,
      })
      .from(sqliteSchema.decisionEdges)
      .where(eq(sqliteSchema.decisionEdges.targetType, 'file'))
      .limit(batch * 5);

    const filesByDecision = new Map<string, string[]>();
    for (const edge of edges) {
      const list = filesByDecision.get(edge.decisionId) ?? [];
      list.push(edge.targetId);
      filesByDecision.set(edge.decisionId, list);
    }

    for (const [decisionId, rawTargets] of filesByDecision) {
      const files = rawTargets.filter(looksLikeFilePath);
      if (files.length === 0) {
        // Prose targets, nothing verifiable. Retract any verdict a
        // previous, looser pass left behind — same rule as packs. The
        // /memory dashboard is what caught this asymmetry: it showed 7
        // stale decisions where the current logic marks 2, the other
        // five being fossils of an earlier calibration.
        await markDecisionFreshness(db, decisionId, { status: 'unverified', staleReason: null });
        continue;
      }
      decisionsChecked += 1;
      const missing: string[] = [];
      for (const path of files) {
        if (!(await pathExists(projectCwd, path))) missing.push(path);
      }
      const status: MemoryFreshnessStatus = missing.length > 0 ? 'stale' : 'fresh';
      if (status === 'stale') decisionsMarkedStale += 1;
      await markDecisionFreshness(db, decisionId, {
        status,
        staleReason: missing.length > 0 ? `files_deleted:${missing.slice(0, 5).join(',')}` : null,
        verifiedAgainstFiles: files,
      });
    }
  } catch (err) {
    // Swallowed like every other maintenance pass: gardening must never
    // take down the daemon or disturb a live session.
    gardenLogger.warn(
      { event: 'memory_gardening_error', projectId, err: err instanceof Error ? err.message : String(err) },
      'gardening pass threw; will retry on the next interval',
    );
  }

  const result = { packsChecked, packsMarkedStale, decisionsChecked, decisionsMarkedStale };
  if (packsMarkedStale > 0 || decisionsMarkedStale > 0) {
    gardenLogger.info(
      { event: 'memory_gardening_pass', projectId, ...result },
      `gardening: ${packsMarkedStale} pack(s) and ${decisionsMarkedStale} decision(s) marked stale`,
    );
  }
  return result;
}

export interface MemoryGardeningWorkerHandle {
  stop(): Promise<void>;
  runOnce(projectCwd: string, projectId: string): Promise<MemoryGardeningResult>;
}

/**
 * Daemon-side scheduler. HTTP transport only, for the reason
 * `startStaleRunsSweeper` documents — stdio is a short-lived per-hook
 * subprocess where a timer never reaches a second tick.
 *
 * Cadence is deliberately slow (6h). Rot is measured in days; a tight
 * loop would burn filesystem calls to re-answer a question whose answer
 * changes about as often as a refactor lands.
 */
export function startMemoryGardeningWorker(opts: {
  readonly db: DbHandle;
  readonly intervalMs?: number;
  readonly listProjects?: () => Promise<ReadonlyArray<{ projectId: string; projectCwd: string }>>;
}): MemoryGardeningWorkerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;

  async function runOnce(projectCwd: string, projectId: string): Promise<MemoryGardeningResult> {
    return runMemoryGardeningOnce({ db: opts.db, projectCwd, projectId });
  }

  if (opts.listProjects !== undefined) {
    timer = setInterval(() => {
      if (stopped) return;
      inFlight = (async () => {
        const projects = await opts.listProjects?.().catch(() => []);
        for (const project of projects ?? []) await runOnce(project.projectCwd, project.projectId);
      })();
      inFlight.finally(() => {
        inFlight = null;
      });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  gardenLogger.info({ event: 'memory_gardening_worker_started', intervalMs }, 'memory gardening worker started');

  return {
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight !== null) await inFlight.catch(() => {});
    },
    runOnce,
  };
}
