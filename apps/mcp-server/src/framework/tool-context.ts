import type { PolicyClient } from '@coodra/policy';
import type { Logger } from '@coodra/shared';
import type { AuthClient, Identity } from '@coodra/shared/auth';

import type { IdempotencyKey } from './idempotency.js';

/**
 * Frozen ToolContext shape for the entire Module 02 tool surface.
 *
 * DESIGN LOCK (2026-04-23, S7a): the member list below is the
 * authoritative list of per-call dependencies a tool handler may
 * consume. S7a builds the first four implementations (db, logger,
 * auth, policy); S7c fills in the remaining slots (featurePack,
 * contextPack, runRecorder). Stub factories
 * live today in the corresponding `src/lib/*.ts` file so the
 * filesystem shape is locked and S7c is a function-body change,
 * not a file addition.
 *
 * Why freeze now: every tool shipped in S7b..S15 will type-check
 * against this shape. Growing the shape mid-module forces every
 * already-landed tool to be revisited for the new slot; shrinking
 * it is even worse because test-stubs would reference absent
 * fields. One shape, one release.
 *
 * Why factories, not singletons (user S7a directive): each lib
 * module exports `createXxxClient(deps)` — never a module-level
 * exported instance. The factory pattern lets:
 *   - `index.ts` decide mode dispatch exactly once at boot
 *     (see `createSoloAuthClient` vs the forthcoming
 *     `createClerkAuthClient`);
 *   - tests instantiate fresh per-suite clients with fixture-
 *     owned state (temp SQLite files, in-memory fakes);
 *   - S7b swap `createPolicyClient` from the dev-null shim to
 *     the cache-backed `lib/policy.ts::evaluatePolicy` without
 *     touching a single call site.
 *
 * Why tools use `ctx.now()`, not `new Date()` (user S7a
 * directive): a single `now()` entry point lets tests inject a
 * frozen clock, cuts real-clock flakiness, and keeps the
 * server timezone-safe — the handler never calls the global
 * `Date()` constructor. A test in
 * `__tests__/unit/tools/_no-raw-date.test.ts` greps the
 * `src/tools/**` tree and fails CI if any tool file contains
 * `new Date(`.
 */

// ---------------------------------------------------------------------------
// Lib-client interfaces.
// Each of these is implemented in `apps/mcp-server/src/lib/<name>.ts`.
// Interfaces live here (not in the lib file) so `tool-context.ts` is the
// single grep target for "what does a handler see?" and so individual lib
// files can evolve their internals freely without import cycles.
// ---------------------------------------------------------------------------

/** Handle on the Drizzle DB and its lifecycle. Implemented in `lib/db.ts`. */
export interface DbClient {
  /**
   * The Drizzle instance, already bound to the mode-specific driver
   * (@coodra/db's SQLite + better-sqlite3 or Postgres + postgres.js).
   * Typed as `unknown` here to avoid baking the driver choice into the
   * ToolContext interface; `lib/db.ts` re-exports a typed version for
   * lib-internal consumers that need it.
   */
  readonly db: unknown;
  /** Closes the underlying connection. Idempotent. */
  close(): Promise<void>;
}

// `Identity`, `AuthClient` moved to `@coodra/shared/auth` and
// `PolicyClient` moved to `@coodra/policy` in Module 03 S3 so
// `apps/hooks-bridge` can use the same shapes without depending on
// `apps/mcp-server`. Re-exported here so existing imports
// (`import type { Identity } from '../framework/tool-context.js'`)
// keep compiling. Imported above for use in the local interfaces.
export type { AuthClient, Identity, PolicyClient };

/** Feature-Pack store. Implemented (stub) in `lib/feature-pack.ts`, real impl in S7c. */
export interface FeaturePackStore {
  get(args: { projectSlug: string; filePath?: string }): Promise<unknown>;
  list(args: { projectSlug: string }): Promise<ReadonlyArray<unknown>>;
  upsert(pack: unknown): Promise<unknown>;
}

/**
 * Context-Pack store. Implemented in `lib/context-pack.ts`.
 *
 * Module 05 reshape (2026-05-08): the embedding parameter is gone.
 * `write` now takes an options object with `source` (provenance flag —
 * 'agent' | 'bridge_auto') and optional `meta` (agent-curated JSON
 * metadata). See `docs/feature-packs/05-agent-driven-nl-assembly/spec.md`
 * §5.4 for the source semantics — including the narrow ADR-007
 * relaxation that lets an agent-explicit save overwrite a bridge_auto
 * row.
 */
export interface ContextPackStoreWriteOptions {
  readonly source: 'agent' | 'bridge_auto';
  readonly meta?: Record<string, unknown>;
  /**
   * Module 04 Phase 4 — Clerk user id of the actor saving the pack.
   * Stamped on `context_packs.created_by_user_id`. NULL on solo-mode
   * + when the actor identity is unavailable.
   */
  readonly createdByUserId?: string | null;
}

export interface ContextPackStore {
  write(pack: unknown, options?: ContextPackStoreWriteOptions): Promise<unknown>;
  read(runId: string): Promise<unknown>;
  list(filter: { projectSlug?: string; runId?: string; limit?: number }): Promise<ReadonlyArray<unknown>>;
}

/**
 * Run-recorder. Implemented in `lib/run-recorder.ts` (S7c).
 *
 * Design note (user S7a directive Q2): the `runId: string | null`
 * nullable invariant (§4.3 — PreToolUse can fire before a run
 * exists) is handled INSIDE this module. Tool code passes whatever
 * it has; the recorder's internals translate `null` → SQL NULL on
 * insert. Call sites never branch on `if (runId)`.
 *
 * Schema backing (`packages/db/src/schema/{sqlite,postgres}.ts`):
 *   `run_events.run_id` is `text references(() => runs.id, { onDelete:
 *   'set null' })` — nullable + cascade-to-NULL. Widened in Module-02
 *   migration 0002 from the initial NOT NULL shape so the
 *   `RunRecorder.record({ runId: null, ... })` contract is truthful
 *   (see context_memory/decisions-log.md 2026-04-24 — the original
 *   S7a docblock's reference to `ON DELETE SET NULL` was aspirational
 *   against a schema that hadn't yet been updated; this entry
 *   references the real, landed clause).
 *
 * Scope (S7c): this recorder writes ONLY `run_events`. `runs` rows
 * are owned by the `get_run_id` tool (§S8) which has the full
 * project/agentType/mode context to populate that table's NOT NULL
 * columns.
 */
export interface RunRecorder {
  record(args: {
    runId: string | null;
    toolName: string;
    /**
     * 'pre'/'post' — Claude Code-style hook events (bridge-driven).
     * 'mcp_call' — agent invoked a coodra__* MCP tool. Added 2026-05-08
     * to close the visibility gap where MCP tool calls were invisible in
     * the run timeline (only Bash/Edit/Write showed up via PostToolUse).
     */
    phase: 'pre' | 'post' | 'mcp_call';
    sessionId: string;
    idempotencyKey: IdempotencyKey;
    input: unknown;
    output?: unknown;
    decision?: 'allow' | 'deny';
    reason?: string | null;
  }): Promise<void>;
}

/**
 * SqliteVecClient was the embedding-search interface for the abandoned
 * Module 05 NL Assembly Python service. Removed in the M05 reshape
 * (2026-05-08) — search is now keyword-only LIKE, agent does relevance
 * ranking. See `docs/feature-packs/05-agent-driven-nl-assembly/spec.md`.
 *
 * Kept here as a documentation-only marker so future grep for the
 * symbol returns a deliberate "this was removed by design" hit rather
 * than a missing-import puzzle.
 */

/**
 * GraphifyClient was the structural-graph reader for the Graphify
 * integration. Removed 2026-05-21 — Module 09 (ADR-010 rewrite,
 * Option C): Graphify is now consumed via its own MCP server wired
 * into the agent config, so Coodra no longer reads `graph.json`
 * itself. See `system-architecture.md` §17 and
 * `docs/feature-packs/09-integrations/`.
 *
 * Kept as a documentation-only marker (mirrors the SqliteVecClient
 * marker above) so a future grep for the symbol returns a deliberate
 * "removed by design" hit rather than a missing-import puzzle.
 */

// ---------------------------------------------------------------------------
// Aggregated shapes.
// ---------------------------------------------------------------------------

/**
 * The lib-client bag. Constructed ONCE at boot in `index.ts` by
 * wiring the per-module factories, then passed to `ToolRegistry` at
 * construction time. Every `handleCall` spreads this bag into the
 * per-call ctx that handlers see.
 */
export interface ContextDeps {
  readonly db: DbClient;
  readonly logger: Logger;
  readonly auth: AuthClient;
  readonly policy: PolicyClient;
  readonly featurePack: FeaturePackStore;
  readonly contextPack: ContextPackStore;
  readonly runRecorder: RunRecorder;
}

/** Per-call fields the registry populates for every invocation. */
export interface PerCallContext {
  readonly toolName: string;
  readonly sessionId: string;
  /** Unique id for this tool invocation. Distinct from `sessionId`. */
  readonly requestId: string;
  readonly receivedAt: Date;
  readonly idempotencyKey: IdempotencyKey;
  /**
   * Canonical `runs.agent_type` for the caller. Populated by the
   * transport from the MCP `initialize.clientInfo.name` handshake
   * value (via `src/lib/agent-type.ts::mapAgentType`). Additive slot
   * landed in S8 (user directive Q2 2026-04-24) as a reserved
   * future-transport-metadata slot. Tests inject `'unknown'` via
   * `makeFakeDeps` when they don't care about the value.
   */
  readonly agentType: string;
  /**
   * Clock injection. Tool handlers call this instead of `new Date()`
   * so tests can inject a frozen clock and the tool code is entirely
   * clock-agnostic. Enforced by `__tests__/unit/tools/_no-raw-date.test.ts`.
   */
  readonly now: () => Date;
}

/** What every tool handler receives as its second argument. Frozen shape. */
export type ToolContext = ContextDeps & PerCallContext;
