# Module 02 — MCP Server — Implementation Plan

> Follow top-to-bottom. Each step lists the files it creates/modifies and the commit it belongs to. Every commit that bumps a package version amends `External api and library reference.md` in the same commit — amendment B, carried forward from Module 01. 23 slices total (S7 was split into S7a/S7b/S7c along trust boundaries per addition A of the approved plan).

## Prerequisites (one-time, before S1)

- Module 01 merged on `main` at `88aac10`.
- Node ≥ 22.16.0, pnpm ≥ 10.33.0, git ≥ 2.40 (already required by Module 01).
- **Docker Desktop running** on the local machine. Required from S17 onward for the `testcontainers`-backed Postgres integration test. The daemon is already a GitHub-hosted `ubuntu-latest` runner default, so CI needs no config change for it.
- Repo-local git identity already set by Module 01 (verified: Abishai / abishai95141@gmail.com).

Clerk keys are **not** required to build or test Module 02. The solo-bypass path runs with zero real keys; the Clerk middleware is wired against env-var reads and is first live-tested in Module 04 or the first real team-mode flip.

## Step sequence

### S1 — Module 02 Feature Pack spec (this commit)

**Files:** `docs/feature-packs/02-mcp-server/spec.md`, `docs/feature-packs/02-mcp-server/implementation.md` (this file), `docs/feature-packs/02-mcp-server/techstack.md`.

**Commit:** `docs(02-mcp-server): spec, implementation plan, techstack`.

### S2 — Context memory handover

Archive the Module 01 `current-session.md` to `context_memory/sessions/2026-04-22-module-01.md` and open a fresh `current-session.md` for Module 02. Backfill its Log section with the S1 entries that already happened. Append to `context_memory/decisions-log.md` one entry per approved Q / addition from the Module 02 plan approval (Q-02-1 through Q-02-7, additions A/B/C/D). Update `context_memory/pending-user-actions.md` — **Docker Desktop** moves from "needed before Module 02" to "due now"; **Clerk publishable + secret keys** noted as "needed by Module 04 or first team-mode flip, whichever is earlier". `blockers.md` stays empty.

**Files:** `context_memory/sessions/2026-04-22-module-01.md` (new archive), `context_memory/current-session.md` (rewritten for Module 02), `context_memory/decisions-log.md` (appended), `context_memory/pending-user-actions.md` (edited).

**Commit:** `chore(context-memory): archive module-01 session, begin module-02`.

### S3 — DB: four new tables + `content_excerpt` column

Add `policies`, `policy_rules`, `policy_decisions`, `feature_packs` to both `packages/db/src/schema/sqlite.ts` and `packages/db/src/schema/postgres.ts`. Append `content_excerpt text NOT NULL default ''` to `context_packs` on both sides (default is empty string only for the migration; the application layer writes the real value on every insert). Extend the dialect-parity test to cover all four new tables. Add indices per `system-architecture.md §4.3`:

```sql
CREATE INDEX policy_rules_policy_priority_idx ON policy_rules (policy_id, priority ASC);
CREATE INDEX policy_decisions_session_idx     ON policy_decisions (session_id, created_at DESC);
CREATE UNIQUE INDEX policy_decisions_idemp_idx ON policy_decisions (idempotency_key);
CREATE UNIQUE INDEX feature_packs_slug_idx    ON feature_packs (slug);
```

Generate `0001_module_02_mcp_server.sql` for both dialects:

```bash
pnpm --filter @coodra/db exec drizzle-kit generate --config=drizzle.sqlite.config.ts
pnpm --filter @coodra/db exec drizzle-kit generate --config=drizzle.postgres.config.ts
```

The produced SQL is committed.

**Files:** `packages/db/src/schema/sqlite.ts`, `packages/db/src/schema/postgres.ts`, `packages/db/drizzle/sqlite/0001_*.sql`, `packages/db/drizzle/postgres/0001_*.sql`, `packages/db/drizzle/sqlite/meta/*`, `packages/db/drizzle/postgres/meta/*`, `packages/db/__tests__/unit/schema-parity.test.ts` (extended).

**No reference updates** — `drizzle-orm` and `drizzle-kit` are unchanged from Module 01.

**Commit:** `feat(db): policies, policy_rules, policy_decisions, feature_packs tables`.

### S4 — DB: sqlite-vec virtual table + pgvector HNSW index (hand-edited + locked)

Hand-append to `packages/db/drizzle/sqlite/0001_*.sql`:

```sql
-- @preserve-begin hand-written
CREATE VIRTUAL TABLE context_packs_vec USING vec0(
  context_pack_id TEXT PRIMARY KEY,
  summary_embedding float[384] distance_metric=cosine
);
-- @preserve-end
```

Hand-append to `packages/db/drizzle/postgres/0001_*.sql`:

```sql
-- @preserve-begin hand-written
CREATE INDEX context_packs_embedding_hnsw ON context_packs
  USING hnsw (summary_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
-- @preserve-end
```

Record the sha256 of each block in `packages/db/migrations.lock.json` with this shape:

```json
{
  "0001_module_02_mcp_server.sql": {
    "sqlite": { "context_packs_vec": "sha256:..." },
    "postgres": { "context_packs_embedding_hnsw": "sha256:..." }
  }
}
```

Add `packages/db/scripts/check-migration-lock.mjs` — extracts each `@preserve-begin / @preserve-end` block, recomputes sha256, diffs against `migrations.lock.json`, exits non-zero on mismatch. Wire it as `pnpm --filter @coodra/db run check:migration-lock` and add it as the first step of the `verify` CI job (before `lint`). Drop a `CI: migration lock integrity` reminder paragraph into `docs/DEVELOPMENT.md` explaining what to do if `drizzle-kit` regenerate overwrites a block.

Install `sqlite-vec@^0.1.9` as a dev dependency of `@coodra/db`. Wire `sqliteVec.load(db)` inside `createSqliteDb` immediately after the better-sqlite3 connection opens, wrapped in try/catch — on failure, log a structured `sqlite_vec_unavailable` warning and continue (the search-packs-nl LIKE fallback takes over).

Extend `packages/db/__tests__/integration/postgres-migrate.test.ts` to verify the HNSW index exists. Add `packages/db/__tests__/integration/sqlite-vec.test.ts` that loads the extension, creates the virtual table, inserts a 384-d vector, and performs a `MATCH` KNN query — assert the expected row is returned.

**Reference updates in the same commit** (amendment B):

- `External api and library reference.md` — `sqlite-vec` section: pin `^0.1.9`; add the `db.loadExtension(getLoadablePath())` snippet and the brute-force-KNN gotcha.

**Files:** `packages/db/drizzle/sqlite/0001_*.sql` (hand-append), `packages/db/drizzle/postgres/0001_*.sql` (hand-append), `packages/db/migrations.lock.json` (new), `packages/db/scripts/check-migration-lock.mjs` (new), `packages/db/package.json` (add `sqlite-vec`), `packages/db/src/client.ts` (extension-load branch), `packages/db/__tests__/integration/sqlite-vec.test.ts` (new), `packages/db/__tests__/integration/postgres-migrate.test.ts` (extended), `.github/workflows/ci.yml` (add `check:migration-lock` step), `docs/DEVELOPMENT.md` (migration-lock section), `External api and library reference.md`.

**Commit:** `feat(db): sqlite-vec virtual table + pgvector HNSW index for context_packs`.

### S5 — Bootstrap `apps/mcp-server` + tool-registration framework + `ping` walking skeleton

**Scope grew on 2026-04-23** per the user-approved S5 directive — S5 is now a full walking skeleton that proves every layer of the framework before S6+ ship the real tools. The previous S6 (tool-registration framework) and parts of S7a (env/logger infra) are folded into this slice, and a minimal `ping` tool lands to end-to-end-prove the pipeline.

**What lands in S5:**

- `apps/mcp-server/package.json` (private, `"type": "module"`, `bin`), `tsconfig.json` + `tsconfig.typecheck.json` (extends `../../tsconfig.base.json`), `vitest.config.ts`, `README.md`, `.env.example`, `.dockerignore`.
- Runtime deps pinned EXACT where protocol stability demands it: `@modelcontextprotocol/sdk@1.29.0` (no caret — MCP minor bumps can add required fields), `zod@^4.3.6` (matches shared), `@coodra/shared` + `@coodra/db` as workspace deps. The HTTP-transport deps (`hono`, `@hono/node-server`, `cockatiel`, `@clerk/backend`, `ajv`, `ajv-formats`) are deferred to S16 (HTTP transport) per the directive's "stdio-only in S5" constraint — installing them now would bloat the dev graph with unused code.
- `zod-to-json-schema` **dropped** in favour of Zod v4's built-in `z.toJSONSchema()`. Deviates from techstack.md's original `^3.25.2` pin; decision recorded in `decisions-log.md 2026-04-23`.
- `src/bootstrap/ensure-stderr-logging.ts` — side-effect module imported first in `src/index.ts`. Sets `COODRA_LOG_DESTINATION=stderr` before `@coodra/shared`'s logger module evaluates, so every transitively-loaded log call (including db's sqlite-vec loader in future slices) routes to fd 2.
- `src/config/env.ts` — zod-validated, typed `env` singleton, parsed once at module load via `@coodra/shared::parseEnv`. The ONE module in mcp-server allowed to read `process.env`. Strictness rules (team-mode Clerk requirements, LOCAL_HOOK_SECRET length floor, COODRA_LOG_DESTINATION enum) are enforced here and locked by 8 regression fixtures in `__tests__/unit/config/env.test.ts`.
- `src/framework/manifest-from-zod.ts` — wraps `z.toJSONSchema` with Coodra's target (`draft-2020-12`) and runtime `type: 'object'` check.
- `src/framework/idempotency.ts` — `IdempotencyKeyBuilder<Input>` contract + `assertIdempotencyKeyBuilder` runtime probe. Read-only tools return `{ kind: 'readonly', key }`; mutating tools return `{ kind: 'mutating', key }` which the registry forwards into the handler's context for ON-CONFLICT dedupe in DB operations.
- `src/framework/policy-wrapper.ts` — `PolicyCheck` abstraction, `PolicyDenyError`, plus `devNullPolicyCheck` always-allow stand-in for S5. S7b replaces it with the real cache-backed `lib/policy.ts::evaluatePolicy` as a single-file swap at `src/index.ts`. `logDevNullPolicyInUse()` writes a WARN at startup so the dev-null path cannot ship to production unnoticed.
- `src/framework/tool-registry.ts` — the enforcement core. `ToolRegistry.register(reg)` validates, synchronously, at registration time:
  1. name shape `^[a-z][a-z0-9_]{2,63}$`, no duplicates
  2. description length ≥ 200 chars (the `MIN_DESCRIPTION_LENGTH` constant)
  3. `inputSchema` is a z.object
  4. `outputSchema` is present (Zod type)
  5. handler arity is exactly 2
  6. idempotencyKey builder returns a well-formed key when probed
  Invalid registrations throw — the server refuses to start. `handleCall` routes every call through input validation → idempotency-key build → pre-phase policy check → handler → output validation → post-phase policy check. Handlers cannot opt out of policy evaluation because they never see an unwrapped call path.
- `src/tools/ping/{schema,handler,manifest}.ts` — the walking-skeleton tool. Read-only, no filesystem/db/network side effects. Returns `{ ok, pong, serverTime, sessionId, idempotencyKey, echo? }`. Description is 666 chars and follows the §24.3 "Call this tool when…/Returns" recipe.
- `src/transports/stdio.ts` — uses the SDK's low-level `Server` + `setRequestHandler` (not the high-level `McpServer.registerTool`) because our custom registry already owns input parsing, output validation, idempotency, and policy. Registers handlers against the SDK-exported `ListToolsRequestSchema` / `CallToolRequestSchema`. Bound to `StdioServerTransport`.
- `src/index.ts` — entrypoint. First import is `./bootstrap/ensure-stderr-logging.js`. Constructs one `ToolRegistry`, registers `pingToolRegistration`, starts the stdio transport with a per-process `sessionId = stdio:<uuid>`. SIGINT/SIGTERM → graceful shutdown.
- `Dockerfile` — four-stage build (deps → build → pnpm deploy → runtime). Base image pinned by digest `node@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34` (Node 22.16.0 bookworm-slim — glibc, required for better-sqlite3/sqlite-vec prebuilt binaries). Runtime stage: non-root `node` user, no build tools, `COODRA_LOG_DESTINATION=stderr` as defence-in-depth, `CMD ["node", "dist/index.js"]`.
- `.mcp.json` — updated from the stub HTTP URL to a real stdio entry pointing at `apps/mcp-server/dist/index.js` with `env.COODRA_LOG_DESTINATION=stderr`.
- **Logger change to `@coodra/shared`:** extended `packages/shared/src/logger.ts` to honour `COODRA_LOG_DESTINATION={unset,stdout,stderr}`. Unknown values throw at module load; `'stderr'` routes pino to fd 2 via `pino.destination({ fd: 2, sync: true })`. Four new tests in `packages/shared/__tests__/unit/logger.test.ts` lock the parse contract.

**Unit tests added (34 new, all green):**

- `__tests__/unit/framework/manifest-from-zod.test.ts` (4) — conversion, `.describe()` passthrough, non-object rejection, JSON-serialisable output.
- `__tests__/unit/framework/tool-registry.test.ts` (13) — 8 negative cases pinning each enforcement rule, 5 happy-path cases including a handler-opt-out proof (deny blocks the handler).
- `__tests__/unit/config/env.test.ts` (8) — four valid fixtures + four invalid fixtures; locks the exact env contract addition D requires.
- `__tests__/unit/tools/ping.test.ts` (8) — manifest contract, roundtrip, echo, oversize rejection, idempotency-key purity.
- `__tests__/unit/transports/stdio-stdout-purity.test.ts` (1) — spawns the real entrypoint via tsx, sends an `initialize` frame, asserts stdout is JSON-RPC-only and stderr is pino-JSON-only. This is the authoritative proof that the stderr-logging contract survives transitive imports.

**Reference updates in the same commit** (amendment B):

- `External api and library reference.md` — new **`@modelcontextprotocol/sdk` (Node.js server)** subsection under Protocols & Transports: exact pin `1.29.0`, Server-vs-McpServer decision, Zod v4 compatibility note (no `zod-to-json-schema`), full stdio-transport stderr contract with links to the three enforcement points.
- `External api and library reference.md` — Pino section amended with the `COODRA_LOG_DESTINATION` gotcha.

**Deferred to S6+** (not in S5):

- `zod-to-json-schema` — dropped permanently; Zod v4's native helper replaces it.
- `hono`, `@hono/node-server`, `cockatiel`, `@clerk/backend`, `ajv`, `ajv-formats` — added in S16 when the HTTP transport lands. Their pins stay pending in techstack.md until then.
- `testcontainers`, `@testcontainers/postgresql` — added in S17 for integration tests.
- Auth chain (Clerk + solo-bypass + LOCAL_HOOK_SECRET) — S7b only; stdio is a trusted local channel and needs no auth.
- Real `lib/policy.ts::evaluatePolicy` — S7b; the registry's policy injection point is already the right abstraction boundary.

**Files:** `apps/mcp-server/package.json`, `apps/mcp-server/tsconfig.json`, `apps/mcp-server/tsconfig.typecheck.json`, `apps/mcp-server/vitest.config.ts`, `apps/mcp-server/README.md`, `apps/mcp-server/.env.example`, `apps/mcp-server/.dockerignore`, `apps/mcp-server/Dockerfile`, `apps/mcp-server/src/bootstrap/ensure-stderr-logging.ts`, `apps/mcp-server/src/config/env.ts`, `apps/mcp-server/src/framework/{manifest-from-zod,idempotency,policy-wrapper,tool-registry}.ts`, `apps/mcp-server/src/tools/ping/{schema,handler,manifest}.ts`, `apps/mcp-server/src/transports/stdio.ts`, `apps/mcp-server/src/index.ts`, `apps/mcp-server/__tests__/unit/**`, `packages/shared/src/logger.ts`, `packages/shared/__tests__/unit/logger.test.ts`, `.mcp.json`, `External api and library reference.md`.

**Commit:** `feat(mcp-server): scaffold @coodra/mcp-server — stdio transport, tool-registration framework, ping walking skeleton`.

### S6 — §24.3 description assertion helper (shared) + §24.3 spec amendment

The tool-registration framework and `manifest-from-zod` helper landed in S5 as part of the walking-skeleton scope expansion. S6 is therefore narrow but essential: bake the §24.3 "tool descriptions are agent prompts" contract into a single shared helper that every Coodra tool test — not just mcp-server's — routes through.

**Landed 2026-04-23:**

- **New subpath `@coodra/shared/test-utils`** (see `packages/shared/package.json` `exports`): wired as a dedicated export so production consumers of `@coodra/shared` do not transitively pick up test-only code in their bundle graph.
- `packages/shared/src/test-utils/manifest-assertions.ts` — `assertManifestDescriptionValid(manifest, { folderName? })`. Enforces: name matches `TOOL_NAME_PATTERN` (and folder when supplied, with hyphen → underscore translation), char length in `[200, 800)`, starts with "Call this" (case-insensitive), word count in `[40, 120]`, contains "Returns".
- `packages/shared/src/test-utils/index.ts` — subpath entry re-exports.
- `packages/shared/__tests__/unit/test-utils/manifest-assertions.test.ts` — 11 tests: 3 happy-path + 8 negative (one per rule) so a CI failure names exactly the rule that broke.
- `apps/mcp-server/__tests__/unit/tools/ping.test.ts` — collapsed from 4 ad-hoc assertions to one call into the shared helper. Future tools in `apps/mcp-server/src/tools/<tool>/` and any downstream `@coodra/tools-*` package use the same helper.
- `system-architecture.md` §24.3 amended to "40–80 word soft target, 120-word hard maximum" per Q-02-6. §24.8 safeguard 1 updated to reference the canonical shared helper.

**Decision recorded** (2026-04-23): the helper lives in `@coodra/shared/test-utils`, not `apps/mcp-server/__tests__/helpers/`, because future tool packages shipped outside the mcp-server will need the same assertion without taking a dev dep on the server package.

**Files:** `packages/shared/package.json` (new subpath export), `packages/shared/src/test-utils/{index,manifest-assertions}.ts`, `packages/shared/__tests__/unit/test-utils/manifest-assertions.test.ts`, `apps/mcp-server/__tests__/unit/tools/ping.test.ts`, `system-architecture.md` §24.3 + §24.8.

**Commit:** `feat(shared): assertManifestDescriptionValid in @coodra/shared/test-utils + §24.3 amendment`.

### S7a — Lib layer + frozen `ToolContext` (landed 2026-04-23)

**User directive recap:** before S7b/c land real behaviour, lock the shape of every infrastructure boundary every tool handler will see. "Shapes before guts": a handler written today and a handler written in S15 must reach every subsystem through identical names and identical types. The slice below is that lock.

**What landed:**

- `apps/mcp-server/src/framework/tool-context.ts` — canonical `ToolContext` + `ContextDeps` + `PerCallContext`. Every handler receives the frozen bag; there are no hidden imports, no `globalThis`, no module-level singletons. The `AuthClient`, `PolicyClient`, `FeaturePackStore`, `ContextPackStore`, `RunRecorder`, `SqliteVecClient`, `GraphifyClient`, and `DbClient` interfaces live here — they are the vocabulary shared between the registry and the lib layer.
- `apps/mcp-server/src/lib/{logger,errors,db,auth,policy,feature-pack,context-pack,run-recorder,sqlite-vec,graphify}.ts` — nine typed factories, one file each, each returning a value that satisfies the corresponding `ToolContext` slot. **No module-level singletons are exported.** `createXxxClient(...)` is the only way in.
  - `logger.ts` — `createMcpLogger(moduleName)` wraps `@coodra/shared::createLogger` with an `mcp-server.<moduleName>` namespace.
  - `errors.ts` — `NotImplementedError` (subclass of `@coodra/shared::InternalError`, name `'NotImplementedError'`, carries a `subsystem` tag) + `mcpErrorResult(err)` that translates any `AppError` / unknown throwable into the MCP `{ content, isError: true }` envelope. Used consistently by every lib stub so a CI grep can verify a single error shape across all 8 tools.
  - `db.ts` — `createDbClient(options)` delegates to `@coodra/db::createDb`, returns `{ client, asInternalHandle() }`. `close()` is idempotent. A `_testOverrideInMemory` shorthand is reserved for the stdio-purity subprocess test.
  - `auth.ts` — `createSoloAuthClient()` + `createAnonymousAuthClient()`. Solo returns a stable `SOLO_IDENTITY = { userId: 'user_dev_local', orgId: 'org_dev_local', source: 'solo-bypass' }`. The solo factory emits a WARN on construction so team-mode smoke deployments see the stand-in in every log. Clerk-backed factory lands in S7b behind the same interface.
  - `policy.ts` — `createPolicyClientFromCheck(check)` wraps a `PolicyCheck` callback into a `PolicyClient`; `createDevNullPolicyClient()` is the S7a always-allow stand-in plus its WARN. The previous `framework/policy-wrapper.ts::devNullPolicyCheck` export was deleted; `policy-wrapper.ts` now holds only the shared vocabulary (`PolicyInput`, `PolicyResult`, `PolicyCheck`, `PolicyDenyError`).
  - `feature-pack.ts`, `context-pack.ts`, `run-recorder.ts`, `sqlite-vec.ts`, `graphify.ts` — factories whose methods throw `NotImplementedError('<subsystem>.<method>')`. The signatures already honour the user-directive answers: `context-pack.write(pack, embedding: Float32Array | null)` (Q3 — the store never computes an embedding; Module 04 does); `run-recorder.record({ runId: string | null, ... })` (Q2 — PreToolUse may fire before a run exists; the nullable invariant lives inside the recorder, not at every call site); `sqlite-vec` exposes a domain API (`searchSimilarPacks`) not a raw query runner; `graphify` exposes `expandContext`, not a filesystem helper.
- `apps/mcp-server/src/framework/tool-registry.ts` — constructor now takes `{ deps: ContextDeps, clock?: () => Date, mintRequestId?: () => string }`. Handlers receive the full frozen `ToolContext = ContextDeps & PerCallContext`. The registry is the **single location in `src/**`** that reads from a `Date` constructor (via the injected clock); every `ctx.now()` flows through it. Policy evaluation goes through `deps.policy.evaluate(...)` pre- and post-handler.
- `apps/mcp-server/src/tools/ping/handler.ts` — updated to consume `ToolContext` and produce `serverTime = ctx.now().toISOString()`.
- `apps/mcp-server/src/index.ts` — builds `ContextDeps` from the nine factories, hands it to `new ToolRegistry({ deps })`, registers `ping`, starts the stdio transport, and shuts down (transport + `dbClient.close()`) on SIGINT/SIGTERM. The boot comment is the map of the slice.

**Tests:**

- `__tests__/unit/framework/tool-registry.test.ts` — 18 cases covering construction contract, register-time enforcement, pre/post policy, invalid input, unknown tool, clock injection (`ctx.now()`), and stable `requestId`.
- `__tests__/unit/tools/_no-raw-date.test.ts` — **clock-discipline guard.** Walks `src/tools/**` and fails CI if any file contains a literal `new Date(` substring. The only legitimate `Date` constructor call in `src/**` is the registry's own injected clock.
- `__tests__/unit/tools/ping.test.ts` — migrated to the new `ToolRegistry({ deps })` shape via the shared `makeFakeDeps` helper.
- `__tests__/unit/transports/stdio-stdout-purity.test.ts` — spawns the real `src/index.ts` under `COODRA_SQLITE_PATH=:memory:` so S7a's newly-wired `createDbClient` does not touch the user's `~/.coodra/data.db`.
- `__tests__/integration/lib/*.test.ts` — one file per factory (`db`, `auth`, `policy`, `feature-pack`, `context-pack`, `run-recorder`, `sqlite-vec`, `graphify`, `logger`, `errors`). 45 tests. Each pins construction contract + stub behaviour so the S7b/c replacements can swap the body without touching signatures.
- `__tests__/helpers/fake-deps.ts` — `makeFakeDeps(overrides?)` for the unit suite.
- `vitest.integration.config.ts` + `pnpm test:integration` script.

**Biome:** `biome.json` now enables `suspicious/noImportCycles: 'error'` on `apps/mcp-server/src/lib/**` so the factory tree stays acyclic as it grows.

**Gate:** `pnpm install --frozen-lockfile` (clean), `check:migration-lock` (ok, 2 blocks), `pnpm lint` (0 errors), `pnpm typecheck` (all 3 packages), `pnpm --filter @coodra/mcp-server test:unit` (39/39), `pnpm --filter @coodra/mcp-server test:integration` (45/45), repo-wide `pnpm test:unit` (full turbo).

**Commit:** `feat(mcp-server): S7a — freeze ToolContext + lib factories + clock-discipline guard`.

**Deferred to later slices (per user directive):**

- S7b lands the real `lib/auth.ts` (Clerk + local-hook-secret chain) and `lib/policy.ts` (cache-first evaluator, cockatiel breaker, async idempotent `policy_decisions` inserts). Swap is a single line in `src/index.ts`.
- S7c lands the real bodies of `lib/feature-pack.ts`, `lib/context-pack.ts`, `lib/run-recorder.ts`, `lib/sqlite-vec.ts`, `lib/graphify.ts`. Each swap is a function-body change only — file tree, interfaces, and wiring are frozen.
- `apps/mcp-server/src/lib/env.ts` — **not needed.** The env schema already lives at `apps/mcp-server/src/config/env.ts` (landed S6); moving it is unnecessary.

### S7b — Lib: auth + policy (landed 2026-04-24)

**User directive recap:** swap the S7a stubs for real bodies in `lib/auth.ts` and `lib/policy.ts`. No edits to `tool-context.ts`, no interface changes, body swaps only. The Clerk chain is wired but not live-validated against a real tenant (that is a Module 04 precondition, per `context_memory/pending-user-actions.md`).

**What landed:**

- `apps/mcp-server/src/lib/auth.ts` — real auth module. `createSoloAuthClient`, `createAnonymousAuthClient`, and `SOLO_IDENTITY` are unchanged; three new exports land: `verifyLocalHookSecret(presented, expected): boolean` (constant-time compare via `node:crypto::timingSafeEqual`, defence-in-depth length / type guards), `verifyClerkJwt(token, env): Promise<Identity>` (thin adapter over `@clerk/backend@3.3.0`'s top-level `verifyToken(token, { secretKey })` export — not `ClerkClient.verifyToken`, which does not exist; see decisions-log 2026-04-24), and `createClerkAuthClient(env): AuthClient` (returns `{ getIdentity: () => null, requireIdentity: () => throw UnauthorizedError }` on stdio — null-then-helpers per user directive Q1; per-request identity flows through the two helpers above when S16 HTTP middleware lands). The top-level dispatcher `createAuthClient(env)` picks solo when the solo-bypass sentinel is set OR `COODRA_MODE === 'solo'`, otherwise Clerk. The chain order (solo → local-hook → Clerk) mirrors `context_memory/decisions-log.md` 2026-04-22 Q-02-1 and `system-architecture.md` §19.

- `apps/mcp-server/src/lib/policy.ts` — real cache-first evaluator. `createPolicyClientFromCheck` and `createDevNullPolicyClient` + `devNullPolicyCheck` stay exported (test fixtures depend on them). The new `createPolicyClient({ db, now?, cacheTtlMs?, timeoutMs?, breakerThreshold?, breakerHalfOpenMs? })` factory returns a `PolicyClient` whose `evaluate()` does:
  1. Cache-first rule read with 60 s TTL (keyed globally for Module 02 solo-mode; per-project keying deferred to S14 — see decisions-log 2026-04-24).
  2. DB read wrapped in `wrap(timeout(100, TimeoutStrategy.Aggressive), circuitBreaker(handleAll, { halfOpenAfter: 30_000, breaker: new ConsecutiveBreaker(5) }))` from `cockatiel@3.2.1`. Numbers are `§7` verbatim plus the 100ms fuse per user directive Q4.
  3. First-match-wins rule evaluation via the exported pure function `evaluateRules(rules, input)`. Match axes: event-type (PreToolUse/PostToolUse/`*`), tool-name (exact/`*`/picomatch glob — `picomatch@4.0.2`), path-glob (picomatch, compiled once per rule at cache-load), agent-type (`null` or `*` only for the auto-wrap path; specific-agent rules are skipped until S14 threads agentType through input).
  4. Fail-open on every error path: `BrokenCircuitError`, `IsolatedCircuitError`, `TaskCancelledError`, or any DB throw returns `{ decision: 'allow', reason: 'policy_check_unavailable', matchedRuleId: null }`. WARN-logs with `{ tool, phase, sessionId, durationMs, reason|err }` so degradation is visible before the breaker trips.
  5. INFO log at construction (`policy_engine_wired` with mode + cache/timeout/breaker knobs) — pairs with the S7a dev-null WARN to give ops a binary grep signal.
  - `createPolicyClient` does NOT write to `policy_decisions` from the registry auto-wrap path — the PolicyInput shape (frozen) lacks `projectId`, `agentType`, `runId`, which are NOT NULL FK columns. The audit-write helper `recordPolicyDecision(db, args)` is exported from the same module as real wire code (ON CONFLICT DO NOTHING on the locked idempotency key `pd:{sessionId}:{toolName}:{eventType}` per §4.3, accepts `runId: string | null`). S14's `check_policy` MCP tool is the first call site. See decisions-log 2026-04-24 for the rationale.
  - Key builder `buildPolicyDecisionIdempotencyKey` is also exported so S14 and any future auditing test uses the same format.

- `apps/mcp-server/src/index.ts` — two factory-call swaps: `createSoloAuthClient()` → `createAuthClient(env)`, and `createDevNullPolicyClient()` → `createPolicyClient({ db: dbClient.asInternalHandle() })`. Nothing else changes. Shutdown flow unchanged (no setImmediate writes from the evaluator; flush hook arrives with S14's `check_policy` audit writes).

- `apps/mcp-server/package.json` — three runtime deps exact-pinned: `cockatiel@3.2.1`, `@clerk/backend@3.3.0`, `picomatch@4.0.2`. One devDep: `@types/picomatch@4.0.2`. Also adds `drizzle-orm@^0.45.2` as a direct runtime dep (matches `@coodra/db`'s pin) because `lib/policy.ts` imports `eq` from it.

- `biome.json` — `.claude` and `context_memory` added to `files.includes` exclusion list. Pre-existing Claude Code internal worktrees carry their own nested biome.json which was failing root-level `pnpm lint`. This is ancillary to S7b but unblocks the gate.

- `External api and library reference.md` — amendment-B mandatory update same commit: cockatiel section rewritten against 3.2.1 (verbatim breaker config, timeout-inside-breaker pattern, TaskCancelledError/BrokenCircuitError handling); new `@clerk/backend` subsection under Auth & Security (exact 3.3.0 pin, top-level `verifyToken` snippet, JWKS caching note, "wired but not live-validated" flag); new `picomatch` subsection under Validation, Schemas & Resilience (exact 4.0.2 pin, compile-at-cache-load pattern, picomatch-over-minimatch rationale).

- `context_memory/decisions-log.md` — six new entries appended (2026-04-24): cockatiel exact pin + breaker config, @clerk/backend exact pin + top-level verifyToken entrypoint, picomatch exact pin, AuthClient null-on-stdio contract, policy cache global-keying for Module 02, policy_decisions writes deferred to S14.

- `context_memory/pending-user-actions.md` — the Clerk-project entry is refreshed to note S7b ships the real wire code + mandates a Module-04 AC for the first live validation. New entry added for the future `coodra team login` CLI → `~/.coodra/config.json` read-path for `LOCAL_HOOK_SECRET` (env-only is the S7b scope, per user directive Q7).

**Tests added or changed:**

- `__tests__/unit/lib/auth-chain.test.ts` (new, ~19 tests) — hoist-mocks `@clerk/backend::verifyToken` via `vi.mock`; covers `createAuthClient` dispatcher (solo / solo-bypass-sentinel-in-team / real-team), `createClerkAuthClient` construction rejection of the sentinel + missing publishable key, `verifyLocalHookSecret` (match / length-mismatch / same-length-different-content / non-string / empty), `verifyClerkJwt` (valid token with/without org_id, SDK rejection, missing `sub`, empty token short-circuit, sentinel secret short-circuit).
- `__tests__/unit/lib/policy-rules.test.ts` (new, ~17 tests) — pure unit tests against the exported `evaluateRules` function: empty ruleset, event-type axis, tool-name axis (exact/`*`/glob), path-glob axis (null matcher / missing path / matching / file_path / path / non-match), agent-type axis (null / `*` / pinned-to-specific-agent skipped), first-match-wins by priority ASC.
- `__tests__/integration/lib/auth.test.ts` (extended, +4 tests) — dispatcher fixtures for solo vs sentinel-in-team vs real-team; `createClerkAuthClient` construction-contract rejection cases.
- `__tests__/integration/lib/policy.test.ts` (extended, +3 tests) — `createPolicyClient` construction contract (missing options, missing db); `buildPolicyDecisionIdempotencyKey` format lock (`pd:{sessionId}:{toolName}:{eventType}`).
- `__tests__/integration/lib/policy-db.test.ts` (new, ~9 tests) — end-to-end against real `:memory:` SQLite with migrations applied. Covers: no-rules → allow with `no_rule_matched` reason; seeded deny-rule match with `matchedRuleId` populated; priority ASC first-match-wins across two rules; TTL cache behavior with fake clock (stale within TTL, refresh after); DB-throw fail-open + breaker-open fail-open; `recordPolicyDecision` inserts with locked idempotency key shape; ON CONFLICT DO NOTHING retry dedupe; null runId accepted per §4.3.

**Gate (all green):**

- `pnpm install --frozen-lockfile` — clean.
- `pnpm --filter @coodra/db run check:migration-lock` — ok, 2 blocks verified.
- `pnpm lint` — 0 errors, 1 pre-existing info (S5-era `useShorthandFunctionType` hint, intentionally left).
- `pnpm typecheck` — all 3 packages green.
- `pnpm --filter @coodra/mcp-server run test:unit` — **75/75** (was 40 at S7a; +35 from S7b: 17 policy-rules + 19 auth-chain − 1 deduped test setup line).
- `pnpm --filter @coodra/mcp-server run test:integration` — **61/61** (was 45 at S7a; +16 from S7b: 9 policy-db + 4 auth dispatcher + 3 policy construction).

**Commit:** `feat(mcp-server): S7b — real Clerk/local-hook auth + cache-first policy engine with breaker`.

**Deferred (per user directive, S7c scope):**

- S7c lands the real bodies of `lib/feature-pack.ts`, `lib/context-pack.ts`, `lib/run-recorder.ts`, `lib/sqlite-vec.ts`, `lib/graphify.ts`. Each swap is a function-body change only; file tree, interfaces, and wiring are frozen.
- S14's `check_policy` MCP tool lands the first caller of `recordPolicyDecision`, threading `projectId` / `agentType` / `eventType` / `runId` through from the Hooks Bridge input. At that point the policy cache key upgrades from global `'all'` to per-`projectId`.
- S16 HTTP transport lands the Clerk + local-hook middleware that calls `verifyClerkJwt` / `verifyLocalHookSecret` on inbound Bearer tokens / `X-Local-Hook-Secret` headers.

### S7c — Lib: domain services (landed 2026-04-24)

**Scope:** real bodies for the five remaining lib slots — `feature-pack`, `context-pack`, `run-recorder`, `sqlite-vec`, `graphify` — plus a same-commit schema migration 0002 that widens `run_events.run_id` to nullable + ON DELETE SET NULL so the frozen `RunRecorder.record({ runId: string | null })` contract is truthful against the DB.

**Reconciliations vs. the original plan (not deviations — doc-level fixes):**
- Filename: the original plan said `src/lib/sqlite-vec-client.ts`; S7a landed it as `src/lib/sqlite-vec.ts`. S7c keeps the actual filename; the S7a contract "file tree is frozen" governs.
- Run recorder scope: the original plan said "writes `runs` and `run_events`"; the frozen `RunRecorder.record()` signature does not carry `projectId`/`agentType`/`mode` (all NOT NULL on `runs`). The §S8 `get_run_id` handler owns `runs` row creation; S7c's recorder is `run_events`-only. Spec.md §68 and techstack.md §85 already reflect this; the doc drift was confined to this file.
- Outbox worker: the original plan's "in-process worker polled on 500ms" was superseded by spec.md §68 + techstack.md §85's "`setImmediate` + ON CONFLICT DO NOTHING, durable `pending_jobs` outbox deferred post-Module-03". S7c mirrors spec/techstack.

**What landed:**

- **`apps/mcp-server/src/lib/feature-pack.ts`** — filesystem-first loader. Reads `docs/feature-packs/<slug>/{spec,implementation,techstack}.md` + `meta.json` (a new per-pack file carrying `{ slug, parentSlug?, sourceFiles? }`); computes checksum = sha256 of the three markdown bodies concatenated in fixed (spec, implementation, techstack) order; compares against `feature_packs` row on read and upserts on mismatch (Q-02-4). 60s per-slug TTL cache keyed on load time; checksum mismatch drops the entry. Inheritance walks `parentSlug` root-first (no in-file merge per user Q3 — downstream S9 handler renders the chain); cycle detection via visited-set throws `InternalError('feature_pack_cycle', { chain })`. `upsert(pack)` writes FS + DB atomically from the caller's side; tests seed both the filesystem and the DB. `projectSlug === featurePackSlug` is documented in the store's docblock (Q1 confirmation; decisions-log 2026-04-24).

- **`apps/mcp-server/src/lib/context-pack.ts`** — DB-first writer with FS as a reconcilable view (Q4). Validates `pack` as `{ runId, projectId, title, content, featurePackId? }` via a local Zod schema; computes `contentExcerpt` = first 500 Unicode **code points** of `content` with trailing whitespace trimmed, via `Array.from(content).slice(0, 500).join('').replace(/\s+$/u, '')` (Q-02-3); idempotent per `runId` (existing row → returned shape, no second insert); inserts the `context_packs` row, then the `context_packs_vec` row for non-null embeddings (sqlite) or writes `summary_embedding` via pgvector for postgres; finally materialises `docs/context-packs/YYYY-MM-DD-<runId-first-8>.md`. Filesystem failure AFTER a successful DB insert logs WARN and returns success — DB is durable, FS is reconcilable. Non-null embeddings MUST have `length === EMBEDDING_DIM` (384); mismatch → `ValidationError` before any DB work. Exports `computeContentExcerpt` as a pure function so the unit test locks the Q-02-3 contract with emoji and CJK at code point 499.

- **`apps/mcp-server/src/lib/run-recorder.ts`** — async, idempotent `run_events` writer (Q6). `record()` validates args synchronously (so invalid phase / missing toolName throws BEFORE the setImmediate) and then fires an `INSERT ... ON CONFLICT (id) DO NOTHING` via `setImmediate`. Row id binds the caller's `idempotencyKey.key` + `phase`, so retries with the same key collide cleanly. `runId: null` is passed through as SQL NULL (requires migration 0002 — see below).

- **Migration 0002** — `packages/db/drizzle/{sqlite,postgres}/0002_*.sql` widens `run_events.run_id` from NOT NULL + `references(runs.id)` to nullable + `references(runs.id, { onDelete: 'set null' })`. Both schema files (`packages/db/src/schema/{sqlite,postgres}.ts`) move together; the schema-parity test still passes. User ruling 2026-04-24 rejected skip-and-WARN and synthetic-placeholder options — (b) schema fix is the honest shape because the frozen interface accepts null and the schema was the stale side. No new preserve-block, so `migrations.lock.json` is unchanged. Decisions-log 2026-04-24 records the doc reconciliation and the three-rejection reasoning.

- **`apps/mcp-server/src/lib/sqlite-vec.ts`** — dual-path semantic search (Q8). sqlite path uses the `context_packs_vec` vec0 virtual table with `vec_distance_cosine` brute-force ordering (sqlite-vec 0.1.9 doesn't accept `distance_metric=cosine` in the vec0 DDL — see External reference gotchas). postgres path uses pgvector's `<=>` cosine operator backed by the HNSW index from migration 0001. Both paths accept `filter.projectSlug` and resolve it to `projectId` via a `projects` row lookup before scoping the KNN. Domain surface stays narrow — only `searchSimilarPacks` is exposed; the context-pack store writes embeddings directly via the raw handle because `SqliteVecClient`'s interface was reserved for read-side domain methods (an additive `insertEmbedding` slot can land later without breaking anything).

- **`apps/mcp-server/src/lib/graphify.ts`** — filesystem-backed Graphify index reader. `expandContext({ runId, depth })` resolves `runId → projects.slug` via a single `runs INNER JOIN projects` query, then loads `<graphifyRoot>/<slug>/graph.json`. Missing file → empty `{ nodes: [], edges: [] }`; malformed JSON → empty with a WARN log; runId that doesn't resolve → empty. Per-slug in-memory cache (no TTL — graph.json only changes when an operator runs `graphify scan`, which is manual). `getIndexStatus(slug)` returns `{ present: true }` or `{ present: false, howToFix: 'run ' + '`graphify scan` at repo root' }` — the remediation string that S15's tool handler surfaces verbatim. `getIndexStatus` is a NEW method on the `GraphifyClient` interface (additive edit approved under user Q9; the slot was reserved by the S7a docblock for "future domain methods slot in here in later modules"). The `expandContext` method's `depth` argument is accepted for forward-compat with Module 05's n-hop expansion — S7c returns the full parsed subgraph regardless.

- **`apps/mcp-server/src/framework/tool-context.ts`** — docblock fix on `RunRecorder` to cite the real `references(runs.id, { onDelete: 'set null' })` clause landed by migration 0002 (the S7a docblock cited an aspirational clause that didn't exist in schema code). Additive interface edit: `GraphifyClient.getIndexStatus(slug)` added, documented as the reserved forward slot.

- **`apps/mcp-server/src/index.ts`** — five factory call-sites swap from passing `DbClient` to `dbClient.asInternalHandle()` (DbHandle). `createGraphifyClient` also receives `db`. Otherwise unchanged.

- **`docs/feature-packs/01-foundation/meta.json`** + **`docs/feature-packs/02-mcp-server/meta.json`** — bootstrap per-pack metadata for the two existing feature packs so the real `feature-pack.ts` has real inputs. `02-mcp-server` has `parentSlug: '01-foundation'`; `01-foundation` has `parentSlug: null`. `sourceFiles` populated per each pack's actual governance.

**Tests added / rewritten:**

- **Unit (2 new):** `__tests__/unit/lib/context-pack-excerpt.test.ts` — 7 tests pinning the Q-02-3 Unicode truncation contract (emoji at 499, CJK at 499, string.slice would break, optional `max` parameter). `__tests__/unit/lib/feature-pack-cycle.test.ts` — 1 test building an a→b→c→a cycle on tmpfs and asserting `InternalError` with chain naming.
- **Integration (5 rewritten, +24 tests):** `feature-pack.test.ts` (+11 — bootstrap, ghost-slug, checksum drift, meta-slug mismatch, inheritance chain, list root-first, missing-parent throw, cache-within-TTL + refresh, upsert files + DB, upsert validation). `context-pack.test.ts` (+9 — insert-with-embedding, insert-with-null, idempotent-per-runId, dim mismatch, missing-runId, missing-title, read, list by projectSlug, list returns [] for unknown slug, FS content matches DB). `run-recorder.test.ts` (+7 — ctor rejects, arg validation, insert with runId, insert with null runId, retry dedupe, ON DELETE SET NULL cascade). `sqlite-vec.test.ts` (+9 — ctor rejects, domain-surface narrow, input validation 3 cases, KNN ordering, k cap, project scoping). `graphify.test.ts` (+11 — ctor rejects, getIndexStatus 3 cases, expandContext 5 cases including cache).
- **Sanity (1 deleted, 0 skipped):** the S7a "throws NotImplementedError" tests are all gone — real bodies mean real behaviour is what's tested now.

**Gate (all green):**

- `pnpm install --frozen-lockfile` — clean (no new deps).
- `pnpm --filter @coodra/db run check:migration-lock` — ok, 2 blocks verified.
- `pnpm --filter @coodra/db run test:unit` — 42/42 (schema parity test still passes — both dialects widened together).
- `pnpm lint` — 0 errors, 1 pre-existing info (`idempotency.ts:77:3` `useShorthandFunctionType`, documented leave-as-is in the chore-commit `dfaefe9` from S7b).
- `pnpm typecheck` — 5/5 green.
- `pnpm --filter @coodra/mcp-server run test:unit` — 84/84 (was 75; +9).
- `pnpm --filter @coodra/mcp-server run test:integration` — 90/90 (was 61; +29).

**Commit:** `feat(mcp-server): S7c — domain lib bodies + schema migration 0002 (run_events.run_id nullable + ON DELETE SET NULL)`.

### S8 — Tool `get_run_id` (landed 2026-04-24)

**Scope:** the first real MCP tool (`ping` was the walking skeleton in S5). Lands the `get_run_id` handler/schema/manifest trio, the `ALL_TOOLS` registration barrel at `src/tools/index.ts`, a pure agent-type mapping module, an additive `PerCallContext.agentType` slot on the frozen `ToolContext`, and stdio-transport capture of the MCP `initialize.clientInfo.name` handshake value.

**Asymmetric resolution (user directive Q1):** solo mode auto-creates the `projects` row on an unknown slug; team mode returns a structured soft-failure `{ ok: false, error: 'project_not_found', howToFix }` so the agent surfaces actionable guidance instead of a generic tool-failure envelope. Decisions-log 2026-04-24 14:30 records the rationale.

**What landed:**

- **`src/tools/get-run-id/schema.ts`** — Zod input `{ projectSlug }` (1–128 chars, strict). Output is a **discriminated union on `ok`** — success branch `{ ok: true, runId, startedAt }`, soft-failure branch `{ ok: false, error: 'project_not_found', howToFix }`. The discriminated union is the honest shape: a failed lookup is a user-recoverable state, not a programming bug, so modeling it as data keeps the agent-reading contract clean (no `handler_threw` envelope for this case).

- **`src/tools/get-run-id/handler.ts`** — factory `createGetRunIdHandler({ db: DbHandle, mode: 'solo' | 'team' })` closes over the process's boot-time deps. Flow:
  1. `SELECT id FROM projects WHERE slug = ?` — resolve slug → projectId.
  2. Missing: solo auto-creates (orgId from `SOLO_IDENTITY.orgId`); team returns the structured soft-failure.
  3. `SELECT id, status, started_at FROM runs WHERE project_id = ? AND session_id = ? ORDER BY started_at DESC LIMIT 1` — latest existing run for the session.
  4. Found: return `{ runId, startedAt }`. WARN when `status !== 'in_progress'` (Q3 escalation trigger for a future migration 0003 that relaxes the unique index to `(project_id, session_id, status)` if the WARN grows common).
  5. Missing: `INSERT INTO runs ... RETURNING` with `id = generateRunKey({ projectId, sessionId })` (from `@coodra/shared`, pattern `run:{projectId}:{sessionId}:{uuid}` per §4.3). `onConflictDoNothing({ target: [projectId, sessionId] })` resolves concurrent-insert races. If 0 rows return, re-SELECT to fetch the winner.

- **`src/tools/get-run-id/manifest.ts`** — factory `createGetRunIdToolRegistration(deps)` returns a `ToolRegistration`. Description is §24.4 verbatim + a 2-line tail naming the solo/team asymmetry so callers reading the manifest see the soft-failure branch exists. Idempotency builder: `{ kind: 'mutating', key: 'get_run_id:${projectSlug}:${sessionId}' }` — uses caller-supplied `projectSlug` (not internal-resolved `projectId`) per user directive Q5 so retries with the same input dedupe regardless of whether the solo-auto-create branch ran.

- **`src/tools/index.ts`** — NEW registration barrel. Exports `registerAllTools(registry, { db, mode })` which calls `registry.register(...)` for every tool. `src/index.ts` is now a single-line wire-up. Future tools (S9–S15) are additive to this barrel. Guard test `__tests__/unit/tools/_no-unregistered-tools.test.ts` walks `src/tools/` directory entries and asserts each folder's canonical name (`hyphen-to-underscore`) is registered — this is the "tools/list returns empty" failure-mode guard named in `essentialsforclaude/10-troubleshooting.md`.

- **`src/lib/agent-type.ts`** — NEW pure mapping module. `KnownAgentType` union + `AGENT_TYPE_MAPPING` frozen table + `mapAgentType(clientName)` resolver. Single source of truth for the `clientInfo.name → runs.agent_type` translation; adding a new client is one entry here. Case-insensitive lookup; unknown/missing → `'unknown'`.

- **`src/framework/tool-context.ts`** — additive edit to `PerCallContext`: `readonly agentType: string`. Approved under user directive Q2 as the same "reserved future-transport-metadata" slot pattern as S7c's `GraphifyClient.getIndexStatus`. `makeFakeDeps` / `ToolRegistry` default to `'unknown'` when tests or transports don't supply one. Decisions-log 2026-04-24 14:30 records the additive-edit rationale.

- **`src/framework/tool-registry.ts`** — `handleCall(name, rawInput, sessionId, options?: { requestId?, agentType? })`. Options object replaces the prior `requestId?` positional arg; `agentType` defaults to `'unknown'`. Populates `PerCallContext.agentType`. Unit tests updated.

- **`src/transports/stdio.ts`** — CallToolRequestSchema handler calls `server.getClientVersion()?.name`, runs it through `mapAgentType`, and passes the result to `registry.handleCall(...)`. The MCP SDK's `Server` exposes `clientInfo` after the initialize handshake completes; stdio captures per call so HTTP's per-connection model (Module 03+) can follow the same pattern without refactor.

- **`src/index.ts`** — swap: `registerAllTools(registry, { db: dbHandle, mode: env.COODRA_MODE })` replaces the direct `pingToolRegistration` import + `registry.register(...)` pair.

**Tests added (+40 total; unit 84→116, integration 90→98):**

- **`__tests__/unit/lib/agent-type.test.ts`** (NEW, 9 tests) — mapping table round-trip lock, undefined/null/empty guards, case-insensitive, unknown client default, Object.isFrozen assertion on the table.
- **`__tests__/unit/tools/get-run-id.test.ts`** (NEW, 11 tests) — manifest contract via `@coodra/shared/test-utils::assertManifestDescriptionValid` (§24.3 rules), name lock, idempotency-key shape, input schema boundaries (valid, empty, too long, strict, missing), factory construction contract (missing options, non-DbHandle, invalid mode).
- **`__tests__/unit/tools/_no-unregistered-tools.test.ts`** (NEW, 5 tests) — self-sanity of the folder-to-name translation (samples locked), every `src/tools/<folder>/` has a registration, inverse (no dangling registrations without a folder), folder-discovery locks.
- **`__tests__/integration/tools/get-run-id.test.ts`** (NEW, 7 tests) — real `:memory:` SQLite with migrations applied; solo auto-create (projects row + runs row, agentType stamped); agentType=unknown default; project re-use across sessions; team-mode `project_not_found` soft-failure (no projects row written); idempotent re-call; non-in-progress return (WARN-adjacent behaviour); concurrent `Promise.all` race resolution.

**Gate:**

- `pnpm install --frozen-lockfile` — clean (no new deps).
- `pnpm --filter @coodra/db run check:migration-lock` — ok, 2 blocks verified.
- `pnpm lint` — 0 errors, 1 pre-existing info (`idempotency.ts:77:3`, documented leave-as-is since S7b).
- `pnpm typecheck` — 5/5 green.
- `pnpm test:unit` — 233/233 repo-wide (shared 75 + db 42 + mcp-server 116).
- `pnpm --filter @coodra/mcp-server run test:integration` — 98/98.

**Commit:** `feat(mcp-server): S8 — tool get_run_id + PerCallContext.agentType + ALL_TOOLS barrel`.

### S9 — Tool `get_feature_pack` (landed 2026-04-24)

**Scope:** second real MCP tool. Lands `get_feature_pack` handler/schema/manifest as a static-const registration (no factory — handler consumes `ctx.featurePack` which is already wired at boot). Amends `system-architecture.md §24.4` with the canonical soft-failure shape per the §9.1.2 rule the S8 review tightened. No interface edits; no new deps.

**Return shape semantics (user directive Q1 2026-04-24 15:00):** `pack` is the deepest pack in the inheritance chain whose `sourceFiles` globs match `filePath` (or the slug's own pack when `filePath` is absent or no glob matches). `inherited` is the ancestor chain of `pack`, root-first. `subPack` is always `null` in Module 02; reserved for Module 07+ folder-nested sub-feature-packs (a different scoping axis from inheritance).

**What landed:**

- **`src/tools/get-feature-pack/schema.ts`** — Zod input `{ projectSlug, filePath? }` strict. Output is a `z.union` of three branches: success `{ ok: true, pack, subPack: null, inherited }`; `pack_not_found` `{ ok: false, error, howToFix }`; `feature_pack_cycle` `{ ok: false, error, chain, howToFix }`. Wire shape for each `FeaturePack` is `{ metadata: {id, slug, parentSlug, isActive, checksum, updatedAt: ISO-8601 string}, content: {spec, implementation, techstack, sourceFiles} }`. Handler converts the store's `Date` `updatedAt` to an ISO string at the boundary.

- **`src/tools/get-feature-pack/handler.ts`** — delegates to `ctx.featurePack.get({ projectSlug, filePath })`. Error mapping from the store's `InternalError` throws:
  - `feature_pack_cycle: a → b → c → a` → `feature_pack_cycle` branch with `chain` parsed from the message.
  - `slug '<x>' not found on disk + DB` or `feature_pack_parent_missing: ...` → `pack_not_found` branch.
  - anything else → re-throw (registry wraps in generic `handler_threw`).
  Successful path builds the full chain `[root, ..., leaf]`, walks from leaf backwards calling `picomatch(pattern, { dot: false, nobrace: true })` against each level's `sourceFiles`, and returns the deepest match. `filePath` with no match falls back silently to the slug's own pack with a DEBUG log `{ event: 'feature_pack_filepath_no_match', projectSlug, filePath }` for observability per Q3 — default log level (`info`) does NOT emit this, operators who care set `LOG_LEVEL=debug`. No second cache layer — the store's 60 s TTL with checksum-mismatch invalidation is the single cache surface.

- **`src/tools/get-feature-pack/manifest.ts`** — static const `getFeaturePackToolRegistration` (not a factory, per §9.1.1: handler consumes `ctx.featurePack` directly). §24.4 description landed verbatim (80 words). Idempotency builder is `{ kind: 'readonly', key: 'readonly:get_feature_pack:{slug}:{filePath ?? '*'}'}` truncated to 200 chars — caller-supplied inputs in the key so retries with the same input dedupe in the registry's logs.

- **`src/tools/index.ts`** — one-line addition: `registry.register(getFeaturePackToolRegistration)`. The `_no-unregistered-tools.test.ts` guard from S8 now sees `ping`, `get-run-id`, `get-feature-pack` folders and asserts all three are registered.

- **`system-architecture.md §24.4` (Amendment-B same-commit)** — `get_feature_pack` return-shape line extended with the `pack`/`subPack`/`inherited` semantics + the canonical soft-failure shape with both error codes (`pack_not_found`, `feature_pack_cycle`), each carrying `howToFix`, plus `chain` for the cycle branch.

- **`essentialsforclaude/09-common-patterns.md §9.1.2`** — one-line tightening adding *"Canonical soft-failure shape — every soft-failure branch MUST include BOTH `error` AND `howToFix`. Tool-specific fields (e.g. `chain` for a cycle, `notice` for a fallback) are additive."* Pairs with §24.4's extension; locks the convention for S11/S15 to inherit.

**Tests added (+22 total; unit 116→128, integration 98→108):**

- **`__tests__/unit/tools/get-feature-pack.test.ts`** (NEW, 12 tests) — manifest contract via `@coodra/shared/test-utils::assertManifestDescriptionValid`, name lock, idempotency-key readonly + truncation, input schema boundaries (accept slug alone, accept slug+filePath, reject empty, reject oversized, reject strict-unknown fields, reject missing slug).
- **`__tests__/integration/tools/get-feature-pack.test.ts`** (NEW, 10 tests — 2 more than the original Q9 7 per user directive Q11):
  1. Simple root-only pack, no filePath.
  2. 3-deep chain, no filePath — locks `inherited` root-first.
  3. filePath matches leaf's own sourceFiles → pack = leaf.
  4. filePath matches a mid ancestor only → pack = mid, inherited = [root]. *(Q11 ancestor-glob match lock.)*
  5. filePath matches root sourceFiles only → pack = root, inherited = [].
  6. filePath with no match → silent fallback to leaf, no `notice`/`warning` field leaks into the response.
  7. `pack_not_found` soft-failure for unknown slug.
  8. `pack_not_found` soft-failure when a parent slug is missing from disk.
  9. `feature_pack_cycle` soft-failure with chain for a cyclic parentSlug graph.
  10. Explicit 3-deep inherited ordering lock — asserts `out.inherited.map(p => p.metadata.slug) === ['root', 'middle']`. *(Q11 inheritance ordering lock.)*

**Decisions-log entries (5 timestamped 2026-04-24 15:00):** pack = deepest match + subPack M07-reserved; canonical soft-failure shape as the cross-tool rule; DEBUG log on filePath-no-match; inherited[] root-first locked; feature_pack_cycle structured soft-failure with chain.

**Gate:**

- `pnpm install --frozen-lockfile` — clean (no new deps).
- `pnpm --filter @coodra/db run check:migration-lock` — ok, 2 blocks verified.
- `pnpm lint` — 0 errors, 1 pre-existing info (`idempotency.ts:77:3`, documented leave-as-is since `dfaefe9`).
- `pnpm typecheck` — 5/5 green.
- `pnpm test:unit` — 245/245 repo-wide (shared 75 + db 42 + mcp-server 128).
- `pnpm --filter @coodra/mcp-server run test:integration` — 108/108.

**Commit:** `feat(mcp-server): S9 — tool get_feature_pack + §9.1.2 soft-failure canonical shape + §24.4 amendment`.

### S10 — Tool `save_context_pack` (landed 2026-04-24)

**Scope:** third real MCP tool. Factory-shaped registration (`createSaveContextPackToolRegistration({ db })`) because the handler closes over a `DbHandle` for the `runs` SELECT + UPDATE; the `context_packs` write itself goes through `ctx.contextPack` (S7c store, already wired into `ContextDeps`). §24.4 description verbatim; failure-mode block amended same-commit with the `run_not_found` branch + append-only re-call documentation per §9.1.2 canonical shape.

**Flow:**

1. SELECT `runs.projectId` for the supplied `runId`. Missing → `{ ok: false, error: 'run_not_found', howToFix: 'Call get_run_id first...' }` soft-failure. No solo auto-create — `save_context_pack` writes against an existing run, different from `get_run_id` which bootstraps sessions.
2. Delegate to `ctx.contextPack.write({ runId, projectId, title, content, featurePackId? }, null)`. Embedding is `null` in Module 02 (Module 05 NL Assembly backfills later per decisions-log 2026-04-24 12:30; `SqliteVecClient` stays read-only).
3. `UPDATE runs SET status='completed', endedAt=unixepoch() WHERE id=runId AND status != 'completed'` — idempotent no-op on already-completed runs.
4. Return `{ ok: true, contextPackId, savedAt, contentExcerpt }`.

**Append-only (ADR-007):** same `runId` + different content returns the ORIGINAL row unchanged (`contextPackId`, `savedAt`, `contentExcerpt` all from the first call; store's idempotency path skips the second insert and the second FS write). Integration test locks this against `content = 'v2 DIFFERENT'` confirming DB row's `content === 'v1'`.

**FS-failure degradation:** the S7c store is DB-first; FS materialisation runs AFTER the DB insert succeeds, and an FS write failure logs WARN and returns success. Integration test wires `contextPacksRoot` to a `chmod 0555` tmpdir and asserts `ok: true` + DB row exists.

**`featurePackId` semantics:** accepted in the tool input per §24.4, passed through to the store, silently discarded today (`context_packs` has no `featurePackId` FK column yet). Retained on the wire for M05/M07 schema growth without tool-contract change.

**Not wired (per standing rules):**
- `recordPolicyDecision` — S14 (`check_policy`) remains the first caller.
- JIRA/PR comment worker (§22.8/§23.11) — post-Module-02 integration module.
- Embedding write — Module 05 owns.

**Tests added (+19 total; unit 128→141, integration 108→114):**

- **`__tests__/unit/tools/save-context-pack.test.ts`** (NEW, 13 tests) — manifest via `assertManifestDescriptionValid`, name lock, idempotency-key (mutating, `save_context_pack:<runId>`, truncation), input schema boundaries (valid, featurePackId supplied, missing runId, empty title, title > 512, content > 1 MiB, strict-unknown fields), factory construction contract.
- **`__tests__/integration/tools/save-context-pack.test.ts`** (NEW, 6 tests):
  1. Happy path (DB row + FS file + runs completed).
  2. `run_not_found` soft-failure (no context_packs row inserted).
  3. Append-only re-call: same runId + different content returns original; DB content unchanged.
  4. runs UPDATE idempotent when already completed.
  5. FS-failure degradation: `chmod 0555` `contextPacksRoot`, still ok + DB row durable.
  6. `featurePackId` accepted (no break).

**Decisions-log entry (1 timestamped 2026-04-24 15:30):** S10 resolution pattern — pre-SELECT runs for projectId + soft-failure on missing; runs UPDATE marks completed idempotently after store.write; embedding stays null until Module 05; featurePackId pass-through without FK (M02-scope schema).

**Gate:**

- `pnpm install --frozen-lockfile` — clean (no new deps).
- `pnpm --filter @coodra/db run check:migration-lock` — ok, 2 blocks verified.
- `pnpm lint` — 0 errors, 1 pre-existing info (`idempotency.ts:77:3`, documented leave-as-is since `dfaefe9`).
- `pnpm typecheck` — 5/5 green.
- `pnpm test:unit` — 258/258 repo-wide (shared 75 + db 42 + mcp-server 141).
- `pnpm --filter @coodra/mcp-server run test:integration` — 114/114.

**Commit:** `feat(mcp-server): S10 — tool save_context_pack + §24.4 failure-mode amendment`.

### S11 — Tool `search_packs_nl` with LIKE fallback (landed 2026-04-24)

**Scope:** fourth real MCP tool. Factory-shaped registration (closes over `DbHandle` for projects-slug lookup + context_packs IN-JOIN + LIKE fallback). Semantic KNN goes through `ctx.sqliteVec.searchSimilarPacks` (the S7c dual-path surface — sqlite-vec vec0 for solo, pgvector `<=>` cosine for team). §24.4 amended same-commit to document the new `embedding?: number[]` optional input + the canonical soft-failure shape + the `no_embeddings_yet` advisory on the LIKE fallback path.

**Input-side design (M02-specific):** §24.4's base input is `{ projectSlug, query, limit? }`. The S11 slice adds `embedding?: number[]` because Module 02 has no NL Assembly service to compute one server-side; callers that have an embedder pre-compute and supply. Module 05 will become the default producer. Callers without an embedder get the LIKE fallback over `title + content_excerpt`.

**Flow:**

1. Resolve `projectSlug → projects.id`. Missing → `{ ok: false, error: 'project_not_found', howToFix }` soft-failure. No auto-create — this is a read tool.
2. If `embedding` supplied:
   - Length === `EMBEDDING_DIM` (384)? Handler-level check BEFORE the store. Mismatch → `{ ok: false, error: 'embedding_dim_mismatch', expected: 384, got: N, howToFix }`. Deliberately NOT at the Zod level — the registry's generic `invalid_input` envelope is too opaque for callers; a structured code lets agents branch.
   - Convert `number[] → Float32Array`, call `ctx.sqliteVec.searchSimilarPacks({ embedding, k: limit, filter: { projectSlug } })`, IN-JOIN `context_packs` for metadata, preserve distance-ascending order, attach `distance` as `score`. Return `{ ok: true, packs: [...] }` — no `notice`.
3. If `embedding` NOT supplied (M02 common case):
   - LIKE fallback query: `context_packs WHERE project_id = ? AND (LOWER(title) LIKE ? OR LOWER(content_excerpt) LIKE ?) ORDER BY created_at DESC LIMIT ?`.
   - Return `{ ok: true, packs: [...], notice: 'no_embeddings_yet', howToFix: '...' }`. `score = null` per row (no semantic distance).

**Output shape:**

- Success: `{ ok: true, packs: Array<{ id, title, excerpt, score: number | null, savedAt, runId }>, notice?: 'no_embeddings_yet', howToFix?: string }`. §9.1.2 canonical shape for success-side advisory notices (additive on top, not soft-failure).
- Soft-failures: `project_not_found` and `embedding_dim_mismatch` — each carries `error` + `howToFix` per §9.1.2.

**Empty semantic results** (caller supplied valid embedding but no matching rows exist for the project) → `{ ok: true, packs: [] }`, NO notice. Empty is a valid success — callers distinguish "no matches" from "no embeddings available" via `notice` presence.

**Tests added (+25 total; unit 141→156, integration 114→124):**

- `__tests__/unit/tools/search-packs-nl.test.ts` (NEW, 15 tests) — manifest via `assertManifestDescriptionValid`, name lock, idempotency-key readonly + truncation + embedding-presence flag, input schema boundaries (valid, any embedding length accepted at Zod, missing fields, oversize query, limit bounds, strict-unknown fields), factory construction contract.
- `__tests__/integration/tools/search-packs-nl.test.ts` (NEW, 10 tests):
  1. `project_not_found` soft-failure.
  2. `embedding_dim_mismatch` (too-short embedding) — handler-level check, store untouched.
  3. `embedding_dim_mismatch` (too-long embedding).
  4. LIKE fallback returns matching packs + notice + howToFix.
  5. Empty LIKE result is `ok:true, packs:[], notice:'no_embeddings_yet'` — NOT soft-failure.
  6. LIKE is case-insensitive across title + content_excerpt.
  7. LIKE respects the `limit` parameter.
  8. LIKE scopes to the project (no cross-project leakage).
  9. Semantic path with real 384-dim unit-vector embeddings — distance-ordered, score populated, no notice.
  10. Empty semantic result (no packs in project) → `ok:true, packs:[]`, NO notice.

**Decisions-log entry (1 timestamped 2026-04-24 16:00):** S11 input extension + dim-check location + LIKE fallback triggers on no-embedding-supplied (not on project-has-no-embeddings); empty-result is success-with-empty, not soft-failure; score is semantic distance or null.

**Gate:**

- `pnpm install --frozen-lockfile` — clean (no new deps).
- `pnpm --filter @coodra/db run check:migration-lock` — ok, 2 blocks verified.
- `pnpm lint` — 0 errors, 1 pre-existing info.
- `pnpm typecheck` — 5/5 green.
- `pnpm test:unit` — 273/273 repo-wide (shared 75 + db 42 + mcp-server 156).
- `pnpm --filter @coodra/mcp-server run test:integration` — 124/124.

**Commit:** `feat(mcp-server): S11 — tool search_packs_nl (semantic + LIKE fallback) + §24.4 amendment`.

### S12 — Tool `query_run_history` (landed 2026-04-24)

**Scope:** sixth real MCP tool. Factory-shaped registration closing over `DbHandle` for projects-slug resolution + runs SELECT with a LEFT JOIN on `context_packs` for the `title` projection. §24.4 amended same-commit to document `title` nullability (the LEFT JOIN returns `null` for runs with no pack yet), the default/max `limit` (10/200), DESC ordering, canonical success + soft-failure shape, and the "empty result is ok:true" rule.

**Landed out of linear order:** S13 (record_decision) shipped first per the S13 kickoff's option-(a) (spec-faithful numbering). S12 fills the gap now; subsequent slices resume linear sequence from S14.

**Title source:** `runs` has no `title` column; the LEFT JOIN onto `context_packs ON runs.id = context_packs.run_id` surfaces the pack title. The `context_packs_run_idx` unique index (S3's migration 0000) guarantees at most one join row per run, so no row multiplication. Runs that have not yet called `save_context_pack` return `title: null` — the field is always present on the wire, with null rather than omission, so output shape is stable across run states.

**Flow:**

1. Resolve `projectSlug → projects.id`. Missing → `{ ok: false, error: 'project_not_found', howToFix }` soft-failure per §9.1.2. No auto-create — this is a read tool.
2. Build WHERE: `runs.project_id = ?` + (if supplied) `runs.status = ?`.
3. `SELECT runs.*, context_packs.title FROM runs LEFT JOIN context_packs ON context_packs.run_id = runs.id WHERE ... ORDER BY runs.started_at DESC LIMIT ?`.
4. Map rows: `Date → ISO 8601 string`; `endedAt` / `title` / `issueRef` / `prRef` pass through with their DB nulls.

**Output shape:**

- Success: `{ ok: true, runs: Array<{ runId, startedAt, endedAt: string | null, status, title: string | null, issueRef: string | null, prRef: string | null }> }`. Empty `runs` array is NOT a soft-failure — agents distinguish "no recent runs" from "project not registered" via the `ok` discriminant.
- Soft-failure: `{ ok: false, error: 'project_not_found', howToFix }`.

**Read-only tool:** idempotency key is kind `readonly`. Registry skips DB-backed dedupe but logs the key for correlation — the builder embeds `(projectSlug, status ?? 'any', limit)` so distinct reads produce distinct log keys.

**Zod bounds:** `projectSlug` min 1; `status` enum `'in_progress' | 'completed' | 'failed'`; `limit` int 1..200 default 10. Oversize → registry's generic `invalid_input` envelope.

**Tests added (+27 total; unit 174→192, integration 131→140):**

- `__tests__/unit/tools/query-run-history.test.ts` (NEW, 18 tests) — manifest via `assertManifestDescriptionValid`, name lock, idempotency-key readonly (slug+status+limit embed, 'any' when status absent, distinct combos yield distinct keys, truncation, probe-safe empty input), input schema boundaries (minimal valid + default limit=10, each status enum value, invalid status reject, empty slug, limit<1/>200/non-integer rejects, limit boundary 1/200, strict-unknown-fields), factory construction contract.
- `__tests__/integration/tools/query-run-history.test.ts` (NEW, 9 tests):
  1. `project_not_found` soft-failure.
  2. Empty result → `{ ok: true, runs: [] }` (NOT soft-failure).
  3. DESC order by `started_at`.
  4. Status filter (`in_progress`, `failed`) returns only matching rows.
  5. Limit honoured (default 10, custom 3).
  6. LEFT JOIN title: pack title surfaces for run-with-pack; null for run-without-pack.
  7. Project scoping: no cross-project leak.
  8. `issueRef` + `prRef` + ISO-formatted `endedAt` passthrough.
  9. `endedAt: null` for in-progress runs.

**Decisions-log entry (1 timestamped 2026-04-24):** S12 title-via-LEFT-JOIN choice + DESC ordering + empty-is-success + readonly idempotency key + default limit 10.

**Gate:**

- `pnpm install --frozen-lockfile` — clean (no new deps).
- `pnpm --filter @coodra/db run check:migration-lock` — ok, 2 blocks verified.
- `pnpm lint` — 0 errors, 1 pre-existing info (idempotency.ts:77:3).
- `pnpm typecheck` — 5/5 green.
- `pnpm test:unit` — 309/309 repo-wide (shared 75 + db 42 + mcp-server 192).
- `pnpm --filter @coodra/mcp-server run test:integration` — 140/140.

**Commit:** `feat(mcp-server): S12 — tool query_run_history + §24.4 amendment`.

### S13 — Tool `record_decision` (landed 2026-04-24)

**Scope:** fifth real MCP tool. Factory-shaped registration (closes over `DbHandle` for `runs` existence check + `decisions` INSERT). New `decisions` table shipped same-commit as migration **0003** (S3's 0001 was already pushed, and S7c's 0002 widened `run_events`, so 0002 is taken — the S13 pre-flight note's Option-B path applied). §24.4 amended same-commit to document the idempotency key, the `created` boolean return, storage shape, and the `run_not_found` soft-failure.

**Migration 0003:** dual-dialect `decisions` table. Columns: `id`, `idempotency_key` UNIQUE, `run_id` nullable + `ON DELETE SET NULL` (per the S7c `run_events` widening precedent — decisions are permanent history that must survive run deletion), `description`, `rationale`, `alternatives` TEXT (JSON-encoded string[]; NULL = `[]`; TEXT on both dialects for parity), `created_at`. Index `decisions_run_created_idx (run_id, created_at)` for per-run enumeration. Generated via `drizzle-kit generate`, no preserve blocks → migrations.lock.json unchanged.

**Idempotency:** key is `dec:{runId}:{sha256(description).slice(0,32)}`. Same `runId` + identical `description` → second call collides on the UNIQUE index via `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` and the handler re-reads the existing row, returning `{ decisionId, createdAt, created: false }`. Rationale + alternatives changes on the retry are **discarded** — description is the decision's identity; rationale is metadata. Different `description` → different key → distinct row. Multi-decision-per-run is explicitly supported (unlike `save_context_pack` which is idempotent-per-runId).

**Flow:**

1. SELECT `runs.id` for `input.runId`. Missing → `{ ok: false, error: 'run_not_found', howToFix }` soft-failure per §9.1.2. No auto-create.
2. Compute idempotency key + JSON-encode `alternatives` (empty array → NULL).
3. `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, created_at`. If RETURNING returns a row → `created: true`. Empty → re-SELECT by idempotency_key → `created: false`.
4. Return `{ ok: true, decisionId, createdAt: ISO string, created }`.

**Output shape:**

- Success: `{ ok: true, decisionId, createdAt, created: boolean }`. `created` lets an agent detect silently-deduped retries without re-reading the DB.
- Soft-failure: `{ ok: false, error: 'run_not_found', howToFix }`.

**Zod caps:** `description` ≤ 2048, `rationale` ≤ 8192, `alternatives` ≤ 10 items × 512 chars each. Oversize → registry's generic `invalid_input` envelope (caller bug, not user-recoverable).

**Tests added (+25 total; unit 156→174, integration 124→131):**

- `__tests__/unit/tools/record-decision.test.ts` (NEW, 18 tests) — manifest via `assertManifestDescriptionValid`, name lock, idempotency-key shape (mutating + matches handler hash + same-description-same-key regardless of rationale + probe-safe empty input + 200-char truncation), input schema boundaries (minimal valid, alternatives 10-cap, 11-item reject, 513-char alternative reject, empty runId/description/rationale, oversize description, oversize rationale, strict-unknown-fields), factory construction contract.
- `__tests__/integration/tools/record-decision.test.ts` (NEW, 7 tests):
  1. Happy path — DB row with expected columns, idempotency key, JSON alternatives roundtrip, `created: true`.
  2. `alternatives` omitted → stored NULL.
  3. `alternatives: []` → stored NULL (empty-array collapse).
  4. Multi-decision-per-run: two different descriptions on same runId persist as two distinct rows.
  5. Idempotency dedupe: same description + different rationale → same decisionId, `created: false`, rationale is NOT updated.
  6. `run_not_found` soft-failure — no decisions row inserted.
  7. `ON DELETE SET NULL` — deleting the originating runs row nulls `decisions.run_id` but preserves the decision row.
- `packages/db/__tests__/unit/client.test.ts` updated: expected table list bumps from ten to eleven to include `decisions`.

**Decisions-log entry (1 timestamped 2026-04-24):** S13 storage choice (dedicated table over RunRecorder), idempotency boundary (description is identity; rationale is metadata), `run_id` `ON DELETE SET NULL` + nullable, `alternatives` TEXT-JSON parity across dialects, and the added `created: boolean` return value.

**Gate:**

- `pnpm install --frozen-lockfile` — clean (no new deps).
- `pnpm --filter @coodra/db run check:migration-lock` — ok, 2 blocks verified.
- `pnpm --filter @coodra/db run db:generate` — produces `drizzle/sqlite/0003_cloudy_colossus.sql` + `drizzle/postgres/0003_slow_meteorite.sql` + updated `meta/_journal.json` + `meta/0003_snapshot.json` per dialect.
- `pnpm lint` — 0 errors.
- `pnpm typecheck` — 5/5 green.
- `pnpm test:unit` — 291/291 repo-wide (shared 75 + db 42 + mcp-server 174).
- `pnpm --filter @coodra/mcp-server run test:integration` — 131/131.

**Commit:** `feat(mcp-server): S13 — tool record_decision (new decisions table + 0003 migration) + §24.4 amendment`.

### S14 — Tool `check_policy` (landed 2026-04-24)

**Scope:** seventh real MCP tool, and the load-bearing S7b closure. S14 is the first caller of `recordPolicyDecision` (exported from `lib/policy.ts` since S7b, uncalled through S7c / S8 / S9 / S10 / S11 / S13 / S12 — the audit-write deferral is now closed). Factory-shaped handler closes over `DbHandle` for the projects-slug resolve + `recordPolicyDecision` audit write. §24.4 amended same-commit with the locked reason enum + `failOpen` boolean + `ruleReason` field + cache-upgrade note + `project_not_found`-as-soft-failure rule + 8 KiB `toolInputSnapshot` truncation.

**Three noteworthy slice-wide decisions (locked this commit):**

1. **Reason enum locked** (user Q4 sign-off 2026-04-24): output `reason` is one of `no_rule_matched | rule_matched | policy_engine_unavailable`. `failOpen` is computed (`reason === 'policy_engine_unavailable'`), not independently supplied — a unit test locks this derivation. `ruleReason: string | null` carries the matched rule's human text separately; agents that need "why was I blocked?" read `ruleReason`, observability systems read `reason`.
2. **Per-projectId cache upgrade** (closes S7b deferral): `lib/policy.ts`'s rule cache upgrades from the `'all'` sentinel to `Map<string, CacheEntry>` keyed by projectId. `PolicyInput.projectId?: string` + `PolicyClient.evaluate({ ..., projectId? })` are additive-optional extensions (user Q1 explicit sign-off — "the long-awaited closure of S7b's deferral note"). Auto-wrap callers that omit `projectId` still hit a `__global__` slot with unfiltered rules, preserving backwards compat for the registry's pre/post auto-evaluation path.
3. **Async audit ordering** (§24.4's "dispatched via setImmediate" contract made operational): the handler's response returns BEFORE the `policy_decisions` row is visible. Latency stays on the <10 ms hook-SLO path; audit durability lives one tick later. Idempotent dedupe via the locked `pd:{sessionId}:{toolName}:{eventType}` key + ON CONFLICT DO NOTHING.

**`project_not_found` is NOT fail-open.** §7 fail-open covers evaluator faults (breaker / timeout / throw) — a well-formed call against an unregistered project is a caller-addressable error, surfaced as `{ ok: false, error: 'project_not_found', howToFix }`. Module 03 (Hooks Bridge) must treat this response as `allow` for hook-dispatch (see decisions-log 2026-04-24 S14 entry) — otherwise a missing project registration would silently block all work.

**`toolInputSnapshot` 8 KiB truncation** (user Q4 push-back): the audit row's snapshot is JSON-serialised and truncated to 8 KiB with a `…[truncated:N]` suffix. Prevents unbounded `policy_decisions` row growth from agent-supplied large bodies (a `Write` tool with a 500 KB file body would otherwise bloat the audit table permanently). Suffix preserves original-size forensics for "this was a big write" audits.

**Flow:**

1. Resolve `projectSlug → projects.id`. Missing → `{ ok: false, error: 'project_not_found', howToFix }` soft-failure per §9.1.2. No auto-create. No audit row written.
2. Build `PolicyInput` with the real `projectId` threaded through. Evaluator keys the cache per-project and filters rules via `policies.project_id = ?`.
3. `ctx.policy.evaluate(input)` — cache-first, cockatiel-fused (`timeout(100, Aggressive) + circuitBreaker(5, halfOpenAfter: 30_000ms)`), fail-open on every error path.
4. Map evaluator result → response:
   - `permissionDecision = evalResult.decision` (evaluator emits `'allow' | 'deny'`; `'ask'` stays reserved).
   - `reason` = locked enum, derived from evaluator's reason + matchedRuleId presence.
   - `ruleReason` = evaluator's reason text when `'rule_matched'`, else `null`.
   - `matchedRuleId` = evaluator passthrough.
   - `failOpen` = derived (`reason === 'policy_engine_unavailable'`).
5. Dispatch `recordPolicyDecision({ projectId, sessionId, agentType, eventType, toolName, toolInputSnapshot, permissionDecision, matchedRuleId, reason: ruleReason ?? reason, runId })` via `setImmediate(...)` with `.catch(err => policyLogger.warn(...))`. Handler returns the response synchronously (before the audit write completes).

**Audit-row reason column** gets the human rule text when matched (so a DBA reading `policy_decisions` sees actionable info), and the enum code otherwise — consistent with the response but richer for matched rules.

**`PolicyInput` + `PolicyClient.evaluate()` extensions** (additive-only, user Q1 sign-off): `projectId?: string` added to both. `PolicyCheck` (the stub type used in tests) receives `projectId` through unchanged. `createPolicyClientFromCheck` propagates the field when supplied. Frozen-interface discipline preserved — no rename, no required field added.

**Tests added (+32 total; unit 192→211, integration 140→154):**

- `__tests__/unit/tools/check-policy.test.ts` (NEW, 19 tests) — manifest via `assertManifestDescriptionValid`, name lock, idempotency-key shape (mutating + matches audit key `pd:{sessionId}:{toolName}:{eventType}` + same-triple-same-key regardless of toolInput + Pre vs Post distinct + truncation + probe-safe empty), input schema (minimal valid, PostToolUse accepted, unknown eventType rejected, empty required fields rejected, non-object toolInput rejected, optional runId, strict-unknown-fields), output schema (`'ask'` remains reachable, unknown reason rejected, `failOpen` required), factory construction.
- `__tests__/integration/tools/check-policy.test.ts` (NEW, 14 tests):
  1. `project_not_found` soft-failure; no audit row written.
  2. `no_rule_matched` → allow + audit row persisted (all columns verified).
  3. Deny via `Write + **/secrets.json` glob → deny response + audit row captures `matched_rule_id` + rule's human reason. Non-matching path → allow.
  4. Async audit ordering — DB empty immediately after `await handler`, 1 row after `setImmediate` flush.
  5. Idempotent dedupe — two calls with same `(sessionId, toolName, eventType)` → exactly 1 row. Different sessionIds → 2 rows.
  6. Fail-open via breaker (closed DB handle trips breaker) → allow + `reason='policy_engine_unavailable'` + `failOpen=true`.
  7. Fail-open via evaluator sentinel `'policy_check_unavailable'` mapping → response enum `'policy_engine_unavailable'` + audit row stores the enum code.
  8. Per-projectId cache isolation — project A (deny rule) and project B (no rules) served correctly by the same `createPolicyClient` instance; order-independent (A-then-B AND B-then-A both produce correct decisions).
  9. `runId` threads into the audit row (supplied → FK value; omitted → NULL).
  10. 8 KiB truncation — 20 KB toolInput → audit row has 8192-char prefix + `…[truncated:N]` suffix. Small toolInput → verbatim.
  11. `projectId` propagation — `createPolicyClientFromCheck` stub receives `req.projectId` matching the resolved `projects.id` (auto-wrap calls with `undefined` also observed per the additive-optional contract).

**Decisions-log entries (4, timestamped 2026-04-24):**

1. S7b deferral closure — `recordPolicyDecision` first caller lands.
2. Per-projectId cache upgrade + `projectId?` additive-optional extension.
3. Reason enum lock + `failOpen` derivation + `ruleReason` separation.
4. 8 KiB `toolInputSnapshot` truncation decision.

Plus a Module-03-consumption note: Hooks Bridge must treat `check_policy → project_not_found` as allow-for-hook-dispatch; otherwise a missing project registration silently blocks all work.

**Gate:**

- `pnpm install --frozen-lockfile` — clean (no new deps).
- `pnpm --filter @coodra/db run check:migration-lock` — ok, 2 blocks verified.
- `pnpm lint` — 0 errors, 1 pre-existing info (idempotency.ts:77:3).
- `pnpm typecheck` — 5/5 green.
- `pnpm test:unit` — 328/328 repo-wide (shared 75 + db 42 + mcp-server 211).
- `pnpm --filter @coodra/mcp-server run test:integration` — 154/154.

**Commit:** `feat(mcp-server): S14 — tool check_policy (fail-open + async policy_decisions write + per-projectId cache upgrade) + §24.4 amendment`.

### S15 — Tool `query_codebase_graph` (landed 2026-04-24)

**Scope:** eighth real MCP tool — closes the pure-tool-set for Module 02. Factory-shaped registration (user Q1 sign-off) closing over `DbHandle` for projects-slug resolution. §24.4 amended same-commit: output shape migrated from `{ symbols: [...] }` (Module-05 typed projection) to the M02-accurate `{ ok: true, nodes, edges, indexed: true, notice? }`. Two distinct soft-failure shapes.

**Four noteworthy decisions (all user-approved pre-code):**

1. **Factory over static-const** (Q1). Static-const handler could not distinguish `project_not_found` from `codebase_graph_not_indexed` because `ctx.db.db` is `unknown`-typed at the ToolContext boundary. Factory-close-over-`DbHandle` matches every other project-resolving tool (S11, S12, S14).
2. **`GraphifyClient.expandContextBySlug(slug)` additive method landed** (Q2). `expandContext({ runId })` doesn't fit S15's input (no runId on `{ projectSlug, query }`). Same additive-method pattern as S7c's `getIndexStatus(slug)` — Q9 sign-off precedent. Both paths share the per-slug cache in the implementation.
3. **Output shape amended from `{ symbols }` to `{ nodes, edges, indexed, notice? }`** (Q3). M02 treats graphify nodes as `unknown` (Module 05 owns the rich schema). Shipping a typed-`symbols` shape would require either duck-type casts (structural dishonesty) or a full type system that doesn't exist yet. The M02-accurate shape matches what the lib actually delivers; Module 05 replaces this handler with typed filtering.
4. **`query` accepted but not applied at M02** (Q4). Nodes are `unknown` — any filter would be imprecise (stringify+substring) or dishonest (cast). The M02 shim returns the full subgraph with `notice: 'query_filtering_deferred_to_m05'` so agents detect the shim explicitly. Same advisory-notice pattern as `search_packs_nl`'s `no_embeddings_yet`.

**First caller of two S7c/S15 additive methods:**
- **`getIndexStatus(slug)`** — landed in S7c (user Q9 sign-off) reserved for exactly this slice. S15 is its first caller, closing the S7c deferral.
- **`expandContextBySlug(slug)`** — landed in S15 (user Q2 sign-off this commit). First caller is S15 itself.

**Flow (order-critical — the spy-based integration test locks this):**

1. Resolve `projectSlug → projects.id`. Missing → `{ ok: false, error: 'project_not_found', howToFix }` soft-failure per §9.1.2. No graphify call.
2. `ctx.graphify.getIndexStatus(slug)` BEFORE `ctx.graphify.expandContextBySlug(slug)`. If `{ present: false, howToFix }`, return `{ ok: false, error: 'codebase_graph_not_indexed', howToFix }` soft-failure. The `howToFix` string is the lib-authored ``'run `graphify scan` at repo root'`` — surfaced verbatim.
3. `ctx.graphify.expandContextBySlug(slug)` → `{ nodes, edges }`. Empty arrays on lib-internal fail-open (parse failure / read failure) — these still return success with `indexed: true`, NOT collapsed with `codebase_graph_not_indexed`.
4. Return `{ ok: true, nodes, edges, indexed: true, notice: 'query_filtering_deferred_to_m05' }`.

**Output shape:**

- Success: `{ ok: true, nodes: unknown[], edges: unknown[], indexed: true, notice?: 'query_filtering_deferred_to_m05' }`.
- Soft-failure 1: `{ ok: false, error: 'project_not_found', howToFix }`. Remediation: `coodra init`.
- Soft-failure 2: `{ ok: false, error: 'codebase_graph_not_indexed', howToFix }`. Remediation: ``run `graphify scan` at repo root``.

Empty results (index present, graph.json parses to empty arrays) → `{ ok: true, nodes: [], edges: [], indexed: true, notice }` — NOT a soft-failure.

**Read-only tool:** idempotency key is kind `readonly`. Shape: `readonly:query_codebase_graph:{slug}:{query.slice(0,60)}` truncated to 200. No DB dedupe; log correlator only.

**Zod bounds:** `projectSlug` min 1 max 256; `query` min 1 max 2048 (empty query is a caller bug, rejected at schema layer). `.strict()`.

**Tests added (+30 total; unit 211→231, integration 154→164):**

- `__tests__/unit/tools/query-codebase-graph.test.ts` (NEW, 20 tests) — manifest via `assertManifestDescriptionValid`, name lock, idempotency-key readonly + (slug, query) combos distinct + 200-char truncation + probe-safe empty input, input schema (minimal valid, empty slug/query rejects, oversize query, strict-unknown-fields), output schema (success with/without notice, indexed: false reject, each soft-failure branch accepted, unknown error code rejected, unknown notice rejected), factory construction.
- `__tests__/integration/tools/query-codebase-graph.test.ts` (NEW, 10 tests):
  1. `project_not_found` soft-failure (slug not registered).
  2. `codebase_graph_not_indexed` soft-failure (project exists, no `graph.json`).
  3. Success — graph.json present → nodes + edges + indexed:true + notice.
  4. Empty graph.json (zero nodes) is success-with-empty, NOT soft-failure.
  5. Malformed graph.json → lib fail-open → success with empty arrays + indexed:true (does NOT collapse with `codebase_graph_not_indexed`).
  6. Order spy — `getIndexStatus` called BEFORE `expandContextBySlug` on the present-index path; only `getIndexStatus` called on the missing-index path. `expandContext` (runId-variant) never invoked by S15.
  7. Order spy — `project_not_found` short-circuits BEFORE any graphify call.
  8. Per-slug cache (lib) — second call returns cached version; disk change while cache warm is NOT observed.
  9. `query` accepted but NOT applied at M02 — different query values return identical nodes; notice present in both.

**Decisions-log entries (2, timestamped 2026-04-24):**

1. S15 four-decision rollup — factory/expandContextBySlug/output-shape/query-deferred.
2. S7c deferral closure — `getIndexStatus` first caller lands (parallels S14's `recordPolicyDecision` closure).

**Gate:**

- `pnpm install --frozen-lockfile` — clean (no new deps).
- `pnpm --filter @coodra/db run check:migration-lock` — ok, 2 blocks verified.
- `pnpm lint` — 0 errors, 1 pre-existing info (idempotency.ts:77:3).
- `pnpm typecheck` — 5/5 green.
- `pnpm test:unit` — 348/348 repo-wide (shared 75 + db 42 + mcp-server 231).
- `pnpm --filter @coodra/mcp-server run test:integration` — 164/164.

**Commit:** `feat(mcp-server): S15 — tool query_codebase_graph (two soft-failures + GraphifyClient.expandContextBySlug) + §24.4 amendment`.

### S16 — Transports + server entrypoint (landed 2026-04-25)

**Scope:** ships the Streamable HTTP transport alongside the existing stdio path, wires both through `src/index.ts` with a `--transport` CLI flag, and lands the three-layer auth chain (solo-bypass / X-Local-Hook / Clerk JWT) per §19. New deps: `hono@4.12.15` + `@hono/node-server@2.0.0`. No schema migration. No new MCP tool — this is transport infrastructure.

**Two noteworthy decisions (drove the implementation shape):**

1. **Hybrid Node listener, not pure-Hono.** MCP's `StreamableHTTPServerTransport` writes to Node `ServerResponse` directly (response is JSON-or-SSE depending on the request shape). Hono's context contract expects the handler to return a `Response` object; `@hono/node-server` has a `RESPONSE_ALREADY_SENT` sentinel for handler-owned writes, but it is not re-exported from the package root, and deep imports break under tightened `exports` fields. The S16 solve dispatches `/mcp` via `createServer`'s listener directly (auth + body read + SDK transport) and delegates `/healthz` and the 404 fallthrough to Hono via `getRequestListener(app.fetch)`. Future non-MCP routes land naturally on the Hono side.

2. **Bound-port read-back for ephemeral-port testing.** Test harnesses use `MCP_SERVER_PORT=0` so the kernel assigns a port (avoids port collisions in parallel test workers). The schema's `.positive()` constraint was loosened to `.min(0)` to allow this, and `startHttpTransport` reads the actually-bound port back via `nodeServer.address()` and reflects it in the returned `HttpTransportHandle.url` — without this, every test would race on a fixed port.

**Three-layer auth chain (§19 locked order, applied to `/mcp` only):**

```
1. solo-bypass    CLERK_SECRET_KEY === 'sk_test_replace_me' OR COODRA_MODE === 'solo'
                  → identity = SOLO_IDENTITY (user_dev_local / org_dev_local)

2. X-Local-Hook   request header `X-Local-Hook-Secret` matches `LOCAL_HOOK_SECRET` env
                  via timingSafeEqual (constant-time)
                  → identity source = 'local-hook'

3. Clerk JWT      `Authorization: Bearer <jwt>` → @clerk/backend::verifyToken
                  → identity = { userId: payload.sub, orgId: payload.org_id, source: 'clerk' }

4. else           401 + WWW-Authenticate: Bearer + body { error: 'unauthorized', reason: 'no_valid_auth_layer' }
```

`/healthz` is unauthed — reverse proxies / load balancers probe it without a Clerk round-trip.

**Routes shipped:**

- `GET /healthz` → `200 ok` with `Cache-Control: no-store`. Hono.
- `POST /mcp` → JSON-RPC 2.0 single request; response is `application/json` for unary calls or `text/event-stream` (SSE) when the SDK chooses streaming. Auth chain BEFORE body read.
- `GET /mcp` → SSE server→client stream leg per MCP Streamable HTTP spec.
- `DELETE /mcp` → session close per spec; SDK transport handles.
- 404 fallthrough → JSON `{ error: 'not_found', path }`. Hono.

**Body cap:** 1 MiB on `POST /mcp`. Prevents trivial DoS by closing the connection mid-read once the cap is exceeded.

**Server entrypoint (`src/index.ts`):**

- New `--transport stdio|http|both` CLI flag (or `-t`). Falls back to `MCP_SERVER_TRANSPORT` env var; default `both`. Throws on unrecognised value at boot.
- Stdio + HTTP transports start concurrently when `both` is selected.
- Graceful shutdown on SIGINT/SIGTERM: (a) one `setImmediate` tick to drain S14 audit-write queue, (b) close HTTP listener, (c) close stdio transport, (d) close DB. Errors at any step are logged and shutdown continues.

**Env additions:**

- `MCP_SERVER_HOST` — default `127.0.0.1` (loopback). Operators set `0.0.0.0` for team-mode behind a reverse proxy.
- `MCP_SERVER_TRANSPORT` — enum `stdio | http | both`, default `both`.
- `MCP_SERVER_PORT` constraint loosened to `.min(0)` for ephemeral-port test mode.

**Tests added (+9 integration; unit unchanged at 231):**

`__tests__/integration/transports/http.test.ts` (NEW, 9 tests, all using ephemeral port 0):
1. `/healthz` returns 200 ok (no auth, headers).
2. `/healthz` skips the auth chain — bogus Authorization header still returns 200.
3. Unknown path → 404 JSON via Hono fallthrough.
4. Solo-bypass: MCP `initialize` round-trip succeeds with no Authorization header; response has correct serverInfo.
5. Team mode + no creds → 401 with `WWW-Authenticate: Bearer` and structured body.
6. Team mode + malformed Bearer JWT → 401.
7. Team mode + wrong `X-Local-Hook-Secret` → 401.
8. Team mode + matching `X-Local-Hook-Secret` → 200 (initialize succeeds).
9. Body > 1 MiB → connection rejected (status >= 400 or fetch error).

Stdio transport tests unchanged — S16 didn't touch the stdio code path.

**Decisions-log entries (3, timestamped 2026-04-25):**

1. Hybrid Node listener vs pure-Hono routing — why and trade-offs.
2. Three-layer auth chain order locked + `/healthz` unauthed.
3. `MCP_SERVER_PORT` `.positive()` → `.min(0)` for kernel-ephemeral testing.

**Gate:**

- `pnpm install --frozen-lockfile` — 2 new deps (`hono` 4.12.15, `@hono/node-server` 2.0.0).
- `pnpm --filter @coodra/db run check:migration-lock` — ok, 2 blocks verified.
- `pnpm lint` — 0 errors, 1 pre-existing info (idempotency.ts:77:3).
- `pnpm typecheck` — 5/5 green.
- `pnpm test:unit` — 348/348 repo-wide (shared 75 + db 42 + mcp-server 231).
- `pnpm --filter @coodra/mcp-server run test:integration` — 173/173 (was 164; +9 from new HTTP tests).

**Commit:** `feat(mcp-server): S16 — Streamable HTTP transport + auth chain + entrypoint --transport flag`.

### S17 — End-to-end tests (landed 2026-04-25)

**Scope:** Module 02 closeout slice. Five e2e scenarios across `__tests__/e2e/<name>.test.ts` at the repo root (cross-workspace by design — they import from `apps/mcp-server/src/*`, `@coodra/db`, and `@coodra/shared` simultaneously). New deps: `testcontainers@11.14.0`, `ajv@8.20.0` + `ajv-formats@3.0.1`, `@modelcontextprotocol/sdk@1.29.0` (root devDep — already a workspace dep on mcp-server, lifted to root for the SDK Client), `drizzle-orm` (root). No schema migration. No new MCP tool.

**vitest.e2e.config.ts** at repo root: `testTimeout: 60_000`, `hookTimeout: 120_000` (testcontainers cold-pull tolerance), `fileParallelism: false` (port reservations + container lifecycle), `pool: 'forks'`. New `pnpm test:e2e` script. New turbo task `test:e2e` with the full env passthrough allowlist.

**Five scenarios shipping:**

1. **`manifest-e2e.test.ts`** (13 tests). Connects an SDK Client over Streamable HTTP, calls `tools/list`, asserts:
   - Exact 9-tool set (`ping`, `get_run_id`, `get_feature_pack`, `save_context_pack`, `search_packs_nl`, `record_decision`, `query_run_history`, `check_policy`, `query_codebase_graph`) — locks the count + each name.
   - Each description ≤ 800 chars (§24.3).
   - Each input schema is valid JSON Schema (Ajv 2020-12 dialect — Zod's `.toJSONSchema()` emits draft 2020-12).
   - Each tool's curated minimal-valid-input round-trips; soft-failure envelopes count as legitimate protocol shapes.

2. **`http-roundtrip.test.ts`** (5 tests). Boots the full ContextDeps graph + Streamable HTTP listener for each test (independent harness — proves auth-mode swaps work cleanly). Exercises:
   - Solo-bypass (sentinel) → 200 on initialize without Authorization header.
   - Team mode + no creds → 401 + `WWW-Authenticate: Bearer`.
   - Team mode + malformed Bearer → 401 (Clerk verifyToken rejects).
   - Team mode + matching `X-Local-Hook-Secret` → 200.
   - `/healthz` unauthed in team mode (operational probe).

3. **`policy-decisions-idempotency.test.ts`** (1 test, testcontainers Postgres). Real `pgvector/pgvector:pg16` container; CREATE EXTENSION vector before migrate (migration 0000 references `vector(384)` and pre-dates the safety-net extension creation in 0001). Dispatches 10 concurrent `check_policy` calls with identical `(sessionId, toolName, eventType)` triple via `Promise.all`. Asserts:
   - All 10 responses structurally match (deterministic — `no_rule_matched`, `failOpen: false`).
   - Exactly 1 row in `policy_decisions` after `setImmediate` queue drain.
   - Audit row's `idempotency_key` matches `pd:{sessionId}:{toolName}:{eventType}`.

4. **`full-session.test.ts`** (2 tests). Single SDK Client session walks the entire data plane:
   - `get_run_id` → mints a run, auto-creates the projects row in solo mode.
   - `record_decision` × 2 → two distinct rows (different descriptions).
   - `save_context_pack` → inserts `context_packs`, materialises markdown file on disk, flips run to `completed`.
   - `query_run_history` → returns the run with the joined pack title and `endedAt` populated.
   - DB-side assertions verify each write actually hit the tables; FS check confirms the markdown materialisation.

5. **`stdio-roundtrip.test.ts`** (3 tests). Spawns `apps/mcp-server/src/index.ts` as a subprocess via `pnpm exec tsx ... --transport stdio`, connects an SDK Client over `StdioClientTransport`. Asserts:
   - `initialize` handshake completes; `serverInfo.name === '@coodra/mcp-server'`.
   - `tools/list` returns the same 9-tool set as the HTTP path.
   - `ping` round-trip preserves the echoed payload.

**Bug surfaced + fixed in S17:** the HTTP transport's session id was minted as `http:${uuid}` (with a colon). `get_run_id` rejects sessionIds containing `':'` because its runId encoding is `run:{projectId}:{sessionId}:{uuid}`. The colon broke the encoding round-trip. Fixed by minting `http-${uuid}` and `stdio-${uuid}` instead. Same edit applied at `transports/http.ts` + `index.ts`. The integration tests didn't catch this because none of them chained `get_run_id` against a real per-call sessionId from the transport.

**Cross-workspace test layout:** per `essentialsforclaude/06-testing.md` §6.7, e2e tests live at repo root (NOT under any workspace's `__tests__/`). They import directly from workspace source paths via the new root-level workspace devDeps (`@coodra/db`, `@coodra/shared`, `@coodra/mcp-server`). The boot helper at `__tests__/e2e/_helpers/boot.ts` mirrors `apps/mcp-server/src/index.ts`'s ContextDeps wiring exactly — every lib factory production calls is also called here.

**`BootHandle` exposes `dbHandle`** (additive to S17): the strongly-typed `DbHandle` is now a top-level field on the boot handle, so e2e tests can run direct DB assertions (Drizzle `select().from(schema...)` with full type safety) instead of casting through `deps.db` which is `unknown` at the ContextDeps boundary.

**CI extension:** new `e2e` job in `ci.yml` that depends on `verify` + `integration` (so e2e only runs after the cheaper jobs pass). Runs `docker info` to fail fast if the daemon is unavailable. Pulls `pgvector/pgvector:pg16` for the idempotency scenario; subsequent runs reuse the cached image. 25-minute timeout.

**Tests added (+24 total e2e; unit unchanged at 348; integration unchanged at 173):**

| Scenario file | tests | scope |
|---|---|---|
| `manifest-e2e.test.ts` | 13 | tool set + description caps + JSON schema + minimal-valid-input round-trip |
| `http-roundtrip.test.ts` | 5 | three auth modes + healthz unauthed |
| `policy-decisions-idempotency.test.ts` | 1 | 10× concurrent → 1 row, testcontainers Postgres |
| `full-session.test.ts` | 2 | cross-tool session + DB/FS assertions |
| `stdio-roundtrip.test.ts` | 3 | subprocess spawn + tool surface + ping |

**Decisions-log entries (3, timestamped 2026-04-25):**

1. E2e-test layout at repo root (cross-workspace) + boot helper mirroring `index.ts` + `BootHandle.dbHandle` exposure.
2. testcontainers Postgres for the idempotency scenario (sqlite serialises writes; can't fake real concurrent INSERT...ON CONFLICT racing).
3. `http-${uuid}` / `stdio-${uuid}` session-id mint fix + bug-trace.

**Gate:**

- `pnpm install --frozen-lockfile` — clean (5 new root devDeps).
- `pnpm --filter @coodra/db run check:migration-lock` — ok, 2 blocks verified.
- `pnpm lint` — 0 errors, 1 pre-existing info (idempotency.ts:77:3).
- `pnpm typecheck` — 5/5 green.
- `pnpm test:unit` — 348/348 repo-wide.
- `pnpm --filter @coodra/mcp-server run test:integration` — 173/173.
- `pnpm test:e2e` — **24/24 across 5 scenarios** (~12s wall-clock incl. testcontainers Postgres pull on a warm image, ~2.3s for the stdio subprocess scenario).

**Commit:** `feat(repo): S17 — e2e test suite (5 scenarios, 24 tests, testcontainers + subprocess) + sessionId colon bug fix`.

`apps/mcp-server/__tests__/integration/stdio-roundtrip.test.ts` — in-process Duplex pair + `@modelcontextprotocol/sdk` `Client`. Sends `initialize` + `tools/list` + `tools/call` for each of the 8 tools. Asserts stdout purity (no non-JSON-RPC bytes in the Duplex buffer).

`apps/mcp-server/__tests__/integration/http-roundtrip.test.ts` — spawns the real Hono server on an ephemeral port; same round-trip assertions via HTTP.

`apps/mcp-server/__tests__/integration/manifest-e2e.test.ts` — per §24.9. Asserts: exactly 8 tools, names match the expected set, list is sorted by name, every `description.length < 800`, every `inputSchema` compiles under Ajv, every tool returns either a valid shape or a documented `{ ok: false, error }` for a minimal valid input. **Exercises both fallbacks** — `search_packs_nl` with zero embeddings asserts `notice: 'no_embeddings_yet'`; `query_codebase_graph` without a graph file asserts `notice: 'graphify_index_missing'`.

`apps/mcp-server/__tests__/integration/policy-decisions-idempotency.test.ts` — uses `@testcontainers/postgresql` to boot Postgres 16 with pgvector. Runs migrations, inserts a policy + rule, calls `check_policy` twice with the same input. Asserts one row in `policy_decisions` (the second write hit `ON CONFLICT DO NOTHING`).

**Commit:** `test(mcp-server): integration — stdio, http, manifest-e2e, policy-decisions idempotency`.

### S18 — CI extension

Extend `.github/workflows/ci.yml`:

- `verify` job: add `apps/mcp-server` to the matrix implicitly via the root `pnpm lint / typecheck / test:unit`. Add an explicit `pnpm --filter @coodra/db run check:migration-lock` step BEFORE lint.
- `integration` job: on the same Postgres + Redis service containers already running, add `pnpm --filter @coodra/mcp-server test:integration`. Docker socket is available on `ubuntu-latest` by default, so `testcontainers` works without further config.

**Commit:** `ci(mcp-server): extend workflow for apps/mcp-server + migration lock check`.

### S19 — Verification gate

Run locally:

```bash
pnpm install --frozen-lockfile
pnpm --filter @coodra/db run check:migration-lock
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm --filter @coodra/mcp-server test:integration   # requires Docker running
```

All six must pass. Coverage report confirms `apps/mcp-server ≥ 80% line coverage`. Any failure → fix commit on this branch, never a workaround.

### S20 — `.mcp.json` update + DEVELOPMENT.md update + Module 02 Context Pack

Update `.mcp.json` per Q-02-7 — point at workspace-relative `apps/mcp-server/dist/index.js`, update the inline `_comment` to note the CLI install helper is deferred to Module 07+.

Extend `docs/DEVELOPMENT.md` with an **MCP server** section: how to run `pnpm --filter @coodra/mcp-server dev`, how to point a Claude Code / Windsurf instance at the running server, how to hit `GET /healthz`, troubleshooting notes for sqlite-vec load failure.

Write `docs/context-packs/2026-04-22-module-02-mcp-server.md` from `docs/context-packs/template.md`. Must document: the 8 tools shipped, the two partial-capability fallbacks (with reactivation plan for Modules 05/17), every decision recorded during the module, every file touched, test results, and the pending Clerk live-validation flag.

**Commit:** `docs(02-mcp-server): module-02 context pack + .mcp.json + DEVELOPMENT.md`.

### S21 — Push to remote + merge

```bash
git push -u origin feat/02-mcp-server
```

Open PR. On review approval, squash-merge to `main`. After merge, user reloads their IDE; `coodra__*` tools become callable for the first time (§3.5, §24.2). Module 03+ uses them from the next session onward.

## Rollback strategy

If any step introduces a regression discovered after its commit, fix forward via an additional commit on this branch. Do not force-push `feat/02-mcp-server` during Module 02 — the history is part of the Context Pack.

## Logging discipline during Module 02

- After each file write: append a `- [HH:mm] <verb> <object> — <outcome>` line to `context_memory/current-session.md` Log section.
- After each design decision: append to `context_memory/decisions-log.md` with timestamp, decision, rationale, alternatives.
- Open questions and blockers go to `context_memory/open-questions.md` / `context_memory/blockers.md`.
- The manual discipline above is **still** the source of truth during Module 02. Once the server is merged and reloaded, the `coodra__*` tools take over and the manual discipline becomes the fallback path.
