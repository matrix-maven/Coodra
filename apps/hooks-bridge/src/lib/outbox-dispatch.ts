import {
  type CreateOutboxDispatchHandlerDeps,
  createOutboxDispatchHandler,
  type OutboxDispatchHandler,
} from '@coodra/cli/lib/outbox';
import type { DbHandle } from '@coodra/db';
import { createLogger } from '@coodra/shared';

/**
 * `apps/hooks-bridge/src/lib/outbox-dispatch` — bridge-side factory
 * for the durable outbox dispatch handler. Wraps the canonical
 * dispatcher in `@coodra/cli/lib/outbox` with the bridge's child
 * logger so log lines are tagged correctly. The actual queue routing
 * lives in the canonical dispatcher (both bridge and mcp-server
 * MUST run identical dispatch logic — they compete for the same
 * `pending_jobs` table; lease serialization is only safe when the
 * dispatch is byte-equivalent).
 *
 * See `system-architecture.md` §16 pattern 3 (Outbox) and
 * `docs/feature-packs/03.1-durable-outbox/spec.md` §7 (drain
 * ownership).
 */

export interface CreateBridgeDispatchHandlerDeps {
  readonly db: DbHandle;
}

export function createBridgeDispatchHandler(deps: CreateBridgeDispatchHandlerDeps): OutboxDispatchHandler {
  const logger = createLogger('hooks-bridge.outbox-dispatch');
  const inner: CreateOutboxDispatchHandlerDeps = { db: deps.db, logger };
  return createOutboxDispatchHandler(inner);
}
