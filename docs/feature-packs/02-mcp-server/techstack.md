# Module 02 — MCP Server — Tech Stack

> Every version below was verified against the npm registry on 2026-04-22 via `npm view <pkg> version` and reconciled with `External api and library reference.md`. Any drift between this file and the reference means the reference is updated **in the same commit** that changes this file — amendment B, carried forward from Module 01.

## Runtimes (carried forward from Module 01)

| Tool | Pin | Module-02 delta |
|---|---|---|
| Node.js | `22.16.0` (engines `>=22.16.0 <23`) | unchanged |
| pnpm | `10.33.0` | unchanged |
| Docker | host-installed ≥ 24 | **now required** for `testcontainers` integration tests (was optional in Module 01) |
| Python / uv | `>=3.12 <3.14` / `0.9.29` | unused in Module 02 |

## Module-02 npm dependencies (installed in S5)

`apps/mcp-server/package.json` dependencies:

| Package | Pin | Role | Reference action |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.29.0` | MCP server + client TS SDK. Provides `Server`, stdio/HTTP transport classes, `Client` (used in manifest-e2e test). | **NEW** entry in Protocols & Transports section |
| `hono` | `^4.12.14` | Minimal web framework for the HTTP transport's `POST /mcp` + `GET /healthz` endpoints. | Pin `^4.12.14` replaces the "verify via npm view" placeholder |
| `@hono/node-server` | `^2.0.0` | Node.js adapter for Hono's `fetch` handler. Serves the Streamable HTTP endpoint on 127.0.0.1:3100. | **Major bump** from reference's `1.19.3`; `serve({ fetch, port, hostname })` signature unchanged for our use |
| `cockatiel` | `3.2.1` **exact** | Circuit breaker + timeout fuse wrapping the policy-rule DB read in `lib/policy.ts`. Installed in S7b. Exact pin (no caret) per amendment-B — security-adjacent library; silent minor bumps could shift breaker semantics. |
| `zod-to-json-schema` | dropped | Replaced by Zod v4's native `z.toJSONSchema()` in S5 (decisions-log 2026-04-23). Not installed. |
| `@clerk/backend` | `3.3.0` **exact** | Server-side JWT verification via the top-level `verifyToken(token, { secretKey })` helper (NOT `ClerkClient.verifyToken`, which does not exist — see decisions-log 2026-04-24). Installed in S7b. Exact pin (no caret) — auth-critical library. Supersedes the original `^3.2.13` plan. |
| `picomatch` | `4.0.2` **exact** | Policy-rule path/tool-name glob matcher compiled once per rule at cache-load time in `lib/policy.ts`. Installed in S7b. Exact pin per amendment-B — glob semantics govern policy decisions. |
| `drizzle-orm` | `^0.45.2` | Query builder used by `lib/policy.ts` to SELECT policies + policy_rules rows and INSERT policy_decisions with `onConflictDoNothing`. Installed in S7b. Caret pin matches `@coodra/db`'s own pin. |

`apps/mcp-server/package.json` devDependencies:

| Package | Pin | Role | Reference action |
|---|---|---|---|
| `@types/picomatch` | `4.0.2` **exact** | Type definitions for picomatch. Installed alongside the runtime pin in S7b. |
| `ajv` | `^8.18.0` | JSON Schema validator used by `manifest-e2e.test.ts` to assert every tool's `inputSchema` is a valid Ajv-compilable schema (per §24.9). Deferred to S17. |
| `ajv-formats` | `^3.0.1` | Adds `date-time`, `uuid`, `uri` format checkers to Ajv so the manifest-e2e test matches real MCP client behaviour. Deferred to S17. |
| `testcontainers` | `^11.14.0` | Docker-backed Postgres 16 + pgvector container for `policy-decisions-idempotency.test.ts` and the Module 04 reuse. Deferred to S17. |
| `@testcontainers/postgresql` | `^11.14.0` | Convenience wrapper for the Postgres container with pgvector preinstalled. Deferred to S17. |

## `packages/db` dependency additions (installed in S4)

| Package | Pin | Role |
|---|---|---|
| `sqlite-vec` | `^0.1.9` (dev) | Native loadable extension for SQLite. Ships platform-specific binaries inside the npm tarball; loaded via `db.loadExtension(sqliteVec.getLoadablePath())` inside `createSqliteDb()`. Powers the `context_packs_vec` virtual table for solo-mode semantic search. On load failure, logs `sqlite_vec_unavailable` and the `search_packs_nl` LIKE fallback takes over. |

## Reference updates committed in-lockstep

Every new/updated version above is amended in `External api and library reference.md` in the **same commit** that introduces the matching `package.json` change. Summary of commit mapping:

| Commit | Reference changes |
|---|---|
| S4 (`feat(db): sqlite-vec virtual table...`) | `sqlite-vec` pin + load snippet + brute-force-KNN gotcha |
| S5 (`feat(mcp-server): scaffold...`) | MCP SDK new entry, Pino `COODRA_LOG_DESTINATION` gotcha. Zod v4 replaces `zod-to-json-schema` (dropped). HTTP-transport deps (Hono, @hono/node-server, ajv, ajv-formats, testcontainers) deferred to S16/S17. |
| S6 (`feat(shared): assertManifestDescriptionValid...`) | `system-architecture.md §24.3` amended to "40–80 word soft target, 120-word hard maximum" per Q-02-6; §24.8 safeguard 1 updated to reference `@coodra/shared/test-utils`. |
| S7a (`feat(mcp-server): S7a — freeze ToolContext...`) | No reference changes; lib-factory infra only. |
| S7b (`feat(mcp-server): S7b — real Clerk/local-hook auth + cache-first policy engine with breaker`) | `cockatiel` rewritten for 3.2.1 exact + timeout-fuse pattern; `@clerk/backend` new subsection at 3.3.0 exact + top-level `verifyToken` snippet + "wired but not live-validated" flag; `picomatch` new subsection at 4.0.2 exact + compile-at-cache-load pattern + picomatch-over-minimatch rationale. |

## Deferred / forward-looking pins (not installed in Module 02)

Carried forward from Module 01's list, with Module-02 adjustments:

| Package | Pin | First-used module | Notes |
|---|---|---|---|
| `@hono/zod-validator` | `^0.7.6` | Module 03 | Hooks Bridge HTTP body validation. |
| `bullmq` | `^5.76.0` | Module 03 (team mode) | Job queues (ADR-006). |
| `ioredis` | `^5.10.1` | Module 03 (team mode) | BullMQ transport. |
| `next` | `^16.2.4` | Module 04 | Paired with React 19. |
| `react` / `react-dom` | `^19.2.5` | Module 04 | Server Actions + RSC. |
| `jira.js` | `^5.3.1` | JIRA integration module (post Module 02) | §22. |
| `@octokit/rest` | `^22.0.1` | GitHub integration module (post Module 02) | §23. |
| `@octokit/auth-app` | `^8.2.0` | GitHub integration module | §23. |
| `@octokit/webhooks` | `^14.2.0` | GitHub integration module | §23. |
| `@octokit/plugin-throttling` | `^11.0.3` | GitHub integration module | §23. |
| `@octokit/plugin-retry` | `^8.1.0` | GitHub integration module | §23. |
| `@octokit/plugin-paginate-rest` | `^14.0.0` | GitHub integration module | §23. |

## Key gotchas carried forward from Module 01 — plus Module-02 additions

- **Pino 10 is ESM-only.** Unchanged; `apps/mcp-server` also uses ESM `nodenext`.
- **`@hono/node-server` 2.0.0.** Module 02 is the first consumer. `serve({ fetch, port, hostname })` works as expected; the 1.x vs 2.x return-shape diff does not affect our usage (we don't hold the returned handle for anything beyond `.close()`).
- **Drizzle-kit does not emit `CREATE VIRTUAL TABLE`.** The sqlite-vec virtual table in migration `0001` is hand-appended between `-- @preserve-begin hand-written` / `-- @preserve-end` markers. The block's sha256 is committed to `packages/db/migrations.lock.json` and CI rejects any mismatch. If `drizzle-kit generate` regenerates the migration and wipes the hand-written block, restore it from the last commit and re-verify the sha256 — see `docs/DEVELOPMENT.md` migration-lock section.
- **sqlite-vec extension load path.** `sqlite-vec.getLoadablePath()` returns a platform-specific `.dylib` / `.so` / `.dll`. Wrapped in try/catch; load failure logs `sqlite_vec_unavailable` at WARN and the `search_packs_nl` LIKE fallback takes over. The extension is not required for the test suite to pass — the LIKE fallback is itself covered by unit tests.
- **Stdio transport must not write to stdout outside protocol frames.** Pino is redirected to `process.stderr`; a unit test enforces this by running a 100-message round-trip and asserting stdout purity.
- **Clerk JWT verification is team-mode only and ships wired-but-unvalidated.** The solo-bypass + `LOCAL_HOOK_SECRET` + Clerk chain compiles and unit-tests with mocks. Live validation against a real Clerk tenant is deferred to Module 04 or the first real team-mode flip, flagged in `context_memory/pending-user-actions.md` and the Module 02 Context Pack.
- **`content_excerpt` is Unicode code-point safe.** Use `Array.from(content).slice(0, 500).join('')`, not `content.slice(0, 500)` (which would split multi-byte JS-string UTF-16 surrogate pairs). Covered by a specific unit test with an emoji at position 499.
- **`policy_decisions` write is asynchronous and idempotent.** `setImmediate` + `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`. Async-write failure logs at WARN with full decision context (`sessionId, toolName, eventType, matchedRuleId`). Durable outbox via `pending_jobs` deferred until post-Module-03 — revisit if DB downtime becomes visible.
- **`@modelcontextprotocol/sdk@^1.29.0` Streamable HTTP is NOT browser SSE.** No `EventSource`, no auto-reconnect. `POST /mcp` accepts JSON-RPC single or batch; response is `application/json` for unary or `text/event-stream` for streamed. Per-call decision at response time. Test both in `http-roundtrip.test.ts`.

## Version-bump policy (amendment B, unchanged)

Every time a `package.json` in this repo changes a pinned version, the entry in `External api and library reference.md` is updated in the same commit. For architecture-cited libraries (`@hono/node-server`, `@modelcontextprotocol/sdk`, `@clerk/backend`), `system-architecture.md` is also updated in the same commit if the referenced behaviour changes. Never a follow-up commit.
