import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createLogger } from '@coodra/shared';

/**
 * `packages/lifecycle/src/graph-refresh-worker` — COOD-82.
 *
 * Rebuilds the Graphify graph when it has drifted, without anyone
 * having to remember to.
 *
 * ## Rebuild at SessionEnd, not SessionStart
 *
 * SessionStart is the intuitive trigger and the wrong one. It is the
 * moment a rebuild is most expensive (something is waiting on it) and
 * least useful (the drift already happened). SessionEnd is the moment
 * the agent just finished writing code — the drift's actual cause —
 * and nothing is waiting on the result. The next session then opens
 * against a fresh graph for free.
 *
 * ## Never spends the user's money
 *
 * `coodra graphify build` defaults to `graphify .`, a full build that
 * requires an LLM backend key and performs semantic extraction. That is
 * categorically wrong for a background trigger: a hook that silently
 * bills an API account is not a feature.
 *
 * This worker always takes the `--no-llm` path (`graphify update .`),
 * documented in `graphify-artifacts.ts` as "re-extract code files … (no
 * LLM needed)" — the genuine key-free structural path. Semantic
 * re-extraction stays a deliberate, human-invoked action.
 *
 * ## Cost, measured
 *
 * 8.6s for a structural rebuild of a 7,396-node repo (Coodra itself,
 * 2026-08-16). That comfortably justifies running on every SessionEnd
 * rather than only on a periodic backstop — the original open question
 * in COOD-82.
 *
 * ## Triggers, not a cadence
 *
 * Every entry point calls `requestRefresh`, which rebuilds only if
 * drift actually warrants it and a cooldown has elapsed. Detection is
 * cheap (`git rev-parse` + a JSON field); the rebuild is not, so the
 * two are deliberately separated.
 *
 * ## Transport
 *
 * Started by the mcp-server daemon on the **HTTP transport only**, for
 * the reason `startStaleRunsSweeper` documents — stdio is a
 * short-lived per-hook subprocess where a timer never reaches a second
 * tick — plus one specific to this worker: a rebuild spawned there
 * would be killed mid-write when the subprocess exits, which is
 * precisely how a half-written `graph.json` happens.
 */

const execFileAsync = promisify(execFile);
const refreshLogger = createLogger('lifecycle.graph-refresh');

const GIT_TIMEOUT_MS = 5_000;
const REBUILD_TIMEOUT_MS = 10 * 60 * 1000;
/** Measured rebuild is ~9s; a minute of quiet is ample coalescing. */
const DEFAULT_COOLDOWN_MS = 60_000;
/** Backstop for sessions that ended abnormally — crash, sleep, no Stop hook. */
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
/**
 * Files changed before a rebuild is worth its seconds. Deliberately far
 * below COOD-81's *withholding* threshold: refreshing early is cheap,
 * whereas serving stale topology is not, so the two thresholds answer
 * different questions and must not be shared.
 */
const DEFAULT_MIN_FILES_CHANGED = 25;

export type GraphRefreshTrigger = 'session_end' | 'work_pack_done' | 'session_start_drift' | 'backstop' | 'manual';

export interface GraphRefreshWorkerOptions {
  readonly cooldownMs?: number;
  readonly intervalMs?: number;
  readonly minFilesChanged?: number;
  /** Test seam — defaults to spawning the real CLI. */
  readonly runRebuild?: (projectCwd: string) => Promise<boolean>;
  /** Test seam — defaults to real `git`. */
  readonly runGit?: (cwd: string, args: readonly string[]) => Promise<string | null>;
  /** Registers project cwds to sweep on the backstop interval. */
  readonly listProjectCwds?: () => Promise<readonly string[]>;
}

export interface GraphRefreshResult {
  readonly rebuilt: boolean;
  readonly reason:
    | 'rebuilt'
    | 'within_cooldown'
    | 'drift_below_threshold'
    | 'no_graph'
    | 'rebuild_failed'
    | 'in_flight';
  readonly filesChanged: number | null;
}

export interface GraphRefreshWorkerHandle {
  stop(): Promise<void>;
  requestRefresh(projectCwd: string, trigger: GraphRefreshTrigger): Promise<GraphRefreshResult>;
}

async function defaultGit(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * The ONLY command this worker may run.
 *
 * `--no-llm` routes to Graphify's `update` path — "re-extract code
 * files … (no LLM needed)". Dropping it would fall back to
 * `graphify .`, a full semantic build that requires an API key and
 * bills the user's account. Exported so a test can assert it, because
 * the rebuild itself sits behind a seam and would otherwise be the one
 * contract in this file nothing verifies.
 */
export const STRUCTURAL_REBUILD_ARGS: readonly string[] = ['graphify', 'build', '--no-llm'];

/**
 * Routed through the Coodra CLI rather than `graphify` directly so the
 * resolved output dir, env loading and bin discovery stay in one place.
 */
async function defaultRebuild(projectCwd: string): Promise<boolean> {
  try {
    await execFileAsync('coodra', [...STRUCTURAL_REBUILD_ARGS], {
      cwd: projectCwd,
      timeout: REBUILD_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function readBuiltAtCommit(projectCwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(projectCwd, '.coodra', 'graphify', 'out', 'graph.json'), 'utf8');
    const parsed = JSON.parse(raw) as { built_at_commit?: unknown };
    return typeof parsed.built_at_commit === 'string' && parsed.built_at_commit.length > 0
      ? parsed.built_at_commit
      : null;
  } catch {
    return null;
  }
}

export function startGraphRefreshWorker(opts: GraphRefreshWorkerOptions = {}): GraphRefreshWorkerHandle {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const minFilesChanged = opts.minFilesChanged ?? DEFAULT_MIN_FILES_CHANGED;
  const rebuild = opts.runRebuild ?? defaultRebuild;
  const git = opts.runGit ?? defaultGit;

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const lastRebuildAt = new Map<string, number>();
  // A rebuild writes graph.json; two concurrent ones would race on it.
  const inFlight = new Map<string, Promise<GraphRefreshResult>>();

  async function driftFileCount(projectCwd: string, builtAtCommit: string): Promise<number | null> {
    const exists = await git(projectCwd, ['cat-file', '-e', `${builtAtCommit}^{commit}`]);
    // Commit gone (rebase/force-push): drift is unmeasurable, and a
    // rebuild is the cheapest way to make it measurable again.
    if (exists === null) return Number.POSITIVE_INFINITY;
    const diff = await git(projectCwd, ['diff', '--name-only', `${builtAtCommit}..HEAD`]);
    if (diff === null) return null;
    return diff.split('\n').filter((line) => line.trim().length > 0).length;
  }

  async function refreshOnce(projectCwd: string, trigger: GraphRefreshTrigger): Promise<GraphRefreshResult> {
    const builtAtCommit = await readBuiltAtCommit(projectCwd);
    if (builtAtCommit === null) {
      // No graph, or one with no provenance. Building one from nothing
      // is a deliberate first-run action, not something a background
      // hook should decide to do on a user's behalf.
      return { rebuilt: false, reason: 'no_graph', filesChanged: null };
    }

    const now = Date.now();
    const last = lastRebuildAt.get(projectCwd);
    if (last !== undefined && now - last < cooldownMs) {
      return { rebuilt: false, reason: 'within_cooldown', filesChanged: null };
    }

    const filesChanged = await driftFileCount(projectCwd, builtAtCommit);
    if (filesChanged === null || filesChanged < minFilesChanged) {
      return {
        rebuilt: false,
        reason: 'drift_below_threshold',
        filesChanged: Number.isFinite(filesChanged) ? filesChanged : null,
      };
    }

    const ok = await rebuild(projectCwd);
    lastRebuildAt.set(projectCwd, Date.now());
    const reported = Number.isFinite(filesChanged) ? filesChanged : null;
    if (!ok) {
      refreshLogger.warn(
        { event: 'graph_refresh_failed', projectCwd, trigger, filesChanged: reported },
        'graph rebuild failed; will retry on a later trigger',
      );
      return { rebuilt: false, reason: 'rebuild_failed', filesChanged: reported };
    }
    refreshLogger.info(
      { event: 'graph_refreshed', projectCwd, trigger, filesChanged: reported },
      'graph rebuilt after drift',
    );
    return { rebuilt: true, reason: 'rebuilt', filesChanged: reported };
  }

  async function requestRefresh(projectCwd: string, trigger: GraphRefreshTrigger): Promise<GraphRefreshResult> {
    if (stopped) return { rebuilt: false, reason: 'in_flight', filesChanged: null };
    const existing = inFlight.get(projectCwd);
    if (existing !== undefined) {
      // Coalesce: several sessions ending at once must not each spawn a
      // rebuild writing the same graph.json.
      await existing.catch(() => {});
      return { rebuilt: false, reason: 'in_flight', filesChanged: null };
    }
    const run = refreshOnce(projectCwd, trigger).catch((err: unknown) => {
      refreshLogger.warn(
        { event: 'graph_refresh_error', projectCwd, trigger, err: err instanceof Error ? err.message : String(err) },
        'graph refresh threw; swallowed',
      );
      return { rebuilt: false, reason: 'rebuild_failed' as const, filesChanged: null };
    });
    inFlight.set(projectCwd, run);
    try {
      return await run;
    } finally {
      inFlight.delete(projectCwd);
    }
  }

  // Backstop for sessions that never fire SessionEnd — crash, laptop
  // sleep, force-quit. Without it those projects drift indefinitely.
  if (opts.listProjectCwds !== undefined) {
    timer = setInterval(() => {
      if (stopped) return;
      void (async () => {
        const cwds = await opts.listProjectCwds?.().catch(() => [] as readonly string[]);
        for (const cwd of cwds ?? []) await requestRefresh(cwd, 'backstop');
      })();
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  refreshLogger.info(
    { event: 'graph_refresh_worker_started', cooldownMs, intervalMs, minFilesChanged },
    'graph refresh worker started (structural rebuilds only, never LLM)',
  );

  return {
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      await Promise.allSettled([...inFlight.values()]);
    },
    requestRefresh,
  };
}
