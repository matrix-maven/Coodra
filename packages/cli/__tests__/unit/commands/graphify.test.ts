import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type GraphifyIO,
  runGraphifyDisableCommand,
  runGraphifyEnableCommand,
  runGraphifyStatusCommand,
} from '../../../src/commands/graphify.js';

/**
 * Locks the Module 09 Track 9B `coodra graphify {enable,disable,status}`
 * command surface. The handlers operate over filesystem state only (no
 * DB, no daemon), wiring Graphify's own stdio MCP server into each
 * agent's config via the 9·Core substrate.
 *
 *   - enable writes a `graphify` entry; preserves `coodra` + siblings.
 *   - --python overrides the interpreter; Windsurf gets an absolute
 *     graph path (its config is global, no project anchor).
 *   - Codex (TOML) gets a real `[mcp_servers.graphify]` write — same as
 *     the three JSON agents.
 *   - enable seeds the `graphify-seed-packs` Feature recipe; --no-feature
 *     skips it.
 *   - disable strips only the `graphify` entry.
 *   - status is a read-only probe across all four agents.
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

describe('runGraphifyEnableCommand', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-graphify-enable-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-graphify-enable-home-'));
  });

  it('wires the `graphify` entry into <cwd>/.mcp.json for --ide claude', async () => {
    const c = makeIO();
    await expect(runGraphifyEnableCommand({ ide: 'claude', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const parsed = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.graphify.command).toBe('python3');
    expect(parsed.mcpServers.graphify.args).toEqual(['-m', 'graphify.serve', 'graphify-out/graph.json']);
  });

  it('--python overrides the interpreter on the written entry', async () => {
    const c = makeIO();
    await expect(
      runGraphifyEnableCommand({ ide: 'claude', python: '.venv/bin/python3', cwd, userHome: home }, c.io),
    ).rejects.toThrow();
    const parsed = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.graphify.command).toBe('.venv/bin/python3');
  });

  it('--graph overrides the graph path on the written entry', async () => {
    const c = makeIO();
    await expect(
      runGraphifyEnableCommand({ ide: 'claude', graph: 'out/g.json', cwd, userHome: home }, c.io),
    ).rejects.toThrow();
    const parsed = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.graphify.args).toEqual(['-m', 'graphify.serve', 'out/g.json']);
  });

  it('Windsurf gets an absolute graph path (global config has no project anchor)', async () => {
    const c = makeIO();
    await expect(runGraphifyEnableCommand({ ide: 'windsurf', cwd, userHome: home }, c.io)).rejects.toThrow();
    const wsPath = join(home, '.codeium', 'windsurf', 'mcp_config.json');
    const parsed = JSON.parse(await readFile(wsPath, 'utf8'));
    expect(parsed.mcpServers.graphify.args[2]).toBe(join(cwd, 'graphify-out', 'graph.json'));
  });

  it('writes a real [mcp_servers.graphify] table into Codex config.toml for --ide codex', async () => {
    const c = makeIO();
    await expect(runGraphifyEnableCommand({ ide: 'codex', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { graphify: { command: string; args: string[] } };
    };
    expect(parsed.mcp_servers.graphify.command).toBe('python3');
    expect(parsed.mcp_servers.graphify.args).toEqual(['-m', 'graphify.serve', 'graphify-out/graph.json']);
  });

  it('preserves the `coodra` entry and any sibling MCP servers', async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { coodra: { command: 'node' }, memory: { command: 'npx' } } }, null, 2),
      'utf8',
    );
    const c = makeIO();
    await expect(runGraphifyEnableCommand({ ide: 'claude', cwd, userHome: home }, c.io)).rejects.toThrow();
    const parsed = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.coodra.command).toBe('node');
    expect(parsed.mcpServers.memory.command).toBe('npx');
    expect(parsed.mcpServers.graphify.command).toBe('python3');
  });

  it('is idempotent — a second enable is a no-op', async () => {
    const first = makeIO();
    await expect(
      runGraphifyEnableCommand({ ide: 'claude', json: true, cwd, userHome: home }, first.io),
    ).rejects.toThrow();
    expect(JSON.parse(first.stdout()).results[0].action).toBe('wrote');
    const second = makeIO();
    await expect(
      runGraphifyEnableCommand({ ide: 'claude', json: true, cwd, userHome: home }, second.io),
    ).rejects.toThrow();
    const report = JSON.parse(second.stdout());
    expect(report.results[0].action).toBe('unchanged');
    expect(report.feature.action).toBe('unchanged');
  });

  it('leaves a drifted entry untouched without --force', async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { graphify: { command: 'custom' } } }, null, 2),
      'utf8',
    );
    const c = makeIO();
    await expect(runGraphifyEnableCommand({ ide: 'claude', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8')).mcpServers.graphify.command).toBe('custom');
  });

  it('--force overwrites a drifted entry', async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { graphify: { command: 'custom' } } }, null, 2),
      'utf8',
    );
    const c = makeIO();
    await expect(runGraphifyEnableCommand({ ide: 'claude', force: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8')).mcpServers.graphify.command).toBe('python3');
  });

  it('--dry-run writes nothing to disk (no config, no feature)', async () => {
    const c = makeIO();
    await expect(
      runGraphifyEnableCommand({ ide: 'claude', dryRun: true, cwd, userHome: home }, c.io),
    ).rejects.toThrow();
    await expect(readFile(join(cwd, '.mcp.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(cwd, FEATURE_MD), 'utf8')).rejects.toThrow();
  });

  it('--ide all wires all four agents, Codex included', async () => {
    const c = makeIO();
    await expect(runGraphifyEnableCommand({ ide: 'all', json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const report = JSON.parse(c.stdout());
    expect(report.ok).toBe(true);
    const byIde = Object.fromEntries(report.results.map((r: { ide: string; action: string }) => [r.ide, r.action]));
    expect(byIde.claude).toBe('wrote');
    expect(byIde.cursor).toBe('wrote');
    expect(byIde.windsurf).toBe('wrote');
    expect(byIde.codex).toBe('wrote');
    // Codex's TOML config carries a real graphify table now.
    const codexCfg = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { graphify?: unknown };
    };
    expect(codexCfg.mcp_servers.graphify).toBeDefined();
  });

  it('seeds the graphify-seed-packs Feature recipe + regenerates the index', async () => {
    const c = makeIO();
    await expect(runGraphifyEnableCommand({ ide: 'claude', json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const report = JSON.parse(c.stdout());
    expect(report.feature).toMatchObject({ slug: 'graphify-seed-packs', action: 'wrote' });
    const featureMd = await readFile(join(cwd, FEATURE_MD), 'utf8');
    expect(featureMd).toContain('name: graphify-seed-packs');
    expect(featureMd).toContain('coodra__seed_feature_packs_from_graph');
    // The features index is regenerated so the bridge / MCP can see it.
    const indexJson = JSON.parse(await readFile(join(cwd, 'docs', 'features', 'INDEX.json'), 'utf8'));
    expect(indexJson.features.map((f: { slug: string }) => f.slug)).toContain('graphify-seed-packs');
  });

  it('--no-feature skips the graphify-seed-packs Feature seed', async () => {
    const c = makeIO();
    await expect(
      runGraphifyEnableCommand({ ide: 'claude', feature: false, json: true, cwd, userHome: home }, c.io),
    ).rejects.toThrow();
    expect(JSON.parse(c.stdout()).feature).toBeNull();
    await expect(readFile(join(cwd, FEATURE_MD), 'utf8')).rejects.toThrow();
  });

  it('autodetects installed agents when --ide is omitted', async () => {
    await mkdir(join(home, '.claude'));
    const c = makeIO();
    await expect(runGraphifyEnableCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const report = JSON.parse(c.stdout());
    expect(report.results.map((r: { ide: string }) => r.ide)).toEqual(['claude']);
  });

  it('exits user-recoverable (1) when no IDE is detected and none is named', async () => {
    const c = makeIO();
    await expect(runGraphifyEnableCommand({ cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(1);
    expect(c.stderr()).toContain('No supported IDE detected');
  });

  it('exits user-recoverable (1) on an unknown --ide value', async () => {
    const c = makeIO();
    await expect(runGraphifyEnableCommand({ ide: 'intellij', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(1);
  });

  it('emits the install + graph-build prerequisites in human output', async () => {
    const c = makeIO();
    await expect(runGraphifyEnableCommand({ ide: 'claude', cwd, userHome: home }, c.io)).rejects.toThrow();
    const out = c.stdout().replace(ANSI, '');
    expect(out).toContain('graphifyy[mcp]');
    expect(out).toContain('/graphify .');
  });
});

describe('runGraphifyDisableCommand', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-graphify-disable-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-graphify-disable-home-'));
  });

  it('strips the `graphify` entry but leaves `coodra` intact', async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { coodra: { command: 'node' }, graphify: { command: 'python3' } } }, null, 2),
      'utf8',
    );
    const c = makeIO();
    await expect(runGraphifyDisableCommand({ ide: 'claude', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const parsed = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.graphify).toBeUndefined();
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
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { coodra: { command: 'node' } } }, null, 2),
      'utf8',
    );
    const c = makeIO();
    await expect(runGraphifyDisableCommand({ ide: 'claude', json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(JSON.parse(c.stdout()).results[0].action).toBe('unchanged');
  });

  it('--dry-run writes nothing to disk', async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { graphify: { command: 'python3' } } }, null, 2),
      'utf8',
    );
    const c = makeIO();
    await expect(
      runGraphifyDisableCommand({ ide: 'claude', dryRun: true, cwd, userHome: home }, c.io),
    ).rejects.toThrow();
    expect(JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8')).mcpServers.graphify.command).toBe('python3');
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
    expect(report.ides.map((i: { ide: string }) => i.ide)).toEqual(['claude', 'cursor', 'windsurf', 'codex']);
    expect(report.ides.every((i: { wired: boolean; exists: boolean }) => i.wired === false && i.exists === false)).toBe(
      true,
    );
  });

  it('reports a wired agent after enable', async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { graphify: { command: 'python3' } } }, null, 2),
      'utf8',
    );
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const claude = JSON.parse(c.stdout()).ides.find((i: { ide: string }) => i.ide === 'claude');
    expect(claude).toMatchObject({ exists: true, wired: true, unreadable: false });
  });

  it('probes Codex TOML for a [mcp_servers.graphify] table', async () => {
    await mkdir(join(cwd, '.codex'));
    await writeFile(join(cwd, '.codex', 'config.toml'), '[mcp_servers.graphify]\ncommand = "python3"\n', 'utf8');
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const codex = JSON.parse(c.stdout()).ides.find((i: { ide: string }) => i.ide === 'codex');
    expect(codex).toMatchObject({ exists: true, wired: true });
  });

  it('flags an unreadable config file', async () => {
    await writeFile(join(cwd, '.mcp.json'), '{ not json', 'utf8');
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const claude = JSON.parse(c.stdout()).ides.find((i: { ide: string }) => i.ide === 'claude');
    expect(claude).toMatchObject({ exists: true, wired: false, unreadable: true });
  });

  it('renders a human-readable table naming all four agents', async () => {
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ cwd, userHome: home }, c.io)).rejects.toThrow();
    const out = c.stdout().replace(ANSI, '');
    expect(out).toContain('Claude Code');
    expect(out).toContain('Cursor');
    expect(out).toContain('Windsurf');
    expect(out).toContain('Codex');
  });
});

describe('runGraphifyEnableCommand — enable → status round-trip', () => {
  it('a graphify enable run is visible to a subsequent status run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'coodra-graphify-rt-cwd-'));
    const home = await mkdtemp(join(tmpdir(), 'coodra-graphify-rt-home-'));
    const enableIo = makeIO();
    await expect(runGraphifyEnableCommand({ ide: 'all', cwd, userHome: home }, enableIo.io)).rejects.toThrow();
    const statusIo = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, statusIo.io)).rejects.toThrow();
    const report = JSON.parse(statusIo.stdout());
    expect(report.ides.every((i: { wired: boolean }) => i.wired === true)).toBe(true);
  });
});
