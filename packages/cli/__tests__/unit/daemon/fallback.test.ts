import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FallbackDaemonManager } from '../../../src/lib/daemon/fallback.js';

describe('FallbackDaemonManager — real-spawn integration', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'coodra-daemon-fallback-'));
    await mkdir(join(home, 'pids'), { recursive: true });
  });

  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('install + start + status + stop lifecycle against `node -e "setInterval(...)"`', async () => {
    const mgr = new FallbackDaemonManager({ coodraHome: home });

    expect(await mgr.isAvailable()).toBe(true);

    // Install a long-running noop daemon.
    await mgr.install({
      name: 'test-daemon',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 60_000)'],
      env: {},
    });

    // Check the unit file landed.
    const unitPath = join(home, 'pids', 'test-daemon.unit.json');
    const record = JSON.parse(await readFile(unitPath, 'utf8'));
    expect(record.name).toBe('test-daemon');
    expect(record.command).toBe(process.execPath);

    // Start it.
    await mgr.start('test-daemon');
    let status = await mgr.status('test-daemon');
    expect(status.state).toBe('running');
    expect(status.pid).toBeGreaterThan(0);

    // List should include it.
    const list = await mgr.list();
    expect(list.find((s) => s.name === 'test-daemon')?.state).toBe('running');

    // Stop is idempotent: first call kills, second call no-ops.
    await mgr.stop('test-daemon');
    await mgr.stop('test-daemon');
    status = await mgr.status('test-daemon');
    expect(status.state).toBe('stopped');

    // Uninstall removes both files.
    await mgr.uninstall('test-daemon');
    await expect(readFile(unitPath, 'utf8')).rejects.toThrow();
  });

  it('start force-restarts when already running so a re-installed unit picks up the new env', async () => {
    // The OLD contract was "start is idempotent — second call no-ops".
    // That was a bug: after `coodra start` is invoked a second time
    // with a different COODRA_HOME, the previously-spawned process
    // continued to serve the OLD env and the new install() was silently
    // ignored. The contract is now: `start` always tears down any prior
    // instance first, then spawns fresh against the latest installed
    // unit. Verify the second start produces a different PID.
    const mgr = new FallbackDaemonManager({ coodraHome: home });
    await mgr.install({
      name: 'idempo',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 60_000)'],
      env: {},
    });
    await mgr.start('idempo');
    const first = await mgr.status('idempo');
    expect(first.state).toBe('running');
    await mgr.start('idempo');
    const second = await mgr.status('idempo');
    expect(second.state).toBe('running');
    expect(second.pid).not.toBe(first.pid);
    await mgr.stop('idempo');
    await mgr.uninstall('idempo');
  });

  it('status returns stopped when no PID file exists', async () => {
    const mgr = new FallbackDaemonManager({ coodraHome: home });
    expect((await mgr.status('never-installed')).state).toBe('stopped');
  });

  it('start throws when no unit was installed', async () => {
    const mgr = new FallbackDaemonManager({ coodraHome: home });
    await expect(mgr.start('not-here')).rejects.toThrow(/no unit installed/);
  });
});
