import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemdDaemonManager, type SystemdManagerOptions } from '../../../src/lib/daemon/systemd.js';

type FakeExeca = NonNullable<SystemdManagerOptions['execa']>;

function fakeExeca(
  impl: (file: string, args: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string },
): FakeExeca {
  return vi.fn(async (file: string, args: readonly string[]) => impl(file, args)) as unknown as FakeExeca;
}

describe('SystemdDaemonManager — service-file write + systemctl wiring', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'coodra-daemon-systemd-'));
  });

  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('isAvailable returns true when systemctl --user --version exits 0', async () => {
    const mgr = new SystemdDaemonManager({
      homeDir: home,
      execa: fakeExeca(() => ({ exitCode: 0, stdout: 'systemd 252' })),
    });
    expect(await mgr.isAvailable()).toBe(true);
  });

  it('install writes ~/.config/systemd/user/coodra-<name>.service + runs daemon-reload', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const mgr = new SystemdDaemonManager({
      homeDir: home,
      execa: fakeExeca((file, args) => {
        calls.push({ file, args: [...args] });
        return { exitCode: 0 };
      }),
    });
    await mgr.install({
      name: 'mcp',
      command: '/usr/bin/node',
      args: ['/opt/coodra/dist/index.js', '--transport', 'stdio'],
      env: { COODRA_LOG_DESTINATION: 'stderr' },
    });
    const body = await readFile(join(home, '.config/systemd/user/coodra-mcp.service'), 'utf8');
    expect(body).toContain('[Unit]');
    expect(body).toContain('[Service]');
    expect(body).toContain('Type=simple');
    expect(body).toContain('ExecStart=/usr/bin/node');
    expect(body).toContain('Restart=on-failure');
    // beta.8 — env lines are now `Environment="KEY=VALUE"` (whole
    // assignment quoted) so values with spaces / specials survive.
    expect(body).toContain('Environment="COODRA_LOG_DESTINATION=stderr"');
    // W5 / beta.5 — install runs daemon-reload THEN reset-failed so a
    // unit previously latched into `failed` by systemd's restart
    // rate-limiter becomes startable again on the next `coodra start`.
    expect(calls).toEqual([
      { file: 'systemctl', args: ['--user', 'daemon-reload'] },
      { file: 'systemctl', args: ['--user', 'reset-failed', 'coodra-mcp.service'] },
    ]);
  });

  it('escapes % in Environment values as %% (systemd specifier-expansion guard)', async () => {
    // beta.8 regression guard. A URL-encoded Postgres password like
    // `Abi%4029250204` (%40 = encoded `@`) contains `%4`, which systemd
    // tries to expand as a specifier on `Environment=` lines. Pre-fix
    // this mangled/dropped DATABASE_URL → sync-daemon booted with
    // `DATABASE_URL=undefined` and crash-looped. Every `%` must be `%%`.
    const mgr = new SystemdDaemonManager({
      homeDir: home,
      execa: fakeExeca(() => ({ exitCode: 0 })),
    });
    const databaseUrl = 'postgresql://postgres:Abi%4029250204@db.example.supabase.co:5432/postgres';
    await mgr.install({
      name: 'sync-daemon',
      command: '/usr/bin/node',
      args: ['/opt/coodra/dist/runtime/sync-daemon/index.js'],
      env: { DATABASE_URL: databaseUrl },
    });
    const body = await readFile(join(home, '.config/systemd/user/coodra-sync-daemon.service'), 'utf8');
    // The raw %40 must NOT appear; it must be doubled to %%40.
    expect(body).toContain(
      'Environment="DATABASE_URL=postgresql://postgres:Abi%%4029250204@db.example.supabase.co:5432/postgres"',
    );
    expect(body).not.toMatch(/Environment="DATABASE_URL=[^"]*[^%]%4029250204/);
  });

  it('start runs systemctl --user restart <unit> so re-starts pick up the new env', async () => {
    // `start` was changed to `restart` so a second `coodra start`
    // after a unit-file change always picks up the latest env. systemd's
    // `start` is a no-op on an already-active unit; `restart` does
    // stop+start and re-reads the (already daemon-reloaded) unit file.
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const mgr = new SystemdDaemonManager({
      homeDir: home,
      execa: fakeExeca((file, args) => {
        calls.push({ file, args: [...args] });
        return { exitCode: 0 };
      }),
    });
    await mgr.install({ name: 'svc', command: '/x', args: [], env: {} });
    calls.length = 0; // discard daemon-reload from install
    await mgr.start('svc');
    expect(calls).toEqual([{ file: 'systemctl', args: ['--user', 'restart', 'coodra-svc.service'] }]);
  });

  it('status parses ActiveState=active + MainPID', async () => {
    const mgr = new SystemdDaemonManager({
      homeDir: home,
      execa: fakeExeca(() => ({
        exitCode: 0,
        stdout: 'ActiveState=active\nMainPID=9876\n',
      })),
    });
    const status = await mgr.status('svc');
    expect(status.state).toBe('running');
    expect(status.pid).toBe(9876);
  });

  it('status returns stopped when ActiveState=inactive', async () => {
    const mgr = new SystemdDaemonManager({
      homeDir: home,
      execa: fakeExeca(() => ({
        exitCode: 0,
        stdout: 'ActiveState=inactive\nMainPID=0\n',
      })),
    });
    const status = await mgr.status('svc');
    expect(status.state).toBe('stopped');
  });

  it('install renders StandardOutput=append + StandardError=append when paths are set', async () => {
    const mgr = new SystemdDaemonManager({
      homeDir: home,
      execa: fakeExeca(() => ({ exitCode: 0 })),
    });
    await mgr.install({
      name: 'svc-logs',
      command: '/usr/bin/node',
      args: ['/opt/x.js'],
      env: {},
      stdoutPath: '/var/test/.coodra/logs/svc-logs.log',
      stderrPath: '/var/test/.coodra/logs/svc-logs.log',
    });
    const body = await readFile(join(home, '.config/systemd/user/coodra-svc-logs.service'), 'utf8');
    expect(body).toContain('StandardOutput=append:/var/test/.coodra/logs/svc-logs.log');
    expect(body).toContain('StandardError=append:/var/test/.coodra/logs/svc-logs.log');
  });
});
