import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type DbHandle, migrateSqlite } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { __internal as envInternal, type McpServerEnv } from '../../../apps/mcp-server/src/config/env.js';
import type { ContextDeps } from '../../../apps/mcp-server/src/framework/tool-context.js';
import { ToolRegistry } from '../../../apps/mcp-server/src/framework/tool-registry.js';
import { createAuthClient } from '../../../apps/mcp-server/src/lib/auth.js';
import { createContextPackStore } from '../../../apps/mcp-server/src/lib/context-pack.js';
import { createDbClient } from '../../../apps/mcp-server/src/lib/db.js';
import { createFeaturePackStore } from '../../../apps/mcp-server/src/lib/feature-pack.js';
import { createPolicyClient } from '../../../apps/mcp-server/src/lib/policy.js';
import { createRunRecorder } from '../../../apps/mcp-server/src/lib/run-recorder.js';
// `sqlite-vec` was removed in the M05 reshape (2026-05-08) — search is
// now keyword-only LIKE; the agent does relevance ranking. The slot is
// also gone from `ContextDeps`. See `tool-context.ts` for the rationale.
import { registerAllTools } from '../../../apps/mcp-server/src/tools/index.js';
import { type HttpTransportHandle, startHttpTransport } from '../../../apps/mcp-server/src/transports/http.js';

/**
 * Boot helper for E2E scenarios. Wires the same `ContextDeps` graph
 * `apps/mcp-server/src/index.ts` builds at production boot, but
 * accepts an externally-managed `DbHandle` (sqlite :memory: for
 * cheap scenarios, testcontainers Postgres for the
 * policy-decisions-idempotency scenario which needs real
 * cross-connection row-locking).
 *
 * Returns the registry plus an optional HTTP transport handle and a
 * close hook the caller must `await` in `afterAll`. The helper does
 * NOT touch `process.env` — env is passed in fully-formed.
 */

export interface BootOpts {
  readonly db: DbHandle;
  readonly env: McpServerEnv;
  readonly contextPacksRoot?: string;
  /** When `true`, also start the HTTP transport on the env's port. */
  readonly withHttp?: boolean;
}

export interface BootHandle {
  readonly registry: ToolRegistry;
  readonly deps: ContextDeps;
  /** Strongly-typed sqlite/postgres handle — exposed for e2e DB assertions. */
  readonly dbHandle: DbHandle;
  readonly http?: HttpTransportHandle;
  readonly env: McpServerEnv;
  readonly contextPacksRoot: string;
  readonly close: () => Promise<void>;
}

export async function bootForE2E(opts: BootOpts): Promise<BootHandle> {
  const sharedLogger = createLogger('mcp-server.e2e');
  const dbHandle = opts.db;
  const auth = createAuthClient(opts.env);
  const policy = createPolicyClient({ db: dbHandle });
  const featurePack = createFeaturePackStore({ db: dbHandle });
  const contextPacksRoot = opts.contextPacksRoot ?? mkdtempSync(join(tmpdir(), 'e2e-cp-'));
  const contextPack = createContextPackStore({ db: dbHandle, contextPacksRoot });
  const runRecorder = createRunRecorder({ db: dbHandle });

  const deps: ContextDeps = Object.freeze({
    db: { db: dbHandle.db, async close() {} },
    logger: sharedLogger,
    auth,
    policy,
    featurePack,
    contextPack,
    runRecorder,
  });

  const registry = new ToolRegistry({ deps });
  registerAllTools(registry, { db: dbHandle, mode: opts.env.COODRA_MODE });

  let http: HttpTransportHandle | undefined;
  if (opts.withHttp) {
    http = await startHttpTransport({
      registry,
      serverName: '@coodra/mcp-server-e2e',
      serverVersion: '0.0.0-e2e',
      env: opts.env,
    });
  }

  return {
    registry,
    deps,
    dbHandle,
    http,
    env: opts.env,
    contextPacksRoot,
    close: async () => {
      if (http) await http.close();
    },
  };
}

/**
 * Build a complete `McpServerEnv` from a small override set, using
 * the same Zod schema the production `env` singleton uses (so the
 * `superRefine` rules apply). Test harnesses do NOT touch
 * `process.env` — the result is a typed object handed to bootForE2E
 * directly.
 */
export interface EnvOverride {
  readonly COODRA_MODE?: 'solo' | 'team';
  readonly MCP_SERVER_PORT?: number;
  readonly MCP_SERVER_HOST?: string;
  readonly CLERK_SECRET_KEY?: string;
  readonly CLERK_PUBLISHABLE_KEY?: string;
  readonly LOCAL_HOOK_SECRET?: string;
}

export function buildE2eEnv(override: EnvOverride = {}): McpServerEnv {
  const base: Record<string, unknown> = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    COODRA_MODE: override.COODRA_MODE ?? 'solo',
    COODRA_LOG_DESTINATION: 'stderr',
    MCP_SERVER_PORT: override.MCP_SERVER_PORT ?? 0,
    MCP_SERVER_HOST: override.MCP_SERVER_HOST ?? '127.0.0.1',
    MCP_SERVER_TRANSPORT: 'http',
    CLERK_SECRET_KEY: override.CLERK_SECRET_KEY ?? 'sk_test_replace_me',
  };
  if (override.CLERK_PUBLISHABLE_KEY !== undefined) base.CLERK_PUBLISHABLE_KEY = override.CLERK_PUBLISHABLE_KEY;
  if (override.LOCAL_HOOK_SECRET !== undefined) base.LOCAL_HOOK_SECRET = override.LOCAL_HOOK_SECRET;
  return envInternal.schema.parse(base) as McpServerEnv;
}

/**
 * Open a fresh in-memory sqlite handle, run all migrations, return
 * the `DbHandle` plus a close hook. Cheap (~20ms); used by every
 * scenario except the policy-decisions-idempotency one which needs a
 * real Postgres for cross-connection row-level dedupe.
 */
export function openSqliteHandle(): { handle: DbHandle; close: () => Promise<void> } {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);
  return {
    handle,
    close: async () => {
      await client.close();
    },
  };
}
