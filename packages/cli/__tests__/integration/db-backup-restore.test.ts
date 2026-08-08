import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, migrateSqlite } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type DbBackupIO, runDbBackupCommand } from '../../src/commands/db-backup.js';
import { type DbRestoreIO, runDbRestoreCommand } from '../../src/commands/db-restore.js';
import { EXIT_BACKUP_RESTORE_PRECONDITION, EXIT_OK, EXIT_USER_RECOVERABLE } from '../../src/exit-codes.js';
import { resolveCoodraDataDb } from '../../src/lib/coodra-home.js';
import type { DaemonManager } from '../../src/lib/daemon/index.js';

/**
 * Hermetic daemon-manager stub for the restore preflight. `running` maps a
 * unit name → whether the platform manager reports it as running. Restore
 * tests MUST inject one — otherwise the preflight resolves the real
 * launchd/systemd manager, which on a dev machine reports Coodra's own
 * units as running and makes every restore test refuse.
 */
function makeStubDaemonManager(running: Record<string, boolean> = {}): DaemonManager {
  return {
    kind: 'launchd',
    isAvailable: async () => true,
    install: async () => {},
    uninstall: async () => {},
    start: async () => {},
    stop: async () => {},
    status: async (u: string) => ({
      name: u,
      state: running[u] === true ? ('running' as const) : ('stopped' as const),
    }),
    list: async () => [],
  };
}

interface Capture {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

function backupIo(home: string, cap: Capture): DbBackupIO {
  return {
    writeStdout: (c) => cap.stdout.push(c),
    writeStderr: (c) => cap.stderr.push(c),
    exit: (code) => {
      cap.exitCode = code;
      throw new Error(`__exit__:${code}`);
    },
    coodraHome: home,
  };
}

// `daemonManager` omitted → an all-stopped stub so the preflight never
// queries the host's real launchd/systemd units.
function restoreIo(home: string, cap: Capture, daemonManager?: DaemonManager): DbRestoreIO {
  return {
    writeStdout: (c) => cap.stdout.push(c),
    writeStderr: (c) => cap.stderr.push(c),
    exit: (code) => {
      cap.exitCode = code;
      throw new Error(`__exit__:${code}`);
    },
    coodraHome: home,
    daemonManager: daemonManager ?? makeStubDaemonManager(),
  };
}

async function expectExit(p: () => Promise<unknown>): Promise<number> {
  try {
    await p();
    throw new Error('did not exit');
  } catch (err) {
    const m = (err as Error).message.match(/^__exit__:(\d+)$/);
    if (!m) throw err;
    return Number(m[1]);
  }
}

const REPO_DRIZZLE_SQLITE = join(__dirname, '..', '..', '..', 'db', 'drizzle', 'sqlite');

let cwd: string;
let homePath: string;
let pidsDir: string;
let logsDir: string;

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'cli-db-backup-int-'));
  homePath = join(cwd, '.coodra');
  pidsDir = join(homePath, 'pids');
  logsDir = join(homePath, 'logs');
  mkdirSync(pidsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  // Seed a real SQLite DB at the canonical path so VACUUM INTO has something to copy.
  const handle = createDb({
    kind: 'local',
    sqlite: { path: resolveCoodraDataDb(homePath), loadVecExtension: true },
  });
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
  migrateSqlite(handle.db, REPO_DRIZZLE_SQLITE);
  // Insert a marker row so we can prove the backup contains data.
  handle.raw
    .prepare(`INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)`)
    .run('00000000-0000-0000-0000-000000000001', 'backup-test', '__solo__', 'Backup Test');
  handle.close();
});

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('coodra db backup + db restore integration', () => {
  it('Fixture 1 — default single-file backup writes a .sqlite under ~/.coodra/backups/', async () => {
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runDbBackupCommand({ json: true }, backupIo(homePath, cap)));
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as { ok: boolean; destination: string; format: string };
    expect(payload.ok).toBe(true);
    expect(payload.format).toBe('sqlite');
    expect(payload.destination).toContain('/backups/data.db.bak.');
    expect(payload.destination.endsWith('.sqlite')).toBe(true);
    const stats = statSync(payload.destination);
    expect(stats.size).toBeGreaterThan(0);
  });

  it('Fixture 2 — backup --include-logs produces a tarball with data.db.bak + logs/* entries', async () => {
    writeFileSync(join(logsDir, 'mcp-server.log'), 'line one\nline two\n');
    writeFileSync(join(logsDir, 'sync-daemon.log'), 'sync log\n');
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runDbBackupCommand({ json: true, includeLogs: true }, backupIo(homePath, cap)));
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as { ok: boolean; destination: string; format: string };
    expect(payload.format).toBe('tarball');
    expect(payload.destination.endsWith('.tar.gz')).toBe(true);

    // Verify the tarball contents.
    const tar = await import('tar');
    const members: string[] = [];
    await tar.list({ file: payload.destination, onentry: (entry) => members.push(entry.path as string) });
    expect(members).toContain('data.db.bak');
    expect(members).toContain('logs/mcp-server.log');
    expect(members).toContain('logs/sync-daemon.log');
  });

  it('Fixture 3 — backup → restore roundtrip yields a byte-identical DB on a quiescent system', async () => {
    // Backup
    const bcap: Capture = { stdout: [], stderr: [], exitCode: null };
    const bcode = await expectExit(() => runDbBackupCommand({ json: true }, backupIo(homePath, bcap)));
    expect(bcode).toBe(EXIT_OK);
    const bpayload = JSON.parse(bcap.stdout.join('')) as { destination: string };
    const backupBytes = readFileSync(bpayload.destination);

    // Mutate the live DB so we can verify the restore reverts the change.
    const handle = createDb({
      kind: 'local',
      sqlite: { path: resolveCoodraDataDb(homePath), loadVecExtension: true },
    });
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    handle.raw
      .prepare(`INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)`)
      .run('00000000-0000-0000-0000-000000000002', 'should-be-gone-after-restore', '__solo__', 'Doomed');
    handle.close();

    // Restore
    const rcap: Capture = { stdout: [], stderr: [], exitCode: null };
    const rcode = await expectExit(() =>
      runDbRestoreCommand(bpayload.destination, { json: true }, restoreIo(homePath, rcap)),
    );
    expect(rcode).toBe(EXIT_OK);

    // Verify the post-restore DB matches the backup byte-for-byte.
    const targetBytes = readFileSync(resolveCoodraDataDb(homePath));
    expect(targetBytes.equals(backupBytes)).toBe(true);

    // Verify the doomed row is gone (proves the live DB was actually replaced).
    const verify = createDb({
      kind: 'local',
      sqlite: { path: resolveCoodraDataDb(homePath), loadVecExtension: true },
    });
    if (verify.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = verify.raw.prepare(`SELECT slug FROM projects WHERE slug = ?`).all('should-be-gone-after-restore');
    expect(rows).toHaveLength(0);
    verify.close();
  });

  it('Fixture 4 — restore refuses if a daemon PID file is alive', async () => {
    // Take a backup first so we have something to restore.
    const bcap: Capture = { stdout: [], stderr: [], exitCode: null };
    await expectExit(() => runDbBackupCommand({ json: true }, backupIo(homePath, bcap)));
    const { destination } = JSON.parse(bcap.stdout.join('')) as { destination: string };

    writeFileSync(join(pidsDir, 'mcp-server.pid'), String(process.pid));

    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runDbRestoreCommand(destination, { json: true }, restoreIo(homePath, cap)));
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    const payload = JSON.parse(cap.stdout.join('')) as { ok: boolean; daemonsRunning?: { unit: string }[] };
    expect(payload.ok).toBe(false);
    expect(payload.daemonsRunning?.[0]?.unit).toBe('mcp-server');
  });

  it('Fixture 4b — THE GAP: restore refuses if the web daemon is running (no PID file, manager-reported)', async () => {
    // 2026-07-18: pre-hardening the preflight was PID-file-only and omitted
    // `web` entirely, so a running web dashboard (which reads the same DB)
    // sailed past the guard → restore-while-open corruption. The web unit is
    // launchd-managed and writes no PID file, so ONLY the daemon-manager
    // signal catches it.
    const bcap: Capture = { stdout: [], stderr: [], exitCode: null };
    await expectExit(() => runDbBackupCommand({ json: true }, backupIo(homePath, bcap)));
    const { destination } = JSON.parse(bcap.stdout.join('')) as { destination: string };

    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runDbRestoreCommand(destination, { json: true }, restoreIo(homePath, cap, makeStubDaemonManager({ web: true }))),
    );
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    const payload = JSON.parse(cap.stdout.join('')) as { ok: boolean; daemonsRunning?: { unit: string }[] };
    expect(payload.ok).toBe(false);
    expect(payload.daemonsRunning?.map((d) => d.unit)).toContain('web');
  });

  it('Fixture 4c — restore refuses a launchd-managed mcp-server with no PID file (manager signal)', async () => {
    // Proves the manager signal catches daemons that write no PID file — the
    // exact case the old PID-only check missed for launchd/systemd installs.
    const bcap: Capture = { stdout: [], stderr: [], exitCode: null };
    await expectExit(() => runDbBackupCommand({ json: true }, backupIo(homePath, bcap)));
    const { destination } = JSON.parse(bcap.stdout.join('')) as { destination: string };

    // No PID file written — only the manager reports it running.
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runDbRestoreCommand(
        destination,
        { json: true },
        restoreIo(homePath, cap, makeStubDaemonManager({ 'mcp-server': true })),
      ),
    );
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    const payload = JSON.parse(cap.stdout.join('')) as { ok: boolean; daemonsRunning?: { unit: string }[] };
    expect(payload.daemonsRunning?.map((d) => d.unit)).toContain('mcp-server');
  });

  it('Fixture 5 — restore rejects a non-SQLite source via the magic-bytes check', async () => {
    const fakeFile = join(cwd, 'not-a-db.txt');
    writeFileSync(fakeFile, 'this is just a text file pretending to be a db');

    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runDbRestoreCommand(fakeFile, { json: true }, restoreIo(homePath, cap)));
    expect(code).toBe(EXIT_BACKUP_RESTORE_PRECONDITION);
    const payload = JSON.parse(cap.stdout.join('')) as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/not a SQLite v3 file|magic-bytes mismatch/);
  });

  it('Fixture 6 — restore takes auto-backup of current DB by default', async () => {
    const bcap: Capture = { stdout: [], stderr: [], exitCode: null };
    await expectExit(() => runDbBackupCommand({ json: true }, backupIo(homePath, bcap)));
    const { destination } = JSON.parse(bcap.stdout.join('')) as { destination: string };

    const targetPath = resolveCoodraDataDb(homePath);
    const beforeRestoreBytes = readFileSync(targetPath);

    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runDbRestoreCommand(destination, { json: true }, restoreIo(homePath, cap)));
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as { autoBackupPath?: string };
    expect(payload.autoBackupPath).toBeDefined();
    expect(payload.autoBackupPath ?? '').toMatch(/\.pre-restore-/);
    const autoBytes = readFileSync(payload.autoBackupPath ?? '');
    expect(autoBytes.equals(beforeRestoreBytes)).toBe(true);
  });
});
