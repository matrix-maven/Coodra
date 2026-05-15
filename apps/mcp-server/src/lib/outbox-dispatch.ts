import {
  type CreateOutboxDispatchHandlerDeps,
  createOutboxDispatchHandler,
  type OutboxDispatchHandler,
} from '@coodra/cli/lib/outbox';
import type { DbHandle } from '@coodra/db';

import { createMcpLogger } from './logger.js';

/**
 * `apps/mcp-server/src/lib/outbox-dispatch` — mcp-server-side
 * factory for the durable outbox dispatch handler. Wraps the
 * canonical dispatcher in `@coodra/cli/lib/outbox` with the
 * mcp-server's child logger so log lines are tagged correctly.
 *
 * Both bridge and mcp-server MUST run identical dispatch logic —
 * they compete for the same `pending_jobs` table; lease
 * serialization is only safe when the dispatch is byte-equivalent
 * across services. The canonical dispatcher in
 * `@coodra/cli/lib/outbox` is the single source of truth; this
 * file's only job is to inject the mcp-server logger.
 *
 * See `system-architecture.md` §16 pattern 3 (Outbox) and
 * `docs/feature-packs/03.1-durable-outbox/spec.md` §7 (drain
 * ownership).
 */

export interface CreateMcpDispatchHandlerDeps {
  readonly db: DbHandle;
}

export function createMcpDispatchHandler(deps: CreateMcpDispatchHandlerDeps): OutboxDispatchHandler {
  const logger = createMcpLogger('outbox-dispatch');
  const inner: CreateOutboxDispatchHandlerDeps = { db: deps.db, logger };
  return createOutboxDispatchHandler(inner);
}
