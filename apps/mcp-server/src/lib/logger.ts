import { createLogger as createSharedLogger, type Logger } from '@coodra/shared';

/**
 * `apps/mcp-server/src/lib/logger.ts` — typed factory for per-module
 * loggers. Every lib module and every tool handler calls this one
 * place, never `@coodra/shared::createLogger` directly, so:
 *
 *   - Logger names are namespaced under `mcp-server.<module>` with a
 *     grep-able prefix (stderr purity already guaranteed by
 *     `src/bootstrap/ensure-stderr-logging.ts`; this just gives ops a
 *     single substring to filter Pino output by).
 *   - The ToolContext's `ctx.logger` field has exactly one origin —
 *     the factory returned here — so a future log-redaction or log-
 *     sampling layer lands in one file, not nine.
 *
 * Factory style (not a singleton) is required by the S7a user
 * directive: every lib module exports `createXxx(deps)`. This module
 * is the first link in that chain.
 */

export function createMcpLogger(moduleName: string): Logger {
  if (typeof moduleName !== 'string' || moduleName.length === 0) {
    throw new TypeError('createMcpLogger: moduleName must be a non-empty string');
  }
  return createSharedLogger(`mcp-server.${moduleName}`);
}

export type { Logger };
