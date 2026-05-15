import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LaunchdDaemonManager, type LaunchdManagerOptions } from '../../../src/lib/daemon/launchd.js';

type FakeExeca = NonNullable<LaunchdManagerOptions['execa']>;

function fakeExeca(
  impl: (file: string, args: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string },
): FakeExeca {
  return vi.fn(async (file: string, args: readonly string[]) => impl(file, args)) as unknown as FakeExeca;
}

describe('LaunchdDaemonManager — plist write + launchctl wiring', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'coodra-daemon-launchd-'));
  });

  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('isAvailable returns true when launchctl version exits 0', async () => {
    const mgr = new LaunchdDaemonManager({
      homeDir: home,
      execa: fakeExeca(() => ({ exitCode: 0, stdout: 'launchctl 1003.0.0' })),
    });
    expect(await mgr.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when launchctl is unreachable', async () => {
    const mgr = new LaunchdDaemonManager({
      homeDir: home,
      execa: fakeExeca(() => ({ exitCode: 127, stderr: 'command not found' })),
    });
    expect(await mgr.isAvailable()).toBe(false);
  });

  it('install writes a plist with com.coodra.<name> label + ProgramArguments + env', async () => {
    let called: { file: string; args: readonly string[] } | null = null;
    const mgr = new LaunchdDaemonManager({
      homeDir: home,
      execa: fakeExeca((file, args) => {
        called = { file, args: [...args] };
        return { exitCode: 0 };
      }),
    });
    await mgr.install({
      name: 'test',
      command: '/usr/local/bin/coodra-mcp-server',
      args: ['--transport', 'stdio'],
      env: { COODRA_LOG_DESTINATION: 'stderr' },
    });
    const plist = await readFile(join(home, 'Library/LaunchAgents/com.coodra.test.plist'), 'utf8');
    expect(plist).toContain('<string>com.coodra.test</string>');
    expect(plist).toContain('<string>/usr/local/bin/coodra-mcp-server</string>');
    expect(plist).toContain('<string>--transport</string>');
    expect(plist).toContain('<string>stdio</string>');
    expect(plist).toContain('<key>COODRA_LOG_DESTINATION</key>');
    expect(plist).toContain('<string>stderr</string>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    // install() does not auto-bootstrap — that happens in start().
    expect(called).toBeNull();
  });

  it('start invokes launchctl bootout-then-bootstrap so re-starts pick up new plists', async () => {
    // Background: launchctl bootstrap is a no-op when the label is
    // already loaded. A second `coodra start` with a different
    // COODRA_HOME used to be silently ignored; the daemon kept its
    // stale env. Fix: bootout-first, then bootstrap. Verify both calls.
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const mgr = new LaunchdDaemonManager({
      homeDir: home,
      execa: fakeExeca((file, args) => {
        calls.push({ file, args: [...args] });
        return { exitCode: 0 };
      }),
    });
    await mgr.install({ name: 'svc', command: '/x', args: [], env: {} });
    await mgr.start('svc');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.file).toBe('launchctl');
    expect(calls[0]?.args[0]).toBe('bootout');
    expect(calls[0]?.args[1]).toMatch(/^gui\/\d+\/com\.coodra\.svc$/);
    expect(calls[1]?.file).toBe('launchctl');
    expect(calls[1]?.args[0]).toBe('bootstrap');
    expect(calls[1]?.args[1]).toMatch(/^gui\/\d+$/);
    expect(String(calls[1]?.args[2])).toContain('com.coodra.svc.plist');
  });

  it('status parses pid from `launchctl print` output', async () => {
    const mgr = new LaunchdDaemonManager({
      homeDir: home,
      execa: fakeExeca((_file, _args) => ({
        exitCode: 0,
        stdout: 'state = running\npid = 4242\n',
      })),
    });
    const status = await mgr.status('svc');
    expect(status.state).toBe('running');
    expect(status.pid).toBe(4242);
  });

  it('status returns stopped when launchctl print exits non-zero', async () => {
    const mgr = new LaunchdDaemonManager({
      homeDir: home,
      execa: fakeExeca(() => ({ exitCode: 113, stderr: 'unknown service' })),
    });
    expect((await mgr.status('svc')).state).toBe('stopped');
  });

  it('install renders StandardErrorPath + StandardOutPath when stderrPath/stdoutPath are set', async () => {
    const mgr = new LaunchdDaemonManager({
      homeDir: home,
      execa: fakeExeca(() => ({ exitCode: 0 })),
    });
    await mgr.install({
      name: 'test-logs',
      command: '/usr/local/bin/coodra-bridge',
      args: [],
      env: {},
      stdoutPath: '/var/test/.coodra/logs/test-logs.log',
      stderrPath: '/var/test/.coodra/logs/test-logs.log',
    });
    const plist = await readFile(join(home, 'Library/LaunchAgents/com.coodra.test-logs.plist'), 'utf8');
    expect(plist).toContain('<key>StandardOutPath</key><string>/var/test/.coodra/logs/test-logs.log</string>');
    expect(plist).toContain('<key>StandardErrorPath</key><string>/var/test/.coodra/logs/test-logs.log</string>');
  });

  it('install omits StandardErrorPath/StandardOutPath when paths not set (back-compat)', async () => {
    const mgr = new LaunchdDaemonManager({
      homeDir: home,
      execa: fakeExeca(() => ({ exitCode: 0 })),
    });
    await mgr.install({ name: 'no-logs', command: '/x', args: [], env: {} });
    const plist = await readFile(join(home, 'Library/LaunchAgents/com.coodra.no-logs.plist'), 'utf8');
    expect(plist).not.toContain('<key>StandardOutPath</key>');
    expect(plist).not.toContain('<key>StandardErrorPath</key>');
  });
});
