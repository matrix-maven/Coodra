import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphifyIO } from '../../../src/commands/graphify.js';
import { runGraphifyStatusCommand } from '../../../src/commands/graphify.js';

/**
 * Locks the Module 09 Track 9B `coodra graphify status` command surface.
 * Graphify wiring itself is Coodra-owned end to end — `coodra agent add
 * <agent>` installs the native Claude Code / Codex plugin, which bundles
 * a managed `graphify` MCP entry automatically alongside `coodra`. There
 * is no more `enable`/`disable` config-writing path; `status` is the only
 * remaining subcommand here and it is a read-only probe across both
 * agents plus the graph artifact state.
 *
 * Codex's probe is pure filesystem (`~/.codex/plugins/coodra/.mcp.json`)
 * so it's exercised for real. Claude's probe falls back to a real `claude`
 * CLI detection when one is on $PATH (see `probeClaudePlugin`), which
 * would make tests depend on the host environment, so `createClaudeCliRunner`
 * is mocked to force the deterministic file-based path.
 */

const { detect, isInstalled } = vi.hoisted(() => ({
  detect: vi.fn(async () => null as string | null),
  isInstalled: vi.fn(async () => false),
}));

vi.mock('../../../src/lib/agents/claude-plugin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/agents/claude-plugin.js')>();
  return {
    ...actual,
    createClaudeCliRunner: () => ({ detect, isInstalled }),
  };
});

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

describe('runGraphifyStatusCommand', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-graphify-status-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-graphify-status-home-'));
    detect.mockReset().mockResolvedValue(null);
    isInstalled.mockReset().mockResolvedValue(false);
  });

  it('reports both agents as not-wired on a clean tree (--json)', async () => {
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const report = JSON.parse(c.stdout());
    expect(report.server).toBe('graphify');
    expect(report.agents).toEqual([
      { id: 'claude', displayName: 'Claude Code', wired: false },
      { id: 'codex', displayName: 'Codex', wired: false },
    ]);
  });

  it('reports Codex as wired when the native plugin .mcp.json bundles graphify', async () => {
    await mkdir(join(home, '.codex', 'plugins', 'coodra'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'plugins', 'coodra', '.mcp.json'),
      JSON.stringify({ mcpServers: { coodra: { command: 'node' }, graphify: { command: 'python' } } }, null, 2),
      'utf8',
    );
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const report = JSON.parse(c.stdout());
    const codex = report.agents.find((a: { id: string }) => a.id === 'codex');
    expect(codex.wired).toBe(true);
    const claude = report.agents.find((a: { id: string }) => a.id === 'claude');
    expect(claude.wired).toBe(false);
  });

  it('reports Claude as wired when the CLI reports the plugin installed', async () => {
    detect.mockResolvedValue('/usr/local/bin/claude');
    isInstalled.mockResolvedValue(true);
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const report = JSON.parse(c.stdout());
    const claude = report.agents.find((a: { id: string }) => a.id === 'claude');
    expect(claude.wired).toBe(true);
  });

  it('includes graph artifact state in the JSON report', async () => {
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const report = JSON.parse(c.stdout());
    expect(report.artifacts).toBeDefined();
  });

  it('renders a human-readable table naming both agents', async () => {
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ cwd, userHome: home }, c.io)).rejects.toThrow();
    const out = c.stdout().replace(ANSI, '');
    expect(out).toContain('Claude Code');
    expect(out).toContain('Codex');
  });

  it('points at `coodra agent add` when an agent is not wired', async () => {
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ cwd, userHome: home }, c.io)).rejects.toThrow();
    const out = c.stdout().replace(ANSI, '');
    expect(out).toContain('coodra agent add');
  });
});
