# Module 01 — Foundation — Implementation Plan

> Follow top-to-bottom. Each step lists the files it creates/modifies and the commit it belongs to. Every commit that bumps a package version amends `External api and library reference.md` (and, for Next.js-class decisions, `system-architecture.md`) **in the same commit** — amendment B in the user-approved plan.

## Prerequisites (one-time, before step 1)

- `node --version` ≥ 22.16.0
- `pnpm --version` ≥ 10.33.0
- `git --version` ≥ 2.40
- Repo-local git identity set (`git config --local user.name` / `user.email`)

`docker` and Python tooling are **not** required during Module 01 but must be installed before Module 02 begins.

## Step sequence

### S1 — Module 01 Feature Pack spec (this commit)

**Files:** `docs/feature-packs/01-foundation/spec.md`, `docs/feature-packs/01-foundation/implementation.md` (this file), `docs/feature-packs/01-foundation/techstack.md`.

**Commit:** `docs(01-foundation): spec, implementation plan, techstack`.

### S2 — Initialize `context_memory/`

Create the folder, seed files with the templates from `essentialsforclaude/03-context-memory.md` §3.3, and backfill the Log section with entries for every file write that has already happened in Module 01 (S1 plus the two commits already on `main`).

**Files:** `context_memory/README.md`, `context_memory/current-session.md`, `context_memory/decisions-log.md`, `context_memory/open-questions.md`, `context_memory/pending-user-actions.md`, `context_memory/blockers.md`, and the archive directory `context_memory/sessions/`.

**Commit:** `chore(context-memory): initialize session memory folder`.

### S3 — Root monorepo scaffolding + reference updates

**Files created:** `package.json` (root, private, workspaces `["packages/*", "apps/*"]`, `packageManager` pinned to `pnpm@10.33.0`, `engines.node` `>=22.16.0`, `license: MIT`), `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json` (strict + ESM `nodenext`), `biome.json`, `.env.example`.

**Reference updates in the same commit** (amendment B):

- `External api and library reference.md` — Biome section: pinned version `2.2.4` → `2.4.12`.
- `External api and library reference.md` — Vitest section: pinned version `4.1.4` → `4.1.5`.
- `External api and library reference.md` — Turborepo section: "Not shown" → `2.9.6` (pinned now).
- `External api and library reference.md` — Tooling section: add TypeScript pin `^6.0.3`.

**Commit:** `feat(foundation): monorepo scaffold (pnpm, turbo, tsconfig, biome) and pin tooling`.

### S4 — Local service stack (`docker-compose.yml`)

Services: `postgres` (`pgvector/pgvector:pg16`) and `redis` (`redis:7-alpine`). Named volumes for persistence. `healthcheck` on each so testcontainers / local dev can wait.

**Files:** `docker-compose.yml`.

**Commit:** `feat(foundation): docker-compose for postgres + redis`.

### S5 — `.mcp.json` stub

Valid JSON, single server entry named `coodra` pointing to `http://127.0.0.1:3100/mcp`, plus a `_comment` field noting the server is implemented by Module 02 and connection failures are expected until then.

**Files:** `.mcp.json`.

**Commit:** `feat(foundation): .mcp.json stub`.

### S6 — `packages/shared`

Package `@coodra/shared`.

**Files:** `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/logger.ts`, `packages/shared/src/config.ts`, `packages/shared/src/errors/index.ts` (`AppError`, `ValidationError`, `NotFoundError`, `ConflictError`, `UnauthorizedError`, `InternalError`), `packages/shared/src/idempotency.ts` (exactly `generateRunKey({ projectId, sessionId })` and `generateRunEventKey({ sessionId, toolUseId, phase })` — no other helpers until needed), and matching `__tests__/unit/*.test.ts`.

**Test assertions (must fail on drift):**

- `logger.ts` — produces JSON output with `level`, `time`, `msg`; `child()` carries context through.
- `errors/` — each error class has the correct `name`, preserves `cause`, and is `instanceof AppError`.
- `config.ts` — missing required env throws via Zod; defaults populate correctly; `COODRA_MODE` defaults to `solo`.
- `idempotency.ts` — `generateRunKey` output matches `^run:[^:]+:[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`. `generateRunEventKey` output matches `^[^:-]+-[^:-]+-(pre|post)$`. Both are UUID v4 where applicable (`run_id`), and deterministic for stable inputs where applicable (`run_event_id`).

**Reference updates in the same commit** (amendment B):

- `External api and library reference.md` — Pino section: pinned version `9.9.5` → `10.3.1`; add note on Pino 10 ESM-only import surface.
- `External api and library reference.md` — Zod section: pinned version `4.1.9` → `4.3.6`.
- `External api and library reference.md` — cockatiel section unchanged in Module 01 (not yet installed).

**Commit:** `feat(shared): logger, errors, zod env loader, idempotency helpers + tests`.

### S7 — `packages/db`

Package `@coodra/db`.

**Files:** `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/drizzle.sqlite.config.ts`, `packages/db/drizzle.postgres.config.ts`, `packages/db/src/schema/sqlite.ts`, `packages/db/src/schema/postgres.ts`, `packages/db/src/schema/index.ts` (dialect-aware re-export), `packages/db/src/client.ts` (`createDb()` factory), `packages/db/src/migrate.ts` (programmatic migrator for Vitest + CLI), `packages/db/__tests__/unit/schema-parity.test.ts`, and the generated migrations under `packages/db/drizzle/sqlite/` and `packages/db/drizzle/postgres/`.

**Commands run in this step:**

```bash
pnpm --filter @coodra/db exec drizzle-kit generate --config=drizzle.sqlite.config.ts
pnpm --filter @coodra/db exec drizzle-kit generate --config=drizzle.postgres.config.ts
```

The produced SQL is committed.

**Reference updates in the same commit** (amendment B):

- `External api and library reference.md` — Drizzle section: pin `drizzle-orm@^0.45.2`, `drizzle-kit@^0.31.10`.
- `External api and library reference.md` — `better-sqlite3` section: pin `^12.9.0`.
- `External api and library reference.md` — `postgres` section: pin `^3.4.9`.

**Commit:** `feat(db): drizzle schemas, createDb factory, initial migrations + parity test`.

### S8 — CI workflow

**Files:** `.github/workflows/ci.yml` with jobs `lint-typecheck`, `test-unit`, `test-integration` (Docker-gated — skips in Module 01 because no integration tests exist; the job is declared so Module 02 inherits a wired pipeline).

**Commit:** `ci: lint, typecheck, unit, integration jobs`.

### S9 — Docs

**Files:** `docs/DEVELOPMENT.md` (local setup, service commands, test commands, troubleshooting pointer), `docs/context-packs/template.md` (Context Pack template per `essentialsforclaude/08-implementation-order.md` §8.4).

**Commit:** `docs: development guide + context pack template`.

### S10 — Verification gate

Run locally:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm --filter @coodra/db run schema:parity   # alias for the parity test, same thing run alone
```

All four must pass before moving to S11. Any failure triggers a fix commit on this branch — never a workaround.

### S11 — Module 01 Context Pack

Write `docs/context-packs/2026-04-22-module-01-foundation.md` using `docs/context-packs/template.md`. Since `coodra__save_context_pack` is not yet callable (Module 02 hasn't shipped), this is a manual write per user Step 2.

**Commit:** `docs(01-foundation): module 01 context pack`.

### S12 — Push to remote

```bash
git push -u origin main
git push -u origin feat/01-foundation
```

Remote: `https://github.com/Abishai95141/Coodra`. Review / squash-merge to `main` is the user's call.

## Rollback strategy

If any step introduces a regression discovered after its commit, fix forward via an additional commit on this branch. Do not force-push `feat/01-foundation` during Module 01 — the history is part of the Context Pack.

## Logging discipline during Module 01

- After each file write: append a `- [HH:mm] <verb> <object> — <outcome>` line to `context_memory/current-session.md` Log section.
- After each design decision: append to `context_memory/decisions-log.md` with timestamp, decision, rationale, alternatives.
- Open questions and blockers go to `context_memory/open-questions.md` / `context_memory/blockers.md`.

Once Module 02 ships, the Coodra MCP tools take over the decision/pack-recording role and the manual discipline is only the fallback path.
