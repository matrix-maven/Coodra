import { type FSWatcher, watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import pc from 'picocolors';

import { EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveContextosHome, resolveContextosLogsDir } from '../lib/contextos-home.js';
import { DurationParseError, parseDuration } from '../lib/duration.js';
import { readLastNLines, readLinesSince } from '../lib/log-reader.js';

/**
 * `contextos logs <service>` — tail or print recent lines from
 * `<contextosHome>/logs/<service>.log`. Pure file I/O; no DB calls.
 *
 * Service names mirror `lib/services.ts::ServiceName`:
 * `mcp-server | hooks-bridge | sync-daemon`. Unknown service →
 * exit 1 with the valid set listed. Missing log file → exit 2
 * with "daemon hasn't started yet" remediation pointing at
 * `contextos start`.
 *
 * `--follow` uses `node:fs::watch` (same pattern Hono dev tools use)
 * — no `tail -f` shellout, so Windows parity holds.
 *
 * `--since <input>` accepts either an ISO-8601 timestamp or a
 * relative duration parsed by `lib/duration.ts` (5m / 1h / 7d).
 * Filter applies to the JSON `time` field; non-JSON lines pass
 * through verbatim so the operator never silently loses a line.
 */

const VALID_SERVICES = ['mcp-server', 'hooks-bridge', 'sync-daemon'] as const;
type ValidService = (typeof VALID_SERVICES)[number];

export interface LogsOptions {
  readonly follow?: boolean;
  readonly lines?: string;
  readonly since?: string;
}

export interface LogsIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly contextosHome?: string;
  /**
   * Optional override for `--follow` so tests can inject a deterministic
   * watcher. Production code path uses `node:fs::watch`.
   */
  readonly watch?: (path: string, listener: () => void) => FSWatcher;
}

export const DEFAULT_LOGS_IO: LogsIO = {
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

export async function runLogsCommand(service: string, options: LogsOptions, ioOverride?: LogsIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_LOGS_IO;

  if (!VALID_SERVICES.includes(service as ValidService)) {
    io.writeStderr(`${pc.red('error')}: unknown service "${service}". Valid services: ${VALID_SERVICES.join(', ')}.\n`);
    io.exit(EXIT_USER_RECOVERABLE);
    return;
  }
  const validService = service as ValidService;

  const homePath = io.contextosHome ?? resolveContextosHome();
  const logPath = join(resolveContextosLogsDir(homePath), `${validService}.log`);

  let exists = false;
  try {
    const s = await stat(logPath);
    exists = s.isFile();
  } catch {
    exists = false;
  }
  if (!exists) {
    io.writeStderr(
      `${pc.red('error')}: log file ${logPath} does not exist. The ${validService} daemon may not have started yet — try \`contextos start\`.\n`,
    );
    io.exit(EXIT_USER_ACTION_REQUIRED);
    return;
  }

  // --since takes precedence over --lines (the operator asked for a
  // time window; line-count is the default fallback when no window
  // is given).
  let initialLines: string[];
  if (options.since !== undefined && options.since.length > 0) {
    const since = parseSince(options.since);
    if (since instanceof Error) {
      io.writeStderr(`${pc.red('error')}: ${since.message}\n`);
      io.exit(EXIT_USER_RECOVERABLE);
      return;
    }
    initialLines = await readLinesSince(logPath, since);
  } else {
    const n = parseLineCount(options.lines);
    if (n instanceof Error) {
      io.writeStderr(`${pc.red('error')}: ${n.message}\n`);
      io.exit(EXIT_USER_RECOVERABLE);
      return;
    }
    initialLines = await readLastNLines(logPath, n);
  }

  for (const line of initialLines) {
    io.writeStdout(`${line}\n`);
  }

  if (options.follow !== true) {
    io.exit(EXIT_OK);
    return;
  }

  // --follow: keep printing new lines as they're appended. Track the
  // current file size so each watch event re-reads only the new bytes.
  // Exit cleanly on SIGINT.
  await followFile(logPath, io);
}

function parseLineCount(raw: string | undefined): number | Error {
  if (raw === undefined || raw.length === 0) return 100;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
    return new Error(`--lines must be an integer between 1 and 1,000,000 (got "${raw}")`);
  }
  return n;
}

function parseSince(raw: string): Date | Error {
  // Try ISO first.
  const asDate = new Date(raw);
  if (!Number.isNaN(asDate.getTime()) && /\d{4}-\d{2}-\d{2}/.test(raw)) {
    return asDate;
  }
  // Fall back to relative duration.
  try {
    const { ms } = parseDuration(raw);
    return new Date(Date.now() - ms);
  } catch (err) {
    if (err instanceof DurationParseError) {
      return new Error(
        `--since "${raw}" is not an ISO-8601 timestamp or a duration (e.g. "5m", "1h", "2026-05-03T10:00:00Z"): ${err.message}`,
      );
    }
    return new Error(`--since "${raw}" parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function followFile(path: string, io: LogsIO): Promise<void> {
  const initialStat = await stat(path);
  let position = initialStat.size;
  let watcher: FSWatcher | null = null;
  let closed = false;

  return new Promise<void>((resolve) => {
    const onChange = (): void => {
      if (closed) return;
      void readNew();
    };
    const readNew = async (): Promise<void> => {
      try {
        const s = await stat(path);
        if (s.size < position) {
          // Truncated/rotated. Reset to start.
          position = 0;
        }
        if (s.size === position) return;
        const fd = await import('node:fs/promises').then((m) => m.open(path, 'r'));
        try {
          const len = s.size - position;
          const buf = Buffer.alloc(len);
          await fd.read(buf, 0, len, position);
          position = s.size;
          io.writeStdout(buf.toString('utf8'));
        } finally {
          await fd.close();
        }
      } catch (err) {
        io.writeStderr(
          `${pc.yellow('warn')}: follow read failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    };

    const watcherFactory = io.watch ?? ((p, listener) => watch(p, { encoding: 'utf8' }, listener));
    watcher = watcherFactory(path, onChange);

    const close = (signal: NodeJS.Signals): void => {
      if (closed) return;
      closed = true;
      io.writeStderr(`\n${pc.cyan('—')} ${signal} received; closing log follower.\n`);
      try {
        watcher?.close();
      } catch {
        // best-effort
      }
      resolve();
      io.exit(EXIT_OK);
    };
    process.once('SIGINT', () => close('SIGINT'));
    process.once('SIGTERM', () => close('SIGTERM'));
  });
}
