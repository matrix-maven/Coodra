# Module 02 — MCP Server — Spec

> **Status:** in progress (2026-04-22)
> **Depends on:** Module 01 (Foundation) — merged on `main` at `88aac10`.
> **Blocks:** Module 03 (Hooks Bridge), Module 04 (Web App), Module 05 (NL Assembly), Module 06 (Semantic Diff), Module 07 (VS Code Extension). Every module from 03 onward calls `coodra__*` tools this module exposes.
> **Source of truth:** `system-architecture.md` §3.5, §4.3, §7, §16, §19, §24; `essentialsforclaude/05-agent-trigger-contract.md`, `essentialsforclaude/09-common-patterns.md §9.1`; `External api and library reference.md` → Protocols & Transports, Auth & Security, Validation/Schemas/Resilience.

## 1. What the MCP Server is

The MCP Server is the single agent-facing read/record surface of Coodra. It is how the IDE-hosted agent (Claude Code, Windsurf, Cursor, Copilot) discovers what tools Coodra offers and invokes them. Without this server the rest of the architecture is unreachable: hooks fire on events the agent triggers, but the agent only triggers tools it knows exist — which it learns exclusively through `tools/list` on this server (§24.2).

Module 02 ships:

- A Node process at `apps/mcp-server/` that speaks the Model Context Protocol (JSON-RPC 2.0) over **two transports simultaneously** (§3.5):
  - **stdio** — for Claude Code, which spawns the server as a subprocess and framed-JSON-RPC over stdin/stdout.
  - **Streamable HTTP** — for Windsurf / Copilot / VS Code, on `http://127.0.0.1:3100/mcp`, per MCP 2025-03-26 transport spec.
- A **tool-registration framework** that enforces the three-file-per-tool pattern (`handler.ts` + `schema.ts` + `manifest.ts`) from `essentialsforclaude/09-common-patterns.md §9.1`.
- **Eight core `coodra__*` tools** with manifest descriptions verbatim from `system-architecture.md` §24.4: `get_run_id`, `get_feature_pack`, `save_context_pack`, `search_packs_nl`, `query_run_history`, `record_decision`, `check_policy`, `query_codebase_graph`.
- A **Policy Engine** per §16 pattern 4 (fail-open) and §24.4 (`check_policy`). New tables: `policies`, `policy_rules`, `policy_decisions`. Decisions are written append-only via the outbox pattern (§16 pattern 3).
- A **Feature Pack service** that reads from `docs/feature-packs/<slug>/` on disk and registers metadata + checksum in a new `feature_packs` table. Inheritance resolution per §16 pattern 9.
- A **Context Pack service** that writes completed-session markdown to `docs/context-packs/YYYY-MM-DD-*.md` AND registers the row in the existing `context_packs` table. Idempotent per `runId` (§4.3).
- A **Run Recorder** that writes to `runs` and `run_events` via the outbox pattern (writes never block the response).
- **sqlite-vec wiring** for `context_packs.summary_embedding`. SQLite uses a parallel `context_packs_vec` virtual table (vec0); Postgres keeps the pgvector column + HNSW index. The dialect-parity exemption from Module 01 is widened by one entry, documented.
- **Auth** — Clerk JWT middleware on the HTTP transport with solo-bypass (§19). Stdio has no auth by construction (local-only, no network surface).
- **Manifest test** — the §24.9 headless-MCP-client integration test that asserts exact tool set, per-tool description length, JSON Schema validity, and that every tool returns either a valid shape or a structured `{ ok: false }` error for a minimal valid input.
- **Graceful fallbacks** for cross-module dependencies (Step 3 of the directive):
  - `search_packs_nl` → SQL LIKE fallback over `title + content_excerpt` when `summary_embedding IS NULL`. Documented in the manifest description and in the Module 02 Context Pack. When Module 05 ships embeddings, the tool automatically returns semantic results without code change.
  - `query_codebase_graph` → returns `{ ok: true, nodes: [], edges: [], notice: 'graphify_index_missing', howToFix: 'run `graphify scan` at repo root' }` when `~/.coodra/graphify/<slug>/graph.json` is absent.

## 2. Acceptance criteria

A commit on `feat/02-mcp-server` is only "complete" when **every** item below holds on a clean checkout:

1. `pnpm install` clean, no peer-dependency warnings escalated to errors.
2. `pnpm lint` — zero Biome findings across the new `apps/mcp-server` + modified `packages/db`.
3. `pnpm typecheck` — `tsc --noEmit` clean across every workspace package.
4. `pnpm test:unit` — every unit test passes. Coverage **≥ 80% line coverage** on `apps/mcp-server` per `essentialsforclaude/06-testing.md §6.4`.
5. `pnpm test:integration` — the four integration tests pass (stdio roundtrip, HTTP roundtrip, manifest-e2e per §24.9, policy-decisions idempotency via testcontainers Postgres).
6. **Schema-parity test still passes** for the Module 01 five-table core **and** the four new tables (`policies`, `policy_rules`, `policy_decisions`, `feature_packs`). The `DIALECT_TYPE_EXEMPTIONS` allowlist grows by exactly one documented entry: SQLite's `context_packs_vec` virtual table (Postgres materialises the equivalent index directly on `context_packs.summary_embedding` via HNSW).
7. **Migration hand-edits are protected.** Every hand-appended SQL block inside a migration file is wrapped in `-- @preserve-begin hand-written` / `-- @preserve-end`, its sha256 is recorded in `packages/db/migrations.lock.json`, and a CI step rejects any mismatch.
8. **`coodra__*` tool count is exactly 8.** `tools/list` returns the eight names verbatim; adding a ninth or dropping one fails `manifest-e2e.test.ts`.
9. **Every tool's description passes the §24.3 shape check:** starts with "Call this" (case-insensitive), word count 40–120 (the upper bound is widened per Q-02-6 and §24.3 is amended in the same commit), `length < 800` chars, mentions the return shape.
10. **Every tool's `inputSchema` is valid JSON Schema** — Ajv 8 `compile()` does not throw in the manifest-e2e test.
11. **Policy Engine is fail-open** per §24.4: on any throw, timeout, or open breaker the tool returns `{ permissionDecision: 'allow', reason: 'policy_check_unavailable' }` and a row is still written to `policy_decisions`.
12. **Policy decision writes are async, idempotent, and logged at WARN on failure** (per Q-02-2). Insert uses `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`; duplicate writes are no-ops. Async-write failure logs include `sessionId`, `toolName`, `eventType`, `matchedRuleId`.
13. **Context Pack excerpt is Unicode-safe.** `content_excerpt` is the first 500 Unicode **code points** (not bytes) of `content` with trailing whitespace trimmed. A unit test with an emoji or CJK character at position 499 asserts lossless truncation.
14. **Feature Pack cache invalidation** is driven by sha256 of `spec.md + implementation.md + techstack.md` concatenated in that fixed order. On-disk-checksum mismatch with the DB row drops the in-process cache entry and updates the row.
15. **Env schema is strict on Clerk keys.** `CLERK_SECRET_KEY` + `CLERK_PUBLISHABLE_KEY` are optional in solo mode OR when `CLERK_SECRET_KEY === 'sk_test_replace_me'`, required in team mode with the placeholder disallowed. Secret must match `/^sk_(test|live)_/`, publishable `/^pk_(test|live)_/`. Failure is a startup `ValidationError` — not a silent degradation.
16. **Env-shape regression test locks the contract** — four fixtures (valid-solo, valid-team, missing-clerk-in-team, malformed-port) in `apps/mcp-server/__tests__/unit/lib/env.test.ts`.
17. **Team-mode auth ships wired but pending live validation.** The middleware layers in order: (a) solo-bypass when `CLERK_SECRET_KEY === 'sk_test_replace_me'`, (b) `X-Local-Hook-Secret` header check against `LOCAL_HOOK_SECRET`, (c) Clerk JWT via `@clerk/backend` `authenticateRequest()`. First match wins. Live Clerk validation is deferred to Module 04 or the first real team-mode flip, recorded in `context_memory/pending-user-actions.md`.
18. **`manifest-e2e.test.ts` exercises both happy paths and documented fallbacks** — `search_packs_nl` without embeddings and `query_codebase_graph` without a Graphify file both return their documented `notice`/`warning` payload, asserted in CI.
19. `docs/context-packs/2026-04-22-module-02-mcp-server.md` exists, matches `docs/context-packs/template.md`, and documents every decision, every file touched, test results, and the two partial-capability fallbacks.
20. `.mcp.json` stub updated to point at the workspace-relative `apps/mcp-server/dist/index.js` per Q-02-7, with an inline `_comment` noting the CLI install helper is deferred to Module 07+.
21. Git: `feat/02-mcp-server` has one commit per logical slice; every commit that adds or bumps a package version amends `External api and library reference.md` (and `system-architecture.md` §24.3 for the word-budget amendment) **in the same commit** per amendment B.

## 3. Non-goals

Explicitly excluded from Module 02 and **not** stubbed (per `essentialsforclaude/01-development-discipline.md §1.1`):

- No JIRA tools (§22). Separate integration module after Module 02 lands.
- No GitHub tools (§23). Separate integration module.
- No Hooks Bridge service. Module 03.
- No Web App / UI. Module 04.
- No NL Assembly service. Module 05. (`search_packs_nl` ships with documented SQL LIKE fallback today; Module 05 adds embeddings without changing this tool's surface.)
- No Semantic Diff service. Module 06.
- No VS Code extension. Module 07.
- No LLM API calls. Those live in NL Assembly.
- No durable outbox via `pending_jobs`. Policy decisions use async `setImmediate` + `ON CONFLICT DO NOTHING`. Revisit post-Module-03 if DB downtime becomes visible (recorded in `context_memory/decisions-log.md`).
- No CLI install helper that symlinks the server into `~/.coodra/bin/`. Deferred to Module 07 or a dedicated distribution module.
- No self-calls of `coodra__*` tools during this build. The server is being constructed; self-calling during construction is a foot-gun. First real call happens when the user reloads their IDE after `feat/02-mcp-server` is merged.

## 4. Scope of the four new tables (migration `0001`)

These tables ship in Module 02's `packages/db/src/schema/{sqlite,postgres}.ts` via migration `0001_module_02_mcp_server.sql`. Every downstream module reads them; none redefines them.

| Table | Purpose | Append-only? | Primary source |
|---|---|---|---|
| `policies` | One row per named policy scoped to a project. Carries `id`, `project_id`, `name`, `description`, `is_active`, `created_at`, `updated_at`. | No (policies are edited by tech leads) | §16, §24.4 |
| `policy_rules` | Individual rules inside a policy. Carries `id`, `policy_id`, `priority`, `match_event_type`, `match_tool_name`, `match_path_glob`, `match_agent_type`, `decision` (`allow`/`deny`/`ask`), `reason`, `created_at`. Evaluation order = `priority ASC`, first match wins. | No (rules are edited) | §16, §24.4 |
| `policy_decisions` | Immutable audit log of every `check_policy` evaluation. Carries `id`, `idempotency_key` (`pd:{sessionId}:{toolName}:{eventType}`), `run_id`, `session_id`, `project_id`, `agent_type`, `event_type`, `tool_name`, `tool_input_snapshot` (JSON), `permission_decision`, `matched_rule_id` (nullable — null on default-allow or fail-open), `reason`, `created_at`. | **Yes** (no UPDATE/DELETE) | §4.3, §24.4 |
| `feature_packs` | Metadata for Feature Packs that live in `docs/feature-packs/<slug>/`. Carries `id`, `slug`, `parent_slug` (nullable — inheritance), `is_active`, `checksum` (sha256 of `spec.md + implementation.md + techstack.md`), `updated_at`. | No | §16 pattern 9, §24.4 |

`context_packs` gains one new column in the same migration:

| Column | Type | Role |
|---|---|---|
| `content_excerpt` | `text NOT NULL` | First 500 Unicode **code points** of `content` with trailing whitespace trimmed. Populated at save time by `save_context_pack`. Indexed to power the `search_packs_nl` LIKE fallback. |

SQLite adds the `context_packs_vec` virtual table via a hand-appended `CREATE VIRTUAL TABLE ... USING vec0(...)` block (vec0 module, cosine distance, `float[384]`). Postgres adds a HNSW index `context_packs_embedding_hnsw` on `context_packs.summary_embedding` via a hand-appended statement. Both hand-appended blocks are wrapped in `-- @preserve-begin hand-written` / `-- @preserve-end` markers and their sha256 is committed to `packages/db/migrations.lock.json`. CI asserts the match on every push.

## 5. Transport contract

Two transports, one server process (§3.5):

### stdio

- Spawned by Claude Code via `.mcp.json` entry. Command (post-Module-02): `node apps/mcp-server/dist/index.js --transport stdio`.
- Wire format: JSON-RPC 2.0 with `Content-Length: N\r\n\r\n` LSP-style framing.
- **Non-negotiable:** the server writes **nothing** to stdout outside protocol frames. Pino log output is redirected to stderr; a test asserts that after 100 tool invocations, `stdout` contains only valid JSON-RPC frames.
- No auth. The parent process owns the stdin handle.

### Streamable HTTP

- Listens on `127.0.0.1:3100`. Bind address is hard-wired to loopback in solo mode; team mode is a Module-04 concern.
- Framework: Hono app served by `@hono/node-server`.
- Endpoint: `POST /mcp` (per MCP 2025-03-26), accepts JSON-RPC requests (single or batch), responds with either `Content-Type: application/json` for unary responses or `Content-Type: text/event-stream` for streamed responses. `GET /mcp` is also supported for the server→client stream leg of Streamable HTTP.
- Health check: `GET /healthz` returns `{ ok: true, runId: <current-or-null>, mode: 'solo'|'team' }`. No auth on this path.
- Auth middleware, in order (per Q-02-1):
  1. Solo-bypass when `CLERK_SECRET_KEY === 'sk_test_replace_me'` → request proceeds with `orgId = 'org_dev_local'`, `userId = 'user_dev_local'`.
  2. `X-Local-Hook-Secret` header equals `LOCAL_HOOK_SECRET` → request proceeds with the secret's mapped orgId.
  3. Full Clerk JWT via `@clerk/backend` `authenticateRequest()` → request proceeds with Clerk-derived identity.
- First match wins. No match → `401 Unauthorized` with structured JSON body `{ ok: false, error: 'unauthorized' }`.

## 6. Fail-open and circuit-breaker discipline

Per §7, §16 pattern 4, and §24.4:

- Every tool handler that touches the DB or filesystem is wrapped by a per-handler `cockatiel` policy: `retry(handleAll, { maxAttempts: 2 })` for transient reads, `circuitBreaker(handleAll, { halfOpenAfter: 30_000, breaker: new ConsecutiveBreaker(5) })` for the policy evaluation path.
- On breaker open in `check_policy`: return `{ permissionDecision: 'allow', reason: 'policy_check_unavailable' }` **and** record the fail-open in `policy_decisions` with `matched_rule_id = null`.
- On any tool throw that is not fail-open-applicable: return `{ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: <string> }) }], isError: true }` per `essentialsforclaude/09-common-patterns.md §9.1`. Never blow up the agent's turn.

## 7. Out-of-scope documentation stance

`system-architecture.md` §24.3 is amended in the same commit that introduces `manifest-e2e.test.ts` to read "40–80 word soft target, 120-word hard maximum" (per Q-02-6). `External api and library reference.md` is amended in every commit that installs a new npm package per amendment B. No other architecture edits land in Module 02 unless a decision directly supersedes what the doc says — and every such edit is committed in the same commit as the code change.

## 8. What "done" hands off to Module 03

- A clean `main` pointing at the squash-merged Module 02 commit.
- The nine-table schema (5 from Module 01 + 4 from Module 02) with numbered migrations that Module 03 can extend by adding `integrations`, `integration_tokens`, `integration_events`, and `knowledge_edges` in `0002_hooks_bridge.sql`.
- `@coodra/mcp-server` binary at `apps/mcp-server/dist/index.js` runnable via `pnpm --filter @coodra/mcp-server dev` (tsx watch) or `node dist/index.js` (compiled).
- Eight `coodra__*` tools callable over both transports.
- Two partial-capability fallbacks (`search_packs_nl` LIKE branch, `query_codebase_graph` graphify-missing notice) active today; automatically upgrade when Modules 05 / 17 ship their dependencies.
- A Module 02 Context Pack describing everything above.
