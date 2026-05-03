# Decisions Log

Append-only. One entry per design/implementation decision. See `essentialsforclaude/03-context-memory.md` §3.2 + `05-agent-trigger-contract.md` §5.4.

Format:

```
## YYYY-MM-DD HH:mm — <short title>
**Decision:** <one-sentence what>
**Rationale:** <why this over alternatives>
**Alternatives considered:** <option A | option B>
**Reference:** <pointer into architecture / reference / ADR>
```

---

## 2026-04-22 14:13 — Bootstrap caveat: ContextOS MCP tools are not callable during Module 01

**Decision:** Use `context_memory/` by hand (manual writes to `current-session.md`, `decisions-log.md`, etc.) until Module 02 ships the MCP server and `.mcp.json` points to a live endpoint.
**Rationale:** The `contextos__*` tools described in `essentialsforclaude/05-agent-trigger-contract.md` require a running MCP server. That server is the Module-02 deliverable. Attempting to call those tools now would fail; faking a shape would violate the no-shallow-proxy rule (`01-development-discipline.md` §1.1). User explicitly instructed this in bootstrap request Step 2.
**Alternatives considered:** Skip context memory during Module 01 | stub the MCP calls to local file writes now (rejected — hides the missing dependency).
**Reference:** user Step 2 directive; `essentialsforclaude/03-context-memory.md` §3.2.

## 2026-04-22 14:27 — Module implementation order starts at Module 01 (Foundation) with explicit non-goals

**Decision:** Module 01 ships only the scaffold + `packages/shared` + `packages/db` + docker-compose + CI + docs + Context Pack. No `apps/*`, no `services/*`, no integration tests, no Clerk wiring beyond the solo-bypass fixture.
**Rationale:** `essentialsforclaude/08-implementation-order.md` §8.1 enforces linear build order. Creating empty `apps/` or `services/` now would be a shallow proxy violating `01-development-discipline.md` §1.1.
**Alternatives considered:** Front-load empty apps scaffolding so Module 02 starts with cd-into-apps/mcp-server (rejected — stubs).
**Reference:** `docs/feature-packs/01-foundation/spec.md` §3.

## 2026-04-22 14:27 — Adopt Next.js 16.2.4 + React 19.2.5 (overrides architecture's "Next.js 15")

**Decision:** Pin `next@^16.2.4` and `react@^19.2.5` / `react-dom@^19.2.5` when Module 04 lands. Architecture §2 and the `External api and library reference.md` Next.js section are updated in the **same commit** that introduces `apps/web/package.json` in Module 04 (amendment B).
**Rationale:** This is a fresh build with zero migration cost; pinning at Next.js 15 while npm latest is 16.2.4 would create upgrade debt and force a future breaking-change window.
**Alternatives considered:** Pin at Next.js 15 as the architecture currently dictates (rejected — upgrade debt). Defer decision to Module 04 (rejected — locks the techstack note in Module 01 now).
**Reference:** user Q2 answer; bootstrap-plan §4; `docs/feature-packs/01-foundation/techstack.md` forward-looking pins.

## 2026-04-22 14:27 — Adopt Pino 10.3.1

**Decision:** Install `pino@^10.3.1` (and `pino-pretty@^13.1.3` dev) in `packages/shared`. Update `External api and library reference.md` Pino section in the same commit (from 9.9.5 to 10.3.1 with ESM-only note).
**Rationale:** Pino 10 is ESM-only, matching our `tsconfig.base.json` `module: nodenext` setup. Fresh build, no migration cost from 9.x.
**Alternatives considered:** Pin Pino 9.9.5 as the reference currently says (rejected — fresh build, no reason to lag).
**Reference:** user Q3 answer.

## 2026-04-22 14:27 — Adopt @hono/node-server 2.0.0

**Decision:** Pin `@hono/node-server@^2.0.0` for Module 03. Update reference in the Module-03 commit.
**Rationale:** Fresh build; 2.x changes the `serve()` return shape and writing code against 1.x-only patterns now would require rewriting at Module 03 install time.
**Alternatives considered:** Pin 1.19.3 (rejected — upgrade debt).
**Reference:** user Q4 answer.

## 2026-04-22 14:27 — Adopt TypeScript 6.0.3

**Decision:** Pin `typescript@^6.0.3` at the root `package.json`. Update the Tooling section of `External api and library reference.md` in the same commit with a new pin (no prior pin existed).
**Rationale:** Fresh project. TS 6 is the current stable major; no prior TS 5 code to migrate.
**Alternatives considered:** Pin TS ~5.9 for library-compat caution (rejected — major ecosystem packages already ship TS 6-compatible types).
**Reference:** user Q5 answer.

## 2026-04-22 14:27 — Python services pin `requires-python = ">=3.12,<3.14"`

**Decision:** When `services/nl-assembly/pyproject.toml` and `services/semantic-diff/pyproject.toml` are added in Modules 05/06, their `requires-python` will be `>=3.12,<3.14`. `uv` will provision a 3.12 venv per service. System Python stays 3.14.4.
**Rationale:** `sentence-transformers` and `tree-sitter` bindings lag on 3.14 wheels; forcing 3.14 would compile from source and brittle the CI.
**Alternatives considered:** Use system 3.14 and compile from source (rejected — CI brittleness) | pin at exactly 3.12 (rejected — over-constrained).
**Reference:** user Q6 answer.

## 2026-04-22 14:27 — Hand-authored dual schemas + CI parity test

**Decision:** `packages/db/src/schema/sqlite.ts` and `packages/db/src/schema/postgres.ts` are authored by hand. A Vitest test in `packages/db/__tests__/unit/schema-parity.test.ts` asserts column-name + nullability + type-category parity for every table in the 5-table core and **fails the build** on drift (not a warning).
**Rationale:** Drizzle requires separate dialect modules (`sqlite-core` vs `pg-core`); a code-generator from a shared Zod source is over-engineered for Module 01. A hard CI assertion is the cheapest path to preventing silent drift.
**Alternatives considered:** Generate both schemas from a shared Zod source (rejected — premature abstraction) | no parity test, trust review (rejected — drift inevitable).
**Reference:** user Q7 answer; `docs/feature-packs/01-foundation/spec.md` §2 #5.

## 2026-04-22 14:27 — Defer Clerk project provisioning to Module 04

**Decision:** Module 01 uses the `sk_test_replace_me` solo-bypass fixture described in `system-architecture.md` §19. No real Clerk project is created until Module 04 begins.
**Rationale:** Module 01 runs in solo mode only; Clerk is unreachable until the web app needs it.
**Alternatives considered:** Provision Clerk now (rejected — premature external account registration) .
**Reference:** user Q8 answer; `02-agent-human-boundary.md` §2.2 "never fake a user action".

## 2026-04-22 14:27 — Schema ships 5 tables in Module 01; each later module owns its own tables

**Decision:** `packages/db/src/schema/*.ts` contains exactly `projects`, `runs`, `run_events`, `context_packs`, `pending_jobs` in Module 01. `policy_rules`, `policy_decisions`, `feature_packs`, `integrations`, `integration_tokens`, `integration_events`, `knowledge_edges` land in the module that first needs them via new numbered migrations.
**Rationale:** Each module takes ownership of its own surface. Front-loading the full schema would create tables nothing reads in Module 01, violating "every feature is real or absent" (§1.1).
**Alternatives considered:** Front-load full schema (rejected — dead tables are stubs).
**Reference:** user Q9 answer; `docs/feature-packs/01-foundation/spec.md` §4.

## 2026-04-22 14:27 — `.mcp.json` stub with explanatory `_comment`

**Decision:** Ship a valid JSON `.mcp.json` pointing to `http://127.0.0.1:3100/mcp` with a `_comment` field naming Module 02 as the delivery point.
**Rationale:** Claude Code / Cursor / Windsurf auto-load `.mcp.json`; its absence would surface as a different UX than "MCP server not running yet". A valid-but-failing endpoint is the honest state.
**Alternatives considered:** Omit `.mcp.json` until Module 02 (rejected — less honest about intended endpoint).
**Reference:** user Q10 answer.

## 2026-04-22 14:27 — Defer Docker daemon install to Module 02 start

**Decision:** Module 01 ships `docker-compose.yml` as a spec artifact but does not require Docker to be running. `docker compose config` validates the file shape; live service startup is a Module-02 prerequisite.
**Rationale:** Module 01 has no integration tests and no service that needs Postgres/Redis. Forcing Docker install now blocks progress.
**Alternatives considered:** Install Docker now (rejected — unnecessary) | skip compose file entirely (rejected — spec artifact for Module 02 should land with Foundation).
**Reference:** user Q1 answer.

## 2026-04-22 14:33 — MIT LICENSE at repo root

**Decision:** Ship MIT License in the root-metadata commit; `package.json` `"license": "MIT"`.
**Rationale:** User-specified.
**Alternatives considered:** None (user directive).
**Reference:** user plan amendment C.

## 2026-04-22 14:35 — Commit-level invariant: version bumps + doc updates in the same commit

**Decision:** Every commit that bumps a pinned version in any `package.json` must amend `External api and library reference.md` (and `system-architecture.md` where the bump contradicts that doc) in the same commit. Never a follow-up commit.
**Rationale:** Prevents the documented version drifting out of sync with the pinned version even for one commit window. Follow-up commits tend to get forgotten.
**Alternatives considered:** Batch doc updates at end-of-module (rejected — drift window between commits).
**Reference:** user plan amendment B.

## 2026-04-22 20:58 — Module 02 auth chain on HTTP transport: three layers, first match wins (Q-02-1)

**Decision:** MCP server HTTP transport applies auth middleware in this order: (1) solo-bypass when `CLERK_SECRET_KEY === 'sk_test_replace_me'`, (2) `X-Local-Hook-Secret` header equals `LOCAL_HOOK_SECRET` env value, (3) full Clerk JWT via `@clerk/backend` `authenticateRequest()`. First match wins. Stdio transport has no auth (local-only by construction — parent process owns stdin).
**Rationale:** Matches `system-architecture.md` §19's three-mode model. Solo developers never need real Clerk; local adapter scripts authenticate via the shared secret without embedding a user token in a shell script; full JWT covers the real team-mode case. Ordering ensures the cheapest, most common path (solo-bypass) short-circuits.
**Alternatives considered:** Single-mode (Clerk JWT only) with a separate dev endpoint (rejected — two code paths instead of one, and the dev endpoint would itself need auth).
**Reference:** user Q-02-1 answer; `system-architecture.md §19`.

## 2026-04-22 20:58 — Module 02 policy_decisions write cadence: async + idempotent + WARN on failure (Q-02-2)

**Decision:** `check_policy` evaluates synchronously and returns the decision in-line; the `policy_decisions` INSERT fires asynchronously via `setImmediate` using `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`. Async-write failure logs at **WARN** (not INFO) with full decision context — `sessionId`, `toolName`, `eventType`, `matchedRuleId`, `error`. Durable outbox via `pending_jobs` is explicitly deferred; revisit post-Module-03 if DB downtime becomes visible in decision-count drift.
**Rationale:** Meets §24.4's <10 ms latency target for `check_policy` while preserving the §4.3 append-only guarantee via the unique idempotency-key constraint. WARN-level logging on write failure is loud enough to surface in log aggregation without being a live-site alarm (decision is already in the agent's hands by then, and fail-open preserves availability).
**Alternatives considered:** Synchronous write in the request path (rejected — blows the 10 ms budget). Route through `pending_jobs` outbox today (rejected — extra machinery before we've observed any failure mode).
**Reference:** user Q-02-2 answer; `system-architecture.md §16 pattern 3 (Outbox)`, §4.3, §24.4.

## 2026-04-22 20:58 — Module 02 content_excerpt is Unicode code-point safe (Q-02-3)

**Decision:** `context_packs.content_excerpt` is the first **500 Unicode code points** (not bytes, not JS string `.length`) of `content` with trailing whitespace trimmed. Implemented via `Array.from(content).slice(0, 500).join('')` which iterates code points and preserves multi-byte characters. A unit test inserts an emoji or CJK character at position 499 and asserts lossless truncation.
**Rationale:** `String#slice` in JS operates on UTF-16 code units and will split surrogate pairs mid-character on emoji or supplementary-plane CJK, producing a broken string. The column is NOT NULL and used by `search_packs_nl` LIKE fallback — corrupted excerpts would poison search results. The code-point approach is O(n) but n ≤ 500 so cost is negligible.
**Alternatives considered:** `content.slice(0, 500)` (rejected — surrogate-pair unsafe). `Buffer.byteLength` byte-bounded truncation (rejected — bytes != characters; variable-width-UTF-8 makes this even worse than UTF-16 code units).
**Reference:** user Q-02-3 answer.

## 2026-04-22 20:58 — Module 02 Feature Pack storage: filesystem source of truth + DB checksum invalidation (Q-02-4)

**Decision:** Feature Packs live at `docs/feature-packs/<slug>/{spec,implementation,techstack}.md` on disk (source of truth). A `feature_packs` DB row carries metadata only: `id`, `slug`, `parent_slug`, `is_active`, `checksum`, `updated_at`. Checksum = sha256 of `spec.md + implementation.md + techstack.md` concatenated in that fixed order. On read, compare against the DB row; mismatch drops the 60-second in-process cache entry and updates the row.
**Rationale:** Files-first respects the editorial workflow (tech leads edit markdown in PRs) while the DB row enables activation/inheritance queries without fanning reads across the filesystem. Fixed concatenation order makes the checksum reproducible across machines. 60 s cache TTL matches §5's AP, cache-first tolerance for feature-pack retrieval.
**Alternatives considered:** DB-first with markdown rendered from a `content` column (rejected — breaks the PR-review workflow). No cache (rejected — every tool call re-reads three files). Cache with time-only invalidation (rejected — allows a tech lead's push to be ignored for up to 60s).
**Reference:** user Q-02-4 answer; `system-architecture.md §5` Feature Pack Retrieval → AP Cache-First, §16 pattern 9.

## 2026-04-22 20:58 — Module 02 Clerk middleware ships wired but unvalidated against live Clerk (Q-02-5)

**Decision:** Clerk middleware is coded against env-var reads and commits in S7b. All unit/integration tests pass without real Clerk keys (solo-bypass + mocked verify). The Module 02 Context Pack and `context_memory/pending-user-actions.md` explicitly flag "Team-mode auth wired but untested against live Clerk until user provides keys; first live validation during Module 04 or when team mode is first flipped for real". Module 02 acceptance checklist marks team-mode auth as 'wired, pending live validation' — not 'complete'.
**Rationale:** Waiting on real Clerk keys before merging Module 02 would gate 9 other slices on an external account registration. The solo-bypass path is complete and testable today. Honest flagging in the Context Pack prevents a future session assuming Clerk is fully validated.
**Alternatives considered:** Halt at the Clerk commit until keys are pasted (rejected by user Q-02-5). Ship without Clerk middleware at all and add in Module 04 (rejected — leaves team-mode HTTP transport unauthenticated; risks a merged-without-auth state that would be hard to spot).
**Reference:** user Q-02-5 answer; `essentialsforclaude/02-agent-human-boundary.md §2.2` "never fake a user action".

## 2026-04-22 20:58 — Module 02 manifest word budget: 40–80 soft target, 120 hard max (Q-02-6)

**Decision:** Per-tool `manifest.test.ts` asserts description word count is ≥ 40 and ≤ 120. `system-architecture.md §24.3` is amended in the same commit as the manifest test (S6) from "40–80 words" to "40–80 word soft target, 120-word hard maximum". The eight verbatim descriptions from `§24.4` are not tightened — architecture should describe what we actually test.
**Rationale:** §24.4's description for `check_policy` is 93 words and for `save_context_pack` is 85; tightening them would lose load-bearing detail (the "do NOT proceed on deny" clause, the "only handoff mechanism to next session" clause). Widening the test bound and documenting the widening is the honest reconciliation. 120 words at ~5 chars/word = ~600 chars, still well under the 800-char hard cap in §24.9.
**Alternatives considered:** Keep 80-word max and rewrite §24.4 descriptions to fit (rejected — lose load-bearing detail). Keep 80-word max and exempt the two offending tools in code comments (rejected — allowlist-based discipline drifts).
**Reference:** user Q-02-6 answer; `system-architecture.md §24.3`, §24.4.

## 2026-04-22 20:58 — Module 02 `.mcp.json` target: workspace-relative dist, no CLI install helper (Q-02-7)

**Decision:** `.mcp.json` stub updated in S20 from `~/.contextos/bin/mcp-server.js` (the eventual install location) to the workspace-relative `apps/mcp-server/dist/index.js`. The inline `_comment` field notes the CLI install helper (which would symlink into `~/.contextos/bin/`) is deferred to Module 07 or a dedicated distribution module.
**Rationale:** Dev ergonomics — the server becomes immediately runnable after a `pnpm build` without a separate install step. Contributors don't need to know about `~/.contextos/bin/` to try ContextOS. When distribution matters (Module 07, VS Code extension packaging, external contributors), the install helper lands and the stub updates then.
**Alternatives considered:** Ship the CLI install helper in Module 02 (rejected — out of scope for an MCP-server module; belongs with distribution work). Keep the stub pointing at `~/.contextos/bin/` and expect the contributor to symlink (rejected — poor first-run UX).
**Reference:** user Q-02-7 answer; `system-architecture.md §3.5`.

## 2026-04-22 20:58 — Module 02 split S7 into S7a/S7b/S7c along trust boundaries (Addition A)

**Decision:** The single S7 "Lib layer" slice in the original plan is split into three separately-committed slices: S7a (infra — `db.ts`, `env.ts`, `logger.ts`, `errors.ts`, `manifest-from-zod.ts`), S7b (security-critical — `auth.ts`, `policy.ts`), S7c (domain — `feature-pack.ts`, `context-pack.ts`, `run-recorder.ts`, `graphify.ts`, `sqlite-vec-client.ts`). Total slice count goes from 21 to 23.
**Rationale:** S7b touches the auth surface and the fail-open policy engine; isolating it in its own commit makes CODEOWNERS review tractable and the blast radius of a security regression bounded to one commit to revert. The infra / domain split keeps each slice small enough to review in one sitting.
**Alternatives considered:** Keep S7 as one commit (rejected — ~2000-line diff spanning infra/security/domain). Split by file rather than by trust boundary (rejected — arbitrary, doesn't help review).
**Reference:** user plan-approval addition A.

## 2026-04-22 20:58 — Module 02 hand-edited migrations are sha256-locked with CI enforcement (Addition B)

**Decision:** Every migration file that contains SQL Drizzle-Kit did not emit (the sqlite-vec `CREATE VIRTUAL TABLE`, the pgvector `CREATE INDEX ... USING hnsw`, and any future similar block) wraps that block in `-- @preserve-begin hand-written` / `-- @preserve-end` comments. A committed `packages/db/migrations.lock.json` records the sha256 of each block. `packages/db/scripts/check-migration-lock.mjs` extracts every preserve-block, recomputes sha256, diffs against the lock file, and exits non-zero on mismatch. Wired as the first step of the CI `verify` job (before lint). A pre-commit-reminder paragraph in `docs/DEVELOPMENT.md` tells contributors what to do if `drizzle-kit generate` regenerates a migration and wipes the hand-written block.
**Rationale:** `drizzle-kit generate` has no awareness of the custom vec0 and HNSW DDL and will happily rewrite a migration file, losing the hand-written bits. Without enforcement, this would only surface at runtime when `migrate` runs a migration without the virtual table or index. sha256-lock + CI grep catches it at PR time.
**Alternatives considered:** Trust review (rejected — drift inevitable). Put the hand-written SQL in a separate migration file (rejected — breaks Drizzle's sequential migration numbering and introduces an out-of-order migration problem).
**Reference:** user plan-approval addition B.

## 2026-04-22 20:58 — Module 02 env schema is strict on Clerk keys (Addition C)

**Decision:** `apps/mcp-server/src/lib/env.ts` `superRefine`s the base env schema so `CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` are optional in solo mode OR when `CLERK_SECRET_KEY === 'sk_test_replace_me'`, but required in team mode with the placeholder disallowed. Secret must match `/^sk_(test|live)_/`, publishable `/^pk_(test|live)_/`. Parse failure is a startup `ValidationError` from `@coodra/contextos-shared` with a specific pointer to the wrong env var.
**Rationale:** Team mode with the placeholder secret would silently run as solo-bypass in production — exactly the "team-mode without auth" failure mode that would be hardest to detect (it works for the developer who set it up, fails silently for everyone else). Startup-time fast-fail is the correct boundary.
**Alternatives considered:** Allow the placeholder in all modes and rely on CI/staging to catch it (rejected — "works on my machine, fails in prod" is the anti-pattern we're preventing). Discriminated union in the main env schema (rejected — `superRefine` is cleaner because the discriminant is a string value, not a type).
**Reference:** user plan-approval addition C; `system-architecture.md §19`.

## 2026-04-22 20:58 — Module 02 env-shape regression test with four fixtures (Addition D)

**Decision:** `apps/mcp-server/__tests__/unit/lib/env.test.ts` locks the env contract with four fixtures: (1) **valid-solo** — `CONTEXTOS_MODE=solo`, no Clerk keys, all defaults populate; (2) **valid-team** — `CONTEXTOS_MODE=team`, real `sk_test_...` + `pk_test_...`, parse succeeds; (3) **missing-clerk-in-team** — `CONTEXTOS_MODE=team`, no Clerk keys, MUST throw `ValidationError` with the Clerk-specific error message; (4) **malformed-port** — `MCP_SERVER_PORT=abc`, MUST throw `ValidationError`.
**Rationale:** Env parsing is the gate on every startup. Without fixture coverage, a refactor to the schema could silently accept invalid envs or reject valid ones. Four fixtures is the minimum to pin the two axes (mode × Clerk presence) + one "obviously wrong" control.
**Alternatives considered:** Exhaustive combinatorial fixtures (rejected — four is enough to pin each path). No regression test (rejected — addition D is explicitly required).
**Reference:** user plan-approval addition D.

## 2026-04-22 22:08 — sqlite-vec load failure is strict in test, fail-open in production (S4 refinement)

**Decision:** `packages/db/src/client.ts::loadSqliteVecOrFail` wraps `sqliteVec.load(db)` in a try/catch. When `process.env.NODE_ENV === 'test'` **or** `process.env.CONTEXTOS_REQUIRE_VEC === '1'`, a load failure throws `InternalError('sqlite_vec_unavailable')` with the underlying cause, logs an `error`-level structured line (`{ event: 'sqlite_vec_unavailable', loadablePath, platform, arch, err }`), and refuses the SQLite handle. Otherwise, the failure logs a `warn`-level line with the same shape and `createSqliteDb` returns a working handle that still serves all non-vector operations. Env vars are re-read on every call so tests can flip them at runtime. Covered by three integration tests in `packages/db/__tests__/integration/sqlite-vec.test.ts` (one per branch).

**Rationale:** The user's S4 approval was explicit — "Don't let dev/test silently degrade". CI and local test runs must never produce false-green results from a missing embedding-index, because the LIKE-over-`content_excerpt` fallback is a semantic degradation that would mask real regressions. Production, by contrast, must stay available: a new binary platform without a prebuilt sqlite-vec should still let the MCP server serve contextual reads with reduced precision, per the §7 fail-open discipline.

**Alternatives considered:** Always throw (rejected — would take down production on any platform sqlite-vec doesn't yet ship binaries for). Always warn (rejected — hides CI regressions). Toggle via a schema env field only (rejected — `NODE_ENV=test` is Vitest's own convention; coupling to it is more predictable than requiring every test to set a ContextOS-specific flag).

**Reference:** user S4 approval, third refinement; `system-architecture.md §7`; `packages/db/src/client.ts`; `External api and library reference.md` → sqlite-vec → Strict-vs-WARN contract.

## 2026-04-22 22:10 — pgvector HNSW index parameters are m=16, ef_construction=64

**Decision:** The hand-written preserve-block in `packages/db/drizzle/postgres/0001_clean_rafael_vega.sql` creates `context_packs_embedding_hnsw_idx ON context_packs USING hnsw (summary_embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`. `m` = number of bidirectional HNSW links per node (controls graph connectivity and storage). `ef_construction` = size of the dynamic candidate list during index build (controls build-time quality). `ef_search` stays at the pgvector session default (40) and is tunable at query time via `SET LOCAL hnsw.ef_search = N`. The `postgres-migrate.test.ts` integration test asserts both parameters appear in `pg_indexes.indexdef`.

**Rationale:** `m=16, ef_construction=64` are pgvector 0.8.x's own defaults, chosen by its authors for datasets up to ~1M rows with ~95% recall at `ef_search=40`. Module 02's expected working set (every Context Pack ever saved) is well inside that envelope. Explicitly writing the defaults (rather than omitting them and relying on the version default) locks the DDL against pgvector default changes and makes the decision grep-able in the migration file itself.

**Alternatives considered:** `m=32, ef_construction=128` (rejected — doubles index size and build time for a recall improvement we cannot currently measure; revisit in Module 05 if recall benchmarks motivate it). `m=8, ef_construction=32` (rejected — pgvector README warns that below the default, recall degrades noticeably beyond a few hundred thousand rows). Omit the WITH clause and rely on pgvector defaults (rejected — silent version coupling).

**Reference:** user S4 approval, fourth refinement ("Record HNSW param choice via record_decision"); pgvector 0.8.x README → HNSW tuning; `packages/db/drizzle/postgres/0001_clean_rafael_vega.sql` preserve-block; `packages/db/__tests__/integration/postgres-migrate.test.ts` HNSW-index-exists assertion.

## 2026-04-23 16:20 — Module 02 S5 is stdio-only; HTTP transport deferred to S16

**Decision:** The S5 walking-skeleton scope — `@coodra/contextos-mcp-server` initial landing — ships **only** the stdio transport. The Streamable HTTP transport (Hono + @hono/node-server + the full Clerk/solo-bypass/LOCAL_HOOK_SECRET auth chain) is deferred to S16 of the Module 02 implementation plan. As a consequence, HTTP-transport dev deps (`hono`, `@hono/node-server`, `cockatiel`, `@clerk/backend`, `ajv`, `ajv-formats`) are NOT installed in S5; they land in S16 alongside the transport they serve.

**Rationale:** The user's S5 directive was explicit — "S5 is stdio-only. HTTP transport deferred." Landing stdio first gives us a minimal, trusted parent-process channel through which the MCP client can exercise the tool-registration framework end-to-end before we add the auth surface area. Pulling the HTTP deps forward would bloat the dependency graph with code no S5 test exercises, and the Clerk middleware would become dead code carrying latent security expectations — both of which cut against the user's "no scope creep" reading of the plan.

**Alternatives considered:** Land both transports in S5 with the devNullPolicyCheck allowing all HTTP calls (rejected — the auth chain is the harder half of Module 02 and deserves its own slice with real tests, not a walking-skeleton bypass). Land stdio + healthz-only HTTP endpoint in S5 (rejected — splits the transport code across slices with no proportional test coverage).

**Reference:** user S5 approval directive 2026-04-23; `docs/feature-packs/02-mcp-server/implementation.md` S5 re-slice; `apps/mcp-server/README.md` "Current scope" section.

## 2026-04-23 16:25 — `CONTEXTOS_LOG_DESTINATION` env contract + bootstrap side-effect module

**Decision:** `packages/shared/src/logger.ts` is extended to honour the `CONTEXTOS_LOG_DESTINATION` env var at module load. Accepted values: unset (or `stdout`, any case) → pino default stdout; `stderr` → `pino.destination({ fd: 2, sync: true })`; anything else → `TypeError` at module load. `apps/mcp-server/src/bootstrap/ensure-stderr-logging.ts` is the side-effect module imported FIRST in `src/index.ts`; it normalises the env to `stderr` (or refuses to start if the env is explicitly set to anything but `stderr`). `apps/mcp-server/Dockerfile` and `.mcp.json` both set `CONTEXTOS_LOG_DESTINATION=stderr` as defence-in-depth.

**Rationale:** The MCP stdio transport uses stdout EXCLUSIVELY for JSON-RPC frames. A single stray byte — a pino line from any transitive dependency such as `@coodra/contextos-db`'s sqlite-vec loader — corrupts the transport and the client disconnects. The fix has to survive ESM's import hoisting: env changes inside `index.ts`'s body would execute AFTER `@coodra/contextos-shared/logger` has already resolved its destination. A side-effect module imported at the very top of the import chain is the only reliable pattern for Node ESM. Three enforcement points (bootstrap module, env var, Dockerfile/.mcp.json env) make the invariant auditable and redundant in the right way.

**Alternatives considered:** Call `pino.destination({ fd: 2 })` directly inside the mcp-server (rejected — would not affect transitively-imported `@coodra/contextos-db` logs, which use `@coodra/contextos-shared`'s `createLogger`). Monkey-patch `console.log`/`console.info` at boot (rejected — brittle, hides bugs, does not affect direct writes to `process.stdout`). Fork the shared logger for the mcp-server (rejected — duplicates the pino config across workspaces and creates two source-of-truth loggers).

**Reference:** user S5 directive "all logs must go to stderr, never stdout — one stray console.log breaks the transport. If packages/shared/src/logger.ts defaults to stdout, override or wrap it in the mcp-server"; `packages/shared/src/logger.ts` docblock; `apps/mcp-server/src/bootstrap/ensure-stderr-logging.ts`; `apps/mcp-server/__tests__/unit/transports/stdio-stdout-purity.test.ts`.

## 2026-04-23 16:28 — Use the SDK's low-level `Server`, not `McpServer.registerTool`

**Decision:** `apps/mcp-server/src/transports/stdio.ts` uses `@modelcontextprotocol/sdk`'s low-level `Server` (`@modelcontextprotocol/sdk/server/index.js`) with `setRequestHandler` against the SDK's exported `ListToolsRequestSchema` and `CallToolRequestSchema`. We explicitly do **not** use the high-level `McpServer.registerTool` API. The SDK tags `Server` as `@deprecated` in favour of `McpServer`; we override that signal.

**Rationale:** Our `ToolRegistry` (`src/framework/tool-registry.ts`) already owns input validation (author-supplied Zod schemas), output validation, the idempotency-key contract, and the automatic policy wrapper. Routing calls through `McpServer.registerTool` would either duplicate that work or split authority across two layers — both outcomes invalidate the "single source of truth for tool invariants" claim the registration framework makes. The SDK's `@deprecated` tag on `Server` means "use `McpServer` unless you have a reason to own the request lifecycle"; our custom registry is exactly that reason.

**Alternatives considered:** Use `McpServer.registerTool` and delete our framework (rejected — we need the synchronous register-time enforcement and the uniform policy/idempotency wrapping; McpServer defers validation to call time and does not wire policy at all). Use `McpServer.registerTool` and have our framework delegate (rejected — layering violation; the framework would become a thin shell that reimplements what McpServer does one level down).

**Reference:** user S5 directive "Tool registration framework must enforce at register time"; `apps/mcp-server/src/transports/stdio.ts` docblock; `External api and library reference.md` → `@modelcontextprotocol/sdk` → Server vs McpServer.

## 2026-04-23 16:32 — Drop `zod-to-json-schema`; use Zod v4 native `z.toJSONSchema`

**Decision:** `apps/mcp-server/src/framework/manifest-from-zod.ts` uses Zod v4's built-in `z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'throw' })`. The previously-pinned third-party `zod-to-json-schema@^3.25.2` (from `docs/feature-packs/02-mcp-server/techstack.md`) is dropped from `apps/mcp-server/package.json` and never installed.

**Rationale:** The original techstack.md was authored when `@coodra/contextos-shared` was on Zod v3. Module 01's foundation commit bumped shared to Zod v4 (`^4.3.6`), which ships a native `z.toJSONSchema()` producing JSON Schema 2020-12 output. Keeping Zod and the JSON-Schema emitter under the same library removes a version-coupling hazard (zod-to-json-schema must track zod's internals on every minor release) and halves the install graph for `@coodra/contextos-mcp-server`. The native helper's output shape is equivalent to our MCP client expectations — the `manifestFromZod` wrapper enforces `type === 'object'` at runtime so any edge case surfaces loudly.

**Alternatives considered:** Keep `zod-to-json-schema` and ignore Zod v4's native helper (rejected — two libraries doing the same job with different output defaults is a recipe for drift). Use an even-newer third-party like `@sinclair/typebox` (rejected — would require rewriting every schema and is unrelated to the approved techstack). Defer the decision and ship with `zod-to-json-schema` pinned (rejected — the user approved "pin @modelcontextprotocol/sdk exact" and deferring would still leave a stale pin in techstack.md for subsequent slices).

**Reference:** `apps/mcp-server/src/framework/manifest-from-zod.ts` docblock; `apps/mcp-server/__tests__/unit/framework/manifest-from-zod.test.ts`; `External api and library reference.md` → `@modelcontextprotocol/sdk` → Zod v4 compatibility.

## 2026-04-23 16:35 — Dockerfile base image is `node:22.16.0-bookworm-slim` (digest pinned)

**Decision:** `apps/mcp-server/Dockerfile` pins its base image by digest to `node@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34`, resolved 2026-04-23 on the host via `docker pull node:22.16.0-bookworm-slim` + `docker inspect --format='{{index .RepoDigests 0}}'`. The version matches `.nvmrc` (22.16.0). The Dockerfile uses a four-stage build (deps → build → `pnpm deploy` → runtime) and carves out a minimal production tree via `pnpm deploy --prod --legacy` in the third stage.

**Rationale:** Per the user's S5 directive "Do not use alpine — musl breaks native modules (better-sqlite3, sqlite-vec). Use the exact version from .nvmrc. Do not land a TODO on a supply-chain control." `better-sqlite3`'s prebuilt binaries and `sqlite-vec`'s per-platform binaries are both glibc-linked; Alpine's musl would force a source rebuild, adding build-essential + python to the runtime image and losing the binary pin. The Debian Bookworm slim variant is glibc, is actively maintained by the Node image team, and is ~130 MB vs ~900 MB for the full Bookworm image. Pinning by digest (rather than by tag) defends against silent upstream re-tagging — the digest moves only when we consciously re-pull and re-inspect.

**Alternatives considered:** `node:22.16.0-alpine` (rejected — musl, per user). `node:22.16.0-slim` (defaults to Bookworm-slim; same result but less explicit — we prefer the named variant in the `FROM` line). `node:22.16.0-bullseye-slim` (rejected — older Debian release, no meaningful security benefit). Un-pinned `node:22` or `node:22.16.0` (rejected — tags move).

**Reference:** user S5 directive "Do not use alpine…", "base image pinned by digest"; `apps/mcp-server/Dockerfile` FROM lines + docblock.

## 2026-04-23 18:40 — §24.3 manifest-assertions helper lives in `@coodra/contextos-shared/test-utils`

**Decision:** `assertManifestDescriptionValid` and its supporting constants live in `packages/shared/src/test-utils/manifest-assertions.ts`, exposed through a new `./test-utils` subpath export in `@coodra/contextos-shared`. It is NOT placed inside `apps/mcp-server/__tests__/helpers/`, which was the original implementation-plan location.

**Rationale:** §24.3 is a protocol-level rule about MCP tool descriptions — it applies equally to the eight `contextos__*` tools shipped inside `apps/mcp-server/` (Module 02 S7a+) and to any future standalone tool package (e.g. a hypothetical `@coodra/contextos-tools-github` or `@coodra/contextos-tools-jira`) that registers with the server. Placing the helper in the server app would force every downstream tool package to take a dev dep on the server, inverting the dependency arrow. The subpath export (rather than main export) keeps production consumers of `@coodra/contextos-shared` clean of test-only code in their bundle graph.

**Alternatives considered:** A new `@coodra/contextos-test-utils` package (rejected — one additional publish surface for a single-function module; can be extracted later if test utilities grow substantially). Leaving the helper in `apps/mcp-server/__tests__/helpers/` and copying it to future packages (rejected — three copies means three points of drift when §24.3 evolves). Re-export from the shared package root (rejected — the package root is reserved for production code; test utilities should be explicitly opt-in via the subpath).

**Reference:** `packages/shared/package.json` exports; `packages/shared/src/test-utils/manifest-assertions.ts`; `apps/mcp-server/__tests__/unit/tools/ping.test.ts` (first consumer); `system-architecture.md` §24.8 safeguard 1; user S6 directive 2026-04-23.

## 2026-04-23 20:55 — S7a: freeze `ToolContext` shape with typed lib factories before S7b/c bodies

**Decision:** Introduce `apps/mcp-server/src/framework/tool-context.ts` defining `ToolContext = ContextDeps & PerCallContext`, and ship nine lib factories in `apps/mcp-server/src/lib/` (`logger`, `errors`, `db`, `auth`, `policy`, `feature-pack`, `context-pack`, `run-recorder`, `sqlite-vec`, `graphify`), each returning a value that satisfies one `ToolContext` slot. Factories expose no module-level singletons. The domain factories (`feature-pack`, `context-pack`, `run-recorder`, `sqlite-vec`, `graphify`) have methods that throw `NotImplementedError('<subsystem>.<method>')` from `@coodra/contextos-shared::InternalError`; S7b and S7c replace those bodies only — file tree, interfaces, and wiring are frozen.

`ToolRegistry`'s constructor becomes `new ToolRegistry({ deps: ContextDeps, clock?: () => Date, mintRequestId?: () => string })`. Every handler receives the full frozen `ToolContext`. `ctx.now()` is the ONLY legitimate clock in `src/tools/**`; an `_no-raw-date.test.ts` guard under `__tests__/unit/tools/` fails CI if a handler file contains the literal substring `new Date(`.

**Rationale:** User S7a directive 2026-04-23: "shapes before guts". A handler written today and a handler written in S15 must reach every subsystem through identical names and identical types. Without the freeze, swapping the dev-null policy for the real evaluator (S7b) or swapping the `NotImplementedError` stubs for real bodies (S7c) would require edits across every tool file — that is the scenario this slice prevents. The factory pattern (no singletons) means tests spin per-suite instances without leaking through hidden module state. `ctx.now()` routed through the registry's injected clock is the single place we need to freeze time for deterministic output; the guard test enforces that nothing else in `src/tools/**` bypasses it.

Domain-API-only constraint (`sqliteVec.searchSimilarPacks`, not `sqliteVec.run(sql)`; `graphify.expandContext`, not `graphify.readFile`) keeps tool manifests honest: an agent-visible description like "this tool only reads context_packs_vec" is provable at the interface level, not just the SQL level.

**User-directive answers pinned by this slice:**
- Q2 — `runRecorder.record({ runId: string | null, ... })` accepts null; the nullable invariant is handled inside the recorder, not at every call site.
- Q3 — `contextPack.write(pack, embedding: Float32Array | null)` — the store NEVER computes an embedding; Module 04 does. Null is a first-class value.

**Alternatives considered:** Build `ToolContext` + lib factories only when each handler needs them (rejected — N × refactors, drift across 8 tools). Pass raw `PolicyCheck` / `DbHandle` / etc. into the registry (rejected — leaks driver choice, widens the opt-out surface, blocks policy auto-wrap). Skip `NotImplementedError` stubs and have `ContextDeps` carry `null` slots (rejected — every caller would need a null-check; a typed `NotImplementedError` gives grep-able failure modes and satisfies the interface).

**Reference:** `apps/mcp-server/src/framework/tool-context.ts`; `apps/mcp-server/src/lib/*.ts`; `apps/mcp-server/src/framework/tool-registry.ts` (constructor); `apps/mcp-server/__tests__/unit/tools/_no-raw-date.test.ts`; `apps/mcp-server/__tests__/integration/lib/*.test.ts`; `docs/feature-packs/02-mcp-server/implementation.md` §S7a; user S7a directive 2026-04-23.

## 2026-04-23 21:05 — `ContextPackStore.write(pack, embedding: Float32Array | null)` — `null` is a first-class value

**Decision:** `apps/mcp-server/src/framework/tool-context.ts` types `ContextPackStore.write`'s second parameter as `Float32Array | null`. `null` is not an error sentinel — it is a legal and expected value. The `context_packs` row is still persisted when `null` is passed; `summary_embedding` is written as SQL `NULL`.

**Rationale:** Three grounds, all anchored in existing spec + schema, not discovered at implementation time:

1. **The DB schema permits it.** Both `packages/db/src/schema/sqlite.ts` and `packages/db/src/schema/postgres.ts` declare `summary_embedding` as nullable from Module 01. The column was designed for this shape.
2. **`search_packs_nl` has a documented LIKE fallback for exactly this case.** `docs/feature-packs/02-mcp-server/implementation.md` S11 defines `notice: 'no_embeddings_yet'` + `howToFix: 'Module 05 (NL Assembly) will populate summary_embedding on save.'`. A fallback that queries rows lacking `summary_embedding` only exists because rows lacking embeddings are expected. Dropping `| null` here would make S11's own contract unsatisfiable — the tool would have nothing to fall back FROM.
3. **Timing / module boundaries.** Module 02 must be able to `save_context_pack` before Module 04 ships the embedder. In solo mode today there is no embedder wired; a `save_context_pack` call with `embedding: null` must still land a row so the rest of the run-graph (Module 05 NL Assembly, Module 07 analytics) continues to work against a complete history. Forcing `Float32Array` non-null would block every solo-mode save until Module 04, which the implementation plan explicitly defers.

Additionally: the type signature carries a user-directive invariant by itself — it names the fact that `ContextPackStore` does NOT compute embeddings. Module 04 owns embedding computation. The store is a sink, not a pipeline stage. Typing the parameter as non-null would quietly imply a computation responsibility that does not belong here.

**Alternatives considered:** `write(pack, embedding: Float32Array)` non-null (rejected — contradicts the schema, the §S11 LIKE fallback, and the module-boundary user directive; every solo-mode save breaks until Module 04). `write(pack, embedding?: Float32Array)` with `undefined` (rejected — `undefined` and `null` at the SQL boundary both encode as SQL `NULL`; `null` is explicit at the type level and matches the Drizzle `.notNull(false)` default). Separate `writeWithoutEmbedding(pack)` + `writeWithEmbedding(pack, vec)` methods (rejected — two call sites per save, doubles the surface to stub + integration-test, and obscures the LIKE-fallback contract).

**Reference:** `apps/mcp-server/src/framework/tool-context.ts::ContextPackStore.write`; `apps/mcp-server/src/lib/context-pack.ts`; `apps/mcp-server/__tests__/integration/lib/context-pack.test.ts` (`write(Float32Array)` + `write(null)` both pinned); `packages/db/src/schema/sqlite.ts` + `packages/db/src/schema/postgres.ts` (`summary_embedding` nullability); `docs/feature-packs/02-mcp-server/implementation.md` §S11; user S7a review question 2 (2026-04-23).

## 2026-04-24 10:45 — S7b: cockatiel@3.2.1 exact pin + 100ms timeout fuse + ConsecutiveBreaker(5) + 30s half-open

**Decision:** `apps/mcp-server` pins `cockatiel@3.2.1` **exact** (no caret) in `dependencies`. The policy evaluator wraps the DB rule-read in `wrap(timeout(100, TimeoutStrategy.Aggressive), circuitBreaker(handleAll, { halfOpenAfter: 30_000, breaker: new ConsecutiveBreaker(5) }))`. The three parameters are exposed as `CreatePolicyClientOptions.{timeoutMs, breakerHalfOpenMs, breakerThreshold}` overrides for tests, defaulting to the locked values.

**Rationale:** User S7b directive 2026-04-23 Q3/Q4: "§7 breaker config (5 consecutive, 30s half-open) verbatim, 100ms per-call timeout as a fuse not a budget." The timeout-on-the-inside ordering (`wrap(timeout, breaker)` vs `wrap(breaker, timeout)`) means the timeout fires per-attempt, which is what "fuse" means; flipping the order would timeout the whole breaker execution and break fail-open semantics. Exact pin (no caret) matches the amendment-B discipline for security-adjacent libraries — a silent minor bump could shift breaker semantics and we'd never notice until a fail-open incident.

**Alternatives considered:** `ConsecutiveBreaker(3)` tighter (rejected — §7 specifies 5, and tighter thresholds trip on routine slow-query spikes). `SamplingBreaker(0.2, 30000)` (rejected — sampling needs a volume baseline we don't have at Module 02 scale). No timeout, rely only on the breaker (rejected — a single pathological DB read could blow the 50ms solo p95 target before the breaker ever tripped). Caret `^3.2.1` (rejected — security surface, no silent bumps).

**Reference:** `apps/mcp-server/src/lib/policy.ts::createPolicyClient`; `apps/mcp-server/__tests__/integration/lib/policy-db.test.ts` ("fails open when the DB throws" test uses `breakerThreshold: 2` + `breakerHalfOpenMs: 60_000` to exercise open-state branch); `External api and library reference.md` → cockatiel section (amended same commit); `system-architecture.md` §7 Fault Tolerance; user S7b directive 2026-04-23 Q3+Q4.

## 2026-04-24 10:45 — S7b: @clerk/backend@3.3.0 exact pin + top-level `verifyToken` entrypoint (not `ClerkClient.verifyToken`)

**Decision:** `apps/mcp-server` pins `@clerk/backend@3.3.0` **exact** in `dependencies`. `apps/mcp-server/src/lib/auth.ts::verifyClerkJwt` calls the top-level `verifyToken(token, { secretKey })` export, NOT `createClerkClient(...).verifyToken(...)`. The latter does not exist in the library's v3.x surface — `ClerkClient` is `ApiClient & createAuthenticateRequest`-shaped, and its JWT verification is the `authenticateRequest({ request })` method used at HTTP boundaries. For the ContextOS lib layer (which has no request object on stdio and a raw Bearer token on HTTP), the plain `verifyToken` helper is the right entrypoint. Supersedes `techstack.md`'s original `^3.2.13` pin.

**Rationale:** Matches `@clerk/backend` 3.3.0's actual API (confirmed via `node_modules/.pnpm/@clerk+backend@3.3.0/.../dist/index.d.ts` lines 7–18). The helper takes the raw token + options and returns the JwtPayload, with JWKS caching at the module level. Earlier plan assumed `ClerkClient.verifyToken()` — that was wrong. Exact pin (no caret) per amendment-B — Clerk is on the critical auth path.

**Alternatives considered:** `authenticateRequest({ request })` (rejected — requires a real Request object; we want the raw-token shape for the HTTP middleware to control how it parses the Authorization header). Keep `^3.2.13` as techstack.md originally said (rejected — `3.2.13` may not ship the same API shape and the exact pin removes the ambiguity).

**Reference:** `apps/mcp-server/src/lib/auth.ts::verifyClerkJwt`; `apps/mcp-server/__tests__/unit/lib/auth-chain.test.ts` (mocks the top-level `verifyToken` via `vi.mock('@clerk/backend', ...)`); `External api and library reference.md` → @clerk/backend section (added same commit); `docs/feature-packs/02-mcp-server/techstack.md` (pin updated same commit).

## 2026-04-24 10:45 — S7b: picomatch@4.0.2 exact pin for policy-rule path matching

**Decision:** `apps/mcp-server` pins `picomatch@4.0.2` (+`@types/picomatch@4.0.2` dev) **exact**. `lib/policy.ts` compiles `match_path_glob` at cache-load time (once per rule) and reuses the matcher across `evaluate()` calls. Rules without a glob skip the matcher entirely.

**Rationale:** User S7b directive 2026-04-23 Q5: picomatch over minimatch (10× faster, zero deps, syntax superset). Exact pin per amendment-B — glob semantics govern policy decisions; a silent minor bump with different glob interpretation could change which rules match which files. Memoising at cache-load (not per-evaluate-call) means a project with hundreds of rules pays the compile cost once every 60s.

**Alternatives considered:** `minimatch` (rejected per user directive). Hand-rolled `**`/`*` (rejected — even simple globs require enough edge-case handling that rolling our own is a test-surface pain and a subtle-bug magnet). `fast-glob` (rejected — file-walking library; this isn't a file-walking problem).

**Reference:** `apps/mcp-server/src/lib/policy.ts::compileRule`, `evaluateRules` (tool-name + path axes both call picomatch); `apps/mcp-server/__tests__/unit/lib/policy-rules.test.ts` (pure match-logic coverage); `External api and library reference.md` → picomatch section (added same commit).

## 2026-04-24 10:45 — S7b: AuthClient on stdio returns null-then-helpers (frozen interface, option a)

**Decision:** `createClerkAuthClient(env).getIdentity()` returns `null` on stdio today; `requireIdentity()` throws `UnauthorizedError`. The real per-request work (JWT verification, local-hook comparison) lives in two NEW exported helpers — `verifyClerkJwt(token, env): Promise<Identity>` and `verifyLocalHookSecret(presented, expected): boolean` — which S16's HTTP middleware will call to resolve an identity before dispatching to the registry. The frozen `AuthClient` interface in `tool-context.ts` does NOT change. The top-level `createAuthClient(env)` dispatcher picks solo when the solo-bypass sentinel is set OR when `CONTEXTOS_MODE === 'solo'`.

**Rationale:** User S7b directive 2026-04-23 Q1 locked option (a): "null-on-stdio + helpers for S16." The stdio transport is a trusted parent-process channel (§9.1 loopback model) with no per-request identity by design; adding AsyncLocalStorage (option b) would ship latent machinery no S7b test exercises, and extending the interface (option c) was explicitly vetoed by the frozen-shape constraint.

**Alternatives considered:** Option (b) AsyncLocalStorage (rejected — machinery without a caller). Option (c) extend `AuthClient` interface (rejected — frozen). Always return solo identity even in team mode (rejected — that IS the "team mode running as solo" silent-auth-failure the env-schema `superRefine` explicitly blocks at boot).

**Reference:** `apps/mcp-server/src/lib/auth.ts` (createClerkAuthClient + verifyClerkJwt + verifyLocalHookSecret + createAuthClient); `apps/mcp-server/__tests__/unit/lib/auth-chain.test.ts` (hoist-mocks `@clerk/backend::verifyToken`); `apps/mcp-server/__tests__/integration/lib/auth.test.ts` (dispatcher fixtures); `system-architecture.md` §19 (auth chain authority); `context_memory/decisions-log.md` 2026-04-22 Q-02-1 (chain order solo → local-hook → Clerk).

## 2026-04-24 10:45 — S7b: policy cache keyed globally today; per-project keying deferred to S14

**Decision:** The S7b policy cache uses a single synthetic key `'all'` with 60 s TTL. All active policies' rules are loaded in one SELECT (`policies` × `policy_rules` INNER JOIN WHERE `policies.is_active = true`, ORDER BY `priority ASC`). Module 02 solo-mode scale (<10 rules, one project) makes a richer cache meaningless until S14's `check_policy` tool threads project scope through the input.

**Rationale:** The frozen `PolicyClient.evaluate(input: PolicyInput)` carries `{ toolName, phase, sessionId, idempotencyKey, input }` — no `projectId` field. The registry auto-wrap's PolicyInput comes from the MCP tool call, not the Hooks Bridge, so project context is simply not available at this layer. Forcing a `projectId` now would either (a) require an interface change (frozen shape vetoed) or (b) introduce a synthetic default that leaks into every cache lookup and audit-write. Global keying is the honest representation of what Module 02's auto-wrap path actually knows.

**Alternatives considered:** Discover `projectId` by joining `runs` on `sessionId` (rejected — PreToolUse can fire before a run exists per §4.3). Require callers to carry `projectId` in `input` (rejected — would require every tool handler to know about project scoping). Cache per-tool-name (rejected — orthogonal axis; rule priority ordering is global within a project).

**Reference:** `apps/mcp-server/src/lib/policy.ts::createPolicyClient` + `loadRules`; `apps/mcp-server/__tests__/integration/lib/policy-db.test.ts` ("caches rules within the TTL window and refreshes after"); `system-architecture.md` §5 Policy Evaluation → AP cache-first; `docs/feature-packs/02-mcp-server/implementation.md` §S14 (future `check_policy` tool — upgrades cache key).

## 2026-04-24 10:45 — S7b: policy_decisions writes land with S14's check_policy, not with the S7b evaluator

**Decision:** `apps/mcp-server/src/lib/policy.ts::createPolicyClient().evaluate(...)` does NOT write to `policy_decisions`. The audit-write helper `recordPolicyDecision(db, args)` is exported from the same module — it is the real wire code, idempotent on the locked key `pd:{sessionId}:{toolName}:{eventType}` (§4.3), ON CONFLICT DO NOTHING, handles nullable `run_id`. S14's `check_policy` MCP tool is the first call site; it will invoke the helper via `setImmediate` per Q-02-2.

**Rationale:** `policy_decisions` has NOT NULL FK columns (`project_id` → `projects.id`, `agent_type`, `event_type`) that the registry auto-wrap `PolicyInput` does not carry. Writing with synthetic defaults would (a) require a placeholder `projects` row and (b) flood the audit log with per-registry-autowrap-call rows that are not the `check_policy` hook events §4.3 is designed to audit. The user S7b brief's "async idempotent inserts" belongs to `check_policy` (the caller with full context), not to every auto-wrap call. Q-02-2's "async-write on every check" applies to the `check_policy` path specifically. Keeping the helper in the same module as the evaluator preserves single-source-of-truth for the policy-engine surface.

**Alternatives considered:** Write from `evaluate()` with synthetic projectId/agentType (rejected — FK violation + audit-log noise). Split into two modules `lib/policy.ts` + `lib/policy-audit.ts` (rejected — breaks the grep convention that lib-module-name = ToolContext-slot-name for the policy surface). Emit audit writes only when S14 ships (rejected — the wire code for the insert needs to exist, be unit-tested, and be imported from one place so S14 is a call-site add, not a code-add).

**Reference:** `apps/mcp-server/src/lib/policy.ts::recordPolicyDecision` + `buildPolicyDecisionIdempotencyKey`; `apps/mcp-server/__tests__/integration/lib/policy-db.test.ts` ("inserts a policy_decisions row with the locked idempotency key", "ON CONFLICT DO NOTHING dedupes a retry", "accepts null runId"); `packages/db/src/schema/sqlite.ts::policyDecisions` (FK shape); `context_memory/decisions-log.md` 2026-04-22 Q-02-2 (async-write policy decision); `docs/feature-packs/02-mcp-server/implementation.md` §S14.

## 2026-04-24 12:15 — S7c: feature_packs is single-namespace-by-slug (projectSlug === featurePackSlug)

**Decision:** The `feature_packs` table intentionally has no `project_id` FK (unlike `policies`, `policy_rules`, `policy_decisions`). `apps/mcp-server/src/lib/feature-pack.ts` treats `projectSlug` as the feature-pack slug: `get({ projectSlug: '02-mcp-server' })` queries `feature_packs.slug = '02-mcp-server'` directly. The interface parameter name `projectSlug` is preserved for historical reasons; the store's docblock documents the convention.

**Rationale:** User ruling 2026-04-24: "confirm projectSlug === featurePackSlug". Verified against `packages/db/drizzle/postgres/0001_clean_rafael_vega.sql:1-9` (no project_id FK) and `docs/feature-packs/02-mcp-server/spec.md:81` (deliberately omits project scoping). The omission is by design — feature packs are a global namespace, not per-project like policies. Future multi-project consumers will need either a join table or denormalized `project_id`; deferred until the first non-self-hosting consumer surfaces.

**Alternatives considered:** Rename the interface parameter to `featurePackSlug` for accuracy (rejected — frozen-interface rule). Add a `project_id` FK retroactively (rejected — premature, no caller needs it). Route get/list through a `projects`-to-`feature_packs` join (rejected — no such relationship in schema).

**Reference:** `apps/mcp-server/src/lib/feature-pack.ts` docblock; `docs/feature-packs/02-mcp-server/spec.md` §81; `packages/db/drizzle/postgres/0001_clean_rafael_vega.sql`; user ruling Q1 S7c 2026-04-24.

## 2026-04-24 12:15 — S7c: Feature-pack metadata lives in per-pack `meta.json` files

**Decision:** Each `docs/feature-packs/<slug>/` directory has a `meta.json` alongside `spec.md` / `implementation.md` / `techstack.md`. Schema (Zod-validated at load): `{ slug: string, parentSlug: string | null, sourceFiles?: string[] }`. The `meta.json.slug` field MUST match the directory name; mismatch throws `InternalError`. On load, `parentSlug` is synced to the `feature_packs.parent_slug` DB column when the checksum mismatches. `sourceFiles` stays in-memory only — the DB row does not carry it.

**Rationale:** User ruling 2026-04-24: "meta.json (a) confirmed". The three markdown files are narrative prose — no structured frontmatter — so `parentSlug` and `sourceFiles` need a separate metadata anchor. Options considered: YAML frontmatter on `spec.md` (rejected — mixes content with structure, harder to grep), convention-based parent derivation (rejected — fragile, breaks for non-numbered packs), a unified monolithic index file (rejected — concurrent-edit conflicts). `meta.json` per-pack: simple JSON, Zod-validatable, git-mergeable on the per-pack axis, consistent with the on-disk scope.

Bootstrap: `docs/feature-packs/01-foundation/meta.json` and `docs/feature-packs/02-mcp-server/meta.json` land in the same commit as the lib body swap, populated with `sourceFiles` reflecting each pack's actual governance scope.

**Alternatives considered:** YAML frontmatter (rejected). `.feature-pack.yaml` (rejected — mixing JSON with YAML in the same tree when everything else is JSON). No metadata file (rejected — `parentSlug` would need to come from somewhere).

**Reference:** `apps/mcp-server/src/lib/feature-pack.ts::readPackFromDisk` + `metaJsonSchema`; `docs/feature-packs/01-foundation/meta.json`; `docs/feature-packs/02-mcp-server/meta.json`; user ruling Q2 S7c 2026-04-24.

## 2026-04-24 12:15 — S7c: Feature-pack inheritance is root-first chain + cycle detection, no in-file merge

**Decision:** `feature-pack.get({ projectSlug })` returns `{ metadata, content, inherited }` where `inherited` is a root-first array of ancestor packs (not including self). The markdown content is NOT merged — consumers (S9 `get_feature_pack` handler) render ancestors then leaf in order. Cycle detection uses a visited-set keyed on slug; reentry throws `InternalError('feature_pack_cycle: ...chain...')`.

**Rationale:** User ruling 2026-04-24: "approve agent's default. No in-file merge; inherited list root-first". §16 pattern 9's "scalar override + array concatenation" is forward-looking to Module 05's NL-Assembly-produced structured sections — no structured data to merge in Module 02. Load-bearing safety (cycle detection) is enforced by the cheapest possible mechanism (visited-set, O(n) space in chain depth); the error message includes the full chain so the operator can correct the offending `parentSlug`.

**Alternatives considered:** Actual field-level merge of structured frontmatter (rejected — no structured fields exist yet). Silent cycle-truncation after N hops (rejected — hides malformed configuration). Walk children root-first during inheritance (rejected — `parentSlug` traversal is the only edge; walking children would require reverse-indexing).

**Reference:** `apps/mcp-server/src/lib/feature-pack.ts::walkAncestors`; `apps/mcp-server/__tests__/unit/lib/feature-pack-cycle.test.ts`; `apps/mcp-server/__tests__/integration/lib/feature-pack.test.ts` (inheritance block); user ruling Q3 S7c 2026-04-24.

## 2026-04-24 12:15 — S7c: Context-pack write is DB-first, FS reconcilable

**Decision:** `contextPackStore.write(pack, embedding)` (a) validates the pack shape, (b) checks idempotency on runId, (c) inserts the `context_packs` row, (d) for non-null embeddings inserts into `context_packs_vec` (sqlite) or sets `summary_embedding` (postgres), (e) writes the on-disk markdown file `docs/context-packs/YYYY-MM-DD-<runId-first-8>.md` AFTER the DB insert completes. FS write failure logs WARN and returns success — the DB row is durable, the FS view is reconcilable from the DB via a future cleanup pass.

**Rationale:** User ruling 2026-04-24: "Approve (b) DB-first, FS reconcilable. Filename YYYY-MM-DD-<runId-first-8>.md is fine." The DB is transactional and carries the authoritative `content_excerpt`; the FS file is a materialised view for human inspection and future third-party tools. A process crash between the DB insert and the FS write leaves a recoverable state (re-run to materialise). The alternative (FS-first + DB rollback on FS success) would require touching the filesystem before the transactional boundary and leak cleanup concerns into the happy path.

**Alternatives considered:** FS-first with DB-failure rollback of the file (rejected — writes go through filesystem mid-transaction, poor error shape). DB-only, no FS (rejected — human-readable archive is a user-visible benefit today and a Module-07 VS Code integration dependency). Filename `YYYY-MM-DD-<slug>.md` (rejected — same-day collisions on same slug).

**Reference:** `apps/mcp-server/src/lib/context-pack.ts` (write flow in docblock); `apps/mcp-server/__tests__/integration/lib/context-pack.test.ts`; user ruling Q4 S7c 2026-04-24.

## 2026-04-24 12:15 — S7c: Run-recorder is run_events-only; runs creation is §S8's job

**Decision:** `apps/mcp-server/src/lib/run-recorder.ts` writes only `run_events` rows. The `runs` row is created by the `get_run_id` MCP tool (§S8) which has the full project / agentType / mode context. The frozen `RunRecorder.record()` signature — `{ runId: string | null, toolName, phase, sessionId, idempotencyKey, input, output?, decision?, reason? }` — is self-consistent with the run_events-only scope: none of the NOT NULL columns on `runs` (`project_id`, `agent_type`, `mode`) are in the signature, so the recorder has no way to populate a `runs` row.

**Doc reconciliation:** `docs/feature-packs/02-mcp-server/implementation.md §S7c` previously read "writes `runs` and `run_events`"; updated to "writes `run_events`" in the same commit. `spec.md §68` and `techstack.md §85` already reflected the run_events-only scope — the drift was localized to the implementation plan. No "deviation from spec" framing — this is a docs consistency fix.

**Rationale:** User ruling 2026-04-24: "Approve. RunRecorder is run_events-only in S7c." The scope carve-out makes the frozen interface truthful and aligns three docs (spec, techstack, implementation). Attempting runs-row creation from the recorder would require an interface change (frozen-vetoed) or synthetic defaults (FK-violation risk + audit pollution).

**Alternatives considered:** Extend RunRecorder.record() with the full runs context (rejected — frozen interface). Split RunRecorder into two methods (rejected — doubles the call-site surface for no win; §S8 already owns the creation path). Keep the "writes `runs` and `run_events`" phrasing and bolt on the rest later (rejected — docs drift is the enemy).

**Reference:** `apps/mcp-server/src/lib/run-recorder.ts`; `apps/mcp-server/__tests__/integration/lib/run-recorder.test.ts`; `docs/feature-packs/02-mcp-server/{spec.md, implementation.md, techstack.md}` (reconciled in-commit); user ruling Q6 S7c 2026-04-24.

## 2026-04-24 12:15 — S7c: Outbox worker deferred post-Module-03 per spec authority

**Decision:** Module 02's `RunRecorder.record()` uses `setImmediate(...)` + `INSERT ... ON CONFLICT DO NOTHING`. The durable outbox via `pending_jobs` (§16 pattern 3) is deferred past Module 03 per `docs/feature-packs/02-mcp-server/spec.md §68` + `techstack.md §85`. Same logic as S7b's `recordPolicyDecision` write path.

**Doc reconciliation:** `docs/feature-packs/02-mcp-server/implementation.md §S7c` previously read "in-process worker polled on 500ms interval" — stale text describing the original §16 pattern 3 outbox before the spec was tightened. `spec.md §68` and `techstack.md §85` are the authority for "what complete means for S7c"; the implementation.md line 277 now mirrors them. No "deviation from spec" framing in the commit body.

**Rationale:** User ruling 2026-04-24: "NOT a deviation. Approve (c) as the spec's actual position." Module 02 scale (1-10 devs, hundreds of events/day) does not justify the outbox worker's additional infrastructure (poller thread, pending_jobs lifecycle, drain-order invariants); the setImmediate path offers identical observability (every failure logs WARN) at zero added machinery. Revisit when Module 03 Hooks Bridge introduces genuinely durable event sourcing.

**Alternatives considered:** Ship a minimal in-process worker today (rejected — spec authority says defer). Ship no async at all and insert synchronously in the record() promise (rejected — blows the tool-call latency budget). Use a third-party job queue (rejected — BullMQ is a Module 03 decision).

**Reference:** `apps/mcp-server/src/lib/run-recorder.ts`; `docs/feature-packs/02-mcp-server/spec.md` §68; `docs/feature-packs/02-mcp-server/techstack.md` §85; `docs/feature-packs/02-mcp-server/implementation.md` §S7c (reconciled); user ruling Q7 S7c 2026-04-24.

## 2026-04-24 12:15 — S7c: sqlite-vec.ts implements dual-path (sqlite-vec + pgvector)

**Decision:** `apps/mcp-server/src/lib/sqlite-vec.ts` keeps its S7a filename but dispatches on `DbHandle.kind`. sqlite path: brute-force KNN over `context_packs_vec` using `vec_distance_cosine(embedding, ?)` ordered ASC. postgres path: drizzle `select` + `sql<number>\`${cp.summaryEmbedding} <=> ${literal}::vector(384)\`` for cosine distance, backed by the HNSW index installed in migration 0001. Both paths accept `filter.projectSlug` and resolve to `projectId` via `projects` lookup; unknown slug → empty array.

**Rationale:** User ruling 2026-04-24: "Approve (b) dual-path. Cosine distance `<=>` against vector(384). Keep filename sqlite-vec.ts (S7a contract) with top-of-file docstring noting it implements both paths via dialect dispatch." Renaming the file would break the S7a "file tree frozen" contract; the module docstring is the honest disclosure. The pgvector path is ~10 LOC of drizzle + sql-template and adds no deps — deferring to Module 05 would leave a latent dialect gap in the `searchSimilarPacks` domain method.

**Alternatives considered:** sqlite-only with postgres-throws (rejected per user). Rename to `semantic-search.ts` (rejected — file-tree contract). Split into two files (rejected — doubles the surface for a 10-LOC branch).

**Reference:** `apps/mcp-server/src/lib/sqlite-vec.ts`; `apps/mcp-server/__tests__/integration/lib/sqlite-vec.test.ts` (sqlite path covered; postgres path exercised when testcontainers postgres integration lands); user ruling Q8 S7c 2026-04-24.

## 2026-04-24 12:15 — S7c: GraphifyClient.getIndexStatus(slug) added (additive interface edit)

**Decision:** `apps/mcp-server/src/framework/tool-context.ts::GraphifyClient` grows a second method: `getIndexStatus(slug): Promise<{ present: boolean; howToFix?: string }>`. The S15 handler calls this first; a `present: false` response carries the `howToFix` string that the tool handler surfaces verbatim in the `{ ok: true, nodes: [], edges: [], notice: 'graphify_index_missing', howToFix }` response.

**Rationale:** User ruling 2026-04-24: "Approve additive getIndexStatus(slug) method. Frozen-interface rule prevents breaking changes; this is the reserved future-domain-method slot from the S7a docblock." The S7a-landed docblock on `GraphifyClient` explicitly says "New domain methods (e.g. `findSymbolNeighbours`, `communitiesContaining`) slot in here in later modules" — `getIndexStatus` fits that reservation. The alternative (silent empty expandContext + module-level sibling helper) would split the status signal from the domain client, degrading discoverability.

**Alternatives considered:** (b) module-level `graphifyIndexExists` helper (rejected — off-interface, harder for handlers to find). (c) defer to S15 (rejected — would force S15 to synthesise the `howToFix` string instead of reading it from the single source of truth in `lib/graphify.ts`).

**Reference:** `apps/mcp-server/src/framework/tool-context.ts::GraphifyClient`; `apps/mcp-server/src/lib/graphify.ts`; `apps/mcp-server/__tests__/integration/lib/graphify.test.ts` (getIndexStatus block); `docs/feature-packs/02-mcp-server/implementation.md §S15` (amended to name getIndexStatus); user ruling Q9 S7c 2026-04-24.

## 2026-04-24 12:30 — S7c follow-up: consolidate embedding write path onto `SqliteVecClient.insertEmbedding(packId, vec)` when next module touches vector storage

**Decision (scheduled, not landed):** The next module that touches vector storage (Module 05 NL Assembly is the natural candidate) will add `insertEmbedding(contextPackId: string, embedding: Float32Array): Promise<void>` to the `SqliteVecClient` interface as an additive edit (same precedent as S7c's `GraphifyClient.getIndexStatus`). `apps/mcp-server/src/lib/context-pack.ts::insertRowAndEmbedding` then delegates its dialect-specific vec0 / pgvector insert to `ctx.sqliteVec.insertEmbedding` instead of dispatching inline on `db.kind`. No call-site churn — `context-pack.ts` is the single caller today.

**Rationale (recording the trade-off):** S7c kept `SqliteVecClient` read-only because a second additive interface edit in the same slice (after `getIndexStatus`) would have been scope creep against the "frozen interfaces, body swaps only" rule. The cost is that dialect-specific raw vector SQL now exists in two places: `sqlite-vec.ts::searchSimilarPacks` (reads) and `context-pack.ts::insertRowAndEmbedding` (writes). A reviewer of the next module touching semantic search has to grep both files to find "how does this codebase store/retrieve embeddings". Consolidating onto the domain client restores the single-source-of-truth pattern that's already applied to every other lib module.

**Alternatives considered:** Bolt `insertEmbedding` onto `SqliteVecClient` now as part of S7c (rejected — second additive edit in one slice; Q9 already exhausted that budget). Move vec0 insert into `sqlite-vec.ts` via a private export + `context-pack.ts` imports it (rejected — breaks the interface encapsulation without actually centralising the domain method; worst-of-both).

**Reference:** `apps/mcp-server/src/lib/context-pack.ts::insertRowAndEmbedding` (the current home of the write path); `apps/mcp-server/src/lib/sqlite-vec.ts` (the future home); `apps/mcp-server/src/framework/tool-context.ts::SqliteVecClient` (the interface to grow); user S7c follow-up ruling 2026-04-24.

## 2026-04-24 12:15 — S7c: Migration 0002 widens run_events.run_id nullable + ON DELETE SET NULL

**Decision:** `packages/db/drizzle/{sqlite,postgres}/0002_*.sql` widens `run_events.run_id` from `text NOT NULL references runs(id)` to `text references runs(id) ON DELETE SET NULL`. Both schema files (`packages/db/src/schema/{sqlite,postgres}.ts`) move together; the schema-parity test remains green because both dialects match. No preserve-blocks changed; `migrations.lock.json` is unchanged. Migration is data-preserving (widening NOT NULL → NULL; no row loses its current `run_id`).

**Rationale:** User ruling Q-bonus 2026-04-24 rejected skip-and-WARN (ships a shallow proxy — "interface accepts X, implementation silently drops X"), rejected lazy-placeholder-runs (pollutes append-only audit per ADR-007), approved the schema widening. The frozen `RunRecorder.record({ runId: string | null })` interface is the contract; the schema was documentation drift — the S7a docblock had already cited `ON DELETE SET NULL` aspirationally. `system-architecture.md §4.3` explicitly calls out "PreToolUse can fire before a run exists" — the nullable shape honours that rationale.

Same-commit asks all satisfied: schema files edited; migration regenerated via `drizzle-kit generate`; schema-parity test passes; decisions-log entry (this one); S7a docblock in `tool-context.ts` cites the real clause; integration test in `run-recorder.test.ts` covers both the null-runId insert and the ON DELETE SET NULL cascade (deletes parent, asserts child `run_id` becomes NULL).

**Alternatives considered:** (a) skip-and-WARN on null runId (rejected — shallow proxy per §1.1); (c) synthetic placeholder `runs` row (rejected — breaks append-only per ADR-007); (d) tighten the interface to `runId: string` (rejected — frozen-interface edit + architectural rationale leans toward null being a real path).

**Reference:** `packages/db/drizzle/sqlite/0002_complete_daredevil.sql`; `packages/db/drizzle/postgres/0002_fixed_adam_warlock.sql`; `packages/db/src/schema/sqlite.ts::runEvents` + `packages/db/src/schema/postgres.ts::runEvents`; `apps/mcp-server/src/framework/tool-context.ts::RunRecorder` docblock; `apps/mcp-server/__tests__/integration/lib/run-recorder.test.ts` (null + cascade blocks); `system-architecture.md §4.3`; user ruling Q-bonus S7c 2026-04-24.

## 2026-04-23 21:07 — Clock-discipline guard extended to ban `Date.now(` and `Date.parse(`

**Decision:** `apps/mcp-server/__tests__/unit/tools/_no-raw-date.test.ts` now fails CI on three banned wall-clock reads in any file under `src/tools/**`: `new Date(`, `Date.now(`, and `Date.parse(`. `Date.UTC(` remains legal (pure computation, no clock read).

**Rationale:** User S7a review noted that `Date.now()` is the more common sneak-in than `new Date()` — a one-line timestamp read that the original regex missed entirely. `Date.parse(` is included as belt-and-braces; even though it is always called with an argument today, a future zero-arg `Date.parse()` call returns a clock-dependent `NaN` or an engine-specific current time, which would silently corrupt determinism. `Date.UTC(` stays allowed because it performs pure arithmetic on its arguments with no clock dependency. A self-sanity test inside the same file locks each regex against its intended sample (and confirms `Date.UTC(` is not a false positive), so a careless refactor that loosens one of the regexes fails on that line, not silently in production.

**Alternatives considered:** Leave the guard catching only `new Date(` (rejected — `Date.now()` is unambiguously a wall-clock read and the more frequent pattern in real codebases). Add an eslint-plugin-ban-date rule instead (rejected — would require biome/eslint plugin overhead for a single-file grep that is less than 30 LOC). Switch to an AST-based matcher (rejected — adds a TypeScript parser dep to the unit-test path for negligible precision gain; the lexical regex already catches every real case and the sanity test locks the intent).

**Reference:** `apps/mcp-server/__tests__/unit/tools/_no-raw-date.test.ts`; `apps/mcp-server/src/framework/tool-registry.ts::handleCall` (the only legitimate clock read in `src/**`); user S7a review question 1 (2026-04-23).

## 2026-04-24 14:00 — Distribution scope: CLI only, no marketing site, no Module 08b

**Decision:** A new Module 08a (`@coodra/contextos-cli`) is inserted between Module 03 and Module 04 in the implementation order. There is no Module 08b. Marketing site, landing page, npm-publish flag-day automation, and Anthropic MCP marketplace submission are user-side operational tasks tracked in `pending-user-actions.md`, not feature-pack work in this repo.
**Rationale:** User directive 2026-04-24 — "we are not making the landing page here, only the system, if landing page and marketing is in the scope, remove it." The CLI is the necessary install surface for Modules 04 and 07 to function as designed (Module 04's onboarding flow refers to `contextos init`; Module 07's VS Code extension shells out to `contextos start`/`stop`/`status` for daemon lifecycle). The marketing surface is not part of the system being built.
**Alternatives considered:** Keep Module 08b for marketing site (rejected — explicit user removal). Defer 08a to the end of the sequence (rejected — Module 04 and Module 07 specs would either invent a CLI surface or hand-wave the install path).
**Reference:** `docs/feature-packs/08a-cli/{spec,implementation,techstack,meta}.md`; `essentialsforclaude/08-implementation-order.md` §8.1 amendment.

## 2026-04-24 14:00 — Team mode is hosted by us; no BYO-cloud variant in v1

**Decision:** Team mode runs on a single managed stack owned by the project lead (Supabase Postgres + pgvector, Upstash Redis, Railway or Fly.io for stateless services, Clerk for auth). Multi-tenant isolation via `org_id` on every team-scoped table + Supabase Row-Level Security policies — closes the §21 "Security: RLS and local secret permissions" open decision. There is no documented path for a customer to bring their own Postgres / Redis / deploy target in v1; that is a post-launch Enterprise variant.
**Rationale:** User directive 2026-04-24 — "make the team service hosted by us." This simplifies Module 04's web-app onboarding (no "paste your Postgres URL" path) and lets Modules 05/06's managed-LLM path use a single set of API keys. Trade-off: we operate the stack (uptime, backups, secret rotation) — acknowledged operational burden, accepted because the architecture's local-first SQLite (ADR-008) keeps each developer's primary data on their machine even in team mode, so the hosted layer is a sync/audit target, not a customer-data store.
**Alternatives considered:** BYO-cloud as the only path (rejected — every team would need its own Supabase + Upstash + deploy account, killing the "easy setup" goal). Both paths supported in v1 (rejected — doubles M04's onboarding surface for a Day-1 use case nobody has).
**Reference:** `system-architecture.md` §21 close-out; `essentialsforclaude/08-implementation-order.md` §8.1 "scope items deliberately out".

## 2026-04-24 14:00 — Pricing / billing entirely out of scope for the project

**Decision:** No pricing tier definitions, no Stripe integration, no `subscriptions` / `usage_quotas` / `usage_events` tables, no metering pipeline, no per-seat license keys appear in any module spec. Module 04 (Web App) is dashboard / admin / team-management only. If/when monetization becomes relevant, it lands as a separate workstream after the working product is shipped.
**Rationale:** User directive 2026-04-24 — "forget about monetary setup, only focus on building the working product." Solo mode is free with no restrictions. Team mode (when it opens) is also free at the architectural level; commercial licensing is a future business decision that does not constrain the technical surface today.
**Alternatives considered:** Ship Stripe in M04 from day one (rejected — not in scope). Reserve table slots / surfaces for billing without implementation (rejected — violates §1.1 "no shallow proxies"; reserved-but-empty surfaces are a stub pattern).
**Reference:** `essentialsforclaude/08-implementation-order.md` §8.1 "scope items deliberately out".

## 2026-04-24 14:00 — Solo mode has no feature restrictions

**Decision:** Solo mode (the local-only configuration shipped from Module 01 onward) has full feature parity for everything that is technically possible without a hosted backend. No features are gated behind team-mode or a future paid tier as a marketing funnel.
**Rationale:** User directive 2026-04-24 — "no restrictions" on solo. The technical features that solo cannot offer (cross-developer audit, GitHub App integration that needs a stable webhook URL, managed Gemini access without a per-developer key) are absent because of architectural constraints, not because of a paywall.
**Alternatives considered:** Gate the web app's policy-rule editor behind team mode (rejected — the local web app at `localhost:3000` is part of solo and editing policies is part of using ContextOS). Gate Graphify / Feature Pack inheritance behind team (rejected — these are core features).
**Reference:** This decisions-log entry; `docs/feature-packs/08a-cli/spec.md` §2 (no flag-gating in `init`).

## 2026-04-24 14:00 — Managed LLM in team mode is Gemini, not Anthropic

**Decision:** Module 05's NL Assembly tier-2 (managed-LLM-with-our-key path) calls Gemini, not Anthropic Claude. Solo mode continues to support Ollama as the local-LLM default. The provider-selection logic in `system-architecture.md` §18 simplifies: Ollama (solo) → Gemini (team-managed) → none (skip enrichment, AST-only mode). The `ANTHROPIC_API_KEY` branch is removed from the §18 selection logic; it can stay in the env schema as an "advanced override" but is not the documented path.
**Rationale:** User directive 2026-04-24 — "we will be using gemini instead." Free tier is generous; cost per token is lower than Anthropic's Haiku at the volume Module 05 expects. Single managed-key path keeps the team-mode infra simpler.
**Alternatives considered:** Keep Anthropic as primary (rejected — explicit user reversal). Support both with runtime selection (rejected — two key types double the secret-management surface for marginal benefit).
**Reference:** `system-architecture.md` §18 amendment (pending in next architecture-touching commit); `pending-user-actions.md` 2026-04-24 — `GEMINI_API_KEY` entry.

## 2026-04-24 14:00 — Clerk OAuth providers: Google + GitHub + Microsoft + email/password

**Decision:** Clerk projects (dev and prod) enable Google OAuth, GitHub OAuth, Microsoft OAuth, and email/password as authentication providers. SAML SSO and other enterprise providers are deferred until an Enterprise variant exists.
**Rationale:** User directive 2026-04-24 — "yes" to Google + GitHub + Microsoft + email/password. Google + GitHub cover the developer-tool standard; Microsoft covers enterprise procurement comfort; email/password is the universal fallback when OAuth round-trips fail or when a user has no preferred provider.
**Alternatives considered:** Google + GitHub only (rejected — Microsoft is table-stakes for enterprise sales conversations even pre-Enterprise-variant). Add Apple Sign-In (rejected — developer-tool users almost never need it; can add later non-breakingly).
**Reference:** `pending-user-actions.md` 2026-04-24 — "Provision team-mode hosted infra" entry, step 4.

## 2026-04-24 14:30 — S8: `get_run_id` solo auto-creates projects row; team returns structured `project_not_found` soft-failure

**Decision:** `apps/mcp-server/src/tools/get-run-id/handler.ts` resolves an unknown `projectSlug` asymmetrically by `CONTEXTOS_MODE`:

- Solo: insert a new `projects` row with `{ id: uuid, slug, orgId: SOLO_IDENTITY.orgId, name: slug }` and proceed to the runs-row creation step.
- Team: return the `{ ok: false, error: 'project_not_found', howToFix: 'Register this project via the Web App or run \`contextos init\` in the project root before retrying.' }` output-schema branch. No `projects` row is inserted.

The output schema is a Zod `discriminatedUnion('ok', [successBranch, softFailureBranch])` — a failed lookup is a user-recoverable state, not a programming bug, so modeling it as data keeps the agent-reading contract clean.

**Rationale:** User ruling 2026-04-24 Q1. Throwing `NotFoundError` would have Claude Code surface "tool failed" with no context — a dead-end for the user. The structured soft-failure lets the agent read `howToFix` and surface it, pointing at the Web App (Module 04) or the CLI (Module 08a) — both future entry points that team-mode operators will know about. Solo-mode auto-create matches the zero-config promise: a developer running ContextOS locally should never have to "register a project" before the first tool call works.

Asymmetric-by-design is the precedent captured here. Solo-mode tools trade strictness for ergonomics; team-mode tools trade ergonomics for governance. Future tools should follow the same axis.

**Alternatives considered:** Pure (a) auto-create in both modes (rejected — would hide configuration errors in team deployments). Pure (c) throw `NotFoundError` in both modes (rejected — surfaces as generic tool-failure). Ship a single soft-failure branch that always returns `project_not_found` and force solo users to run `contextos init` too (rejected — Module 08a CLI hasn't shipped; forcing it pre-release breaks the demo path).

**Follow-up (if the WARN volume grows):** Module 04 Web App and Module 08a CLI will both teach users to call their project-registration flow before the first tool call; at that point the team-mode soft-failure should be rare. If solo-mode auto-creates are being triggered by typos rather than fresh projects, add a Levenshtein-distance nag that suggests existing slugs — no plan for this yet, tracking as a "watch the logs" item.

**Reference:** `apps/mcp-server/src/tools/get-run-id/handler.ts::createGetRunIdHandler`; `apps/mcp-server/src/tools/get-run-id/schema.ts::getRunIdOutputSchema`; `apps/mcp-server/__tests__/integration/tools/get-run-id.test.ts` (team-mode soft-failure block); user ruling Q1 S8 2026-04-24.

## 2026-04-24 14:30 — S8: Additive edit — `PerCallContext.agentType: string` on the frozen `ToolContext`

**Decision:** `apps/mcp-server/src/framework/tool-context.ts::PerCallContext` grows a new required field `agentType: string`. The `ToolRegistry.handleCall` signature changes from `(name, input, sessionId, requestId?)` to `(name, input, sessionId, options?: { requestId?, agentType? })` — the options object absorbs the prior `requestId` and adds `agentType`, defaulting to `'unknown'` when not supplied. The transport layer (today stdio; Module 03 hooks bridge for HTTP) is responsible for populating `agentType` from `server.getClientVersion()?.name` via `mapAgentType(...)`.

**Rationale:** User ruling 2026-04-24 Q2. `runs.agent_type` is NOT NULL and needed from the first tool that writes to `runs` (`get_run_id`, this slice). The three non-edit alternatives fail:

1. Hardcode `'unknown'` — bakes bad data into every row permanently, makes policy `match_agent_type` useless.
2. Optional input field on each tool — pushes self-identification onto callers that don't naturally do it.
3. Env var — doesn't scale to HTTP where many clients share one process.

Option 4 (additive edit) reads the value from where it actually lives in the MCP protocol: `initialize.clientInfo.name`. This uses the same "reserved future-transport-metadata slot" pattern set by S7c's `GraphifyClient.getIndexStatus` (under user Q9 2026-04-24 12:15). Both changes are strictly additive — no existing caller breaks, the new field just arrives populated.

**Alternatives considered:** See above + keep the handler signature 4-positional-arg (rejected — further positional parameters are readability-poor; the options object scales for the next few fields). Read `clientInfo` only at initialize and stash in the registry (rejected — couples the registry to the MCP protocol lifecycle; per-call lookup via `server.getClientVersion()` is free because the SDK caches).

**Reference:** `apps/mcp-server/src/framework/tool-context.ts::PerCallContext`; `apps/mcp-server/src/framework/tool-registry.ts::handleCall`; `apps/mcp-server/src/transports/stdio.ts` (capture site); `apps/mcp-server/__tests__/unit/lib/agent-type.test.ts`; user ruling Q2 S8 2026-04-24.

## 2026-04-24 14:30 — S8: agent-type mapping table in `src/lib/agent-type.ts` (single source of truth)

**Decision:** `apps/mcp-server/src/lib/agent-type.ts::AGENT_TYPE_MAPPING` is the one place `clientInfo.name` strings are translated to canonical `runs.agent_type` values. Current entries (case-insensitive keys):

```
claude-code, claude-ai              → claude_code
cursor, cursor-vscode               → cursor
windsurf                            → windsurf
github-copilot-chat-vscode          → vscode_copilot
mcp-inspector                       → mcp_inspector
<anything else / missing / empty>   → unknown
```

The table is frozen with `Object.freeze` so runtime mutation can't alter the mapping; a unit test asserts this.

**Rationale:** Module 02's stdio transport is the first consumer; Module 03's HTTP transport will be the second. Centralising the translation here means "how do we know what agent this is?" has exactly one answer across the repo. Adding a new client (when Anthropic rebrands, when a fourth IDE ships MCP support) is one entry — the unit tests in `agent-type.test.ts` round-trip every entry so an accidental deletion is a CI failure. Lowercase-snake canonical form mirrors the GitHub/JIRA event `agent_type` enum in `system-architecture.md` §22/§23.

**Alternatives considered:** Inline the mapping in the stdio handler (rejected — code duplication when HTTP lands). Make every tool responsible for its own mapping (rejected — duplication across 8+ tools). Use the policy engine's `match_agent_type` wildcards as the storage form (rejected — conflates policy-rule glob semantics with the underlying enum).

**Reference:** `apps/mcp-server/src/lib/agent-type.ts`; `apps/mcp-server/__tests__/unit/lib/agent-type.test.ts`; user ruling Q2 S8 2026-04-24.

## 2026-04-24 14:30 — S8: `get_run_id` returns any existing run for (projectId, sessionId); WARN on non-in-progress status

**Decision:** When a `runs` row already exists for the `(projectId, sessionId)` pair, `get_run_id` returns its `runId` regardless of `status`. When the returned row's `status !== 'in_progress'`, the handler emits a WARN log: `{ event: 'get_run_id_returning_non_in_progress', runId, sessionId, status }`. No migration 0003 today; the WARN is the escalation trigger.

**Rationale:** User ruling 2026-04-24 Q3. The schema's `uniqueIndex('runs_project_session_idx').on(projectId, sessionId)` is the hard contract — one `runs` row per (project, session) — and the §24.4 wording "most recent in-progress" is aspirational against that. The typical case (session just created, status is `in_progress`) is satisfied; the edge case (session had `save_context_pack` called on it earlier, status is `completed`) is rare because IDEs typically mint fresh session IDs for fresh conversations. Forcing the caller to mint a new sessionId (option c) doesn't work — sessionId comes from the IDE, not the agent. Migration 0003 (option b) to relax the unique index to `(projectId, sessionId, status)` + partial index on `status = 'in_progress'` is possible but premature before the WARN volume says it's needed.

**Escalation criterion:** if the `get_run_id_returning_non_in_progress` WARN becomes a regular signal in ops logs (measured against the `get_run_id_created` INFO at, say, 5% frequency or higher), schedule migration 0003 in a future slice. Log grep is cheap; schema churn is not.

**Alternatives considered:** Migration 0003 now (rejected — scope creep, no data). Soft-failure `{ ok: false, error: 'session_already_completed' }` (rejected — caller can't act on it without minting a new sessionId, which it can't). Soft-update the row's status back to `in_progress` (rejected — violates the append-only spirit even though `runs` is technically mutable).

**Reference:** `apps/mcp-server/src/tools/get-run-id/handler.ts` (WARN site); `apps/mcp-server/__tests__/integration/tools/get-run-id.test.ts` (non-in-progress assertion); `packages/db/src/schema/sqlite.ts::runs` (unique index); user ruling Q3 S8 2026-04-24.

## 2026-04-24 14:30 — S8: `tools/index.ts` ALL_TOOLS barrel + `_no-unregistered-tools.test.ts` guard convention

**Decision:** `apps/mcp-server/src/tools/index.ts` exports `registerAllTools(registry, { db, mode })` — the single place tool registrations are called. `src/index.ts` now has a one-line wire-up: `registerAllTools(registry, { db: dbHandle, mode: env.CONTEXTOS_MODE })`. Tools whose handlers need process-level config (DB handle, mode) expose factory exports (`createGetRunIdToolRegistration(deps)`); tools whose handlers are pure (like `ping`) expose a static constant (`pingToolRegistration`). The barrel calls both shapes uniformly.

The guard test `apps/mcp-server/__tests__/unit/tools/_no-unregistered-tools.test.ts` walks `src/tools/` directory entries, converts each folder name to its canonical tool name via `hyphen-to-underscore` (e.g. `get-run-id` → `get_run_id`), and asserts that name appears in the registry after `registerAllTools` runs. Self-sanity tests lock the folder-to-name translation against a sample fixture so a future refactor that loosens the glob fails on that line, not silently in production.

**Rationale:** The "tools/list returns empty" failure mode is already documented in `essentialsforclaude/10-troubleshooting.md`. The guard test turns that runtime surprise into a CI error. The barrel also keeps `src/index.ts` small across S9–S15 (6 more tools land without touching the entrypoint). The factory-vs-static split mirrors the S7b/S7c pattern for lib modules — pure code exports a constant, env-dependent code exports a factory.

**Alternatives considered:** Keep direct imports in `src/index.ts` and add tools one-by-one (rejected — six edits over S9–S15 vs one). A registration decorator / auto-discovery via `glob import` (rejected — too magic; silent breakage if a tool folder is added without a corresponding export). Put `ALL_TOOLS` as a const array rather than `registerAllTools` function (rejected — tools that need DB/mode deps can't be in a static const).

**Reference:** `apps/mcp-server/src/tools/index.ts`; `apps/mcp-server/__tests__/unit/tools/_no-unregistered-tools.test.ts`; `apps/mcp-server/src/index.ts` (wire-up); `essentialsforclaude/10-troubleshooting.md` (failure-mode source); user ruling Q8 S8 2026-04-24.

## 2026-04-24 15:00 — S9: `get_feature_pack` returns pack = deepest-match; `subPack` reserved for Module 07+ folder-nested sub-packs

**Decision:** `apps/mcp-server/src/tools/get-feature-pack/handler.ts` reads §24.4's *"Returns the Feature Pack for the module that owns the given path"* as owner-centric and singular. Concretely:

- `pack` = the deepest pack in the inheritance chain whose `sourceFiles` globs match `filePath` (walked leaf-first via `picomatch`), OR the slug's own pack when `filePath` is absent / no glob matches.
- `inherited` = ancestors of `pack`, root-first, NOT including `pack` itself.
- `subPack` = always `null` in Module 02. Reserved for Module 07+ folder-nested sub-feature-packs (e.g., `docs/feature-packs/02-mcp-server/sub/transport/` inside the same pack directory) — a DIFFERENT scoping axis from inheritance.

§24.4 is amended same-commit to make these semantics explicit in the return-shape line.

**Rationale:** User ruling 2026-04-24 Q1 S9. Three readings were on the table; (a) "deepest-match primary" won because it matches §24.4's owner-centric wording, matches the S9 spec's "resolves the deepest pack whose `sourceFiles` matches (inheritance-aware)", and makes `pack` self-contained so the agent sees its governing conventions without joining `inherited` first.

`subPack`'s reservation is explicit to prevent the next tool author from mis-reading it as "the deeper match in the inheritance chain" — folder-nested sub-packs and ancestral inheritance are separate axes. Module 07's sub-pack surface will populate `subPack` with a pack nested inside the same slug directory; Module 02 always emits `null`.

**Alternatives considered:** (b) `pack` = slug's own pack + `subPack` = deepest match in chain (rejected — muddles `subPack`'s future semantics). (c) `pack` + `subPack` both refer to nested sub-packs within the same slug (rejected — no such thing in Module 02; would make `pack` always the slug's pack even when filePath matches an ancestor).

**Reference:** `apps/mcp-server/src/tools/get-feature-pack/handler.ts::findDeepestMatchIndex`; `apps/mcp-server/src/tools/get-feature-pack/schema.ts::successBranch`; `system-architecture.md §24.4 get_feature_pack` (amended same-commit); `apps/mcp-server/__tests__/integration/tools/get-feature-pack.test.ts` (5 filePath-match cases); user ruling Q1 S9 2026-04-24.

## 2026-04-24 15:00 — S9: Canonical soft-failure shape is `{ ok: false, error, howToFix }` for every tool in the server

**Decision:** Every tool's output schema that includes a soft-failure branch MUST have both `error: z.literal('<stable-code>')` and `howToFix: z.string().min(1)`. Tool-specific fields (`chain` for a cycle, `notice` for a fallback-with-advisory, etc.) are additive on top. The two-field floor is non-negotiable — agents must always have a stable error code they can branch on AND a user-surfaceable remediation string.

`essentialsforclaude/09-common-patterns.md §9.1.2` is tightened same-commit to state this as a rule. `system-architecture.md §24.4 get_feature_pack` failure-mode line is amended to include `howToFix` for `pack_not_found` and a new `feature_pack_cycle` branch with `chain` + `howToFix`.

**Rationale:** User ruling 2026-04-24 Q2 S9. Cross-tool consistency beats §24.4-verbatim on this axis — §24.4's "do NOT block, proceed with default conventions" becomes the `howToFix` value for `pack_not_found`, so the extension is additive-over-verbatim rather than a replacement. S11 (`search_packs_nl`) and S15 (`query_codebase_graph`) both inherit this shape when they add their respective fallback branches (`no_embeddings_yet`, `graphify_index_missing`). Documenting it as a rule at the §9.1.2 layer rather than a §24.4-local convention means the next tool author sees it immediately.

**Alternatives considered:** Keep §24.4-verbatim and treat S8's `howToFix` as tool-local (rejected — sets up drift). Drop `howToFix` entirely and rely on `error` code + external documentation (rejected — forces the agent to look up every error code rather than surfacing the remediation inline; defeats the whole point of the soft-failure pattern).

**Reference:** `essentialsforclaude/09-common-patterns.md §9.1.2` (canonical-shape paragraph); `system-architecture.md §24.4 get_feature_pack` (failure-mode amendment); `apps/mcp-server/src/tools/get-feature-pack/schema.ts::packNotFoundBranch + cycleBranch`; user ruling Q2 S9 2026-04-24.

## 2026-04-24 15:00 — S9: `filePath` with no `sourceFiles` match silently falls back to the slug's pack + logs DEBUG

**Decision:** When `get_feature_pack` is called with a `filePath` that does NOT match any `sourceFiles` glob in the inheritance chain (leaf + all ancestors), the handler silently returns the slug's own pack and its ancestor chain — no `notice`/`warning` field in the success branch. A DEBUG-level log fires `{ event: 'feature_pack_filepath_no_match', projectSlug, filePath }` for operator observability. Default log level (`info`) does NOT emit this; operators set `LOG_LEVEL=debug` to see it.

**Rationale:** User ruling 2026-04-24 Q3 S9. A caller-supplied advisory `filePath` that doesn't resolve isn't a misbehavior — it's a hint that didn't apply to the chain. Surfacing a `notice` field would force every caller to branch on it even when the hint was wrong; silent fallback matches §24.4's "do NOT block, proceed with default conventions" spirit. WARN level would add noise for a non-error; DEBUG lets operators who want observability opt in without polluting the default log stream.

**Future escalation:** if the DEBUG-log volume crosses a threshold in production (say, >5% of `get_feature_pack` calls have filePath-no-match), consider adding an optional `warning: 'no_sourceFiles_match_for_filePath'` success-branch field in a future slice — additive schema edit, no breaking change.

**Alternatives considered:** (b) add `notice` field with `howToFix` to the success branch (rejected — every caller has to branch on it). (c) return `{ ok: false, error: 'path_not_governed' }` soft-failure (rejected — it's an advisory, not a failure).

**Reference:** `apps/mcp-server/src/tools/get-feature-pack/handler.ts` (silent-fallback branch); `apps/mcp-server/__tests__/integration/tools/get-feature-pack.test.ts` ("filePath with no match" case asserting no notice field); user ruling Q3 S9 2026-04-24.

## 2026-04-24 15:00 — S9: `inherited[]` is root-first (ancestors, not including pack) — locked by both unit and integration test

**Decision:** `get_feature_pack`'s `inherited` array returns ancestors of `pack` in root-first order. For a 3-deep chain `root ← middle ← leaf` with `pack = leaf`, the response is `{ pack: leaf, inherited: [root, middle] }`. `inherited[0]` is always the root; `inherited[inherited.length - 1]` is the parent of `pack`. `pack` itself is NOT in `inherited`.

**Rationale:** User ruling 2026-04-24 Q4 S9. Reading order for an agent consuming the response is least-specific → most-specific: render `inherited[0]` (root), then `inherited[1]`, …, then `pack`. Matches the S7c `FeaturePackStore.walkAncestors` internal ordering so there's no transposition between store and handler. Two lock sites — unit test on `evaluateRules` (wait, that's policy; for S9 it's the schema test) AND integration test on a real 3-deep chain — because this is a contract future tools will consume and the ordering is easy to invert silently.

**Alternatives considered:** Leaf-first ordering (rejected — reading order would be most-specific → least-specific, unnatural for agent consumption). Pack itself included at the end of `inherited` (rejected — duplicates data; the response already has `pack` as a separate field).

**Reference:** `apps/mcp-server/src/tools/get-feature-pack/handler.ts` (chain construction); `apps/mcp-server/__tests__/integration/tools/get-feature-pack.test.ts` ("inherited[] ordering lock" block); `apps/mcp-server/src/lib/feature-pack.ts::walkAncestors` (store-side ordering source); user ruling Q4 S9 2026-04-24.

## 2026-04-24 15:00 — S9: `feature_pack_cycle` surfaces as a structured soft-failure with `chain` payload

**Decision:** When the S7c `FeaturePackStore.walkAncestors` detects a cycle and throws `InternalError('feature_pack_cycle: a → b → c → a')`, the `get_feature_pack` handler catches the throw, parses the `a → b → c → a` chain from the message, and returns:

```
{ ok: false, error: 'feature_pack_cycle', chain: ['a','b','c','a'], howToFix: 'Remove the parentSlug cycle in meta.json: a → b → c → a. Pick one parent and stop.' }
```

This is a third branch of the output schema, distinct from `pack_not_found`. Structured with `chain: string[]` so the caller doesn't have to re-parse the human-readable `howToFix` string to surface the cycle to the user.

**Rationale:** User ruling 2026-04-24 Q5 S9. Cycles are user-recoverable configuration bugs (someone wrote a cyclic `parentSlug` in `meta.json`) — the registry's generic `handler_threw` envelope treats them as programming bugs and loses the chain information. A structured soft-failure keeps the chain accessible to the agent and matches the §9.1.2 canonical soft-failure shape.

**Coupling note:** the handler parses the chain from the error message's human-readable body (`feature_pack_cycle: a → b → c → a`). This couples S9's error handling to the S7c error-message shape. Follow-up — if this coupling grows (more error codes, chain shapes), consider adding structured `details: { chain: [...] }` to `InternalError` at the store level so the handler inspects `err.details` instead of parsing. Not a blocker today; the message format is stable and owned by the same team.

**Alternatives considered:** (a) let it propagate to `handler_threw` (rejected — loses the chain). (c) drop the `chain` field and put it all in `howToFix` (rejected — the chain is structured data, agents and users consume it differently).

**Reference:** `apps/mcp-server/src/tools/get-feature-pack/handler.ts::parseCycleChain`; `apps/mcp-server/src/lib/feature-pack.ts::walkAncestors` (error source); `apps/mcp-server/__tests__/integration/tools/get-feature-pack.test.ts` (cycle soft-failure case); user ruling Q5 S9 2026-04-24.

## 2026-04-24 15:30 — S10: `save_context_pack` resolution pattern — pre-SELECT runs.projectId, soft-failure on missing; mark completed idempotently

**Decision:** `apps/mcp-server/src/tools/save-context-pack/handler.ts` factory closes over a `DbHandle`. Flow is (1) SELECT `runs.projectId` for the supplied `runId` → on miss return `{ ok: false, error: 'run_not_found', howToFix }`; (2) `ctx.contextPack.write({ runId, projectId, title, content, featurePackId? }, null)` — embedding is always `null` in Module 02, Module 05 backfills later; (3) `UPDATE runs SET status='completed', endedAt=unixepoch() WHERE id=runId AND status != 'completed'` — idempotent no-op on already-completed runs; (4) return `{ ok: true, contextPackId, savedAt, contentExcerpt }`.

`featurePackId` is accepted on the wire per §24.4 but is silently discarded by the current `context_packs` schema (no FK column). Retained for M05/M07 schema growth.

Append-only per ADR-007 — same `runId` + different content returns the ORIGINAL row (store's idempotency path). Integration test locks this against a `content = 'v2 DIFFERENT'` second call. FS-failure degradation (read-only `contextPacksRoot`) still returns `ok: true` with the durable DB row.

**Rationale:** S10 is the first write-side context-pack tool. Pre-SELECT vs. relying on FK violation is a direct follow-through on the S8/S9 soft-failure convention — `run_not_found` is a user-recoverable state, not a programming bug. Embedding null preserves the Module-02/Module-05 boundary; forcing an embedding parameter now would either require a stub or leak the NL Assembly dependency backwards. Marking the run completed inside this handler (rather than via a separate `complete_run` tool) matches §24.4's "side-effect" wording and reduces round-trips for the agent.

**Alternatives considered:** let the `context_packs.run_id` FK throw on missing runs and rely on `handler_threw` (rejected — opaque to the agent, violates §9.1.2). Accept `embedding?: number[]` in the tool input (rejected — no M02 caller has one; fake-null pass-through is dishonest). Split run completion into a separate tool (rejected — extra round-trip; §24.4 bakes the side-effect into this tool).

**Reference:** `apps/mcp-server/src/tools/save-context-pack/handler.ts`; `apps/mcp-server/src/tools/save-context-pack/schema.ts`; `apps/mcp-server/src/tools/save-context-pack/manifest.ts`; `apps/mcp-server/__tests__/integration/tools/save-context-pack.test.ts`; `system-architecture.md §24.4 save_context_pack` (amended same-commit); user autonomous-mode directive 2026-04-24 for S10.

## 2026-04-24 16:00 — S11: `search_packs_nl` input/output shape — optional caller-supplied embedding + LIKE fallback with advisory notice

**Decision:** `apps/mcp-server/src/tools/search-packs-nl/` ships with a factory-shaped handler closing over `DbHandle`. The §24.4 base input `{ projectSlug, query, limit? }` is extended with an optional `embedding?: number[]`:

- If `embedding` is supplied AND `length === 384` → semantic path via `ctx.sqliteVec.searchSimilarPacks`, IN-JOIN `context_packs` for metadata, preserve distance-ascending order, `score` = cosine distance.
- If `embedding` is supplied but length mismatches → `{ ok: false, error: 'embedding_dim_mismatch', expected, got, howToFix }` soft-failure. Handler-level check, not Zod — the generic `invalid_input` envelope is too opaque for agents.
- If `embedding` is NOT supplied → LIKE fallback over `LOWER(title) LIKE ? OR LOWER(content_excerpt) LIKE ?` scoped to the project, `ORDER BY created_at DESC LIMIT ?`. Response includes `notice: 'no_embeddings_yet'` + `howToFix` pointing at Module 05. `score: null` per row.

Empty results (valid input, zero hits) are `{ ok: true, packs: [] }` — NOT a soft-failure. Agents distinguish "no matches" from "no embedder available" via `notice` presence.

**Rationale:** Module 02 has no NL Assembly service — no server-side embedder exists. Two pragmatic options: (a) return opaque empty results forever until Module 05 (bad UX, hides the capability gap); (b) accept a caller-supplied embedding so motivated callers get semantic search today + advise the rest via the fallback notice. Option (b) also positions the tool correctly for Module 05, which becomes the default caller simply by computing and passing the embedding. No tool-contract change needed then.

Dim check at handler level (not Zod) because the S8/S9 soft-failure pattern makes structured error codes the user-facing contract; pushing the check into Zod would surface as `invalid_input` with a generic message, wasting the carefully-built agent-caller-branches-on-error-code convention.

**Alternatives considered:** Compute embedding server-side via Ollama (rejected — Module 05's scope, duplicates work). Reject non-embedding callers entirely with a soft-failure `no_embedder` (rejected — LIKE fallback is genuinely useful and matches the §S11 spec). Put the dim check in Zod (rejected — loses structured error code). Advisory-only path with no notice (rejected — agents can't distinguish "LIKE result came from semantic fallback" from "these ARE semantic results"; the notice is load-bearing).

**Reference:** `apps/mcp-server/src/tools/search-packs-nl/handler.ts`; `apps/mcp-server/src/tools/search-packs-nl/schema.ts`; `apps/mcp-server/src/tools/search-packs-nl/manifest.ts`; `apps/mcp-server/__tests__/integration/tools/search-packs-nl.test.ts` (10 cases covering all branches); `system-architecture.md §24.4 search_packs_nl` (amended same-commit); user autonomous-mode directive 2026-04-24 for S11.

## 2026-04-24 17:30 — S13: `record_decision` storage choice, idempotency boundary, `run_id` FK widening, and `created` return value

**Decision:** `record_decision` persists to a new first-class `decisions` table (shipped same-commit as migration **0003**, dual-dialect per §4), NOT via `ctx.runRecorder` with an event shape. Table columns: `id`, `idempotency_key` UNIQUE, `run_id` nullable + `ON DELETE SET NULL`, `description`, `rationale`, `alternatives` TEXT (JSON-encoded string[]; NULL = empty), `created_at`, with `decisions_run_created_idx (run_id, created_at)` for per-run enumeration.

Idempotency key is `dec:{runId}:{sha256(description).slice(0,32)}`. Handler flow: SELECT `runs.id` for `input.runId` → on miss `{ ok: false, error: 'run_not_found', howToFix }`; compute key; `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, created_at`; empty RETURNING → re-SELECT the existing row. Output now includes a `created: boolean` alongside `decisionId` + `createdAt` so agents detect silently-deduped retries without a DB re-read.

Dedupe boundary: `description` is the decision's identity; `rationale` + `alternatives` are metadata. Same runId + identical description → second call returns original `decisionId` with `created: false`, rationale is NOT overwritten. Same runId + different description → distinct rows (multi-decision-per-run is the expected case).

**Rationale:** RunRecorder is a tool-invocation trace (run_events), not a decision ledger — its lifecycle rules, shape, and `idempotencyKey` contract diverge from what decisions need. A dedicated table: (a) matches the §S13 spec verbatim ("inserts a row into a new `decisions` table"), (b) exposes the right UNIQUE index for retry-safe dedupe, (c) keeps decision semantics — including the `ON DELETE SET NULL` history-preservation rule that parallels the S7c run_events widening — first-class at the schema layer.

Description-as-identity (not description+rationale) is deliberate: the point of idempotency is retry-safety for the same semantic operation. A typo-fix retry that re-phrases the rationale should collapse to the original decision, not duplicate it. An agent that genuinely needs to refine a decision can record a new one with a different description — the earlier row remains.

`ON DELETE SET NULL` + nullable run_id mirrors the 2026-04-24 `run_events` widening: decisions are permanent history that must survive run deletion. CASCADE would silently destroy audit trail.

Alternatives TEXT-JSON on both dialects (vs JSONB on postgres) keeps the serialisation contract dialect-agnostic — no one queries into the alternatives array, so the only benefit of JSONB would be indexing we don't need. Parity simplifies the handler.

`created: boolean` in the success return is additive and lets the next slice's caller code detect silently-deduped retries deterministically without a DB round-trip. Useful in test coverage and in agent-side retry logging.

**Alternatives considered:** Route through `ctx.runRecorder` with a `phase: 'decision'` event shape (rejected — wrong table, wrong lifecycle rules, harder to query, doesn't match §S13 spec). Key idempotency on hash(description + rationale + alternatives) (rejected — typo retries duplicate decisions; defeats idempotency). `ON DELETE CASCADE` (rejected — destroys decision history with run deletion, contradicts "permanent record" framing). JSONB alternatives on postgres / TEXT on sqlite (rejected — split dialect types add complexity for zero benefit at M02 scale). Omit `created` from success return (rejected — forces callers to re-query the DB to detect dedupe).

**Reference:** `apps/mcp-server/src/tools/record-decision/handler.ts`; `apps/mcp-server/src/tools/record-decision/schema.ts`; `apps/mcp-server/src/tools/record-decision/manifest.ts`; `apps/mcp-server/__tests__/integration/tools/record-decision.test.ts` (7 cases: happy + alts-null + alts-empty + multi-per-run + dedupe + run_not_found + ON DELETE SET NULL); `packages/db/drizzle/{sqlite,postgres}/0003_*.sql`; `packages/db/src/schema/{sqlite,postgres}.ts`; `system-architecture.md §24.4 record_decision` (amended same-commit); `docs/feature-packs/02-mcp-server/implementation.md §S13` (rewritten in "what landed" style same-commit); user GO-recommendation-as-specified directive 2026-04-24 for S13.

## 2026-04-24 18:00 — S12: `query_run_history` title source, DESC ordering, readonly idempotency key, default limit

**Decision:** `query_run_history` derives `title` via LEFT JOIN `context_packs ON context_packs.run_id = runs.id`. No new column on `runs`. `title` returns as `string | null` (null for runs without a saved pack — e.g., `in_progress` runs that have not yet called `save_context_pack`). The `context_packs(run_id)` unique index (S3 migration 0000) guarantees at most one join row per run, so no row multiplication.

Ordering is `ORDER BY runs.started_at DESC` — most recent first. Matches the agent-trigger use case at session start ("see whether there is an `in_progress` run to resume" — the most recent one is what you want).

Idempotency-key kind is `readonly` (mirrors `search_packs_nl`). Key format: `readonly:query_run_history:{projectSlug}:{status ?? 'any'}:{limit}` truncated to 200 chars. Different (status, limit) combos on the same project emit distinct log keys so retries can be correlated without collapsing two distinct reads.

Input defaults: `limit = 10` (per §S12 spec), upper bound 200. Status enum `'in_progress' | 'completed' | 'failed'`. `projectSlug` required min 1.

Soft-failure: `project_not_found` per S8/S11 canon. Empty results (valid slug, zero matching runs) → `{ ok: true, runs: [] }` — NOT a soft-failure; agents distinguish "no recent runs" from "project not registered" via the `ok` discriminant.

Landed **out of linear order**: S13 (`record_decision`) shipped first per the S13 kickoff's option-(a) directive (spec-faithful numbering). S12 fills the gap now; subsequent slices resume linear sequence from S14.

**Rationale:** LEFT JOIN for title avoids a migration and a write-site decision (who populates `runs.title`?). Null-on-no-pack is the correct semantic for "run started but not yet concluded"; forcing a placeholder string would lie to the caller. The unique index on `context_packs(run_id)` means the join does not fan rows out, so the query is one scan + one index lookup per row with no DISTINCT needed.

DESC ordering matches §24.4's "chronological" with the session-start use case: agents resume the most recent `in_progress` run, not the oldest. Ascending would still be "chronological" but would make the common case require manual reversal client-side.

Empty-is-success (not soft-failure) parallels the S11 search_packs_nl convention: the ok-discriminant carries the transport signal; the data carries the domain payload. Missing results with a valid slug are a legitimate empty state, not an error.

**Alternatives considered:** Add a `runs.title` column via migration 0004 (rejected — requires a new write-site and either default-values dishonesty or a pre-save flow; the join is zero-migration and semantically accurate). ASC ordering (rejected — bad ergonomics for the primary session-start use case). Mutating idempotency key (rejected — reads have no side effects; readonly is correct). Return `title` as omitted-when-null rather than `null` (rejected — unstable output shape; callers then have to `in` check). Treat empty results as a `no_runs_yet` soft-failure (rejected — it's a valid success state; distinguishing "no data" from "project missing" is what `ok:false / error:project_not_found` already does).

**Reference:** `apps/mcp-server/src/tools/query-run-history/handler.ts`; `apps/mcp-server/src/tools/query-run-history/schema.ts`; `apps/mcp-server/src/tools/query-run-history/manifest.ts`; `apps/mcp-server/__tests__/integration/tools/query-run-history.test.ts` (9 cases: project_not_found + empty + DESC + status filter + limit + LEFT JOIN title + cross-project scoping + metadata passthrough + endedAt null); `system-architecture.md §24.4 query_run_history` (amended same-commit); `docs/feature-packs/02-mcp-server/implementation.md §S12` (rewritten in "what landed" style same-commit); user GO-recommendation-as-specified directive 2026-04-24 for S12.

## 2026-04-24 19:00 — S14: `check_policy` is the first caller of `recordPolicyDecision` — S7b audit-write deferral closed

**Decision:** S14's `check_policy` tool wires the full hook-event context (`projectId`, `agentType`, `eventType`, `runId`, `toolName`, `toolInputSnapshot`) into the S7b-exported `recordPolicyDecision` helper, dispatched via `setImmediate(...)` with `ON CONFLICT (idempotency_key) DO NOTHING` (already landed in S7b's `lib/policy.ts::recordPolicyDecision`). Handler returns the response synchronously; the audit row lands one event-loop tick later. Retries on the same `pd:{sessionId}:{toolName}:{eventType}` triple dedupe against the `policy_decisions.idempotency_key` UNIQUE constraint — exactly one row per logical call, regardless of retry count.

The S7b deferral note in `apps/mcp-server/src/lib/policy.ts` ("S7b exports `recordPolicyDecision(db, context)` as the wire code for the audit write; S14's `check_policy` tool is the first call site that will invoke it") is now closed.

**Rationale:** S7b deferred the audit-write call site because `PolicyInput` at the registry auto-wrap layer lacks `projectId` / `agentType` / `runId` — all required (NOT NULL FK) on `policy_decisions`. S14 is the first tool whose input carries those fields verbatim from the Hooks Bridge, so it's the first place the audit write can land without a synthetic projects row or made-up agentType default. Re-deferring past S14 would strand `recordPolicyDecision` permanently — the S7b decision was explicit about this: "do NOT re-defer."

Async dispatch (setImmediate + fail-and-log) keeps the handler on the <10 ms hook-SLO path per §24.4. Audit durability is on the next tick; observability tools that scan `policy_decisions` see a ~1ms lag from decision-time to row-visible — acceptable for forensic use cases, unacceptable for real-time policy decisions, which is the whole point of the split.

**Alternatives considered:** Synchronous audit write on the critical path (rejected — blows the <10 ms SLO; Write rates for a busy agent session would pile up 50+ ms of serialized audit IO). Background queue (BullMQ) for audit writes (rejected — over-engineered at M02 scale; setImmediate is native, durable under single-process assumption, and eliminates the queue as a failure mode). Defer to Module 03 (rejected — the Hooks Bridge doesn't own the policy evaluator, and splitting the decision across two services creates a consistency gap).

**Reference:** `apps/mcp-server/src/tools/check-policy/handler.ts` (lines 130-156 = the setImmediate dispatch); `apps/mcp-server/src/lib/policy.ts::recordPolicyDecision` (S7b helper now has its first caller); `apps/mcp-server/__tests__/integration/tools/check-policy.test.ts` ("fire-and-forget" + "idempotent dedupe" + "runId threads" cases); `system-architecture.md §24.4 check_policy` (amended same-commit); user slice-kickoff directive 2026-04-24 ("Do not re-defer the audit write past S14").

## 2026-04-24 19:05 — S14: per-projectId policy cache + `projectId?` additive-optional extension

**Decision:** `lib/policy.ts`'s rule cache upgrades from the S7b-era `'all'` sentinel to a `Map<string, CacheEntry>` keyed by `projectId`. When `input.projectId` is supplied (S14 `check_policy` path), the cache keys that project's slot; when omitted (registry auto-wrap + pre-S14 callers), the cache falls back to a `__global__` slot with all-project rules loaded. `loadRules(db, projectId | null)` filters by `policies.project_id = ?` when scoped, runs unfiltered when global.

`PolicyInput.projectId?: string` (`framework/policy-wrapper.ts`) and `PolicyClient.evaluate({ ..., projectId? })` (`framework/tool-context.ts`) are additive-optional extensions. `createPolicyClientFromCheck` propagates the field when supplied so test stubs can branch on `projectId` without per-test wiring.

Frozen-interface discipline preserved: no rename, no required field added, no existing test broken. The change is strictly additive — pre-S14 callers continue working unchanged.

**Rationale:** The S7b `'all'` cache key was a hardcoded stand-in flagged for upgrade at S14's arrival (see the "Module 02 solo-mode cache is keyed globally" comment in the S7b-era `lib/policy.ts`). At solo-mode M02 scale (<10 rules per project), per-project caching is essentially free; at team-mode scale (hundreds of projects, thousands of rules), global caching would force every policy check to evaluate every org's rules — a cross-tenant leak-by-default.

Per-project caching also defends against a real failure mode: rule edits on project A propagating to project B via shared cache invalidation. With project-keyed slots, each project's cache refreshes on its own TTL clock.

`projectId?: string` rather than `projectId: string` because the registry auto-wrap (still the dominant caller for every tool's pre/post evaluation) doesn't have a projectId. Making it required would have broken the auto-wrap contract or forced a synthetic project row. Additive-optional is the right shape.

**Alternatives considered:** `evaluateForProject(projectId, input)` as a second method (rejected — grows the PolicyClient surface by one method for no benefit; the field-add is strictly simpler). Require `projectId` on every call (rejected — breaks registry auto-wrap; forces synthetic projects). Cache invalidation via push (rejected — over-engineered at M02 scale; TTL-based invalidation is sufficient until Module 05 introduces real rule editing workflows).

**Reference:** `apps/mcp-server/src/lib/policy.ts` (cache = `Map<string, CacheEntry>`, `getRules(projectId | null)`, `loadRules(db, projectId | null)` scoped filter); `apps/mcp-server/src/framework/policy-wrapper.ts::PolicyInput.projectId`; `apps/mcp-server/src/framework/tool-context.ts::PolicyClient.evaluate({ projectId? })`; `apps/mcp-server/__tests__/integration/tools/check-policy.test.ts` ("per-projectId cache isolation" + "projectId threads through createPolicyClientFromCheck" cases); user Q1 sign-off directive 2026-04-24 ("the long-awaited closure of S7b's deferral note").

## 2026-04-24 19:10 — S14: reason enum lock, `failOpen` derivation, `ruleReason` separation

**Decision:** `check_policy`'s response `reason` is a locked enum of three values: `'no_rule_matched' | 'rule_matched' | 'policy_engine_unavailable'`. `failOpen: boolean` is derived (`failOpen === (reason === 'policy_engine_unavailable')`) — a unit test locks this derivation. `ruleReason: string | null` carries the matched rule's human text separately; populated when `reason === 'rule_matched'`, null otherwise.

The evaluator's internal fail-open sentinel is `'policy_check_unavailable'` (S7b string, kept for backwards-compat with the evaluator's existing test suite); the handler maps it to the response enum `'policy_engine_unavailable'` at the boundary. Audit row stores the response-enum version, so `policy_decisions.reason` is consistent with the wire response.

**`permissionDecision = 'ask'`** is reserved in the schema per §24.4 wording but never emitted by the S14 evaluator. Future CODEOWNERS / branch-protection integrations will populate it. A top-of-handler comment documents this reservation so future contributors don't mistakenly narrow the type.

**Rationale:** S7b's evaluator returned `reason: string` with mixed semantics (rule text OR sentinel code). Observability tooling had to string-match `'policy_check_unavailable'` to detect fail-open — fragile and error-prone. Locking a three-value enum + a derived boolean gives downstream dashboards a stable axis; agents that need the human text read `ruleReason` (null-safe).

`failOpen` being derived (not independently supplied) is important: observability dashboards can't have `reason` and `failOpen` disagree, because they're computed from the same source. Test locks the derivation.

`ruleReason: string | null` rather than conflating with `reason` is a separation-of-concerns call: `reason` is a machine signal; `ruleReason` is a user-facing explanation. An agent that needs to display "why was I blocked?" reads `ruleReason`; a dashboard that counts fail-opens reads `reason === 'policy_engine_unavailable'`.

**Alternatives considered:** Keep `reason` as free-text (rejected — observability fragility). Fold rule text into `reason` (rejected — conflates machine and human axes; downstream consumers can't cleanly branch). Derive `failOpen` by string-matching fail-open reasons (rejected — spec drift risk; derivation from enum is unambiguous). Remove `'ask'` from the output enum (rejected — §24.4 wording locks it for forward-compat with CODEOWNERS integration).

**Reference:** `apps/mcp-server/src/tools/check-policy/schema.ts` (locked reason enum + required failOpen + ruleReason nullable); `apps/mcp-server/src/tools/check-policy/handler.ts` lines 108-125 (enum derivation from evaluator output); `apps/mcp-server/__tests__/unit/tools/check-policy.test.ts` (`'ask' stays reachable in schema` + `failOpen required` + `unknown reason rejected`); user Q4 sign-off directive 2026-04-24.

## 2026-04-24 19:15 — S14: `toolInputSnapshot` 8 KiB truncation with size-preservation suffix

**Decision:** The audit row's `toolInputSnapshot` column stores `JSON.stringify(toolInput)` truncated to 8192 characters with a `…[truncated:N]` suffix (where N is the original length). Serialisation errors (cyclic refs, etc.) collapse to the literal `'[unserialisable]'`.

**Rationale:** Real-world tool inputs frequently exceed 8 KiB — a `Write` against a 500 KB file, a `Bash` call with a long heredoc, a multi-thousand-line patch body. Without a cap, every such call would write that full payload into `policy_decisions` forever. Table bloats fast, queries slow down, and forensic audit use cases only need path + command + first-chunk — the tail provides no additional signal.

Adding truncation retroactively is strictly worse: pre-truncation rows stay disproportionately large forever, and migrating them requires a rewrite pass that's impossible on an append-only table (ADR-007). Truncation at the write boundary is the only cheap solution.

8 KiB (8192 chars) is chosen because:
- It's above the 99th percentile of real policy-check payloads (typical Write: `{ file_path, content }` where content is <2 KB for most edits).
- It's below the 10 KB threshold where sqlite BLOB storage splits into overflow pages (concrete perf cliff).
- It's a round power of 2, so a DBA reading the schema intuits the cap.

The `…[truncated:N]` suffix preserves original-size forensics. Auditors asking "was this a large write?" read N without needing the full payload.

**Alternatives considered:** No cap (rejected — table bloat is a real M02-to-M05 failure mode; postponing forces a lossy migration). Cap at 1 KiB (rejected — too aggressive; loses first-chunk-of-content that forensics actually uses). Cap at 64 KiB (rejected — defeats the purpose; most writes fit under 64 KiB so no real defence). Cap + drop rather than cap + suffix (rejected — suffix is ~20 bytes of overhead that preserves a crucial forensic signal). Store in a separate blob table with soft-link (rejected — over-engineered; `policy_decisions` is already a simple append-only audit log, not the place for a blob-storage split).

**Reference:** `apps/mcp-server/src/tools/check-policy/handler.ts::truncateToolInputSnapshot`; `apps/mcp-server/__tests__/integration/tools/check-policy.test.ts` ("8 KiB truncation" case — 20 KB input → 8192+suffix, small input → verbatim); user Q4 push-back directive 2026-04-24 ("Add an 8KB truncation cap on toolInputSnapshot. Adding truncation retroactively is worse than doing it now.").

## 2026-04-24 19:20 — S14 (for Module-03 consumption): `project_not_found` from `check_policy` must be treated as allow

**Decision (for Module 03, not implemented in S14):** When the Hooks Bridge (Module 03) receives `{ ok: false, error: 'project_not_found' }` from `check_policy`, it SHOULD treat the response as `permissionDecision: 'allow'` for hook-dispatch purposes — NOT as a deny.

**Rationale:** `project_not_found` is a caller-addressable error, not a policy decision. If Module 03 were to deny hook-dispatch on this response, a user with an unregistered project would silently have every `Write`, `Bash`, and destructive operation blocked — with no error surface to the agent beyond "policy denied". That's catastrophic UX: the user's setup is broken but the symptoms look like an aggressive policy. The correct failure is to allow the operation and let the tool itself surface the registration gap (via `get_run_id`'s `project_not_found` or the CLI's registration prompt).

§7 fail-open policy — "if the policy engine is unreachable, fail open" — extends naturally here: a lookup miss is conceptually a narrower "policy scope is unreachable for this project" condition. Denying on policy-scope-miss would be more aggressive than denying on policy-engine-unreachable.

S14 DOES NOT implement this Module-03-side behaviour — it only surfaces the structured soft-failure on the MCP wire. Module 03 picks it up when it lands. This decisions-log entry exists so the Module 03 author doesn't rediscover the reasoning.

**Alternatives considered:** Have S14 itself fail-open on project lookup miss (rejected — conflates soft-failure with fail-open, violates §9.1.2 canonical shape, makes "project exists?" unobservable from the wire). Have Module 03 treat `project_not_found` as deny (rejected — silent breakage on misconfigured projects). Surface a third state ("registration_required") distinct from both (rejected — shape proliferation; `project_not_found` already carries `howToFix` which is the same signal).

**Reference:** `system-architecture.md §24.4 check_policy` amendment (mentions Module 03 expectation); `apps/mcp-server/src/tools/check-policy/handler.ts::resolveProjectId` branch; `apps/mcp-server/__tests__/integration/tools/check-policy.test.ts` ("project_not_found" case asserts no audit row written); user Q3 directive 2026-04-24 ("This is caller-side (M03) policy; don't implement in S14, just flag in the decisions-log so M03 picks it up.").

## 2026-04-24 20:00 — S15: `query_codebase_graph` — factory handler, two soft-failure split, `expandContextBySlug` additive method, output-shape amendment, query deferred to M05

**Decision:** S15 ships the eighth MCP tool and closes the pure-tool-set for Module 02. Four user-approved decisions drive the slice:

1. **Factory handler** (user Q1 sign-off 2026-04-24), NOT static-const. `createQueryCodebaseGraphHandler({ db })` closes over `DbHandle` so the handler can distinguish `project_not_found` (slug not in `projects` table) from `codebase_graph_not_indexed` (project exists, no `graph.json` on disk). The original carryover's "static-const manifest" directive was inconsistent with the carryover's "two distinct soft-failures" requirement — static-const handlers cannot strongly-type-access Drizzle because `ctx.db.db` is deliberately `unknown` at the ToolContext boundary. Factory shape matches every other project-resolving tool (S11, S12, S14).

2. **`GraphifyClient.expandContextBySlug(slug)` additive method** (user Q2 sign-off). The existing `expandContext({ runId, depth })` doesn't fit §24.4's input shape `{ projectSlug, query }` (no runId). Option-(a)-additive-method was chosen over option-(b)-resolve-slug-to-any-runId because (b) would silently return empty results when the project has zero runs (resolveRunSlug returns null → empty), creating false "no results" vs "no runs yet" ambiguity. Same additive-method pattern as S7c's `getIndexStatus(slug)` (user Q9 sign-off precedent). Both `expandContext` paths share the per-slug cache inside the lib.

3. **Output-shape amended from §24.4's `{ symbols: [...] }` to M02-accurate `{ nodes, edges, indexed, notice? }`** (user Q3 sign-off). The M02 lib layer treats Graphify nodes as `unknown` — Module 05 owns the richer `{ name, kind, file, callers, callees, community }` projection. Shipping a typed-`symbols` shape at M02 would require either duck-type casts (structural dishonesty — the caller gets undefined fields if graph.json's real shape diverges) or a type system that doesn't exist yet. The amended shape matches exactly what the lib delivers; Module 05 replaces the handler with a typed-filtering version and restores the richer shape then. `indexed: true` is an additive observability primitive (same spirit as S14's `failOpen: boolean`) — locked `true` on success, distinguishes default-populated success from the `codebase_graph_not_indexed` soft-failure.

4. **`query` accepted on input but NOT applied at M02** (user Q4 sign-off). Any filter at M02 would be imprecise (stringify+substring on `unknown` nodes) or dishonest (cast to a structural shape). The M02 shim returns the full subgraph with `notice: 'query_filtering_deferred_to_m05'` — same advisory-notice pattern as `search_packs_nl`'s `no_embeddings_yet`. Agents detect the shim explicitly; Module 05 drops the notice when it lands typed filtering.

Handler flow (order-critical, spy-test-locked): (a) resolve projectSlug → projects.id, soft-failure on miss; (b) `ctx.graphify.getIndexStatus(slug)` BEFORE `expandContextBySlug`, soft-failure on missing file; (c) `ctx.graphify.expandContextBySlug(slug)` → `{ nodes, edges }`; (d) return `{ ok: true, nodes, edges, indexed: true, notice }`. Without the step-(b) gate, a missing index would silently fall through the lib's empty-return path and callers could not distinguish "no results" from "no scan ran" — the ordering is the whole point of landing `getIndexStatus`.

Fail-open (§7) at the lib layer (parse failure on malformed graph.json, read failure mid-read) returns `{ nodes: [], edges: [] }` with `indexed: true` — does NOT collapse with `codebase_graph_not_indexed`, which is a genuine caller-addressable state.

**Rationale for each decision summarised above — rolling them into one entry for S15 rather than four separate entries because they're tightly coupled: the factory decision forces DB access which enables two-soft-failure split; the output-shape amendment follows naturally from the `unknown`-typed lib layer; the `query`-deferred decision is the mirror image of the typed-filtering coming in Module 05; the new additive method closes the gap between §24.4's input shape and the lib's original runId-addressed surface.

**Alternatives considered:** Static-const handler + collapse project_not_found with codebase_graph_not_indexed (rejected — degrades UX; different remediations for the two states). Duck-type-cast `unknown` nodes into `{ name, kind, file }` to preserve §24.4's literal shape (rejected — structurally dishonest; caller gets undefined fields). Stringify+substring query filter at M02 (rejected — imprecise, costly on large graphs, redundant when Module 05 replaces it). Reject the query parameter entirely at M02 (rejected — forward-incompatible with §24.4 input; Zod reject would force callers to rewrite when Module 05 ships). Resolve projectSlug → any runId → call `expandContext({ runId })` (rejected — silent false-empty when project has zero runs).

**Reference:** `apps/mcp-server/src/tools/query-codebase-graph/handler.ts`; `apps/mcp-server/src/tools/query-codebase-graph/schema.ts`; `apps/mcp-server/src/tools/query-codebase-graph/manifest.ts`; `apps/mcp-server/src/framework/tool-context.ts::GraphifyClient.expandContextBySlug` (additive method docblock referencing S7c Q9 pattern); `apps/mcp-server/src/lib/graphify.ts::expandContextBySlug`; `apps/mcp-server/__tests__/integration/tools/query-codebase-graph.test.ts` (10 cases — three branches + order spy × 3 + cache + query-noop); `system-architecture.md §24.4 query_codebase_graph` (amended same-commit); `docs/feature-packs/02-mcp-server/implementation.md §S15` (rewritten same-commit); user Q1+Q2+Q3+Q4 sign-off directive 2026-04-24.

## 2026-04-24 20:05 — S15: `GraphifyClient.getIndexStatus` S7c deferral closed

**Decision:** S15 is the first caller of `GraphifyClient.getIndexStatus(slug)` — the additive method landed in S7c specifically for this slice (user Q9 sign-off 2026-04-24, recorded in the S7c entries). S7c landed the wire code with a docblock flagging S15 as the intended first caller; the deferral now closes.

The parallel structure is exact: S14 closed the S7b deferral for `recordPolicyDecision` (S7b exported the helper, S14 provided the first call site with full hook-event context). S15 closes the S7c deferral for `getIndexStatus` (S7c exported the method, S15 provides the first call site with full before-expand ordering). Both deferrals landed with explicit "do not re-defer past this slice" directives and both slices now have spy-based integration tests locking the ordering.

**Rationale:** Closing deferrals at the first-caller slice is the discipline that prevents the codebase from accumulating helpers without call sites. A reserved method that is never invoked grows stale quickly — its cache, its error paths, and its docblock references drift from what the eventual caller actually needs. Landing the call site in the slice that motivates the method keeps the contract truthful.

**Reference:** `apps/mcp-server/src/tools/query-codebase-graph/handler.ts` (flow step 2 — `ctx.graphify.getIndexStatus(slug)` before `expandContextBySlug`); `apps/mcp-server/__tests__/integration/tools/query-codebase-graph.test.ts` (order spy locks the call sequence); S7c entry in this log (2026-04-23) exporting `getIndexStatus` as a reserved slot. Parallel to 2026-04-24 19:00 S14 entry closing the S7b `recordPolicyDecision` deferral.

## 2026-04-25 09:00 — S16: hybrid Node listener for `/mcp`, Hono for `/healthz` and 404 fallthrough

**Decision:** `apps/mcp-server/src/transports/http.ts` builds a single `http.createServer()` listener that dispatches `/mcp` directly to `StreamableHTTPServerTransport.handleRequest(req, res, body)` — bypassing Hono. A Hono app handles `/healthz` and the 404 fallthrough, exposed to the listener via `getRequestListener(app.fetch)` from `@hono/node-server`. Auth runs inline in the Node dispatch BEFORE any body read, so unauthenticated requests are rejected without touching the SDK transport at all.

**Rationale:** MCP's Streamable HTTP transport writes to Node `ServerResponse` directly because the response shape is JSON-or-SSE depending on the request. Hono's context contract returns a `Response` object, so handler-owned writes need a special `RESPONSE_ALREADY_SENT` sentinel from `@hono/node-server`. That sentinel is NOT in the package root's `exports` map (only `.` and `./serve-static` are exposed); deep imports like `@hono/node-server/utils/response` resolve under the current pnpm install but are not part of the package's public contract and would break under stricter `exports` enforcement. The hybrid solve trades a few lines of raw Node dispatch for a cleaner integration surface — Hono stays in the picture for non-MCP routes (today: `/healthz`, the 404 page; future: `/admin`, `/feature-flags`, etc).

**Alternatives considered:** Pure Hono with deep import of `RESPONSE_ALREADY_SENT` (rejected — relies on unpublished exports). Skip Hono entirely; serve `/healthz` from raw Node (rejected — Hono is reasonable insurance for the next route's middleware needs). Use the SDK's Express adapter (rejected — Express is a much larger dep than Hono and we've already standardized on Hono for the Hooks Bridge per `essentialsforclaude/11-adrs.md` ADR-004). Wrap Hono around the entire request and use `c.executionCtx.passThroughOnException()` (rejected — that's a Cloudflare Workers API, not present in the Node adapter).

**Reference:** `apps/mcp-server/src/transports/http.ts` lines 17-52 (design-decisions docblock); user 2026-04-25 directive ("continue with s16"); ADR-004 (Hono over Express for hot-path HTTP).

## 2026-04-25 09:05 — S16: three-layer auth chain order locked, `/healthz` unauthed

**Decision:** `/mcp` requests run through a three-layer auth chain in this exact order, with first-match-wins:

1. **Solo-bypass** — when `CLERK_SECRET_KEY === 'sk_test_replace_me'` OR `CONTEXTOS_MODE === 'solo'`, identity is the frozen `SOLO_IDENTITY` (`user_dev_local` / `org_dev_local`). No headers are inspected.
2. **X-Local-Hook-Secret** — request header value compared against `LOCAL_HOOK_SECRET` env via `crypto.timingSafeEqual` (constant-time, byte-length-safe via `Buffer.byteLength`). Identity source = `'local-hook'`.
3. **Clerk JWT** — `Authorization: Bearer <jwt>` → `@clerk/backend::verifyToken` with the configured secret. On success, identity is constructed from the JWT payload (`sub`, `org_id`).
4. **No match** → `401` response with `WWW-Authenticate: Bearer` header and structured body `{ error: 'unauthorized', reason: 'no_valid_auth_layer' }`.

`/healthz` skips the chain entirely — it returns `200 ok` regardless of headers. This is deliberate: reverse proxies, load balancers, and Kubernetes liveness probes hit it without credentials, and gating it would break the deployment story.

**Rationale:** The order is `system-architecture.md` §19 verbatim, locked by `context_memory/decisions-log.md` 2026-04-22 Q-02-1. Putting solo-bypass FIRST means a developer running `CONTEXTOS_MODE=solo` never has to think about Clerk — local dev is one env-var away from working without any external dependency. X-Local-Hook is second so the Hooks Bridge (Module 03) can attach the secret without needing a JWT round-trip on every PostToolUse. Clerk is the team-mode default and lands last because it's the most expensive (network round-trip on first call, JWKS cached after).

The `WWW-Authenticate: Bearer` response header is RFC 7235-compliant and tells well-behaved clients exactly what auth scheme to retry with — useful for the future MCP-Inspector flow where Clerk SSO triggers a reauthentication.

**Alternatives considered:** Reverse the order so Clerk is checked first (rejected — slow path becomes the default). Apply auth to `/healthz` too (rejected — breaks operational probing). Use a header allowlist for healthz (rejected — over-engineered). Issue a `403` instead of `401` on auth failure (rejected — `401` is the correct status for "no/invalid credentials"; `403` is for "valid credentials but insufficient permission").

**Reference:** `apps/mcp-server/src/transports/http.ts::authenticate` (lines 81-108); `apps/mcp-server/src/lib/auth.ts::verifyClerkJwt` + `verifyLocalHookSecret`; `system-architecture.md §19` auth strategy; `context_memory/decisions-log.md` 2026-04-22 Q-02-1; user 2026-04-25 sign-off (Clerk test keys provided in chat for local dev — gitignored in `.env`, rotation reminder noted).

## 2026-04-25 09:10 — S16: `MCP_SERVER_PORT` constraint loosened to allow port 0 (kernel-ephemeral) for tests

**Decision:** Changed `config/env.ts::MCP_SERVER_PORT` from `.positive()` (i.e. `>= 1`) to `.min(0)`. Port `0` is a POSIX-standard sentinel meaning "kernel-assigned ephemeral port" and is accepted by Node's `server.listen()`. With this loosening, integration tests can pass `MCP_SERVER_PORT: 0` and `startHttpTransport` reads the actually-bound port back via `nodeServer.address()`, reflecting it in `HttpTransportHandle.port` and `HttpTransportHandle.url`.

Without this change, parallel test workers in vitest would race on a fixed port and fail intermittently. Hard-coding a high random port per test would work but creates the same flake risk on a busy CI runner. Kernel-ephemeral assignment is the standard test-harness pattern for HTTP servers in Node.

**Rationale:** The `.positive()` constraint expressed an operator concern ("don't accidentally bind nothing in production"), but `.min(0)` plus the `MCP_SERVER_HOST=127.0.0.1` default already enforce the spirit of that concern: production deployments set both to real values; the only callers that pass 0 are test harnesses that immediately read the bound port back. The descriptor on the schema field documents this.

**Alternatives considered:** Keep `.positive()` and have tests assign random ports above 49152 (rejected — race risk on busy machines). Use a separate `MCP_SERVER_PORT_TEST` env var (rejected — schema bifurcation, no real benefit). Mock the listener entirely in tests (rejected — defeats the purpose of an integration test).

**Reference:** `apps/mcp-server/src/config/env.ts::MCP_SERVER_PORT` schema; `apps/mcp-server/src/transports/http.ts` bound-port read-back via `nodeServer.address()`; `apps/mcp-server/__tests__/integration/transports/http.test.ts` harness uses `MCP_SERVER_PORT: 0`.

## 2026-04-25 10:00 — S17: e2e test layout at repo root, BootHandle.dbHandle exposure, e2e boot helper mirrors src/index.ts

**Decision:** E2E tests live at `__tests__/e2e/<scenario>.test.ts` at the repo root, NOT under any workspace's `__tests__/`. Per `essentialsforclaude/06-testing.md §6.7`, e2e crosses workspace boundaries (mcp-server + db + shared + sdk client) and putting it in any single workspace's tree would force fragile cross-workspace path imports inside that workspace's vitest config. Root layout makes the cross-workspace nature first-class.

A new `vitest.e2e.config.ts` at repo root sits next to the existing root `package.json::test:e2e` script. Workspace deps `@coodra/contextos-db`, `@coodra/contextos-shared`, `@coodra/contextos-mcp-server` are added as `workspace:*` root devDependencies so the e2e tests can import production source directly.

The e2e `boot.ts` helper at `__tests__/e2e/_helpers/boot.ts` mirrors `apps/mcp-server/src/index.ts`'s `ContextDeps` wiring — every lib factory the production server constructs is constructed here too (createAuthClient, createPolicyClient, createFeaturePackStore, createContextPackStore, createRunRecorder, createSqliteVecClient, createGraphifyClient). The deliberate parallel structure means e2e proves the production wiring works, not a test-only shim.

`BootHandle.dbHandle` is an additive field landed in this slice so e2e tests can run typed Drizzle queries directly against the underlying handle. `deps.db.db` is intentionally `unknown` at the `ContextDeps` boundary (handlers must consume domain methods, not raw SQL); exposing the strongly-typed handle separately on the boot helper keeps the production invariant while letting e2e assertions verify table state cleanly.

**Rationale:** The boot helper is the load-bearing piece. It MUST stay in lock-step with `src/index.ts` — if production grows a new lib factory, the e2e helper must too, otherwise scenarios silently exercise stale-shape deps. The helper docblock flags this. Mirror discipline > a shared abstraction that could drift.

`testTimeout: 60_000` and `hookTimeout: 120_000` accept testcontainers cold-pull on a fresh runner. `fileParallelism: false` because parallel scenarios race on testcontainers port reservations and `EADDRINUSE` becomes the dominant failure mode under concurrency — sequential keeps the tests deterministic at the cost of ~10–12s wall-clock total.

**Alternatives considered:** Put e2e under `apps/mcp-server/__tests__/e2e/` (rejected — requires that workspace's vitest config to reach into other workspaces' source, breaks Turborepo's task isolation). Use a separate `@coodra/contextos-e2e` workspace package (rejected — over-engineered; root devDeps + a single config file is simpler). Boot helper that delegates back to `index.ts` (rejected — `index.ts` calls `process.exit` in shutdown, can't be reused as a library entry point).

**Reference:** `vitest.e2e.config.ts`, `__tests__/e2e/_helpers/boot.ts` (mirror of `apps/mcp-server/src/index.ts` boot path), `__tests__/e2e/_helpers/postgres.ts` (testcontainers pgvector container helper), `apps/mcp-server/src/transports/http.ts` BootHandle additive field; user 2026-04-25 directive ("S17 — full-lifecycle e2e integration tests"); `essentialsforclaude/06-testing.md` §6.7.

## 2026-04-25 10:05 — S17: testcontainers Postgres for the idempotency scenario, NOT sqlite

**Decision:** The `policy-decisions-idempotency.test.ts` scenario uses a real Postgres container (`pgvector/pgvector:pg16` via `testcontainers@11.14.0`) and explicitly NOT sqlite. The scenario dispatches 10 `check_policy` calls concurrently with the same `(sessionId, toolName, eventType)` triple and asserts exactly one row lands in `policy_decisions`.

The migration 0000 references `vector(384)`. The pgvector extension must exist BEFORE migrate runs; migration 0001 contains a `CREATE EXTENSION IF NOT EXISTS vector` safety net but it runs AFTER 0000. The e2e Postgres helper runs `CREATE EXTENSION IF NOT EXISTS vector` against the fresh database BEFORE calling `migratePostgres`. The `pgvector/pgvector:pg16` image bundles the extension binary; just opting in on the database is sufficient.

**Rationale:** Sqlite serialises writes per file at the OS-page level — "10 concurrent inserts" on sqlite isn't actually concurrent. Postgres + a real connection pool is the only way to exercise the actual race condition the production deployment will see (concurrent Hooks Bridge calls inside a session, retried on the network layer, all hitting the same idempotency key). Without the testcontainers Postgres, the scenario is theatre — it would pass because sqlite serialises out the race, not because the `ON CONFLICT DO NOTHING` clause works.

The other four scenarios use sqlite `:memory:` because they don't exercise concurrency — they walk a single client session through the data plane and assert outcomes. Spinning up a Postgres container for each would add ~30s of cold-pull latency for no additional coverage.

**Alternatives considered:** Run all five scenarios against testcontainers Postgres (rejected — wall-clock cost balloons; sqlite is sufficient for the four non-concurrency scenarios). Skip the idempotency e2e and rely on the unit-level integration test (rejected — that test runs against sqlite which serialises writes; it's the wrong sandbox for the contract being verified). Use Postgres service-container instead of testcontainers (rejected — diverges from local-dev experience; testcontainers runs identically in CI and on a developer's laptop).

**Reference:** `__tests__/e2e/_helpers/postgres.ts` (CREATE EXTENSION + migrate + close); `__tests__/e2e/policy-decisions-idempotency.test.ts` (10× concurrent assertion); `system-architecture.md` §4.2 (pgvector/pgvector:pg16 image pin); `packages/db/__tests__/integration/postgres-migrate.test.ts` (precedent for the CREATE EXTENSION pattern).

## 2026-04-25 10:10 — S17 found a bug: HTTP/stdio session-id colon broke get_run_id encoding

**Decision:** The HTTP transport's per-server session id was minted as `http:${randomUUID()}` (with a colon) since S16. The stdio transport in `src/index.ts` was the same shape (`stdio:${randomUUID()}`). `get_run_id` validates that incoming sessionIds contain no `:` because its runId encoding is `run:{projectId}:{sessionId}:{uuid}` and a colon-bearing sessionId breaks the encoding round-trip. Fix: mint `http-${uuid}` and `stdio-${uuid}` instead (hyphen separator — collision-free with the runId encoding, semantically equivalent for log correlation).

**Rationale for why this wasn't caught earlier:** S14's `check_policy` integration tests pass a literal `'sess_xxx'` style sessionId via `registry.handleCall(name, args, sessionId, ...)` directly — they bypass the transport and so never observe the transport's mint. S16's HTTP integration tests exercise the auth chain + `initialize` + `/healthz` but never invoke `get_run_id`. The bug only surfaces when a real SDK Client connects through the transport AND chains `get_run_id` against the per-transport sessionId. S17's full-session scenario was the first test to do that — and it failed immediately on the very first call.

This is the kind of latent encoding bug that integration tests at the wrong granularity can never catch — they live one stack frame away from the actual contract that breaks. Cross-tool e2e is the right granularity. Documenting this here so the next time we add a tool that constructs IDs from concatenated parts, we lock the separator-purity invariant at the schema layer (Zod refine), not at the runtime layer (handler validate).

**Alternatives considered:** Update `get_run_id` to accept colon-bearing sessionIds (rejected — breaks the runId encoding which other handlers parse). URL-encode the sessionId in runIds (rejected — runId is a primary key; round-trip encoding is fragile). Accept the bug as latent because nothing currently chains transport→get_run_id (rejected — production usage WILL chain that path; lock the contract now).

**Reference:** `apps/mcp-server/src/transports/http.ts` line 165 (`http-${uuid}`); `apps/mcp-server/src/index.ts` line 123 (`stdio-${uuid}`); `apps/mcp-server/src/tools/get-run-id/handler.ts` validation throw on colon-bearing sessionId; `__tests__/e2e/full-session.test.ts` (the test that exposed it on first run); user 2026-04-25 e2e directive.

## 2026-04-25 14:30 — Module 03 begins; 15-slice plan approved per docs/feature-packs/03-hooks-bridge/

**Decision:** Module 03 (Hooks Bridge) starts on a fresh `feat/03-hooks-bridge` branch off `main` (`f496cc5`). Slice plan: S1 docs (this commit) → S2 context memory → S3 extract policy+auth to shared → S4 createDb local|cloud refactor (closes verification §8.3) → S5 scaffold apps/hooks-bridge → S6 per-agent adapters + HookEvent + normalizeSessionId (closes §8.6) → S7 pre-tool policy → S8 post-tool RunRecorder → S9 SessionStart/Stop → S10 UserPromptSubmit → S11 adapter shell scripts → S12 .mcp.json wiring → S13 cross-mode + cloud-mode integration → S14 full-session e2e → S15 closeout pack.

**Rationale:** Linear build order per `essentialsforclaude/08-implementation-order.md` §8.1 — Module 03 depends on Modules 01 + 02 and is itself a prerequisite for 04, 05, 06, 07, 08a. The slicing keeps each commit ≤ one cohesive concern and per amendment-B keeps reference docs in sync. The carryover absorption (§8.3 in S4, §8.6 in S6) lands inside the natural code touchpoints rather than as a separate cleanup pass.

**Alternatives considered:** Defer §8.3 to a Module 04 sync-daemon design slice (rejected — Module 03's hooks-bridge IS a local service that needs to write to local SQLite in BOTH solo and team mode; closing the architectural contradiction here is non-blocking but feels right alongside the new local service). Defer §8.6 to a future "validation hardening" pass (rejected — Module 03 introduces three new external boundaries that take sessionIds; locking the schema-layer validation now means each new adapter is built correct, not retrofitted). Skip the docs commit as redundant with the chat-attached plan (rejected — feature-pack docs are the durable contract every future agent reads).

**Reference:** `docs/feature-packs/03-hooks-bridge/{spec,implementation,techstack}.md`; `docs/verification/2026-04-25-module-01-02-verification.md` §8.3 + §8.6 carryover; `essentialsforclaude/08-implementation-order.md` §8.1 module table; commits `3a76f23` (S1), `5b6b13d` (pre-S1 scope updates).

## 2026-04-25 14:45 — Pre-S1 commit absorbs orphan 2026-04-24 user-directive scope updates + Module 08a placeholder

**Decision:** Before the S1 docs commit, a `chore(scope): apply 2026-04-24 user-directive scope updates + Module 08a placeholder` commit (`5b6b13d`) lands on `feat/03-hooks-bridge` to capture three orphan-but-valuable file modifications from a prior session (`essentialsforclaude/08-implementation-order.md` — Module 08a inserted between 03 and 04 + four "out of every module" scope items; `system-architecture.md` §18 — Tier-2 LLM amended to Gemini-not-Anthropic; `context_memory/pending-user-actions.md` — enriched GitHub App registration steps + GEMINI_API_KEY entry) along with the untracked-but-substantial `docs/feature-packs/08a-cli/` directory (344 lines of placeholder feature-pack docs) and a `.gitignore` entry for `.claude/`.

**Rationale:** These edits represent meaningful prior-session scope clarification work that never reached `main`. Discarding via stash-forever would lose them; landing as a separate context-memory commit on Module 03's branch keeps the scope record durable and unblocks Module 03's plan (which references "Module 08a" for the §8.5 deferral and the Gemini-not-Anthropic decision). They're doc-only, no code risk.

**Alternatives considered:** Discard via `git restore` (rejected — destroys real prior work). Land them on `main` directly via a separate PR (rejected — main is squash-merged history; cherry-picking them onto a fresh branch is the same end state but with extra ceremony). Keep them stashed indefinitely (rejected — stashes go stale and get dropped when other work happens).

**Reference:** commit `5b6b13d`; `docs/feature-packs/08a-cli/`; `essentialsforclaude/08-implementation-order.md` Module 08a sequencing rationale.

## 2026-04-25 15:00 — Module 03 S3: policy lives in new `@coodra/contextos-policy` package, NOT `@coodra/contextos-shared/policy`

**Decision:** Module 03 S3 deviates from spec.md's original wording ("policy moves to `packages/shared/src/policy/`") and instead creates a new workspace package `@coodra/contextos-policy` (`packages/policy/`) for the policy evaluator. Auth still moves to `packages/shared/src/auth/` as planned (no DB dep, no cycle risk).

**Rationale:** `@coodra/contextos-db` already depends on `@coodra/contextos-shared` (for `createLogger` + `InternalError` + `ValidationError`). Putting the policy module in shared would force shared to depend on `@coodra/contextos-db` (for `DbHandle` + the schema tables the evaluator queries), creating a workspace cycle. A new package that depends on both `shared` and `db` is the structurally correct resolution. Auth has no DB dependency — only `@clerk/backend` + node-builtin `crypto.timingSafeEqual` — so it lives in shared as planned.

`IdempotencyKey` (the discriminated `{ kind, key }` value-shape) also moves to `packages/shared/src/idempotency.ts` so the cross-package `PolicyInput.idempotencyKey` field can reference it without depending on the mcp-server-specific framework. Tool-registration concerns (`IdempotencyKeyBuilder<Input>`, `IdempotencyContext`, `assertIdempotencyKeyBuilder`) stay in mcp-server's `framework/idempotency.ts`.

The `auth-chain.test.ts` test file moved from `apps/mcp-server/__tests__/unit/lib/` to `packages/shared/__tests__/unit/auth/` so `vi.mock('@clerk/backend')` actually intercepts. When the test lived in mcp-server, the mock applied only to that file's resolution context; the dist of the `@coodra/contextos-shared/auth` module imported `@clerk/backend` through a different resolution path and bypassed the mock. Moving the test to the same package as the implementation fixed it without needing vitest `deps.inline` gymnastics. The `McpServerEnv` parameter type was replaced with `AuthEnv` (a structural subset declared in shared/auth/types) so the test no longer reaches into mcp-server.

**Alternatives considered:**
- Break `@coodra/contextos-db`'s shared dependency by inlining the three primitives db consumes (rejected — duplicates `InternalError` / `ValidationError` / `createLogger` across packages, breaking single-source-of-truth for error types).
- Use type-only imports of db in shared/policy (rejected — policy imports `postgresSchema` and `sqliteSchema` as runtime values for query construction; type-only doesn't work).
- Lazy-import db at call time inside shared/policy (rejected — ESM doesn't support synchronous lazy import; async lazy adds latency to the policy hot path).
- Put policy directly in `@coodra/contextos-db` (rejected — conflates schema/migrations with domain logic; also pulls cockatiel + picomatch into the db package's surface).
- Keep policy in mcp-server and have hooks-bridge import from a peer app (rejected — hooks-bridge depending on mcp-server breaks CQRS pattern 1: write surface should not depend on read surface).

**Reference:** new `packages/policy/` workspace package; updated `apps/mcp-server/{src/lib/policy.ts, src/framework/policy-wrapper.ts}` re-export shims; `packages/shared/{src/auth/, src/idempotency.ts}` additions; `docs/feature-packs/03-hooks-bridge/{spec.md, implementation.md S3, techstack.md}` rewritten to reflect the new shape; `External api and library reference.md` new `@coodra/contextos-policy` subsection under Validation/Schemas/Resilience + module-location notes on cockatiel/@clerk/backend/picomatch subsections (amendment B).

## 2026-04-25 15:18 — Module 03 S4: createDb takes a kind discriminator; mode no longer dictates DB routing (closes verification §8.3)

**Decision:** `packages/db/src/client.ts::createDb` is refactored from `{ mode?: 'solo'|'team', sqlite?, postgres? }` to a discriminated union `{ kind: 'local', mode?, sqlite? } | { kind: 'cloud', mode?, postgres? }`. `kind: 'local'` always returns SQLite; `kind: 'cloud'` always returns Postgres; `mode` is an auth-strategy hint and does NOT change DB choice. The Module 02 `CONTEXTOS_DB_OVERRIDE_MODE` env knob is removed — the new signature makes it unnecessary.

`apps/mcp-server/src/lib/db.ts::createDbClient` always passes `kind: 'local'` because mcp-server is a local service per `system-architecture.md` §1. The boot path defends with `if (dbHandle.kind !== 'sqlite') throw` so a future wiring bug would surface immediately rather than silently degrade. The old `apps/mcp-server/__tests__/integration/boot-db-override.test.ts` is renamed to `boot-team-mode-local-sqlite.test.ts` and rewritten to assert the new contract: `CONTEXTOS_MODE=team` boots on SQLite without any override env var.

**Rationale:** `system-architecture.md` §1 is unambiguous: local services always write to local SQLite, in both solo and team mode. Cloud Postgres is reached by separate cloud-side processes (Sync Daemon, cloud-api) that hold their own handles. The Module 02 `mode → DB` coupling contradicted that rule; the verification report flagged it as the §8.3 finding. The override env knob was a stop-gap. Now the code finally matches the architecture, and `mode` is free to mean what it always should have meant — "which auth strategy do I use?" — orthogonal to dialect choice.

**Alternatives considered:**
- Keep `mode → DB` coupling and document it (rejected — directly contradicts architecture §1).
- Make the discriminator implicit — auto-derive `kind` from `mode` (rejected — same coupling, same problem).
- Add a third `kind: 'inferred'` that reads env (rejected — env-driven dispatch is fragile, the override knob already showed why).
- Keep `mode` optional everywhere (kept it optional; the change is to `kind` becoming the dispatch axis, with `mode` retained as a free-form hint).

**Reference:** `packages/db/src/client.ts` (refactored CreateDbOptions + createDb); `apps/mcp-server/src/{lib/db.ts, config/env.ts (CONTEXTOS_DB_OVERRIDE_MODE removed), index.ts (boot path always-local)}`; `apps/mcp-server/__tests__/integration/boot-team-mode-local-sqlite.test.ts` (renamed + rewritten); `packages/db/__tests__/unit/client.test.ts` (kind-discriminator coverage replacing the old mode-dispatch tests); `docs/DEVELOPMENT.md` "Local team-mode auth dev" rewritten; `docs/verification/2026-04-25-module-01-02-verification.md` §11 appendix marks §8.3 closed; `External api and library reference.md` Drizzle subsection adds a "createDb local-vs-cloud routing" note.

## 2026-04-25 16:00 — Module 03 S5: scaffolded apps/hooks-bridge with Hono + auth chain inheritance

**Decision:** Created `apps/hooks-bridge/` workspace package — Hono service on `127.0.0.1:3101` per `system-architecture.md` §3.5. Mirrors mcp-server's bootstrap shape (stderr-logging guard, Zod-validated env, lib/db factory always passing kind: 'local'). The three POST /v1/hooks/{claude-code,windsurf,cursor} routes are mounted with the three-layer auth chain extracted to `@coodra/contextos-shared/auth` in S3. GET /healthz is unauthed.

**Rationale:** Pairs with mcp-server (read surface) per CQRS pattern 1. Module 03's whole point is to land this service before any of the per-agent adapter, RunRecorder, or policy-enforcement code can be wired — the scaffold is the load-bearing first slice. Choosing the same layout as mcp-server (config/env, bootstrap, lib, app, index) means a future maintainer reading either app's code can navigate the other in seconds.

**Test architecture:** vi.mock('@clerk/backend') in hooks-bridge's auth-chain integration test was deliberately removed — the same pattern that bit Module 03 S3 (mock doesn't reach the dist's transitive import). The Clerk path's wire code is exercised in `packages/shared/__tests__/unit/auth/auth.test.ts` where the mock applies natively. hooks-bridge tests stay at chain-order granularity: solo-bypass / X-Local-Hook-Secret / no-auth-401 / wrong-secret-401 / bad-Bearer-401 / all-three-routes-share-chain.

**Reference:** `apps/hooks-bridge/{package.json, tsconfig.json, tsconfig.typecheck.json, vitest.config.ts, vitest.integration.config.ts, src/{bootstrap,config,lib,app,index}.ts, __tests__/{unit/config/env.test.ts, integration/{healthz,auth-chain}.test.ts}}`; `.github/workflows/ci.yml` (integration + e2e jobs build hooks-bridge dist).

## 2026-04-25 16:30 — Module 03 S6: per-agent adapters + HookEvent + normalizeSessionId (closes verification §8.6)

**Decision:** Built `packages/shared/src/hooks/` with: `event.ts` (HookEventSchema + HookEvent type per §3.4), `normalize-session-id.ts` (the single function that sanitises agent-supplied session ids at the hooks-bridge boundary), `payloads/{claude-code,windsurf,cursor}.ts` (Zod schemas with `.strict()` rejecting unknown top-level fields), `adapters/{claude-code,windsurf,cursor}.ts` (per-agent normalizers producing HookEvent or null), and `index.ts` (barrel). New subpath export `./hooks` on `@coodra/contextos-shared/package.json`. Wired the adapters into hooks-bridge routes in `apps/hooks-bridge/src/app.ts` with fail-open on Zod parse failure (returns `permissionDecision: 'allow'` + `reason: 'invalid_hook_payload'` + WARN log).

**§8.6 closure:** the Module 02 commit `315c41d` introduced `runKeySegmentSchema` and used it at the MCP registry boundary, protecting the read surface. Module 03 S6 extends the same invariant to the write surface: every hooks-bridge ingress runs the agent-supplied session_id (Claude Code's `session_id`, Windsurf's `trajectory_id`, Cursor's `conversation_id`) through `normalizeSessionId(raw)`, which sanitises Windows-reserved chars + whitespace + collapses double-hyphens + ends with `runKeySegmentSchema.parse(...)` (defence-in-depth — empty result throws). The carryover that the Module 02 verification report flagged as "Hooks Bridge ingress is the place this needs to land" is now landed.

**Adapter pattern (§16 pattern 12):** the three adapters produce HookEvents that match across the four downstream-relevant fields (eventPhase, toolName, filePath, rawAt) for semantically-equivalent inputs. Adding a new agent in the future is one new payload schema + one new adapter + one new shell script — zero agent-specific code downstream of the adapter. Locked by `__tests__/unit/hooks/adapter-parity.test.ts`.

**Tool-name normalization:** Windsurf's `agent_action_name` is the lifecycle marker (pre_write_code), not the tool name. The adapter maps it to the same vocabulary Claude Code uses (Write, Edit, Bash, Read, MCP, user_prompt) so policy rules don't need per-agent matching. Cursor passes `tool_name` through as-is, matching Claude Code's convention.

**Cursor payload note:** Cursor's hook system is newer + less stable than Claude Code's or Windsurf's; the schema reflects the shape ContextOS observes today. `.strict()` rejects unknown fields — drift surfaces as a parse failure with fail-open, not a silent misroute.

**Three Windsurf events deliberately unmapped:** `post_read_code`, `post_user_prompt`, `pre_cascade_response` per `system-architecture.md` §3.3 mapping table. Adapter returns `null` for those; route returns `{ decision: 'allow' }` without invoking dispatch — preserves the "ack but don't process" semantic.

**Reference:** `packages/shared/src/hooks/{event.ts, normalize-session-id.ts, payloads/{claude-code,windsurf,cursor}.ts, adapters/{claude-code,windsurf,cursor}.ts, index.ts}`; `packages/shared/package.json` (./hooks subpath export); `apps/hooks-bridge/src/app.ts` (route handlers wired through Zod validate + adapter + dispatch); 5 test files under `packages/shared/__tests__/unit/hooks/` (24 tests); `apps/hooks-bridge/__tests__/integration/adapters.test.ts` (7 tests covering happy-path + Zod rejection + non-JSON + unmapped event + deny propagation across all three agents); `docs/verification/2026-04-25-module-01-02-verification.md` §11 marks §8.6 closed in S6.

## 2026-04-25 16:45 — Module 03 S7: pre-tool policy enforcement + project resolver (cwd → slug → projects.id)

**Decision:** Built the pre-tool-use handler at `apps/hooks-bridge/src/handlers/pre-tool-use.ts`. Composed via `apps/hooks-bridge/src/lib/dispatch.ts`'s `composeDispatch({ preToolUse })` which routes by `eventPhase`: `'pre'` → real policy enforcement; everything else → S8/S9 stubs (returns allow until those slices wire RunRecorder + lifecycle handlers). The dispatch is plumbed into `buildApp({ env, dispatch })` in `index.ts`.

**Project resolver:** the policy evaluator filters `policies.project_id` against a UUID, but `.contextos.json` and tools speak in slugs. The resolver at `apps/hooks-bridge/src/lib/resolve-project-slug.ts` does the two-stage lookup — cwd → slug (read `<cwd>/.contextos.json`) → projects.id (DB SELECT) — with separate 60s caches per stage. On any failure (file missing, schema mismatch, DB error, slug not registered): returns `{ slug: undefined, projectId: undefined }` and the policy evaluator falls back to its `__global__` cache slot (loads every project's rules unfiltered). Soft-fail by design: the policy still runs at coarser scope.

**Fail-open posture (spec acceptance #13):** the handler explicitly catches `policy.evaluate` throws and returns `{ permissionDecision: 'allow', permissionDecisionReason: 'policy_check_unavailable' }`. The cockatiel breaker + timeout fuse already inside `@coodra/contextos-policy::createPolicyClient` provides the underlying fail-open; this handler's catch is the second line. Three fail-open paths covered by unit tests: evaluator throws, project slug undefined, wrong eventPhase (defensive belt-and-suspenders).

**§4.3 idempotency-key shape:** `${event.sessionId}-${event.turnId ?? 'no-turn'}-pre`. The `'no-turn'` sentinel handles SessionStart events that may legitimately lack a turn (S9 will use it). Wrapped in `{ kind: 'mutating' as const }` because pre-tool-use writes `policy_decisions` (S8 lands the actual setImmediate audit dispatch — this slice focused on the decision path).

**Tests:** 4 unit tests in `__tests__/unit/handlers/pre-tool-use.test.ts` (fail-open paths from spec acceptance #13). 4 integration tests in `__tests__/integration/handlers/pre-tool-use.test.ts` boot a real SQLite (with sqlite-vec extension loaded — required by migration 0001), seed one project + one policy + one deny rule (`Write` to `src/auth/**`), then exercise: claude-code Write to src/auth/x.ts → deny; claude-code Write to src/utils/y.ts → allow; cursor Write to src/auth/x.ts → deny (cross-agent rule applies); claude-code PostToolUse → allow (S8 stub).

**Gotcha caught:** initial test seeded `projects` row without `org_id`; schema requires it (NOT NULL). Fixed by adding `orgId: 'org_dev_local'`. Also caught: passing `slug` as `projectId` in PolicyInput would fail rule matching since the evaluator filters `policies.project_id` (UUID), not slug — added the slug→id lookup to the resolver.

**Reference:** `apps/hooks-bridge/src/{handlers/pre-tool-use.ts, lib/{resolve-project-slug.ts,dispatch.ts}, index.ts}`; `apps/hooks-bridge/__tests__/{unit/handlers/pre-tool-use.test.ts, integration/handlers/pre-tool-use.test.ts}`. `apps/mcp-server/src/tools/check-policy/handler.ts::resolveProjectId` is the precedent for the slug→id pattern.

## 2026-04-25 17:00 — Module 03 S8: post-tool RunRecorder + policy_decisions audit; sha256 id replaces architecture's hyphen-separated key

**Decision:** Built `apps/hooks-bridge/src/lib/run-recorder.ts` with two methods — `recordPostToolUse(event)` writing `run_events` and `recordPolicyDecision({event, projectId, ...})` writing `policy_decisions`. Both methods are sync-return; the actual DB write goes through `setImmediate` (or a test-injected schedule). Wired into `app.ts` via `composeDispatch({ preToolUse, postToolUse })` — `eventPhase === 'post'` now routes through the real handler. Pre-tool handler also accepts an optional RunRecorder and schedules the audit-write per call.

**run_events.id shape — the architecture deviation:** `system-architecture.md §4.3` specifies `{sessionId}-{toolUseId}-{phase}` as the run-event idempotency key. `@coodra/contextos-shared::generateRunEventKey` enforces this shape and rejects hyphens in the segments (`assertRunEventKeySegment` throws on `:` or `-`). But Module 03 S6's `normalizeSessionId` produces hyphen-rich session ids by design — every Windows-reserved char + whitespace + colon is replaced with a hyphen. Result: every hook ingress fails the run-event key build with `ValidationError: sessionId must not contain ':' or '-'`.

Resolution: build the id as `re_` + sha256(sessionId + '|' + toolUseId + '|' + phase).slice(0, 32). The hash captures the same uniqueness contract while accepting any input. Architecture's stated SHAPE is preserved in spirit (deterministic per-event triple); the wire form differs.

**Why not just relax the shared validator?** The validator protects two consumers: hooks-bridge run_events (this slice) AND any future code path that wants to construct a deterministic event key for parsing. Relaxing the validator silently changes the parse contract for the latter. The local recorder hash keeps the boundary contract narrow — hooks-bridge owns its own id shape. shared/idempotency stays strict for callers who need parseable keys.

**8KB tool_input clamp:** `clampToolInput(value)` JSON-serialises and truncates to 8 * 1024 Unicode code points via `Array.from(s).slice(0, N).join('')`. Unicode code-point safe — a multi-byte char at position 8191 stays intact. Same clamp shape Module 02's policy_decisions audit uses.

**runId is best-effort:** PostToolUse may arrive before SessionStart creates the `runs` row. The recorder calls a (currently no-op) `lookupRunId` and writes `runId: null` if no match. The schema's `ON DELETE SET NULL` is exactly the design that supports this. S9 (SessionStart/Stop) will own the runs lookup; the recorder's `lookupRunId` is wired but currently passes `projectSlug: undefined` — projectSlug threading lands when the post-tool-use handler grows the project resolver.

**Test schedule contract:** `RunRecorder.schedule` accepts `(cb: () => Promise<void>) => void`. Default fires-and-forgets via setImmediate; test override pushes the returned promise onto a tracked `pending` array, and the test calls `await drain()` before assertions. Production setImmediate is proven idempotent by the SQL layer; sync drain just removes timing flakiness from the suite.

**Reference:** `apps/hooks-bridge/src/lib/run-recorder.ts`, `apps/hooks-bridge/src/handlers/post-tool-use.ts`, `apps/hooks-bridge/src/lib/dispatch.ts` (composer extended), `apps/hooks-bridge/src/handlers/pre-tool-use.ts` (audit-write wiring), `apps/hooks-bridge/src/index.ts` (createRunRecorder wiring); `apps/hooks-bridge/__tests__/{unit/handlers/post-tool-use.test.ts, integration/handlers/post-tool-use.test.ts}` (3 idempotency + clamp tests).

## 2026-05-02 17:30 — M08a doc reconciliation: rewrite landed slices into "what landed" style (M02 §S7a–§S8 convention)

**Decision:** `docs/feature-packs/08a-cli/implementation.md` rewritten in place. Every slice in the original 10-slice plan (S0–S9) plus the same-merge post-S9 integration-walk fixes plus the five standalone post-merge follow-up commits are now in landed-style with commit SHA, what shipped, tests, gate, and deferred follow-ups — matching the M02 `§S7a` / `§S7b` / `§S7c` / `§S8` convention. The only entries that retain plan-style framing are the closing prose sections (`After M08a — what gets unblocked`, `Per-slice integration-harness gate`, `Doc reconciliations applied in this module's commits`) and a new `Remaining slice surface` summary that explicitly answers "**none** in the original M08a plan."

**Slice-to-commit map:**

- **S0** — `53be96a` (2026-04-25, `docs(feature-pack): Module 08a CLI — spec/implementation/techstack`).
- **S1–S9** — squashed in `93736f6` (2026-04-27, `feat(module-08a + module-03): @coodra/contextos-cli + Hooks Bridge + post-08a integration walk (#2)`). Per-slice commit subjects preserved verbatim from the squashed PR body so the doc cites the exact `feat(cli): ...` line that landed.
- **Post-S9 integration-walk fixes** — also in `93736f6` (5 fixes: `ensureProject` for user's slug, default `CONTEXTOS_LOG_DESTINATION=stderr`, tsbuildinfo out of `dist/`, doctor-check-7 → RED, daemon stdout/stderr to `~/.contextos/logs/`).
- **Post-S9.1** — `64e4067` (PID-aware doctor checks 10/11; `bin/cli` helper).
- **Post-S9.2** — `313d6f0` (Module 03.1 outbox lands `packages/cli/src/lib/outbox/` + doctor checks 21/22/23 + check-13 permanent-yellow → GREEN flip).
- **Post-S9.3** — `6d16b2c` + `6bc0cad` + `0c0768a` (Finding-A layered `.env` loader in `resolveServices` + cwd-mocked tests).
- **Post-S9.4** — `d7a3238` (pipefail-safe doctor checks; biome template-lit cleanup).
- **Post-S9.5** — `907db6a` (Module 04a sync daemon lands `packages/cli/src/commands/cloud-migrate.ts` + doctor checks 24–27 + sync-daemon service entry in `services.ts`).

**Why now:** the user just completed a Phase-3 cross-cutting fix run (rename `@contextos/*` → `@coodra/contextos-*` + Fixes A–E) on top of `907db6a`. The implementation.md was last revised at S0 (in plan-style) and never updated as the slices landed; reading the current doc against the current code makes M08a look unfinished when in fact every slice is committed. The reconciliation is doc-only and aligns the M08a feature pack's narrative with M02's already-landed-in-style convention. Keeps future agents from accidentally trying to "start S1 — package scaffold" against an already-shipped surface.

**Same-commit verifications:**

- `meta.json` glob check: `sourceFiles: ["packages/cli/**", "docs/feature-packs/08a-cli/**"]` still matches the actual repo layout (`packages/cli/{src,scripts,__tests__,package.json,tsconfig*.json,vitest*.config.ts,README.md}` are all under the first glob; the four 08a docs are under the second). No edit needed.
- Phase 2 (`dec_83ba10c1`) and Phase 3 (`@coodra` rename + Fixes A–E) are flagged in the new `Remaining slice surface` section as cross-cutting M02/M03 follow-ups — explicitly **not** new M08a slices — so the next agent doesn't mis-categorize them.

**Reference:** `docs/feature-packs/08a-cli/implementation.md` (full rewrite); `context_memory/decisions-log.md` (this entry); `docs/feature-packs/08a-cli/meta.json` (verified, no change). Convention precedent: `docs/feature-packs/02-mcp-server/implementation.md` §S7a / §S7b / §S7c / §S8.

## 2026-05-02 23:30 — Phase 4 Fix F: default-policy + hook matcher must cover ALL file-mutating tools

**Decision:** Two coupled fixes to the default-deny posture: (1) expand `packages/db/src/ensure-default-policy.ts`'s seeded rule set from 9 rules covering only Write+Edit to 25 rules covering the cross-product of {Write, Edit, MultiEdit, NotebookEdit} × {.env, **/.env, .git/**, **/.git/**, node_modules/**, **/node_modules/**} + the existing Bash→ask rule; (2) replace `packages/cli/src/lib/init/claude-settings-merge.ts`'s matcher='__contextos__' sentinel (which never matched any real Claude Code tool name) with per-event matchers — `Write|Edit|MultiEdit|NotebookEdit|Bash` for PreToolUse/PostToolUse, omitted for SessionStart/Stop — and switch ownership detection from matcher-by-sentinel to URL-by-bridge-endpoint.

**Rationale:** Caught during demo rehearsal. The Phase 3 Fix D rule list claimed to deny dangerous writes but actually only covered two of the four file-mutating tool names Claude Code surfaces; `MultiEdit` and `NotebookEdit` against `.env` slipped through. The settings.json matcher had a separate but related defect: `__contextos__` is documented as a regex over tool names for PreToolUse/PostToolUse, so the literal sentinel never matched any tool — the hooks were functionally inert for Claude Code (Cursor and Windsurf are unaffected because their adapters POST directly without going through the matcher). The protection users believed they had — "the bridge denies dangerous writes" — was demonstrably absent for both reasons.

**Alternatives considered:**
- (rejected) ship Bash with priority >100 so it stays "last" in the listing — would create a duplicate row for existing installs (Phase 3 install at priority 70 + Phase 4 added at 100), no functional benefit. Bash priority stays at 70; it sits between Edit's last priority 60 and MultiEdit's first 80, but priority order doesn't matter when toolName predicates partition the rule space.
- (rejected) destructive-replace existing `__default__` rules on re-run — would erase user customizations. Chose additive merge keyed on `(priority, eventType, toolName, pathGlob)` 4-tuple. Existing rules never touched; only missing-from-baseline rules added.
- (rejected) ship a separate `contextos repair` command for existing-install repair — adds a surface users have to remember. Chose to make `ensureDefaultPolicy` self-healing on re-run (which init already calls). A user upgrading after this fix re-runs `contextos init` and the additive merge fills the 16 missing rules automatically.
- (rejected) keep matcher='__contextos__' as the ownership marker AND add a separate matcher-list field — would require Claude Code to honor an extension field outside the documented schema. Chose URL-based ownership detection: a hook entry is ContextOS-owned iff any of its hooks has a URL pointing at the configured bridge endpoint. Robust, schema-clean, survives future matcher changes.

**Verification:** A new integration test `apps/hooks-bridge/__tests__/integration/handlers/default-policy-tool-coverage.test.ts` walks the cross-product of 4 tools × 6 paths = 24 deny cases plus an allow-sanity case, against the SAME code path init uses (`ensureGlobalProject` → `ensureProject` → `ensureDefaultPolicy`). Pre-fix run on `main`: 16 failed / 9 passed. Post-fix run on `feat/phase4-fix-f-policy-tool-coverage`: 25 passed / 0 failed. `__tests__/manual/verify-f5-live.ts` extended with three new live MCP-stdio cases (Edit on .env, MultiEdit on apps/web/.env, NotebookEdit on .git/HEAD) so future regressions surface in manual verification too.

**Reference:** `packages/db/src/ensure-default-policy.ts` (DEFAULT_RULES expansion + additive-merge); `packages/cli/src/lib/init/claude-settings-merge.ts` (per-event matchers + URL-based ownership + legacy migration); `apps/hooks-bridge/__tests__/integration/handlers/default-policy-tool-coverage.test.ts` (regression test); `docs/feature-packs/08a-cli/implementation.md` (Phase 3 Fix D entry updated to reference Phase 4 Fix F).


## 2026-05-03 — Module 08b (CLI Expansion) kickoff: 19 slices, 8 OQs locked

**Decision:** Open `feat/08b-cli-expansion` and execute the 19-slice plan in `docs/feature-packs/08b-cli-expansion/implementation.md` (one commit per slice). Three orthogonal concerns ship together because each is too small for its own module and all share M08a's package, exit-code contract, daemon manager, runtime-paths resolver, and init pipeline: (S1–S8 + S18) operational essentials + kill switches; (S9–S12) admin surfaces (policy/project/run/export); (S13–S17) Feature Pack flexibility (7 bundled templates + `init --template/--mode` + `pack {new,list,show,regenerate,delete}` + the `<!-- @auto -->` marker contract). One schema delta only: `kill_switches` table at migration `0007_*` (the 0006 slot is taken by Phase 4 Fix K's `policy_rules` UNIQUE-constraint cleanup landed on `main` 2026-05-03 at commit `92e37a6`). M08b is non-blocking for every other module — every other module CAN ship without it; M08b makes operating ContextOS pleasant rather than possible.

**Rationale:** The `2026-05-03 product audit` and the Phase 4 Fix series surfaced that the M02/M03 backbone is sound but operating it requires raw SQLite editing today. M08b makes admin surfaces first-class without changing the architectural shape (no new services, no new wire formats, no schema rework). Bundling operational + admin + template work into one module keeps the surface coherent — splitting them would force three rounds of `init` re-wiring and three CLI version bumps.

**Alternatives considered:** Defer admin surfaces to M04 Web App (rejected — M04 will render against M08b's CLI shapes, not the other way around; building admin in the Web App first would couple the admin contract to React/Next.js renderer choices). Ship kill switches as a separate micro-module (rejected — too small, would force two `init` re-runs). Skip templates entirely and rely on the existing `generic` skeleton (rejected — the 2026-05-03 audit observed that `init` produces an unhelpful skeleton in real-world projects; templates buy real first-run UX without any architecture change).

**Reference:** `docs/feature-packs/08b-cli-expansion/{spec.md,implementation.md,techstack.md,meta.json}`; `docs/audit/2026-05-03-product-audit.md`; commits `d4cd2f8` (Phase 4 Fix L) → kickoff branch base.

## 2026-05-03 — M08b OQ-1 lock: kill-switch default mode = hard

**Decision:** `contextos pause` accepts `--mode hard` and `--mode soft`; default = `hard` when `--mode` is omitted. Hard mode causes the bridge to return `permissionDecision: 'deny'` with reason `kill_switch_paused:<id>` for matching pre-tool events. Soft mode causes the bridge to return `permissionDecision: 'allow'` AND record a synthetic `policy_decisions` row with reason `kill_switch_paused:<id>` so the audit trail is preserved without enforcement.

**Rationale:** "Pause" reads as "stop the system" in operator parlance; hard-by-default matches that mental model and the deny-by-default posture the rest of the policy chain enforces. Soft is the rare case where the user wants observability without enforcement (e.g., running a demo while still capturing what the agent attempted).

**Alternatives considered:** Hard-only (rejected — eliminates the observability use case). Soft-only (rejected — fights the mental model). Both available with default = soft (rejected — surprising default; users who type `pause` expect things to stop).

**Reference:** `docs/feature-packs/08b-cli-expansion/spec.md` §11 OQ-1; constrains `implementation.md` S2 (bridge translation) + S3 (CLI default flag).

## 2026-05-03 — M08b OQ-2 lock: kill-switch schema = polymorphic (scope, target)

**Decision:** `kill_switches.scope` is `text NOT NULL CHECK (scope IN ('global','project','tool','agent_type'))`; `kill_switches.target` is `text NULL` (null when scope='global', otherwise the projectId / toolName / agentType the switch applies to). Bridge match query is `WHERE resumed_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND (scope='global' OR (scope=? AND target=?))`.

**Rationale:** Adding a fifth scope value (e.g., `org`, `repo`) is a one-line CHECK-constraint update rather than a column-addition migration; the bridge's match logic is a 4-row table read either way. The compactness wins for both the schema-parity test (M01 enforces that SQLite and Postgres dialects differ only by text↔vector) and the JSON shape exposed via `contextos run show`.

**Alternatives considered:** Multi-column shape with four nullable cols (`project_id` FK, `tool_name`, `agent_type`, all-null = global) (rejected — adding a fifth scope is a schema migration; no column gives a useful FK except `project_id`, which doesn't justify the shape change for one column).

**Reference:** `docs/feature-packs/08b-cli-expansion/spec.md` §6 + §11 OQ-2; constrains `implementation.md` S1 (migration shape) + S2 (bridge evaluator's match query).

## 2026-05-03 — M08b OQ-3 lock: db backup default = single-file VACUUM INTO; --include-logs = tarball

**Decision:** `contextos db backup` defaults to a single-file `.sqlite` produced via `VACUUM INTO`. With `--include-logs`, it produces a `.tar.gz` containing `data.db.bak` + `logs/*.log` + `config.json` (mode-0600 preserved). No compression on the default single-file path — SQLite is already compact and gzip adds restore friction.

**Rationale:** Single-file is the operator-friendly default — drops cleanly into any backup tool (Time Machine, rsync, Duplicati, AWS Backup). The tarball is for full-environment reproduction (e.g., reproducing a bug for support; sending a frozen-in-time snapshot of a developer's local state).

**Alternatives considered:** Tarball-only with the SQLite file inside (rejected — restore friction for the common case). Compressed `.sqlite.gz` default (rejected — adds gzip-decompress step on restore for negligible space win on already-compact SQLite).

**Reference:** `docs/feature-packs/08b-cli-expansion/spec.md` §11 OQ-3; constrains `implementation.md` S6 (default backup path doesn't pull in `tar` dep; `--include-logs` does).

## 2026-05-03 — M08b OQ-4 lock: db restore = atomic replace + auto-backup-of-current; refuses if daemons running

**Decision:** `contextos db restore <path>` validates the source file (SQLite magic-bytes header `53 51 4c 69 74 65 20 66 6f 72 6d 61 74 20 33 00`), refuses if any of the three daemons (mcp-server, hooks-bridge, sync-daemon) are running per the M08a `pid-status.ts` check, takes an automatic backup of the current `~/.contextos/data.db` to `<current>.pre-restore-<ISO>` (skippable via `--no-auto-backup` with an aloud warning), then atomic-replaces the live DB via temp-file + rename. No `--with-daemons-running` escape hatch.

**Rationale:** Live import is meaningless for a primary store — merge semantics for `runs.status` transitions, `policy_decisions.idempotency_key` collisions, and the append-only `decisions` table are all ill-defined. SQLite WAL + concurrent writers + atomic file replace = silent corruption; an escape hatch would be a footgun that solves no real operator problem (operators stop daemons before restoring; they never want a "fast" restore with running writers).

**Alternatives considered:** Live row-merge import (rejected — undefined semantics on append-only tables). Stop daemons automatically before restore (rejected — surprising side effect; user should know the daemons are stopping). Allow daemons-running with a `--force --with-daemons-running` escape hatch (rejected — silent-corruption footgun).

**Reference:** `docs/feature-packs/08b-cli-expansion/spec.md` §11 OQ-4; constrains `implementation.md` S6 (restore daemons-running check refuses; auto-backup is unconditional unless `--no-auto-backup`).

## 2026-05-03 — M08b OQ-5 lock: uninstall preserves data by default; --purge opts in to wipe

**Decision:** `contextos uninstall` defaults to a conservative removal: drops the `__contextos__` matcher entries from `~/.claude/settings.json`, removes daemon-manager units, removes the `contextos` server entry from `<cwd>/.mcp.json`. Preserves `~/.contextos/data.db`, `~/.contextos/config.json`, every `docs/feature-packs/<slug>/` folder, every `docs/context-packs/` file. `--purge` adds removal of `~/.contextos/`. The CLI prints (does NOT execute) `npm uninstall -g @coodra/contextos-cli` for the user to run manually.

**Rationale:** Matches the principle of least surprise — `apt-get remove` preserves config by default; `apt-get purge` is the explicit wipe. Users who reinstall expect their feature packs / context packs / kill-switch history to still be there. The npm-uninstall step is left to the user because the binary is mid-execution and self-uninstall is unreliable on Windows.

**Alternatives considered:** Default = wipe everything with `--keep-data` / `--keep-config` opt-outs (rejected — destroys user work on a typo). Default = wipe data but preserve feature/context packs (rejected — the data DB and the packs are coherent state; partial wipe is more surprising than full preserve).

**Reference:** `docs/feature-packs/08b-cli-expansion/spec.md` §11 OQ-5; constrains `implementation.md` S8 (default-safe path; `--purge` opt-in).

## 2026-05-03 — M08b OQ-6 lock: run cancel flips status only; bridge keeps recording

**Decision:** `contextos run cancel <runId>` writes `runs.status='cancelled'` + `runs.ended_at=now()` and nothing else. The bridge keeps recording any PostToolUse / PreToolUse / SessionEnd events that arrive for that run if any do; cancellation is informational metadata. The bridge does NOT consult `runs.status` on the latency-sensitive event paths.

**Rationale:** Adding a `runs.status` lookup on every PostToolUse costs ~1 ms of SQLite roundtrip on a path with a 10 ms p95 budget per M03; the gain (refusing to record events for an already-cancelled run) is debugging-utility-grade, not production-grade. Once a developer closes a session, no PostToolUse events arrive anyway. A future "replay events through the bridge" feature would benefit from cancellation-as-block, but that's an M04 / M05 surface, not M08b.

**Alternatives considered:** Bridge denies / refuses to record post-cancel events (rejected — costs latency, solves a non-problem in production). Bridge re-opens the run (sets status back to in_progress) on receiving a post-cancel event (rejected — silently undoes user intent).

**Reference:** `docs/feature-packs/08b-cli-expansion/spec.md` §11 OQ-6; constrains `implementation.md` S11 (`run cancel` writes `runs.status` only).

## 2026-05-03 — M08b OQ-7 lock: export non-JSON formats exclude audit by default

**Decision:** `contextos export <runId> --format markdown|html|slack` excludes `policy_decisions` rows from the rendered output by default. `--include-audit` opts in to include them. `--format json` ALWAYS includes the full audit (machine-readable consumers want full fidelity).

**Rationale:** Markdown / HTML / Slack are narrative formats — the reader (a stakeholder, a code reviewer, a Slack channel) wants "what was decided + why + what files changed", not a 200-row deny audit interleaved with the prose. JSON consumers (CI exports, SOC2 review tooling, future M04 admin pages) need the full audit to do their job.

**Alternatives considered:** Default-include audit for all formats (rejected — narrative formats become unreadable for non-trivial runs). Per-format default config in `~/.contextos/config.json` (rejected — adds config surface for one rare flag toggle).

**Reference:** `docs/feature-packs/08b-cli-expansion/spec.md` §11 OQ-7; constrains `implementation.md` S12 (renderers default `includeAudit=false` for narrative formats; JSON renderer hard-codes `includeAudit=true`).

## 2026-05-03 — M08b OQ-8 lock: kill switches are local-only in M08b; cross-developer sync is M04's surface

**Decision:** A kill switch flipped on developer A's machine does NOT propagate to developer B in M08b. Synced kill switches are an M04 admin-surface concern (admin flips a global switch from the dashboard; the cloud-sync path established in M04a replicates the row to every connected hooks-bridge). M08b's kill switches write to local SQLite only; the sync-daemon (M04a) does not enqueue kill-switch rows.

**Rationale:** M08b ships solo + team-mode-self-host but no managed-cloud product yet — there is no "the team" to sync to. M04 owns the cross-developer admin surface; building the sync path now would couple M08b to a not-yet-decided cloud authorization model (who is allowed to flip a global kill switch on someone else's machine?). The local-only kill switch still solves the operator's "stop the system on my machine" problem completely.

**Alternatives considered:** Sync from day one via the existing M04a cloud-sync path (rejected — no cloud product, no authorization model, premature coupling). Per-machine kill switches with optional `--sync` flag (rejected — adds the same authorization-model question without committing to the answer).

**Reference:** `docs/feature-packs/08b-cli-expansion/spec.md` §11 OQ-8; constrains `implementation.md` S2 (no sync-daemon enqueue) + S3 (CLI never POSTs to cloud); flagged in M08b closeout pack as deferred to M04.
