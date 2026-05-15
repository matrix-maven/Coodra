# Module 01 — Foundation — Spec

> **Status:** in progress (2026-04-22)
> **Depends on:** nothing (base module)
> **Blocks:** every other module (02 MCP Server, 03 Hooks Bridge, 04 Web App, 05 NL Assembly, 06 Semantic Diff, 07 VS Code Extension)
> **Source of truth:** `system-architecture.md` §1, §2, §4.1–4.3, §7, §14, §20; `essentialsforclaude/07-style-and-conventions.md`, `08-implementation-order.md`, `11-adrs.md`

## 1. What Foundation is

Foundation is the shared substrate every downstream module depends on. It is **not** a service. It ships:

- The monorepo layout (pnpm workspaces + Turborepo) that all subsequent modules plug into.
- The strict-TypeScript baseline (`tsconfig.base.json`), the single lint/format toolchain (Biome), and the single test runner (Vitest).
- The shared TypeScript library (`packages/shared`) that every service imports: structured logging (pino), typed error hierarchy, Zod-based env validation, and idempotency-key helpers whose shapes match `system-architecture.md` §4.3 exactly.
- The database package (`packages/db`) with Drizzle schemas for both dialects (SQLite for solo, Postgres for team), a `createDb()` factory that selects the driver by `COODRA_MODE`, the initial numbered migrations for a 5-table append-only core (`projects`, `runs`, `run_events`, `context_packs`, `pending_jobs`), and a CI-enforced schema-parity test between the two dialects.
- The local docker-compose stack (pgvector + Redis) used from Module 02 onward for integration tests.
- The CI pipeline (`.github/workflows/ci.yml`) with lint, typecheck, unit, and integration jobs.
- A stub `.mcp.json` so Claude Code / Cursor / Windsurf pick up a valid MCP entry now; it will fail to connect until Module 02 ships the server.
- `context_memory/` scaffolding for working memory across AI-agent sessions per `essentialsforclaude/03-context-memory.md`.
- Documentation entry points: `docs/DEVELOPMENT.md` and `docs/context-packs/template.md`.

## 2. Acceptance criteria

A commit on `feat/01-foundation` is only "complete" when **every** item below holds on a clean checkout:

1. `pnpm install` succeeds with no peer-dependency warnings treated as errors.
2. `pnpm lint` — zero Biome findings.
3. `pnpm typecheck` — `tsc --noEmit` clean across every workspace package.
4. `pnpm test:unit` — every unit test passes. Coverage ≥ 80% line coverage on `packages/shared` and `packages/db` (per `essentialsforclaude/06-testing.md` §6.4).
5. **Schema parity test passes.** A Vitest assertion in `packages/db/__tests__/unit/schema-parity.test.ts` compares column names + nullability + type category between `schema/sqlite.ts` and `schema/postgres.ts` for every table in the 5-table core and **fails the build** on any mismatch. Not a warning.
6. **Idempotency-key shape tests pass.** Unit tests in `packages/shared/__tests__/unit/idempotency.test.ts` assert `generateRunKey` emits the exact regex `^run:[^:]+:[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` and `generateRunEventKey` emits `^[^:-]+-[^:-]+-(pre|post)$` (or equivalent shapes derived literally from `system-architecture.md` §4.3). Drift fails CI.
7. The docker-compose stack **parses** (`docker compose config`) — a local Docker daemon is not required during Module 01 because no integration test runs in CI yet. It becomes required in Module 02.
8. `.mcp.json` is a valid JSON config pointing to `http://127.0.0.1:3100/mcp` with an inline comment-equivalent field (`"_comment"`) explaining connection failures are expected until Module 02 ships.
9. `context_memory/current-session.md` has a populated Log section covering every file write in Module 01; `context_memory/decisions-log.md` has one entry per design decision made during Module 01.
10. `docs/context-packs/2026-04-22-module-01-foundation.md` exists and matches `docs/context-packs/template.md`.
11. Git: `main` has two commits (docs import + root metadata incl. MIT LICENSE); `feat/01-foundation` has one commit per logical slice. Every commit that bumps a package version also amends the matching entry in `External api and library reference.md` (and `system-architecture.md` where relevant) **in the same commit** (amendment B).

## 3. Non-goals

These are deliberately excluded from Module 01 and are **not** stubbed:

- No `apps/mcp-server/`, `apps/hooks-bridge/`, `apps/web/`, `apps/vscode/`. Those are Modules 02/03/04/07. Creating empty packages now would be a shallow proxy (`01-development-discipline.md` §1.1).
- No `services/nl-assembly/` or `services/semantic-diff/` Python scaffolding. Those arrive with Modules 05/06.
- No integration tests and no E2E tests. There is no service to integrate against yet.
- No Clerk wiring beyond the `sk_test_replace_me` solo-bypass fixture (per decision Q8; Clerk provisioning deferred to Module 04).
- No actual Graphify ingestion. The adapter is Module 02.
- No MCP tools. Just a stub `.mcp.json`. Module 02 implements the server and registers the manifest.
- No schema tables beyond the 5-table core (per decision Q9). Later modules own their own tables via new numbered migrations.

## 4. Scope of the 5-table core

These tables ship in Module 01's `packages/db/src/schema/{sqlite,postgres}.ts` and are created by the initial migration. Every downstream module reads them; some write to them. No other module may redefine them.

| Table | Purpose | Append-only? | Primary source in architecture |
|---|---|---|---|
| `projects` | One row per Coodra-managed project. Carries `slug`, `orgId`, `createdAt`. Referenced by every other table's `project_id` FK. | No (projects can be updated) | §2 Service Inventory, §4 |
| `runs` | One row per AI-agent session. Carries `runId`, `projectId`, `sessionId`, `agentType`, `mode` (solo/team), `status`, timestamps, `issueRef` (nullable), `prRef` (nullable). Idempotency key: `run:{projectId}:{sessionId}:{uuid}`. | No (status transitions) | §4.3, §22.5, §23 |
| `run_events` | Immutable tool-use trace entries. Carries `eventId`, `runId`, `phase` (`pre`/`post`), `toolName`, `toolInput` (JSON), `outcome`, `createdAt`. Idempotency key: `{sessionId}-{toolUseId}-{phase}`. | **Yes** (no UPDATE/DELETE) | §4.3 |
| `context_packs` | One row per completed run's Context Pack. Carries `packId`, `runId`, `projectId`, `title`, `content`, `createdAt`, `summaryEmbedding` (Postgres only, `vector(384)`; SQLite stores the same vector in the `pack_embeddings` sqlite-vec virtual table added by Module 02). | **Yes** | §4.3, §17 |
| `pending_jobs` | In-process SQLite queue for solo mode; analogous cloud Postgres table used as durability ledger before BullMQ enqueue. Carries `id`, `queue`, `payload`, `attempts`, `status`, `runAfter`, `createdAt`. | No (status mutates) | §4.1, §16 |

pgvector types live only in `schema/postgres.ts`; SQLite uses `text` for vector columns and defers vector storage to sqlite-vec (wired in Module 02).

## 5. Mode detection contract

`packages/shared/src/config.ts` exposes a `COODRA_MODE` env value validated as `z.enum(['solo', 'team'])`, defaulting to `'solo'`. `packages/db/src/client.ts`'s `createDb()` factory reads the same env; in solo mode it returns a `better-sqlite3` Drizzle client pointed at `~/.coodra/data.db` (creating the directory if missing). In team mode it returns a `postgres-js` Drizzle client using `DATABASE_URL`. Both code paths are exercised by unit tests; the Postgres path uses a mocked connection in Module 01 and is replaced by a real testcontainers-backed integration test in Module 02.

## 6. Out-of-scope documentation stance

`system-architecture.md` and `External api and library reference.md` are **canonical** and are modified in Module 01 only where Module 01's decisions supersede what they currently say (Biome 2.4.12, Vitest 4.1.5, Zod 4.3.6, Pino 10.3.1, `@hono/node-server` 2.0.0, TypeScript 6). Every such edit is committed in the same commit as the `package.json` change per amendment B.

Next.js 16.2.4 + React 19.2.5 is recorded in `context_memory/decisions-log.md` and flagged in `techstack.md` with rationale "fresh build, zero migration cost, pinning 15 creates upgrade debt" per decision Q2. The matching `system-architecture.md` §2 + `External api and library reference.md` Next.js-section edits are deferred to the Module 04 commit that introduces `apps/web/package.json`, preserving amendment B.

## 7. What "done" hands off to Module 02

- A clean `main` pointing at the squash-merged Foundation commit.
- The 5-table core schema with generated migrations that Module 02 can extend by adding `policy_rules`, `policy_decisions`, `feature_packs`, `integrations`, `integration_tokens`, `integration_events`, `knowledge_edges` in a new numbered migration (`0001_mcp_server_tables.sql`).
- `@coodra/shared` exporting `logger`, error types, `config`, `generateRunKey`, `generateRunEventKey`.
- `@coodra/db` exporting `createDb`, `schema` (dialect-selected), and Drizzle query primitives.
- A working `pnpm test:unit` harness so Module 02 inherits CI green.
- A Context Pack describing everything above.
