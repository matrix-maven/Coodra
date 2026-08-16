import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { STRUCTURAL_REBUILD_ARGS, startGraphRefreshWorker } from '../../src/graph-refresh-worker.js';

/**
 * COOD-82 — automatic graph refresh.
 *
 * The contract, in order of how badly a regression would hurt:
 *
 *   1. **Never spends the user's money.** `coodra graphify build`
 *      defaults to a full LLM build requiring an API key. A background
 *      hook that silently bills an account is not a feature, so this
 *      worker must always take the `--no-llm` structural path.
 *   2. **Coalesces.** A rebuild writes graph.json; two concurrent ones
 *      race on the same file.
 *   3. **Only rebuilds when drift warrants it.** Detection is cheap,
 *      rebuilding is ~9s — so the two are separated and the cheap one
 *      gates the expensive one.
 *   4. **Never rebuilds from nothing.** A first build is a deliberate
 *      human action, not something a hook decides on a user's behalf.
 */

const SHA = 'c5b7b138b067eb539325a4734338dfab88e840f5';

const handles: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
});

function track<T extends { stop(): Promise<void> }>(handle: T): T {
  handles.push(handle);
  return handle;
}

async function repoWithGraph(builtAtCommit: string | null): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'graph-refresh-'));
  await mkdir(join(cwd, '.coodra', 'graphify', 'out'), { recursive: true });
  const graph = builtAtCommit === null ? { nodes: [] } : { nodes: [], built_at_commit: builtAtCommit };
  await writeFile(join(cwd, '.coodra', 'graphify', 'out', 'graph.json'), JSON.stringify(graph), 'utf8');
  return cwd;
}

/** git stub: commit exists, and `n` files changed since. */
function gitWithDrift(n: number) {
  return async (_cwd: string, args: readonly string[]): Promise<string | null> => {
    if (args[0] === 'cat-file') return '';
    if (args[0] === 'diff') return Array.from({ length: n }, (_v, i) => `src/f${i}.ts`).join('\n');
    return '0\n';
  };
}

describe('the rebuild command never costs money', () => {
  it('always passes --no-llm', () => {
    // `coodra graphify build` without this flag runs `graphify .`, a
    // full semantic build that ABORTS without an LLM backend key — and
    // bills the account when one is present. A background hook that
    // silently spends money is not a feature.
    expect(STRUCTURAL_REBUILD_ARGS).toContain('--no-llm');
    expect(STRUCTURAL_REBUILD_ARGS).toEqual(['graphify', 'build', '--no-llm']);
  });

  it('never passes a --backend, which would also reach an LLM', () => {
    expect(STRUCTURAL_REBUILD_ARGS.some((a) => a.startsWith('--backend'))).toBe(false);
  });
});

describe('startGraphRefreshWorker', () => {
  it('rebuilds when drift exceeds the threshold', async () => {
    const cwd = await repoWithGraph(SHA);
    const rebuilt: string[] = [];
    const worker = track(
      startGraphRefreshWorker({
        runGit: gitWithDrift(50),
        runRebuild: async (p) => {
          rebuilt.push(p);
          return true;
        },
        minFilesChanged: 25,
      }),
    );

    const result = await worker.requestRefresh(cwd, 'session_end');
    expect(result.rebuilt).toBe(true);
    expect(result.filesChanged).toBe(50);
    expect(rebuilt).toEqual([cwd]);
  });

  it('skips a rebuild when drift is below the threshold', async () => {
    const cwd = await repoWithGraph(SHA);
    let calls = 0;
    const worker = track(
      startGraphRefreshWorker({
        runGit: gitWithDrift(3),
        runRebuild: async () => {
          calls += 1;
          return true;
        },
        minFilesChanged: 25,
      }),
    );

    const result = await worker.requestRefresh(cwd, 'session_end');
    expect(result.rebuilt).toBe(false);
    expect(result.reason).toBe('drift_below_threshold');
    expect(calls, 'three changed files does not justify nine seconds').toBe(0);
  });

  it('does not build a graph that does not exist yet', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'graph-refresh-empty-'));
    let calls = 0;
    const worker = track(
      startGraphRefreshWorker({
        runGit: gitWithDrift(999),
        runRebuild: async () => {
          calls += 1;
          return true;
        },
      }),
    );

    const result = await worker.requestRefresh(cwd, 'session_end');
    expect(result.reason).toBe('no_graph');
    expect(calls, 'the first build is a deliberate human action').toBe(0);
  });

  it('honours the cooldown so a burst of sessions coalesces', async () => {
    const cwd = await repoWithGraph(SHA);
    let calls = 0;
    const worker = track(
      startGraphRefreshWorker({
        runGit: gitWithDrift(50),
        runRebuild: async () => {
          calls += 1;
          return true;
        },
        minFilesChanged: 25,
        cooldownMs: 60_000,
      }),
    );

    await worker.requestRefresh(cwd, 'session_end');
    const second = await worker.requestRefresh(cwd, 'session_end');
    expect(second.rebuilt).toBe(false);
    expect(second.reason).toBe('within_cooldown');
    expect(calls).toBe(1);
  });

  it('rebuilds when the recorded commit is gone from history', async () => {
    const cwd = await repoWithGraph(SHA);
    let calls = 0;
    const worker = track(
      startGraphRefreshWorker({
        // Rebase or force-push: cat-file fails. Drift is unmeasurable,
        // and rebuilding is the cheapest way to make it measurable again.
        runGit: async (_c, args) => (args[0] === 'cat-file' ? null : ''),
        runRebuild: async () => {
          calls += 1;
          return true;
        },
      }),
    );

    const result = await worker.requestRefresh(cwd, 'session_end');
    expect(result.rebuilt).toBe(true);
    expect(result.filesChanged, 'unmeasurable drift is reported as null, not a number').toBeNull();
    expect(calls).toBe(1);
  });

  it('reports a failed rebuild without throwing', async () => {
    const cwd = await repoWithGraph(SHA);
    const worker = track(
      startGraphRefreshWorker({
        runGit: gitWithDrift(50),
        runRebuild: async () => false,
        minFilesChanged: 25,
      }),
    );

    const result = await worker.requestRefresh(cwd, 'session_end');
    expect(result.rebuilt).toBe(false);
    expect(result.reason).toBe('rebuild_failed');
  });

  it('coalesces concurrent requests for the same project', async () => {
    const cwd = await repoWithGraph(SHA);
    let inFlight = 0;
    let maxConcurrent = 0;
    const worker = track(
      startGraphRefreshWorker({
        runGit: gitWithDrift(50),
        runRebuild: async () => {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 20));
          inFlight -= 1;
          return true;
        },
        minFilesChanged: 25,
      }),
    );

    await Promise.all([
      worker.requestRefresh(cwd, 'session_end'),
      worker.requestRefresh(cwd, 'work_pack_done'),
      worker.requestRefresh(cwd, 'backstop'),
    ]);
    // Two concurrent rebuilds would race on the same graph.json.
    expect(maxConcurrent).toBe(1);
  });
});
