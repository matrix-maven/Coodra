import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type GraphifyEnableOptions,
  type GraphifyIO,
  runGraphifyEnableCommand as runEnableImpl,
  runGraphifyDisableCommand,
  runGraphifyStatusCommand,
} from '../../../src/commands/graphify.js';
import type { GraphifyPythonResolver } from '../../../src/lib/init/graphify-python.js';

/**
 * Locks the Module 09 Track 9B `coodra graphify {enable,disable,status}`
 * command surface. The handlers operate over filesystem state only (no
 * DB, no daemon). Claude Code is native-plugin-managed (Coodra's plugin
 * bundles Graphify automatically) — `graphify enable --ide claude` is a
 * no-op that never touches repo-root `.mcp.json`. Codex is the only
 * remaining explicit-wiring target: a real `[mcp_servers.graphify]` TOML
 * write via the 9·Core substrate.
 *
 *   - enable writes a `graphify` entry into Codex's config.toml; preserves
 *     `coodra` + siblings.
 *   - enable wires only the `graphify` MCP entry (no recipe seeding —
 *     retired in ADR-015; Graphify is query-only).
 *   - disable strips only the `graphify` entry.
 *   - status is a read-only probe across both agents.
 *   - bad / empty IDE selection exits user-recoverable (1).
 */

interface Captured {
  readonly io: GraphifyIO;
  stdout(): string;
  stderr(): string;
  readonly exitCode: () => number | null;
}

function makeIO(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  let code: number | null = null;
  const io: GraphifyIO = {
    writeStdout: (c) => {
      out.push(c);
    },
    writeStderr: (c) => {
      err.push(c);
    },
    exit: ((c: number) => {
      code = c;
      throw new Error(`__exit__:${c}`);
    }) as never,
  };
  return {
    io,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    exitCode: () => code,
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI for assertion.
const ANSI = /\x1b\[[0-9;]*m/g;

const FEATURE_MD = join('docs', 'features', 'graphify-seed-packs', 'feature.md');

/**
 * Deterministic interpreter resolver for the enable tests — never spawns
 * a real `python -c "import ..."`. Mirrors production semantics: an
 * explicit `--python` is honoured verbatim; otherwise we report the bare
 * `python3` fallback as unverified (so the install notice renders). Real
 * auto-detection is covered in `graphify-python.test.ts`.
 */
const stubResolver: GraphifyPythonResolver = async ({ explicit }) =>
  explicit !== undefined && explicit.trim().length > 0
    ? { python: explicit, verified: true, source: 'flag' }
    : { python: 'python3', verified: false, source: 'fallback' };

/** Inject the stub resolver into every enable call unless the test overrides it. */
function enable(opts: GraphifyEnableOptions, io: GraphifyIO): Promise<never> {
  return runEnableImpl({ resolvePython: stubResolver, ...opts }, io);
}

describe('runGraphifyEnableCommand', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-graphify-enable-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-graphify-enable-home-'));
  });

  it('leaves repo-root .mcp.json untouched for --ide claude because native plugin MCP owns Coodra wiring', async () => {
    const c = makeIO();
    await expect(enable({ ide: 'claude', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    await expect(readFile(join(cwd, '.mcp.json'), 'utf8')).rejects.toThrow();
    expect(c.stdout().replace(ANSI, '')).toContain('user-owned');
  });

  it('Phase 3: KEEPS the legacy graphify-out/ layout non-interactively (never silently relocates a git-committed dir)', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(cwd, 'graphify-out'), { recursive: true });
    await writeFile(join(cwd, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [], links: [] }));

    const c = makeIO();
    await expect(enable({ ide: 'codex', cwd, userHome: home, json: true }, c.io)).rejects.toThrow();
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { graphify: { args: string[] } };
    };
    expect(parsed.mcp_servers.graphify.args).toEqual(['-m', 'graphify.serve', 'graphify-out/graph.json']);
    const record = JSON.parse(await readFile(join(cwd, '.coodra', 'graphify.json'), 'utf8'));
    expect(record.managedByCoodra).toBe(false);
    expect(record.outputDir).toBe('graphify-out');
  });

  it('Phase 3: migrates to the Coodra-managed layout when the user answers yes', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(cwd, 'graphify-out'), { recursive: true });
    await writeFile(join(cwd, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [], links: [] }));

    // Answer 'y' ONLY to the migrate question. `install: false` keeps the
    // separate graphifyy install offer out of the way — without both guards a
    // blanket 'y' also triggers a real venv install, which made this flaky.
    const asked: string[] = [];
    const readPrompt = async (q: string): Promise<string> => {
      asked.push(q);
      return /Migrate to Coodra-managed/.test(q) ? 'y' : 'n';
    };

    const c = makeIO();
    await expect(enable({ ide: 'codex', cwd, userHome: home, install: false, readPrompt }, c.io)).rejects.toThrow();
    expect(asked.some((q) => /Migrate to Coodra-managed/.test(q))).toBe(true);
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { graphify: { args: string[] } };
    };
    expect(parsed.mcp_servers.graphify.args).toEqual(['-m', 'graphify.serve', '.coodra/graphify/out/graph.json']);
    const record = JSON.parse(await readFile(join(cwd, '.coodra', 'graphify.json'), 'utf8'));
    expect(record.managedByCoodra).toBe(true);
  });

  it('Phase 3: records the resolved layout in .coodra/graphify.json for a greenfield project', async () => {
    const c = makeIO();
    await expect(enable({ ide: 'claude', cwd, userHome: home }, c.io)).rejects.toThrow();
    const record = JSON.parse(await readFile(join(cwd, '.coodra', 'graphify.json'), 'utf8'));
    expect(record).toMatchObject({
      version: 1,
      outputDir: '.coodra/graphify/out',
      graphJson: '.coodra/graphify/out/graph.json',
      managedByCoodra: true,
    });
  });

  it('--python overrides the interpreter on the written entry', async () => {
    const c = makeIO();
    await expect(enable({ ide: 'codex', python: '.venv/bin/python3', cwd, userHome: home }, c.io)).rejects.toThrow();
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { graphify: { command: string } };
    };
    expect(parsed.mcp_servers.graphify.command).toBe('.venv/bin/python3');
  });

  it('--graph overrides the graph path on the written entry', async () => {
    const c = makeIO();
    await expect(enable({ ide: 'codex', graph: 'out/g.json', cwd, userHome: home }, c.io)).rejects.toThrow();
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { graphify: { args: string[] } };
    };
    expect(parsed.mcp_servers.graphify.args).toEqual(['-m', 'graphify.serve', 'out/g.json']);
  });

  it('writes a real [mcp_servers.graphify] table into Codex config.toml for --ide codex', async () => {
    const c = makeIO();
    await expect(enable({ ide: 'codex', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { graphify: { command: string; args: string[] } };
    };
    expect(parsed.mcp_servers.graphify.command).toBe('python3');
    expect(parsed.mcp_servers.graphify.args).toEqual(['-m', 'graphify.serve', '.coodra/graphify/out/graph.json']);
  });

  it('preserves the `coodra` entry and any sibling MCP servers', async () => {
    await mkdir(join(cwd, '.codex'), { recursive: true });
    await writeFile(
      join(cwd, '.codex', 'config.toml'),
      '[mcp_servers.coodra]\ncommand = "node"\n\n[mcp_servers.memory]\ncommand = "npx"\n',
      'utf8',
    );
    const c = makeIO();
    await expect(enable({ ide: 'codex', cwd, userHome: home }, c.io)).rejects.toThrow();
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { coodra: { command: string }; memory: { command: string }; graphify: { command: string } };
    };
    expect(parsed.mcp_servers.coodra.command).toBe('node');
    expect(parsed.mcp_servers.memory.command).toBe('npx');
    expect(parsed.mcp_servers.graphify.command).toBe('python3');
  });

  it('is idempotent — a second enable is a no-op', async () => {
    const first = makeIO();
    await expect(enable({ ide: 'codex', json: true, cwd, userHome: home }, first.io)).rejects.toThrow();
    expect(JSON.parse(first.stdout()).results[0].action).toBe('wrote');
    const second = makeIO();
    await expect(enable({ ide: 'codex', json: true, cwd, userHome: home }, second.io)).rejects.toThrow();
    const report = JSON.parse(second.stdout());
    expect(report.results[0].action).toBe('unchanged');
  });

  it('leaves a drifted entry untouched without --force', async () => {
    await mkdir(join(cwd, '.codex'), { recursive: true });
    await writeFile(join(cwd, '.codex', 'config.toml'), '[mcp_servers.graphify]\ncommand = "custom"\n', 'utf8');
    const c = makeIO();
    await expect(enable({ ide: 'codex', cwd, userHome: home }, c.io)).rejects.toThrow();
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { graphify: { command: string } };
    };
    expect(parsed.mcp_servers.graphify.command).toBe('custom');
  });

  it('--force overwrites a drifted entry', async () => {
    await mkdir(join(cwd, '.codex'), { recursive: true });
    await writeFile(join(cwd, '.codex', 'config.toml'), '[mcp_servers.graphify]\ncommand = "custom"\n', 'utf8');
    const c = makeIO();
    await expect(enable({ ide: 'codex', force: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { graphify: { command: string } };
    };
    expect(parsed.mcp_servers.graphify.command).toBe('python3');
  });

  it('--dry-run writes nothing to disk', async () => {
    const c = makeIO();
    await expect(enable({ ide: 'claude', dryRun: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    await expect(readFile(join(cwd, '.mcp.json'), 'utf8')).rejects.toThrow();
  });

  it('--ide all wires Codex, leaves Claude untouched (native plugin)', async () => {
    const c = makeIO();
    await expect(enable({ ide: 'all', json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const report = JSON.parse(c.stdout());
    expect(report.ok).toBe(true);
    const byIde = Object.fromEntries(report.results.map((r: { ide: string; action: string }) => [r.ide, r.action]));
    expect(byIde.claude).toBe('unchanged');
    expect(byIde.codex).toBe('wrote');
    // Codex's TOML config carries a real graphify table now.
    const codexCfg = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { graphify?: unknown };
    };
    expect(codexCfg.mcp_servers.graphify).toBeDefined();
  });

  it('enable JSON report carries no feature field (recipe retired, ADR-015)', async () => {
    const c = makeIO();
    await expect(enable({ ide: 'claude', json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const report = JSON.parse(c.stdout());
    expect(report.feature).toBeUndefined();
    // No docs/features/ directory is created by `graphify enable` any more.
    await expect(readFile(join(cwd, FEATURE_MD), 'utf8')).rejects.toThrow();
  });

  it('autodetects installed agents when --ide is omitted', async () => {
    await mkdir(join(home, '.claude'));
    const c = makeIO();
    await expect(enable({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const report = JSON.parse(c.stdout());
    expect(report.results.map((r: { ide: string }) => r.ide)).toEqual(['claude']);
  });

  it('exits user-recoverable (1) when no IDE is detected and none is named', async () => {
    const c = makeIO();
    await expect(enable({ cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(1);
    expect(c.stderr()).toContain('No supported IDE detected');
  });

  it('exits user-recoverable (1) on an unknown --ide value', async () => {
    const c = makeIO();
    await expect(enable({ ide: 'intellij', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(1);
  });

  it('emits the install + graph-build prerequisites in human output', async () => {
    const c = makeIO();
    await expect(enable({ ide: 'codex', cwd, userHome: home }, c.io)).rejects.toThrow();
    const out = c.stdout().replace(ANSI, '');
    // Install line names the [mcp] extra (no semantic backend needed — Graphify is query-only now, ADR-015).
    expect(out).toContain('graphifyy[mcp]');
    // Venv path is the canonical install — system python frequently lacks the mcp package.
    expect(out).toContain('uv venv');
    // Graph-build guidance points at the no-key slash command + the no-LLM CLI.
    expect(out).toContain('/graphify .');
    expect(out).toContain('graphify update .');
    // The sanity-check command appears so users can verify the venv install before reconnecting.
    expect(out).toContain('import graphify.serve, mcp');
    // The payoff is framed as structural queries, not pack seeding.
    expect(out).toContain('what depends on X');
  });

  it('writes the auto-detected interpreter and shows the verified notice', async () => {
    // Resolver finds a verified interpreter (e.g. the uv-tool python).
    const verifiedResolver: GraphifyPythonResolver = async () => ({
      python: '/uv/tools/graphifyy/bin/python',
      verified: true,
      source: 'uv-tool',
    });
    const c = makeIO();
    await expect(
      enable({ ide: 'codex', cwd, userHome: home, resolvePython: verifiedResolver }, c.io),
    ).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { graphify: { command: string } };
    };
    // The wired command is the DETECTED interpreter, not bare python3.
    expect(parsed.mcp_servers.graphify.command).toBe('/uv/tools/graphifyy/bin/python');
    const out = c.stdout().replace(ANSI, '');
    expect(out).toContain('verified');
    // No graph built in the tmp cwd → the verified notice flags the missing graph.
    expect(out).toContain('No graph yet');
    // The verified path does NOT dump the full install instructions.
    expect(out).not.toContain('uv venv');
  });

  it('JSON report carries python + pythonVerified + pythonSource + graphExists', async () => {
    const verifiedResolver: GraphifyPythonResolver = async () => ({
      python: '/uv/py',
      verified: true,
      source: 'uv-tool',
    });
    const c = makeIO();
    await expect(
      enable({ ide: 'codex', json: true, cwd, userHome: home, resolvePython: verifiedResolver }, c.io),
    ).rejects.toThrow();
    const report = JSON.parse(c.stdout());
    expect(report.python).toBe('/uv/py');
    expect(report.pythonVerified).toBe(true);
    expect(report.pythonSource).toBe('uv-tool');
    expect(report.graphExists).toBe(false);
  });
});

describe('runGraphifyDisableCommand', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-graphify-disable-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-graphify-disable-home-'));
  });

  it('Claude disable leaves user-owned root .mcp.json untouched', async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { coodra: { command: 'node' }, graphify: { command: 'python3' } } }, null, 2),
      'utf8',
    );
    const c = makeIO();
    await expect(runGraphifyDisableCommand({ ide: 'claude', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const parsed = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.graphify.command).toBe('python3');
    expect(parsed.mcpServers.coodra.command).toBe('node');
  });

  it('strips the `graphify` table from Codex config.toml, leaving `coodra`', async () => {
    await mkdir(join(cwd, '.codex'));
    await writeFile(
      join(cwd, '.codex', 'config.toml'),
      '[mcp_servers.coodra]\ncommand = "node"\n\n[mcp_servers.graphify]\ncommand = "python3"\n',
      'utf8',
    );
    const c = makeIO();
    await expect(runGraphifyDisableCommand({ ide: 'codex', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { coodra?: unknown; graphify?: unknown };
    };
    expect(parsed.mcp_servers.graphify).toBeUndefined();
    expect(parsed.mcp_servers.coodra).toBeDefined();
  });

  it('is a no-op when no `graphify` entry exists', async () => {
    await mkdir(join(cwd, '.codex'));
    await writeFile(join(cwd, '.codex', 'config.toml'), '[mcp_servers.coodra]\ncommand = "node"\n', 'utf8');
    const c = makeIO();
    await expect(runGraphifyDisableCommand({ ide: 'codex', json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(JSON.parse(c.stdout()).results[0].action).toBe('unchanged');
  });

  it('--dry-run writes nothing to disk', async () => {
    await mkdir(join(cwd, '.codex'));
    await writeFile(join(cwd, '.codex', 'config.toml'), '[mcp_servers.graphify]\ncommand = "python3"\n', 'utf8');
    const c = makeIO();
    await expect(
      runGraphifyDisableCommand({ ide: 'codex', dryRun: true, cwd, userHome: home }, c.io),
    ).rejects.toThrow();
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { graphify: { command: string } };
    };
    expect(parsed.mcp_servers.graphify.command).toBe('python3');
  });

  it('exits user-recoverable (1) on an unknown --ide value', async () => {
    const c = makeIO();
    await expect(runGraphifyDisableCommand({ ide: 'nano', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(1);
  });
});

describe('runGraphifyStatusCommand', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-graphify-status-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-graphify-status-home-'));
  });

  it('reports every agent as not-wired on a clean tree (--json)', async () => {
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const report = JSON.parse(c.stdout());
    expect(report.server).toBe('graphify');
    expect(report.ides.map((i: { ide: string }) => i.ide)).toEqual(['claude', 'codex']);
    expect(report.ides.every((i: { wired: boolean; exists: boolean }) => i.wired === false && i.exists === false)).toBe(
      true,
    );
  });

  it('does not treat user-owned root .mcp.json as Claude wiring', async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { graphify: { command: 'python3' } } }, null, 2),
      'utf8',
    );
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const claude = JSON.parse(c.stdout()).ides.find((i: { ide: string }) => i.ide === 'claude');
    expect(claude).toMatchObject({ exists: false, wired: false, unreadable: false });
  });

  it('reports native Codex plugin Graphify as managed wiring', async () => {
    await mkdir(join(home, '.codex', 'plugins', 'coodra'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'plugins', 'coodra', '.mcp.json'),
      JSON.stringify({ mcpServers: { coodra: { command: 'node' }, graphify: { command: 'python' } } }, null, 2),
      'utf8',
    );
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const codex = JSON.parse(c.stdout()).ides.find((i: { ide: string }) => i.ide === 'codex');
    expect(codex).toMatchObject({ exists: false, wired: true, nativeManaged: true });
  });

  it('probes Codex TOML for a [mcp_servers.graphify] table', async () => {
    await mkdir(join(cwd, '.codex'));
    await writeFile(join(cwd, '.codex', 'config.toml'), '[mcp_servers.graphify]\ncommand = "python3"\n', 'utf8');
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const codex = JSON.parse(c.stdout()).ides.find((i: { ide: string }) => i.ide === 'codex');
    expect(codex).toMatchObject({ exists: true, wired: true });
  });

  it('ignores an unreadable user-owned root .mcp.json for Claude status', async () => {
    await writeFile(join(cwd, '.mcp.json'), '{ not json', 'utf8');
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const claude = JSON.parse(c.stdout()).ides.find((i: { ide: string }) => i.ide === 'claude');
    expect(claude).toMatchObject({ exists: false, wired: false, unreadable: false });
  });

  it('renders a human-readable table naming both agents', async () => {
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ cwd, userHome: home }, c.io)).rejects.toThrow();
    const out = c.stdout().replace(ANSI, '');
    expect(out).toContain('Claude Code');
    expect(out).toContain('Codex');
  });
});

describe('runGraphifyEnableCommand — enable → status round-trip', () => {
  it('a graphify enable run is visible to a subsequent status run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'coodra-graphify-rt-cwd-'));
    const home = await mkdtemp(join(tmpdir(), 'coodra-graphify-rt-home-'));
    const enableIo = makeIO();
    await expect(enable({ ide: 'all', cwd, userHome: home }, enableIo.io)).rejects.toThrow();
    const statusIo = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, statusIo.io)).rejects.toThrow();
    const report = JSON.parse(statusIo.stdout());
    expect(report.ides.find((i: { ide: string }) => i.ide === 'claude')?.wired).toBe(false);
    expect(report.ides.find((i: { ide: string }) => i.ide === 'codex')?.wired).toBe(true);
  });
});
