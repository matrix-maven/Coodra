# Module 01 — Foundation — Tech Stack

> Every version below was verified against the npm registry on 2026-04-22 via `npm view <pkg> version` and reconciled with `External api and library reference.md`. Any drift between this file and the reference means **the reference is updated in the same commit that changes this file** (amendment B).

## Runtimes

| Tool | Pin | Rationale |
|---|---|---|
| Node.js | `22.16.0` (engines `>=22.16.0 <23`) | LTS-track; required by `essentialsforclaude/10-troubleshooting.md`; matches local machine. |
| pnpm | `10.33.0` | Active LTS of pnpm 10 with Corepack-friendly pinning (`"packageManager": "pnpm@10.33.0"`). |
| Python | `>=3.12 <3.14` (services only; system Python stays 3.14.4) | `sentence-transformers` and `tree-sitter` bindings lag on Python 3.14 wheels; pinning the services to 3.12–3.13 avoids compile-from-source. Applied when Modules 05/06 land. |
| uv | `0.9.29` | Fast lockfile-based Python workspace manager; unused in Module 01 but recorded for continuity. |
| Docker | host-installed ≥ 24 (required from Module 02) | testcontainers needs a Docker daemon; Module 01 ships only the compose file. |

## Module-01 npm dependencies (installed now)

| Package | Pin | Role | Reference section |
|---|---|---|---|
| `typescript` | `^6.0.3` | Strict TS 6 baseline; ESM `nodenext`; `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. | *added to reference in same commit* |
| `turbo` | `^2.9.6` | Monorepo task runner. | updated to pin in same commit |
| `@biomejs/biome` | `^2.4.12` | Single lint+format toolchain. | pinned up from 2.2.4 in same commit |
| `vitest` | `^4.1.5` | Unit test runner. | pinned up from 4.1.4 in same commit |
| `@vitest/coverage-v8` | `^4.1.5` | Coverage reporter. | new entry |
| `zod` | `^4.3.6` | Env + error validation. | pinned up from 4.1.9 in same commit |
| `dotenv` | `^17.4.2` | `.env` loader (dev only). | new entry |
| `tsx` | `^4.21.0` (dev) | Direct TS runner for scripts. | new entry |

## `packages/shared` dependencies (installed in S6)

| Package | Pin | Role |
|---|---|---|
| `pino` | `^10.3.1` | Structured logger. **Major bump** from reference's `9.9.5` — Pino 10 is ESM-only. Matches TS `module: nodenext`. Reference updated in the same commit as `packages/shared/package.json`. |
| `pino-pretty` | `^13.1.3` (dev) | Dev log prettifier. |
| `zod` | `^4.3.6` | Shared with root. |

## `packages/db` dependencies (installed in S7)

| Package | Pin | Role |
|---|---|---|
| `drizzle-orm` | `^0.45.2` | ORM with native pgvector + sqlite-vec awareness (per ADR-003). |
| `drizzle-kit` | `^0.31.10` (dev) | Migration generator. |
| `better-sqlite3` | `^12.9.0` | Solo-mode SQLite driver. |
| `postgres` | `^3.4.9` | Team-mode Postgres.js driver (compatible with Supabase Supavisor — set `prepare: false` when wiring in Module 02). |

## Docker images (Module-02+ usage; compose file ships in S4)

| Image | Tag | Rationale |
|---|---|---|
| `pgvector/pgvector` | `pg16` | Required for pgvector extension availability (per `essentialsforclaude/10-troubleshooting.md` "pgvector extension not found"). |
| `redis` | `7-alpine` | Matches BullMQ 5.x compatibility matrix; used from Module 03. |

## Deferred / forward-looking pins (not installed in Module 01)

These are documented so Modules 02–07 don't re-verify. Each will be installed in the module that introduces the matching `apps/<name>/package.json` or `services/<name>/pyproject.toml`, and the matching doc updates will be committed then.

| Package | Pin | First-used module | Notes |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.29.0` | Module 02 | TypeScript MCP SDK, Streamable HTTP transport (ADR-001). |
| `hono` | `^4.12.14` | Module 03 | Hooks Bridge framework (ADR-004). |
| `@hono/node-server` | `^2.0.0` | Module 03 | **Major bump** from reference's `1.19.3`. Reference updated in the Module-03 commit that introduces `apps/hooks-bridge/package.json`. |
| `@hono/zod-validator` | `^0.7.6` | Module 03 | HTTP body validation. |
| `bullmq` | `^5.76.0` | Module 03 (team mode) | Job queues (ADR-006). |
| `ioredis` | `^5.10.1` | Module 03 (team mode) | BullMQ transport. |
| `next` | `^16.2.4` | Module 04 | **Major bump** from architecture's "Next.js 15". Rationale recorded in `context_memory/decisions-log.md` on 2026-04-22: fresh build, zero migration cost, pinning 15 creates upgrade debt. `system-architecture.md` §2 and the Next.js section of `External api and library reference.md` are amended in the Module-04 commit that introduces `apps/web/package.json` (amendment B). |
| `react` / `react-dom` | `^19.2.5` | Module 04 | Paired with Next.js 16. |
| `cockatiel` | `^3.2.1` | Modules 02/03 | Circuit breakers (§7). |
| `zod-to-json-schema` | `^3.25.2` | Module 02 | Zod → JSON Schema for MCP manifest. |
| `jira.js` | `^5.3.1` | Module 02 (JIRA tools) | §22. |
| `@octokit/rest` | `^22.0.1` | Module 02 (GitHub tools) | §23. |
| `@octokit/auth-app` | `^8.2.0` | Module 02 (GitHub App auth) | §23. |
| `@octokit/webhooks` | `^14.2.0` | Module 03 (GitHub webhooks) | §23. |
| `@octokit/plugin-throttling` | `^11.0.3` | Module 02 | §23. |
| `@octokit/plugin-retry` | `^8.1.0` | Module 02 | §23. |
| `@octokit/plugin-paginate-rest` | `^14.0.0` | Module 02 | §23. |
| `testcontainers` | `^11.14.0` (dev) | Module 02 | Integration tests. |
| `@testcontainers/postgresql` | `^11.14.0` (dev) | Module 02 | Integration tests. |

## Key gotchas to carry forward

- **Pino 10 is ESM-only.** Our `tsconfig.base.json` sets `module: nodenext`. No CommonJS import path is supported; use `import pino from 'pino'`.
- **`@hono/node-server` 2.0.0 changed the return of `serve()`.** Module 03 must import the new API; the 1.x pattern will not compile.
- **Next.js 16 Server Actions and caching changes.** Compared to Next.js 15: `unstable_cache` behavior hardened; `use server` directive rules tightened. Module 04 will validate against the Next.js 16 migration guide before implementing any server action.
- **Drizzle requires separate dialect imports.** `drizzle-orm/better-sqlite3` vs `drizzle-orm/postgres-js`; mixing them is an error. `schema/sqlite.ts` uses `sqlite-core`; `schema/postgres.ts` uses `pg-core`. The schema-parity unit test is the single guard against drift.
- **`postgres-js` + Supabase Supavisor pooler** requires `prepare: false`. Not exercised in Module 01; carried forward.
- **`COODRA_MODE` must default to `'solo'`.** Team-mode without explicit opt-in would silently pull `DATABASE_URL` into code paths that expect local SQLite.
- **sqlite-vec is not installed in Module 01.** The `context_packs.summary_embedding` column is `text` in SQLite until Module 02 loads `vec0`. pgvector `vector(384)` is only used in the Postgres schema and is created by the initial Postgres migration.

## Version-bump policy (amendment B)

Every time a `package.json` in this repo changes a pinned version, the entry in `External api and library reference.md` is updated in the same commit. For Next.js and other architecture-cited libraries, `system-architecture.md` §2 is also updated in the same commit. Never a follow-up commit.
