import { copyFile, rename, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { EXIT_BACKUP_RESTORE_PRECONDITION, EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveCoodraDataDb, resolveCoodraHome } from '../lib/coodra-home.js';
import { type DaemonManager, selectDaemonManager } from '../lib/daemon/index.js';
import { readPidStatus } from '../lib/pid-status.js';
import { SERVICES } from '../lib/services.js';
import { isSqliteFile } from '../lib/sqlite-magic.js';
import { pc } from '../ui/index.js';

/**
 * `coodra db restore <path>` — replace `~/.coodra/data.db` with
 * the SQLite file at `<path>`.
 *
 * Per OQ-4 lock (2026-05-03):
 *   - Atomic replace via temp + rename (the OS-level rename is atomic
 *     on POSIX filesystems and as-atomic-as-possible on Windows).
 *   - Auto-backup of current DB to `<current>.pre-restore-<ISO>` before
 *     swap. `--no-auto-backup` skips it (warns aloud first via stderr).
 *   - Refuses if ANY daemon that opens the SQLite store is alive —
 *     mcp-server, sync-daemon, AND web (the web app reads
 *     the same DB). No `--with-daemons-running` escape hatch — daemons +
 *     atomic replace = silent corruption. Liveness is checked via TWO
 *     signals so no strategy is missed (2026-07-18 hardening): the PID
 *     file (fallback-managed / foreground daemons) AND the platform
 *     daemon manager's `status()` (launchd / systemd units, which do NOT
 *     write PID files). Pre-hardening the check was PID-file-only and
 *     omitted `web`, so a launchd-managed mcp-server or a running web
 *     dashboard sailed past the guard.
 *   - Validates the source via SQLite magic-bytes header BEFORE swap.
 *
 */

export interface DbRestoreOptions {
  readonly source?: string;
  readonly noAutoBackup?: boolean;
  readonly json?: boolean;
}

export interface DbRestoreIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly coodraHome?: string;
  /**
   * Daemon manager override. Tests inject a stub so the launchd/systemd
   * liveness probe stays hermetic (never shells `launchctl` / `systemctl`
   * against the host's real units — which on a dev machine ARE running,
   * and would make every restore test refuse). Production omits it —
   * `selectDaemonManager` picks the platform manager.
   */
  readonly daemonManager?: DaemonManager;
}

export const DEFAULT_DB_RESTORE_IO: DbRestoreIO = {
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
  exit: (code) => {
    process.exit(code);
  },
};

interface DbRestoreJson {
  readonly ok: boolean;
  readonly source?: string;
  readonly target?: string;
  readonly autoBackupPath?: string;
  readonly daemonsRunning?: ReadonlyArray<{ readonly unit: string; readonly pid: number }>;
  readonly error?: string;
}

export async function runDbRestoreCommand(
  source: string,
  options: DbRestoreOptions,
  ioOverride?: DbRestoreIO,
): Promise<void> {
  const io = ioOverride ?? DEFAULT_DB_RESTORE_IO;
  const json = options.json === true;
  const homePath = io.coodraHome ?? resolveCoodraHome();
  const target = resolveCoodraDataDb(homePath);
  const resolvedSource = resolve(source);

  // Refuse if any daemon that opens the SQLite store is alive. Check every
  // SERVICES unit (web included) via two independent signals so no
  // process-management strategy is missed: the PID file (foreground /
  // fallback-managed) AND the platform daemon manager's status() (launchd /
  // systemd units, which write no PID file). Resolving the manager is
  // best-effort — if it can't be selected, the PID signal still guards.
  let manager: DaemonManager | null = io.daemonManager ?? null;
  if (manager === null) {
    try {
      manager = await selectDaemonManager({ coodraHome: homePath });
    } catch {
      manager = null;
    }
  }

  const aliveUnits: { unit: string; pid: number }[] = [];
  for (const svc of SERVICES) {
    const unit = svc.name;
    let alive = false;
    let pid = 0;
    // Signal 1: PID file.
    const pidStatus = await readPidStatus(homePath, unit);
    if (pidStatus.state === 'alive') {
      alive = true;
      pid = pidStatus.pid;
    }
    // Signal 2: platform daemon manager (launchd / systemd). A 'running'
    // verdict is authoritative; 'unknown' (probe failed) falls back to the
    // PID signal rather than false-refusing.
    if (manager !== null) {
      try {
        const s = await manager.status(unit);
        if (s.state === 'running') {
          alive = true;
          if (pid === 0 && typeof s.pid === 'number') pid = s.pid;
        }
      } catch {
        // manager status failed for this unit — rely on the PID signal.
      }
    }
    if (alive) aliveUnits.push({ unit, pid });
  }
  if (aliveUnits.length > 0) {
    return surfaceErrorJson(io, json, EXIT_USER_RECOVERABLE, {
      ok: false,
      source: resolvedSource,
      target,
      daemonsRunning: aliveUnits,
      error: `${aliveUnits.length} daemon(s) still running: ${aliveUnits.map((u) => `${u.unit} (pid ${u.pid})`).join(', ')}. Run \`coodra stop\` first.`,
    });
  }

  // Source must exist + be a SQLite file.
  try {
    const s = await stat(resolvedSource);
    if (!s.isFile()) {
      return surfaceError(
        io,
        json,
        EXIT_BACKUP_RESTORE_PRECONDITION,
        `source "${resolvedSource}" is not a regular file`,
      );
    }
  } catch {
    return surfaceError(io, json, EXIT_BACKUP_RESTORE_PRECONDITION, `source "${resolvedSource}" does not exist`);
  }
  const isSqlite = await isSqliteFile(resolvedSource);
  if (!isSqlite) {
    return surfaceError(
      io,
      json,
      EXIT_BACKUP_RESTORE_PRECONDITION,
      `source "${resolvedSource}" is not a SQLite v3 file (magic-bytes mismatch). Did you mean to pass a tarball? db restore takes the .sqlite file inside the tarball, not the .tar.gz itself.`,
    );
  }

  // Auto-backup of current DB unless --no-auto-backup.
  let autoBackupPath: string | undefined;
  let targetExists = true;
  try {
    await stat(target);
  } catch {
    targetExists = false;
  }
  if (targetExists && options.noAutoBackup !== true) {
    autoBackupPath = `${target}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      await copyFile(target, autoBackupPath);
    } catch (err) {
      return surfaceError(
        io,
        json,
        EXIT_BACKUP_RESTORE_PRECONDITION,
        `auto-backup of current DB to ${autoBackupPath} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (targetExists && options.noAutoBackup === true) {
    io.writeStderr(
      `${pc.yellow('warn')}: --no-auto-backup set; current ${target} will be replaced without a snapshot.\n`,
    );
  }

  // Atomic replace: copy source to target.tmp, then rename atop target.
  const tmpPath = `${target}.coodra-restore.tmp`;
  try {
    await copyFile(resolvedSource, tmpPath);
    await rename(tmpPath, target);
  } catch (err) {
    return surfaceError(
      io,
      json,
      EXIT_BACKUP_RESTORE_PRECONDITION,
      `atomic replace failed: ${err instanceof Error ? err.message : String(err)}. The original file at ${target} is unchanged.`,
    );
  }

  // SQLite WAL files (-wal and -shm) belonging to the OLD DB are now
  // stale relative to the NEW DB. Remove them so a fresh open creates
  // new WAL files matching the restored content. Best-effort: failure
  // is logged but doesn't fail the restore.
  for (const suffix of ['-wal', '-shm']) {
    try {
      await import('node:fs/promises').then((m) => m.rm(`${target}${suffix}`, { force: true }));
    } catch {
      // ignore
    }
  }

  if (json) {
    const payload: DbRestoreJson = {
      ok: true,
      source: resolvedSource,
      target,
      ...(autoBackupPath !== undefined ? { autoBackupPath } : {}),
    };
    io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    io.writeStdout(`${pc.green('✓')} db restore: ${resolvedSource} → ${target}.\n`);
    if (autoBackupPath !== undefined) {
      io.writeStdout(`  Previous DB snapshotted to ${autoBackupPath} (use \`db restore <path>\` to roll back).\n`);
    }
  }
  io.exit(EXIT_OK);
}

function surfaceError(io: DbRestoreIO, json: boolean, exitCode: number, message: string): void {
  surfaceErrorJson(io, json, exitCode, { ok: false, error: message });
}

function surfaceErrorJson(io: DbRestoreIO, json: boolean, exitCode: number, payload: DbRestoreJson): void {
  if (json) {
    io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    io.writeStderr(`${pc.red('error')}: ${payload.error ?? 'unknown error'}\n`);
  }
  io.exit(exitCode);
}

void dirname;
