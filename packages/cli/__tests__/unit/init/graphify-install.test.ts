import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type InstallCommandRunner,
  offerGraphifyInstall,
  planGraphifyInstall,
  runGraphifyInstall,
} from '../../../src/lib/init/graphify-install.js';
import type { GraphifyPythonResolution } from '../../../src/lib/init/graphify-python.js';

/**
 * Locks the install-first flow (2026-07-02): `coodra graphify enable` /
 * `coodra init --graphify` offer to install `graphifyy[mcp]` BEFORE
 * wiring, ask consent before touching an existing `.venv`, and wire the
 * verified venv interpreter on success. All subprocesses are stubbed.
 */

const okRunner: InstallCommandRunner = vi.fn(async () => ({ ok: true }) as const);

function unverified(python = 'python3'): GraphifyPythonResolution {
  return { python, verified: false, source: 'fallback', detail: "No module named 'graphify'" };
}

describe('planGraphifyInstall', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-gi-'));
  });

  it('with uv and no .venv: creates the venv then installs', () => {
    const plan = planGraphifyInstall({ cwd, hasUv: true, platform: 'darwin' });
    expect(plan.venvExists).toBe(false);
    expect(plan.tool).toBe('uv');
    expect(plan.steps.map((s) => [s.cmd, ...s.args])).toEqual([
      ['uv', 'venv', '.venv'],
      ['uv', 'pip', 'install', '--python', join(cwd, '.venv', 'bin', 'python'), 'graphifyy[mcp]'],
    ]);
  });

  it('with uv and an existing .venv: installs into it without recreating', async () => {
    await mkdir(join(cwd, '.venv'));
    const plan = planGraphifyInstall({ cwd, hasUv: true, platform: 'darwin' });
    expect(plan.venvExists).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.cmd).toBe('uv');
    expect(plan.steps[0]?.args).toContain('graphifyy[mcp]');
  });

  it('without uv: falls back to python3 -m venv + pip', () => {
    const plan = planGraphifyInstall({ cwd, hasUv: false, platform: 'linux' });
    expect(plan.tool).toBe('pip');
    expect(plan.steps.map((s) => [s.cmd, ...s.args])).toEqual([
      ['python3', '-m', 'venv', '.venv'],
      [join(cwd, '.venv', 'bin', 'python'), '-m', 'pip', 'install', 'graphifyy[mcp]'],
    ]);
  });

  it('uses the Scripts\\python.exe layout on win32', () => {
    const plan = planGraphifyInstall({ cwd, hasUv: true, platform: 'win32' });
    expect(plan.venvPython).toBe(join(cwd, '.venv', 'Scripts', 'python.exe'));
  });
});

describe('runGraphifyInstall', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-gi-'));
  });

  it('runs every step and returns the venv interpreter on success', async () => {
    const calls: string[] = [];
    const runner: InstallCommandRunner = async (cmd) => {
      calls.push(cmd);
      return { ok: true };
    };
    const plan = planGraphifyInstall({ cwd, hasUv: true, platform: 'darwin' });
    const result = await runGraphifyInstall(plan, { cwd, runner });
    expect(result).toEqual({ ok: true, venvPython: plan.venvPython });
    expect(calls).toEqual(['uv', 'uv']);
  });

  it('stops at the first failing step and reports it', async () => {
    const runner: InstallCommandRunner = async (_cmd, args) =>
      args[0] === 'venv' ? { ok: false, detail: 'disk full' } : { ok: true };
    const plan = planGraphifyInstall({ cwd, hasUv: true, platform: 'darwin' });
    const result = await runGraphifyInstall(plan, { cwd, runner });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStep).toContain('.venv');
      expect(result.detail).toBe('disk full');
    }
  });
});

describe('offerGraphifyInstall', () => {
  let cwd: string;
  let out: string[];
  const writeStdout = (chunk: string) => {
    out.push(chunk);
  };

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-gi-'));
    out = [];
  });

  it('returns a verified resolution unchanged without prompting', async () => {
    const resolution: GraphifyPythonResolution = { python: '/x/python', verified: true, source: 'venv' };
    const readPrompt = vi.fn();
    const result = await offerGraphifyInstall({
      resolution,
      cwd,
      interactive: true,
      readPrompt,
      writeStdout,
      runner: okRunner,
    });
    expect(result).toBe(resolution);
    expect(readPrompt).not.toHaveBeenCalled();
  });

  it('does nothing when installFlag is false (--no-install)', async () => {
    const resolution = unverified();
    const result = await offerGraphifyInstall({
      resolution,
      cwd,
      interactive: true,
      installFlag: false,
      readPrompt: vi.fn(),
      writeStdout,
      runner: okRunner,
    });
    expect(result).toBe(resolution);
  });

  it('does nothing when non-interactive and no --install flag', async () => {
    const resolution = unverified();
    const result = await offerGraphifyInstall({
      resolution,
      cwd,
      interactive: false,
      writeStdout,
      runner: okRunner,
      probeUv: async () => true,
    });
    expect(result).toBe(resolution);
  });

  it('asks venv-aware consent and respects a "n" answer', async () => {
    await mkdir(join(cwd, '.venv'));
    const readPrompt = vi.fn(async (q: string) => {
      expect(q).toContain('existing');
      return 'n';
    });
    const result = await offerGraphifyInstall({
      resolution: unverified(),
      cwd,
      interactive: true,
      readPrompt,
      writeStdout,
      runner: okRunner,
      probeUv: async () => true,
    });
    expect(result.verified).toBe(false);
    expect(readPrompt).toHaveBeenCalledOnce();
    expect(out.join('')).toContain('Skipping the install');
  });

  it('installs on consent, re-verifies, and returns the venv interpreter', async () => {
    const runner: InstallCommandRunner = vi.fn(async () => ({ ok: true }) as const);
    const result = await offerGraphifyInstall({
      resolution: unverified(),
      cwd,
      interactive: true,
      readPrompt: async () => 'y',
      writeStdout,
      runner,
      probeUv: async () => true,
      verify: async () => ({ ok: true }),
      platform: 'darwin',
    });
    expect(result.verified).toBe(true);
    expect(result.source).toBe('venv');
    expect(result.python).toBe(join(cwd, '.venv', 'bin', 'python'));
    expect(vi.mocked(runner)).toHaveBeenCalledTimes(2);
    expect(out.join('')).toContain('Installed graphifyy[mcp]');
  });

  it('an empty answer defaults to yes', async () => {
    const result = await offerGraphifyInstall({
      resolution: unverified(),
      cwd,
      interactive: true,
      readPrompt: async () => '',
      writeStdout,
      runner: okRunner,
      probeUv: async () => true,
      verify: async () => ({ ok: true }),
      platform: 'darwin',
    });
    expect(result.verified).toBe(true);
  });

  it('installFlag true installs without prompting', async () => {
    const readPrompt = vi.fn();
    const result = await offerGraphifyInstall({
      resolution: unverified(),
      cwd,
      interactive: false,
      installFlag: true,
      readPrompt,
      writeStdout,
      runner: okRunner,
      probeUv: async () => true,
      verify: async () => ({ ok: true }),
      platform: 'darwin',
    });
    expect(result.verified).toBe(true);
    expect(readPrompt).not.toHaveBeenCalled();
  });

  it('keeps the original resolution and reports the step when the install fails', async () => {
    const runner: InstallCommandRunner = async () => ({ ok: false, detail: 'network down' });
    const original = unverified();
    const result = await offerGraphifyInstall({
      resolution: original,
      cwd,
      interactive: true,
      readPrompt: async () => 'y',
      writeStdout,
      runner,
      probeUv: async () => true,
    });
    expect(result).toBe(original);
    expect(out.join('')).toContain('Install failed');
    expect(out.join('')).toContain('network down');
  });

  it('stays unverified (with the venv python + detail) when the post-install probe fails', async () => {
    const result = await offerGraphifyInstall({
      resolution: unverified(),
      cwd,
      interactive: true,
      readPrompt: async () => 'y',
      writeStdout,
      runner: okRunner,
      probeUv: async () => true,
      verify: async () => ({ ok: false, reason: 'import_failed', detail: 'boom' }),
      platform: 'darwin',
    });
    expect(result.verified).toBe(false);
    expect(result.python).toBe(join(cwd, '.venv', 'bin', 'python'));
    expect(result.detail).toBe('boom');
  });
});
