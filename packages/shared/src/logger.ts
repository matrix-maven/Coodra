import { type DestinationStream, type Logger, type LoggerOptions, pino, destination as pinoDestination } from 'pino';

/**
 * Structured JSON logger for Coodra services.
 *
 * Contract (`essentialsforclaude/01-development-discipline.md` §1.5):
 * every log line carries a correlation id (runId / sessionId), an operation
 * name, and the relevant entity ids. Use `createLogger(name, context)` to
 * bind a service/module name at startup and attach short-lived context
 * via `logger.child({ runId, ... })` at call sites.
 *
 * In development, pipe the process output through `pino-pretty`:
 *   `pnpm --filter @coodra/<service> dev | pnpm exec pino-pretty`.
 * We deliberately do not wire `pino-pretty` as a runtime transport: the
 * transport worker thread is a dev-time ergonomic, not a production
 * dependency, and reaching for it silently in production would hide
 * the source of any formatting bug.
 *
 * ## Log destination (`COODRA_LOG_DESTINATION`)
 *
 * The base pino instance writes to stdout by default. Services that own
 * stdout as a protocol channel — today: `@coodra/mcp-server` under the
 * MCP stdio transport, where JSON-RPC frames occupy stdout exclusively
 * and a single stray byte corrupts the transport — must set
 * `COODRA_LOG_DESTINATION=stderr` before any module that imports this
 * file is loaded. We intentionally make the flip env-driven rather than
 * code-driven so that it survives transitive imports: every package that
 * reaches `createLogger()` via `@coodra/db` or another dependency
 * resolves to the same destination.
 *
 * Accepted values (case-insensitive):
 *   - unset / `stdout` → default (fd 1)
 *   - `stderr`         → fd 2, synchronous writes
 *   - anything else    → throws a `TypeError` at module load — this is a
 *     startup-time configuration error and the service must not start in
 *     an ambiguous state.
 *
 * Synchronous mode for stderr is deliberate: under the stdio transport,
 * shutdown ordering between stderr flushes and stdout protocol frames
 * matters, and sync writes close that race at a negligible throughput
 * cost for our log volume.
 */

type PinoLevel = NonNullable<LoggerOptions['level']>;

const DEFAULT_LEVEL: PinoLevel = 'info';

function resolveLevel(envLevel: string | undefined): PinoLevel {
  const normalized = envLevel?.toLowerCase();
  const allowed: readonly PinoLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
  if (normalized !== undefined && (allowed as readonly string[]).includes(normalized)) {
    return normalized as PinoLevel;
  }
  return DEFAULT_LEVEL;
}

/**
 * Resolves `COODRA_LOG_DESTINATION` into a pino destination.
 *
 * Returns `undefined` for the default (pino's internal stdout sink) so
 * that the resulting `pino(options)` call is identical to the pre-flag
 * behaviour. Returns a `DestinationStream` for `stderr`. Throws for any
 * other value to surface configuration mistakes at boot time rather
 * than letting them silently degrade to the default.
 */
function resolveDestination(envDest: string | undefined): DestinationStream | undefined {
  const normalized = envDest?.toLowerCase();
  if (normalized === undefined || normalized === '' || normalized === 'stdout') return undefined;
  if (normalized === 'stderr') return pinoDestination({ fd: 2, sync: true });
  throw new TypeError(
    `@coodra/shared/logger: COODRA_LOG_DESTINATION must be 'stdout' or 'stderr' (got: '${envDest}')`,
  );
}

const baseOptions: LoggerOptions = {
  level: resolveLevel(process.env.LOG_LEVEL),
  base: {
    pid: process.pid,
    host: process.env.HOSTNAME ?? 'local',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
};

const destination = resolveDestination(process.env.COODRA_LOG_DESTINATION);

export const logger: Logger = destination ? pino(baseOptions, destination) : pino(baseOptions);

/**
 * Returns a child logger bound to a service/module name and optional
 * long-lived context. Call sites should further bind per-request context
 * via `created.child({ runId, projectId })`.
 */
export function createLogger(name: string, context?: Readonly<Record<string, unknown>>): Logger {
  if (!name || typeof name !== 'string') {
    throw new TypeError('createLogger: name must be a non-empty string');
  }
  return logger.child({ name, ...(context ?? {}) });
}

export type { Logger, LoggerOptions };
