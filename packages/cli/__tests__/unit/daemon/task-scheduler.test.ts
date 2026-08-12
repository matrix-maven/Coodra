import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ExecaLike, TaskSchedulerDaemonManager } from '../../../src/lib/daemon/task-scheduler.js';
import type { DaemonUnit } from '../../../src/lib/daemon/types.js';

describe('TaskSchedulerDaemonManager', () => {
  let coodraHome: string;
  let calls: Array<{ file: string; args: readonly string[] }>;

  beforeEach(async () => {
    coodraHome = await mkdtemp(join(tmpdir(), 'coodra-task-scheduler-'));
    calls = [];
  });

  function fakeRun(stdout = ''): ExecaLike {
    return vi.fn(async (file, args) => {
      calls.push({ file, args });
      return { exitCode: 0, stdout } as Awaited<ReturnType<ExecaLike>>;
    }) as unknown as ExecaLike;
  }

  function unit(overrides: Partial<DaemonUnit> = {}): DaemonUnit {
    return {
      name: 'web',
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Users\\alice\\.coodra\\runtime\\web\\server.js'],
      env: { COODRA_HOME: 'C:\\Users\\alice\\.coodra', DATABASE_URL: 'postgres://x:y@h/db%40safe' },
      workingDir: 'C:\\Users\\alice\\project',
      stdoutPath: 'C:\\Users\\alice\\.coodra\\logs\\web.log',
      stderrPath: 'C:\\Users\\alice\\.coodra\\logs\\web.log',
      ...overrides,
    };
  }

  it('creates an ONLOGON scheduled task backed by a Coodra launcher cmd', async () => {
    const manager = new TaskSchedulerDaemonManager({ coodraHome, execa: fakeRun() });

    await manager.install(unit());

    expect(calls).toEqual([
      {
        file: 'schtasks.exe',
        args: [
          '/Create',
          '/TN',
          '\\Coodra\\web',
          '/SC',
          'ONLOGON',
          '/TR',
          `"${join(coodraHome, 'tasks', 'web.cmd')}"`,
          '/F',
        ],
      },
    ]);
    const launcher = await readFile(join(coodraHome, 'tasks', 'web.cmd'), 'utf8');
    expect(launcher).toContain('set "COODRA_HOME=C:\\Users\\alice\\.coodra"');
    expect(launcher).toContain('set "DATABASE_URL=postgres://x:y@h/db%%40safe"');
    expect(launcher).toContain('"C:\\Program Files\\nodejs\\node.exe"');
  });

  it('escapes quotes in env values and preserves non-path args verbatim', async () => {
    const manager = new TaskSchedulerDaemonManager({ coodraHome, execa: fakeRun() });

    await manager.install(
      unit({
        args: ['C:\\Users\\alice\\.coodra\\runtime\\web\\server.js', '--origin=https://example.com/api/v1'],
        env: {
          COODRA_HOME: 'C:\\Users\\alice\\.coodra',
          DATABASE_URL: 'postgres://user:p"ss@host/db%40safe',
          CARET_VALUE: 'a^b',
        },
      }),
    );

    const launcher = await readFile(join(coodraHome, 'tasks', 'web.cmd'), 'utf8');
    expect(launcher).toContain('set "DATABASE_URL=postgres://user:p^"ss@host/db%%40safe"');
    expect(launcher).toContain('set "CARET_VALUE=a^^b"');
    expect(launcher).toContain('"--origin=https://example.com/api/v1"');
    expect(launcher).not.toContain('https:\\\\example.com\\\\api\\\\v1');
  });

  it('maps running and ready task states to daemon status', async () => {
    const running = new TaskSchedulerDaemonManager({ coodraHome, execa: fakeRun('Status: Running\r\n') });
    await expect(running.status('web')).resolves.toEqual({ name: 'web', state: 'running' });

    const ready = new TaskSchedulerDaemonManager({ coodraHome, execa: fakeRun('Status: Ready\r\n') });
    await expect(ready.status('web')).resolves.toEqual({ name: 'web', state: 'stopped', detail: 'ready' });
  });
});
