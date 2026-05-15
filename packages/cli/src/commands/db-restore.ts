import { copyFile, rename, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { EXIT_BACKUP_RESTORE_PRECONDITION, EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveCoodraDataDb, resolveCoodraHome } from '../lib/coodra-home.js';
import { readPidStatus } from '../lib/pid-status.js';
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
 *   - Refuses if any of the three daemons (mcp-server, hooks-bridge,
 *     sync-daemon) are alive. No `--with-daemons-running` escape
 *     hatch — daemons + atomic replace = silent corruption.
 *   - Validates the source via SQLite magic-bytes header BEFORE swap.
 *
 * `--force` skips the interactive confirmation prompt (currently we
 * never prompt — destructive operations exit cleanly with confirmation
 * built into the flag), reserved for future TTY-aware prompting.
 */

const TRACKED_DAEMON_UNITS = ['mcp-server', 'hooks-bridge', 'sync-daemon'] as const;

export interface DbRestoreOptions {
  readonly source?: string;
  readonly noAutoBackup?: boolean;
  readonly force?: boolean;
  readonly json?: boolean;
}

export interface DbRestoreIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly coodraHome?: string;
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

  // Refuse if any daemon is alive.
  const aliveUnits: { unit: string; pid: number }[] = [];
  for (const unit of TRACKED_DAEMON_UNITS) {
    const status = await readPidStatus(homePath, unit);
    if (status.state === 'alive') aliveUnits.push({ unit, pid: status.pid });
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
