import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type GraphifyArtifactIO,
  type GraphifyArtifactOptions,
  runGraphifyBuildCommand,
  runGraphifyCleanCommand,
  runGraphifyOpenCommand,
} from '../../src/commands/graphify-artifacts.js';
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../../src/exit-codes.js';
import { MANAGED_PATHS, writeGraphifyRecord } from '../../src/lib/graphify/artifacts.js';

/**
 * End-to-end coverage for `coodra graphify build | open | clean` against real
 * temp projects. The external `graphify` executable is INJECTED (never spawned)
 * so the tests stay hermetic — Coodra only sets GRAPHIFY_OUT and invokes it.
 */

interface Cap {
  stdout: string[];
  stderr: string[];
  exit: number | null;
}
function makeIO(): { io: GraphifyArtifactIO; cap: Cap } {
  const cap: Cap = { stdout: [], stderr: [], exit: null };
  const io: GraphifyArtifactIO = {
    writeStdout: (c) => cap.stdout.push(c),
    writeStderr: (c) => cap.stderr.push(c),
    exit: (code) => {
      cap.exit = code;
      throw new Error(`__exit__:${code}`);
    },
  };
  return { io, cap };
}
async function run(p: () => Promise<unknown>): Promise<number> {
  try {
    await p();
    throw new Error('did not exit');
  } catch (err) {
    const m = (err as Error).message.match(/^__exit__:(\d+)$/);
    if (!m) throw err;
    return Number(m[1]);
  }
}

let root: string;
function opts(extra: Partial<GraphifyArtifactOptions> = {}): GraphifyArtifactOptions {
  return { cwd: root, json: true, env: {}, ...extra };
}

const GRAPH = { nodes: [{ id: 'a', community: 0 }], links: [] };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'coodra-gfxcmd-'));
  await mkdir(join(root, '.coodra'), { recursive: true });
  await writeFile(join(root, '.coodra', 'config.json'), JSON.stringify({ version: 1, projectSlug: 'gfx-demo' }));
});
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(root, { recursive: true, force: true });
});

describe('coodra graphify build', () => {
  it('invokes the graphify binary with GRAPHIFY_OUT pointed at the resolved output dir', async () => {
    await writeGraphifyRecord(root, MANAGED_PATHS, { dryRun: false });
    const calls: Array<{ bin: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const runner = async (bin: string, args: readonly string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => {
      calls.push({ bin, args, env: o.env });
      // Simulate graphify producing the artifacts.
      await mkdir(join(root, '.coodra/graphify/out'), { recursive: true });
      await writeFile(join(root, '.coodra/graphify/out/graph.json'), JSON.stringify(GRAPH));
      await writeFile(join(root, '.coodra/graphify/out/graph.html'), '<html>');
      return { stdout: '', stderr: '' };
    };

    const { io } = makeIO();
    const code = await run(() => runGraphifyBuildCommand(opts({ runner, bin: 'graphify' }), io));
    expect(code).toBe(EXIT_OK);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['.']);
    expect(calls[0]?.env.GRAPHIFY_OUT).toBe(join(root, '.coodra/graphify/out'));

    // Artifacts are recorded into the manifest as owner=graphify, cleanup=safe
    // (managed output is gitignored + regenerable).
    const manifest = JSON.parse(await readFile(join(root, '.coodra/manifest.json'), 'utf8'));
    const graphEntry = manifest.entries.find((e: { path: string }) => e.path.endsWith('graph.json'));
    expect(graphEntry).toMatchObject({ owner: 'graphify', kind: 'generated-artifact', cleanup: 'safe' });
  });

  it("records graphify's stray graphify-out/manifest.json state cache (0.8.27 ignores GRAPHIFY_OUT for it)", async () => {
    await writeGraphifyRecord(root, MANAGED_PATHS, { dryRun: false });
    const runner = async () => {
      await mkdir(join(root, '.coodra/graphify/out'), { recursive: true });
      await writeFile(join(root, '.coodra/graphify/out/graph.json'), JSON.stringify(GRAPH));
      // graphify 0.8.27 writes its incremental-extraction state to its DEFAULT
      // out dir even when GRAPHIFY_OUT points at the managed layout.
      await mkdir(join(root, 'graphify-out'), { recursive: true });
      await writeFile(join(root, 'graphify-out/manifest.json'), '{"files": {}}');
      return { stdout: '', stderr: '' };
    };
    const { io } = makeIO();
    const code = await run(() => runGraphifyBuildCommand(opts({ runner, bin: 'graphify' }), io));
    expect(code).toBe(EXIT_OK);

    const manifest = JSON.parse(await readFile(join(root, '.coodra/manifest.json'), 'utf8'));
    const stateEntry = manifest.entries.find((e: { path: string }) => e.path === 'graphify-out/manifest.json');
    // Managed layout → the stray is a machine-local cache: safe to auto-clean.
    expect(stateEntry).toMatchObject({ owner: 'graphify', kind: 'state-cache', cleanup: 'safe', safeToDelete: true });
  });

  it('classifies the graphify-out/manifest.json state file as `ask` under the committed legacy layout', async () => {
    // Legacy layout: graphify-out/ is git-committed — the state file sits inside
    // it, so it gets the same ask tier as the artifacts around it.
    await mkdir(join(root, 'graphify-out'), { recursive: true });
    await writeFile(join(root, 'graphify-out/graph.json'), JSON.stringify(GRAPH));
    const runner = async () => {
      await writeFile(join(root, 'graphify-out/manifest.json'), '{"files": {}}');
      return { stdout: '', stderr: '' };
    };
    const { io } = makeIO();
    const code = await run(() => runGraphifyBuildCommand(opts({ runner, bin: 'graphify' }), io));
    expect(code).toBe(EXIT_OK);

    const manifest = JSON.parse(await readFile(join(root, '.coodra/manifest.json'), 'utf8'));
    const stateEntry = manifest.entries.find((e: { path: string }) => e.path === 'graphify-out/manifest.json');
    expect(stateEntry).toMatchObject({ owner: 'graphify', kind: 'state-cache', cleanup: 'ask' });
  });

  it('persists the resolved layout so it stays sticky after the first build', async () => {
    // Greenfield (no record) → managed. The build must WRITE the record, or a
    // stray graphify-out/ appearing later would flip resolution away from the
    // artifacts we just produced.
    const runner = async () => ({ stdout: '', stderr: '' });
    const { io } = makeIO();
    await run(() => runGraphifyBuildCommand(opts({ runner }), io));
    const record = JSON.parse(await readFile(join(root, '.coodra/graphify.json'), 'utf8'));
    expect(record).toMatchObject({ version: 1, outputDir: '.coodra/graphify/out', managedByCoodra: true });
  });

  it('--no-llm runs the key-free `update` path (verified against graphify 0.8.27)', async () => {
    const calls: Array<readonly string[]> = [];
    const runner = async (_b: string, args: readonly string[]) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    };
    const { io } = makeIO();
    await run(() => runGraphifyBuildCommand(opts({ runner, llm: false }), io));
    // NOT `--code-only` — that flag does not exist in graphify 0.8.27.
    expect(calls[0]).toEqual(['update', '.']);
  });

  /**
   * The large-graph gap, found by building this repo's own graph: Graphify
   * refuses HTML above `MAX_NODES_FOR_VIZ` (5000) and the `update` path
   * swallows it, so `graph.html` silently never exists on any real codebase.
   * Coodra's answer is Graphify's OWN `export html --node-limit N`, which
   * aggregates to a community meta-graph instead of raising.
   */
  describe('large-graph graph.html fallback', () => {
    /** Runner that writes graph.json with `nodeCount` nodes and no graph.html. */
    function bigGraphRunner(nodeCount: number, calls: Array<readonly string[]>) {
      return async (_b: string, args: readonly string[], _o?: { cwd: string; env: NodeJS.ProcessEnv }) => {
        calls.push(args);
        if (args[0] === 'export') {
          // The aggregated pass is what finally produces the HTML.
          await writeFile(join(root, '.coodra/graphify/out/graph.html'), '<html>aggregated</html>');
          return { stdout: '', stderr: '' };
        }
        await mkdir(join(root, '.coodra/graphify/out'), { recursive: true });
        await writeFile(
          join(root, '.coodra/graphify/out/graph.json'),
          JSON.stringify({
            nodes: Array.from({ length: nodeCount }, (_, i) => ({ id: `n${i}`, community: i % 7 })),
            links: [],
          }),
        );
        return { stdout: '', stderr: '' };
      };
    }

    it('runs `export html --node-limit` when the graph exceeds the viz limit and no html landed', async () => {
      const calls: Array<readonly string[]> = [];
      const { io, cap } = makeIO();
      const code = await run(() => runGraphifyBuildCommand(opts({ runner: bigGraphRunner(5001, calls) }), io));
      expect(code).toBe(EXIT_OK);
      expect(calls[1]).toEqual(['export', 'html', '--node-limit', '5000']);

      const payload = JSON.parse(cap.stdout.join(''));
      expect(payload.scan.graphHtml.exists).toBe(true);
      expect(payload.vizNote).toContain('aggregated community view');
    });

    it('does NOT run the fallback for a graph under the limit', async () => {
      const calls: Array<readonly string[]> = [];
      const { io } = makeIO();
      await run(() => runGraphifyBuildCommand(opts({ runner: bigGraphRunner(10, calls) }), io));
      expect(calls).toHaveLength(1);
    });

    it('honours GRAPHIFY_VIZ_NODE_LIMIT when deciding the threshold', async () => {
      const calls: Array<readonly string[]> = [];
      const { io } = makeIO();
      await run(() =>
        runGraphifyBuildCommand(
          opts({ runner: bigGraphRunner(200, calls), env: { GRAPHIFY_VIZ_NODE_LIMIT: '100' } }),
          io,
        ),
      );
      expect(calls[1]).toEqual(['export', 'html', '--node-limit', '100']);
    });

    it('--no-viz skips the fallback entirely (CI)', async () => {
      const calls: Array<readonly string[]> = [];
      const { io } = makeIO();
      await run(() => runGraphifyBuildCommand(opts({ runner: bigGraphRunner(5001, calls), viz: false }), io));
      expect(calls).toHaveLength(1);
    });

    it('reports — rather than swallows — a failing fallback', async () => {
      const calls: Array<readonly string[]> = [];
      const base = bigGraphRunner(5001, calls);
      const runner = async (b: string, args: readonly string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => {
        if (args[0] === 'export') throw new Error('boom');
        return base(b, args, o);
      };
      const { io, cap } = makeIO();
      const code = await run(() => runGraphifyBuildCommand(opts({ runner }), io));
      // The build itself still succeeded — only the optional viz pass failed.
      expect(code).toBe(EXIT_OK);
      const payload = JSON.parse(cap.stdout.join(''));
      expect(payload.ok).toBe(true);
      expect(payload.vizNote).toContain('GRAPHIFY_VIZ_NODE_LIMIT');
    });
  });

  it('--backend forwards to the full build (ollama = local, key-free)', async () => {
    const calls: Array<readonly string[]> = [];
    const runner = async (_b: string, args: readonly string[]) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    };
    const { io } = makeIO();
    await run(() => runGraphifyBuildCommand(opts({ runner, backend: 'ollama' }), io));
    expect(calls[0]).toEqual(['.', '--backend', 'ollama']);
  });

  it('layers ~/.coodra/.env into the Graphify subprocess env', async () => {
    const home = await mkdtemp(join(tmpdir(), 'coodra-gfx-home-'));
    await mkdir(home, { recursive: true });
    await writeFile(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-test-graphify\nGRAPHIFY_BACKEND=claude\n', 'utf8');
    const argCalls: Array<readonly string[]> = [];
    const calls: Array<NodeJS.ProcessEnv> = [];
    const runner = async (_b: string, args: readonly string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => {
      argCalls.push(args);
      calls.push(o.env);
      await mkdir(join(root, '.coodra/graphify/out'), { recursive: true });
      await writeFile(join(root, '.coodra/graphify/out/graph.json'), JSON.stringify(GRAPH));
      return { stdout: '', stderr: '' };
    };
    const { io } = makeIO();
    await run(() => runGraphifyBuildCommand(opts({ runner, env: { COODRA_HOME: home } }), io));
    expect(calls[0]?.ANTHROPIC_API_KEY).toBe('sk-test-graphify');
    expect(calls[0]?.GRAPHIFY_BACKEND).toBe('claude');
    expect(argCalls[0]).toEqual(['.', '--backend', 'claude']);
  });

  it('a missing-LLM-key failure names the key-free alternatives', async () => {
    const runner = async () => {
      throw new Error('Command failed: graphify .\nerror: no LLM API key found. Set GEMINI_API_KEY');
    };
    const { io, cap } = makeIO();
    const code = await run(() => runGraphifyBuildCommand(opts({ runner }), io));
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    const { error } = JSON.parse(cap.stdout.join(''));
    expect(error).toContain('--no-llm');
    expect(error).toContain('--backend ollama');
  });

  it('--dry-run prints the command without running it', async () => {
    let ran = false;
    const runner = async () => {
      ran = true;
      return { stdout: '', stderr: '' };
    };
    const { io, cap } = makeIO();
    const code = await run(() => runGraphifyBuildCommand(opts({ runner, dryRun: true }), io));
    expect(code).toBe(EXIT_OK);
    expect(ran).toBe(false);
    expect(JSON.parse(cap.stdout.join('')).dryRun).toBe(true);
  });

  it('missing graphify binary → clean environment error with install guidance', async () => {
    const runner = async () => {
      throw new Error('spawn graphify ENOENT');
    };
    const { io, cap } = makeIO();
    const code = await run(() => runGraphifyBuildCommand(opts({ runner }), io));
    expect(code).toBe(3); // EXIT_ENVIRONMENT_PROBLEM
    const payload = JSON.parse(cap.stdout.join(''));
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('graphifyy');
    expect(payload.error).toContain('--bin <path>');
  });
});

describe('coodra graphify open', () => {
  it('opens the resolved graph.html', async () => {
    await writeGraphifyRecord(root, MANAGED_PATHS, { dryRun: false });
    await mkdir(join(root, '.coodra/graphify/out'), { recursive: true });
    await writeFile(join(root, '.coodra/graphify/out/graph.html'), '<html>');
    const opened: string[] = [];
    const { io } = makeIO();
    const code = await run(() =>
      runGraphifyOpenCommand(opts({ opener: async (p: string) => void opened.push(p) }), io),
    );
    expect(code).toBe(EXIT_OK);
    expect(opened[0]).toBe(join(root, '.coodra/graphify/out/graph.html'));
  });

  it('missing graph.html → actionable error', async () => {
    const { io, cap } = makeIO();
    const code = await run(() => runGraphifyOpenCommand(opts({ opener: async () => {} }), io));
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    expect(JSON.parse(cap.stdout.join('')).error).toContain('coodra graphify build');
  });
});

describe('coodra graphify clean', () => {
  it('removes managed artifacts and prunes them from the manifest', async () => {
    await writeGraphifyRecord(root, MANAGED_PATHS, { dryRun: false });
    await mkdir(join(root, '.coodra/graphify/out'), { recursive: true });
    await writeFile(join(root, '.coodra/graphify/out/graph.json'), JSON.stringify(GRAPH));
    await writeFile(join(root, '.coodra/graphify/out/graph.html'), '<html>');

    const { io, cap } = makeIO();
    const code = await run(() => runGraphifyCleanCommand(opts(), io));
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join(''));
    expect(payload.deleted.sort()).toEqual(['.coodra/graphify/out/graph.html', '.coodra/graphify/out/graph.json']);
    expect(existsSync(join(root, '.coodra/graphify/out/graph.json'))).toBe(false);
  });

  it('REFUSES to clean the git-committed legacy graphify-out/ without --force', async () => {
    // No record → legacy layout.
    await mkdir(join(root, 'graphify-out'), { recursive: true });
    await writeFile(join(root, 'graphify-out/graph.json'), JSON.stringify(GRAPH));

    const { io, cap } = makeIO();
    const code = await run(() => runGraphifyCleanCommand(opts(), io));
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    expect(JSON.parse(cap.stdout.join('')).error).toContain('--force');
    expect(existsSync(join(root, 'graphify-out/graph.json'))).toBe(true); // untouched
  });

  it('--force cleans the legacy directory', async () => {
    await mkdir(join(root, 'graphify-out'), { recursive: true });
    await writeFile(join(root, 'graphify-out/graph.json'), JSON.stringify(GRAPH));
    const { io } = makeIO();
    const code = await run(() => runGraphifyCleanCommand(opts({ force: true }), io));
    expect(code).toBe(EXIT_OK);
    expect(existsSync(join(root, 'graphify-out/graph.json'))).toBe(false);
  });

  it('--dry-run deletes nothing', async () => {
    await writeGraphifyRecord(root, MANAGED_PATHS, { dryRun: false });
    await mkdir(join(root, '.coodra/graphify/out'), { recursive: true });
    await writeFile(join(root, '.coodra/graphify/out/graph.json'), JSON.stringify(GRAPH));
    const { io } = makeIO();
    await run(() => runGraphifyCleanCommand(opts({ dryRun: true }), io));
    expect(existsSync(join(root, '.coodra/graphify/out/graph.json'))).toBe(true);
  });

  it('refuses an output dir outside the project root (safety)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'coodra-outside-'));
    await writeGraphifyRecord(
      root,
      {
        outputDir: outside,
        graphJson: join(outside, 'graph.json'),
        graphHtml: join(outside, 'graph.html'),
        report: join(outside, 'GRAPH_REPORT.md'),
        managedByCoodra: true,
      },
      { dryRun: false },
    );
    const { io, cap } = makeIO();
    const code = await run(() => runGraphifyCleanCommand(opts(), io));
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    expect(JSON.parse(cap.stdout.join('')).error).toContain('outside the project root');
  });
});
