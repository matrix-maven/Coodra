import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureManagedGraphifyRuntime,
  managedGraphifyPythonPath,
  managedGraphifyRuntimeRoot,
} from '../../../src/lib/graphify/managed-runtime.js';
import type { InstallCommandRunner } from '../../../src/lib/init/graphify-install.js';

describe('managed Graphify MCP runtime', () => {
  let coodraHome: string;

  beforeEach(async () => {
    coodraHome = await mkdtemp(join(tmpdir(), 'coodra-graphify-runtime-'));
  });

  it('resolves the Coodra-owned runtime paths', () => {
    expect(managedGraphifyRuntimeRoot(coodraHome)).toBe(join(coodraHome, 'graphify-mcp'));
    expect(managedGraphifyPythonPath(coodraHome, 'darwin')).toBe(
      join(coodraHome, 'graphify-mcp', '.venv', 'bin', 'python'),
    );
  });

  it('uses uv when available to install graphifyy[mcp] into the machine runtime venv', async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const runner: InstallCommandRunner = vi.fn(async (cmd, args) => {
      calls.push([cmd, args]);
      return { ok: true as const };
    });

    const result = await ensureManagedGraphifyRuntime({
      coodraHome,
      dryRun: false,
      runner,
      probeUv: async () => true,
      verify: async (pythonPath) =>
        calls.length === 0
          ? { ok: false, reason: 'import_failed', detail: 'missing graphify' }
          : pythonPath === managedGraphifyPythonPath(coodraHome, 'darwin')
            ? { ok: true }
            : { ok: false, reason: 'import_failed', detail: 'wrong python' },
      platform: 'darwin',
    });

    expect(result).toMatchObject({
      ok: true,
      python: managedGraphifyPythonPath(coodraHome, 'darwin'),
      installed: true,
      tool: 'uv',
    });
    expect(calls).toEqual([
      ['uv', ['venv', '.venv']],
      ['uv', ['pip', 'install', '--python', managedGraphifyPythonPath(coodraHome, 'darwin'), 'graphifyy[mcp]']],
    ]);
  });

  it('falls back to python venv + pip when uv is unavailable', async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const runner: InstallCommandRunner = vi.fn(async (cmd, args) => {
      calls.push([cmd, args]);
      return { ok: true as const };
    });

    const result = await ensureManagedGraphifyRuntime({
      coodraHome,
      dryRun: false,
      runner,
      probeUv: async () => false,
      verify: async () =>
        calls.length === 0 ? { ok: false, reason: 'import_failed', detail: 'missing graphify' } : { ok: true },
      platform: 'linux',
    });

    expect(result).toMatchObject({ ok: true, installed: true, tool: 'pip' });
    expect(calls).toEqual([
      ['python3', ['-m', 'venv', '.venv']],
      [managedGraphifyPythonPath(coodraHome, 'linux'), ['-m', 'pip', 'install', 'graphifyy[mcp]']],
    ]);
  });

  it('keeps an existing verified runtime without reinstalling', async () => {
    const runner: InstallCommandRunner = vi.fn(async () => ({ ok: true as const }));

    const result = await ensureManagedGraphifyRuntime({
      coodraHome,
      dryRun: false,
      runner,
      verify: async () => ({ ok: true }),
      platform: 'darwin',
    });

    expect(result).toMatchObject({ ok: true, installed: false, tool: 'existing' });
    expect(runner).not.toHaveBeenCalled();
  });
});
