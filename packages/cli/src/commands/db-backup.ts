import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { EXIT_BACKUP_RESTORE_PRECONDITION, EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import {
  resolveCoodraConfigJson,
  resolveCoodraDataDb,
  resolveCoodraHome,
  resolveCoodraLogsDir,
} from '../lib/coodra-home.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { pc } from '../ui/index.js';

/**
 * `coodra db backup` — copy the live `~/.coodra/data.db` to a
 * destination path.
 *
 * Per OQ-3 lock (2026-05-03):
 *   - Default: single-file `.sqlite` produced via `VACUUM INTO`.
 *     Concurrent with running daemons because SQLite WAL allows
 *     concurrent readers (and VACUUM INTO is read-only against the
 *     source).
 *   - With `--include-logs`: a `.tar.gz` containing `data.db.bak`,
 *     `logs/*.log`, and `config.json` (mode-0600 preserved when
 *     present). Used for full-environment reproduction (e.g. sending
 *     a frozen snapshot to support).
 *
 * Default destination: `~/.coodra/backups/data.db.bak.<ISO-with-colons-replaced>`
 * (or `.tar.gz` for the tarball variant). The directory is created
 * on demand.
 *
 * `SQLITE_BUSY` retries: VACUUM INTO acquires a brief reserved lock;
 * a write storm may bounce it. We retry with `[100ms, 250ms, 1s]`
 * backoff (3 attempts total) before failing with exit 6
 * (EXIT_BACKUP_RESTORE_PRECONDITION).
 */

export interface DbBackupOptions {
  readonly out?: string;
  readonly includeLogs?: boolean;
  readonly json?: boolean;
}

export interface DbBackupIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly coodraHome?: string;
  /** Override the source DB path for tests. */
  readonly sourceDbPath?: string;
}

export const DEFAULT_DB_BACKUP_IO: DbBackupIO = {
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

interface DbBackupJson {
  readonly ok: boolean;
  readonly destination: string;
  readonly format: 'sqlite' | 'tarball';
  readonly bytes?: number;
  readonly includeLogs: boolean;
  readonly attempts?: number;
  readonly error?: string;
}

const VACUUM_RETRY_DELAYS_MS = [100, 250, 1_000] as const;

export async function runDbBackupCommand(options: DbBackupOptions, ioOverride?: DbBackupIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_DB_BACKUP_IO;
  const json = options.json === true;
  const includeLogs = options.includeLogs === true;
  const homePath = io.coodraHome ?? resolveCoodraHome();
  const sourceDb = io.sourceDbPath ?? resolveCoodraDataDb(homePath);

  // Source must exist — there's nothing to back up otherwise.
  try {
    await stat(sourceDb);
  } catch {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, `source DB ${sourceDb} does not exist`);
  }

  const destination = await resolveDestination(homePath, options.out, includeLogs);
  await mkdir(dirname(destination), { recursive: true });

  if (includeLogs) {
    return runTarballBackup({ io, json, sourceDb, homePath, destination });
  }
  return runSqliteBackup({ io, json, sourceDb, destination });
}

async function runSqliteBackup(args: {
  io: DbBackupIO;
  json: boolean;
  sourceDb: string;
  destination: string;
}): Promise<void> {
  const { io, json, sourceDb, destination } = args;
  let attempt = 0;
  let lastError: unknown = null;
  let success: { sizeBytes: number; attempts: number } | null = null;

  while (attempt < VACUUM_RETRY_DELAYS_MS.length + 1) {
    try {
      const handle = await openLocalDb(sourceDb);
      try {
        // VACUUM INTO is the canonical "create a self-contained backup"
        // SQLite primitive. Concurrent with WAL writers on the source.
        handle.raw.prepare(`VACUUM INTO ?`).run(destination);
      } finally {
        handle.close();
      }
      const sizeBytes = (await stat(destination)).size;
      success = { sizeBytes, attempts: attempt + 1 };
      break;
    } catch (err) {
      lastError = err;
      const code = (err as { code?: string }).code;
      if (code !== 'SQLITE_BUSY' && code !== 'SQLITE_LOCKED') {
        return surfaceError(
          io,
          json,
          EXIT_BACKUP_RESTORE_PRECONDITION,
          `db backup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const delay = VACUUM_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await new Promise((r) => setTimeout(r, delay));
      attempt += 1;
    }
  }

  if (success === null) {
    return surfaceError(
      io,
      json,
      EXIT_BACKUP_RESTORE_PRECONDITION,
      `db backup failed after ${attempt + 1} attempts (SQLITE_BUSY): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  writeBackupSuccess({
    io,
    json,
    destination,
    format: 'sqlite',
    bytes: success.sizeBytes,
    includeLogs: false,
    attempts: success.attempts,
  });
  io.exit(EXIT_OK);
}

async function runTarballBackup(args: {
  io: DbBackupIO;
  json: boolean;
  sourceDb: string;
  homePath: string;
  destination: string;
}): Promise<void> {
  const { io, json, sourceDb, homePath, destination } = args;

  // Take an intermediate VACUUM INTO copy first so the tarball entry
  // is a consistent snapshot (live source could mutate mid-tar
  // otherwise). The intermediate copy is discarded after archiving.
  const intermediate = `${destination}.partial.sqlite`;
  try {
    const handle = await openLocalDb(sourceDb);
    try {
      handle.raw.prepare(`VACUUM INTO ?`).run(intermediate);
    } finally {
      handle.close();
    }
  } catch (err) {
    return surfaceError(
      io,
      json,
      EXIT_BACKUP_RESTORE_PRECONDITION,
      `db backup --include-logs intermediate snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Build the tarball. Members:
  //   data.db.bak       — the snapshot
  //   logs/*.log        — every regular file under ~/.coodra/logs/
  //   config.json       — present if the file exists, mode-0600 preserved
  const logsDir = resolveCoodraLogsDir(homePath);
  const configPath = resolveCoodraConfigJson(homePath);

  const tar = await import('tar');
  let sizeBytes: number;
  try {
    const entries: { fsPath: string; archivePath: string }[] = [{ fsPath: intermediate, archivePath: 'data.db.bak' }];

    let logFiles: string[] = [];
    try {
      const { readdir } = await import('node:fs/promises');
      const dirents = await readdir(logsDir, { withFileTypes: true });
      logFiles = dirents.filter((d) => d.isFile() && d.name.endsWith('.log')).map((d) => d.name);
    } catch {
      // No logs dir → tarball just doesn't include `logs/`.
    }
    for (const name of logFiles) {
      entries.push({ fsPath: join(logsDir, name), archivePath: `logs/${name}` });
    }

    try {
      await stat(configPath);
      entries.push({ fsPath: configPath, archivePath: 'config.json' });
    } catch {
      // No config.json → omit.
    }

    // Stage the entries into a tmp dir with the desired archive names +
    // `cwd`-rooted relative paths, then archive the staging dir. This
    // produces a portable archive whose members unpack to predictable
    // relative paths regardless of the operator's backup-dir choice.
    const { mkdtemp, copyFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const stagingRoot = await mkdtemp(join(tmpdir(), 'coodra-backup-staging-'));
    try {
      for (const e of entries) {
        const target = join(stagingRoot, e.archivePath);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(e.fsPath, target);
      }
      const archiveMembers = entries.map((e) => e.archivePath).sort();
      await tar.create({ gzip: true, file: destination, cwd: stagingRoot, portable: true }, archiveMembers);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }

    // Drop the intermediate VACUUM snapshot now that it's safely inside the tarball.
    await rm(intermediate, { force: true });
    sizeBytes = (await stat(destination)).size;
  } catch (err) {
    return surfaceError(
      io,
      json,
      EXIT_BACKUP_RESTORE_PRECONDITION,
      `db backup --include-logs tarball failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  writeBackupSuccess({ io, json, destination, format: 'tarball', bytes: sizeBytes, includeLogs: true });
  io.exit(EXIT_OK);
}

async function resolveDestination(homePath: string, raw: string | undefined, includeLogs: boolean): Promise<string> {
  if (raw !== undefined && raw.length > 0) {
    return resolve(raw);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = includeLogs ? 'tar.gz' : 'sqlite';
  return join(homePath, 'backups', `data.db.bak.${stamp}.${ext}`);
}

function writeBackupSuccess(args: {
  io: DbBackupIO;
  json: boolean;
  destination: string;
  format: 'sqlite' | 'tarball';
  bytes: number;
  includeLogs: boolean;
  attempts?: number;
}): void {
  const { io, json, destination, format, bytes, includeLogs, attempts } = args;
  if (json) {
    const payload: DbBackupJson = {
      ok: true,
      destination,
      format,
      bytes,
      includeLogs,
      ...(attempts !== undefined ? { attempts } : {}),
    };
    io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  io.writeStdout(`${pc.green('✓')} db backup → ${destination} (${format}, ${humanBytes(bytes)}).\n`);
  if (includeLogs) {
    io.writeStdout(`  Tarball members: data.db.bak, logs/*.log, config.json (when present).\n`);
  }
}

function surfaceError(io: DbBackupIO, json: boolean, exitCode: number, message: string): void {
  if (json) {
    const payload: DbBackupJson = {
      ok: false,
      destination: '',
      format: 'sqlite',
      includeLogs: false,
      error: message,
    };
    io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    io.writeStderr(`${pc.red('error')}: ${message}\n`);
  }
  io.exit(exitCode);
}

function humanBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}
