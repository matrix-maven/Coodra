import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphifyIO } from '../../../src/commands/graphify.js';
import { runGraphifyStatusCommand } from '../../../src/commands/graphify.js';

/**
 * Locks the Module 09 Track 9B `coodra graphify status` command surface.
 * Graphify wiring itself is Coodra-owned end to end — `coodra agent add
 * <agent>` installs the native Claude Code / Codex / Cursor plugin, which
 * bundles a managed `graphify` MCP entry automatically alongside `coodra`.
 * There is no more `enable`/`disable` config-writing path; `status` is the
 * only remaining subcommand here and it is a read-only probe across every
 * agent plus the graph artifact state.
 *
 * The Claude/Codex probes fall back to the real `claude`/`codex` CLI when
 * one is on $PATH (see `probeClaudePlugin`/`probeCodexPlugin`), which would
 * make tests depend on the host environment, so `createClaudeCliRunner` and
 * `createCodexCliRunner` are both mocked to force the deterministic
 * file-based fallback path. `probeCursorPlugin` has no CLI runner at all —
 * it's a pure filesystem probe, so it needs no such mock.
 */

const { detect, isInstalled } = vi.hoisted(() => ({
  detect: vi.fn(async () => null as string | null),
  isInstalled: vi.fn(async () => false),
}));

const { codexDetect, codexIsInstalled } = vi.hoisted(() => ({
  codexDetect: vi.fn(async () => null as { path: string; viaPath: boolean } | null),
  codexIsInstalled: vi.fn(async () => false),
}));

vi.mock('../../../src/lib/agents/claude-plugin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/agents/claude-plugin.js')>();
  return {
    ...actual,
    createClaudeCliRunner: () => ({ detect, isInstalled }),
  };
});

vi.mock('../../../src/lib/agents/codex-plugin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/agents/codex-plugin.js')>();
  return {
    ...actual,
    createCodexCliRunner: () => ({
      detect: codexDetect,
      isInstalled: codexIsInstalled,
      installMarketplaceAndPlugin: async () => ({ ok: true }),
      uninstallPlugin: async () => ({ ok: true }),
    }),
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
    codexDetect.mockReset().mockResolvedValue(null);
    codexIsInstalled.mockReset().mockResolvedValue(false);
  });

  it('reports all agents as not-wired on a clean tree (--json)', async () => {
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const report = JSON.parse(c.stdout());
    expect(report.server).toBe('graphify');
    expect(report.agents).toEqual([
      { id: 'claude', displayName: 'Claude Code', wired: false },
      { id: 'codex', displayName: 'Codex', wired: false },
      { id: 'cursor', displayName: 'Cursor', wired: false },
    ]);
  });

  it('reports Codex as wired when the native plugin .mcp.json bundles graphify', async () => {
    const codexPluginRoot = join(home, '.coodra', 'codex-marketplaces', 'coodra', 'plugins', 'coodra');
    await mkdir(codexPluginRoot, { recursive: true });
    await writeFile(
      join(codexPluginRoot, '.mcp.json'),
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

  it('reports Cursor as wired when the local plugin mcp.json bundles graphify', async () => {
    const cursorPluginRoot = join(home, '.cursor', 'plugins', 'local', 'coodra');
    await mkdir(cursorPluginRoot, { recursive: true });
    await writeFile(
      join(cursorPluginRoot, 'mcp.json'),
      JSON.stringify({ mcpServers: { coodra: { command: 'node' }, graphify: { command: 'python' } } }, null, 2),
      'utf8',
    );
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const report = JSON.parse(c.stdout());
    const cursor = report.agents.find((a: { id: string }) => a.id === 'cursor');
    expect(cursor.wired).toBe(true);
  });

  it('includes graph artifact state in the JSON report', async () => {
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const report = JSON.parse(c.stdout());
    expect(report.artifacts).toBeDefined();
  });

  it('renders a human-readable table naming every agent', async () => {
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ cwd, userHome: home }, c.io)).rejects.toThrow();
    const out = c.stdout().replace(ANSI, '');
    expect(out).toContain('Claude Code');
    expect(out).toContain('Codex');
    expect(out).toContain('Cursor');
  });

  it('points at `coodra agent add` when an agent is not wired', async () => {
    const c = makeIO();
    await expect(runGraphifyStatusCommand({ cwd, userHome: home }, c.io)).rejects.toThrow();
    const out = c.stdout().replace(ANSI, '');
    expect(out).toContain('coodra agent add');
  });
});
