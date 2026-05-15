# Module 03.1 — Durable Audit Outbox — Tech Stack

> **Zero new external dependencies.** The `pending_jobs` table is in the schema since M01 (commits `42a166b` for sqlite, schema-parity-locked for postgres). Every other piece — Drizzle, better-sqlite3, postgres.js, pino, vitest — is already pinned and exercised in M01–M03.

## Inventory

| Layer                    | Technology                                       | Version    | Where it lives                                       | Why this and not the alternative |
|--------------------------|--------------------------------------------------|------------|------------------------------------------------------|---------------------------------|
| Schema                   | `@coodra/db` (Drizzle ORM)                    | already pinned | `packages/db/src/schema/{sqlite,postgres}.ts`     | Existing schema-parity discipline. Migration 0004 emits via `pnpm db:generate`. |
| SQLite driver (solo)     | `better-sqlite3`                                 | already pinned | `packages/db/src/client.ts`                       | Synchronous API → simpler worker pickup logic; WAL mode + `synchronous = NORMAL` give durability without per-write fsync. ADR-008. |
| Postgres driver (team)   | `postgres.js`                                    | already pinned | `packages/db/src/client.ts`                       | Native pgvector support already wired; lib chosen over `pg` for ADR-003 reasons. |
| ORM                      | Drizzle ORM                                      | already pinned | both clients                                       | ADR-003. The `ON CONFLICT (id) DO NOTHING` and `RETURNING *` shapes the worker needs are first-class in both dialects. |
| Worker process model     | In-process (one per service)                     | n/a        | `packages/cli/src/lib/outbox/worker.ts` (new)        | Single-process keeps SQLite WAL writes serialized; no IPC overhead. The worker is a class, not a separate process — boots/stops with the host service. |
| Logger                   | `@coodra/shared::createLogger` (pino)         | already pinned | `packages/shared/src/logger.ts`                   | Existing structured logging; correlation IDs already plumbed. |
| Test framework           | Vitest                                           | already pinned | every `__tests__/`                                | ADR-005. Fakers (`vi.useFakeTimers`) are how the backoff scheduler is tested without real wall-clock waits. |
| Crash-safety harness     | Plain Node + execa (subprocess kill -9)          | already pinned | `__tests__/manual/`                                | Same model as `verify-sigterm-drain.ts`; subprocess SIGTERM/-9 lets us prove crash safety without testcontainers. |

## What we explicitly are NOT adding

- **BullMQ** — ADR-006 mandates BullMQ for cloud queues, but only when the queue's needs (rate limiting, job flows, multi-process distribution, dashboards) justify Redis as a hard infrastructure dep. The audit-write outbox needs none of that — it's a single-table durable queue with idempotency at the destination. Promotion path is documented in `spec.md` §11 OQ1 if team-mode audit volume changes the calculus.
- **Redis / Upstash** — same rationale. Adding Redis as a team-mode hard dep forces every customer to provision Upstash. Postgres already exists in team mode and handles this load.
- **A dedicated worker process** — the OutboxWorker class lives inside `apps/hooks-bridge` and `apps/mcp-server`'s existing Node processes. No new daemon, no new launchd plist or systemd unit, no new doctor check for "is the worker process up" — the worker's liveness is the host service's liveness.

## Deps audit

```bash
$ pnpm --filter @coodra/db ls --depth 0
@coodra/db@0.0.0
├── @coodra/shared@workspace:*
├── better-sqlite3@<pinned>
├── drizzle-orm@<pinned>
├── postgres@<pinned>
└── sqlite-vec-darwin-arm64@<pinned>  # platform-specific
```

No additions. Confirmed by reading `packages/db/package.json`.

```bash
$ pnpm --filter @coodra/cli ls --depth 0
@coodra/cli@0.0.0
├── @coodra/db@workspace:*
├── @coodra/shared@workspace:*
├── commander@<pinned>
├── env-paths@<pinned>
├── execa@<pinned>
├── glob@<pinned>
├── picocolors@<pinned>
└── zod@<pinned>
```

No additions. The OutboxWorker uses Node built-ins (`node:crypto`, `node:timers/promises`) + Drizzle from `@coodra/db`.

## Architecture cross-references

- **§3.4 Outbox pattern** — already documented as the design model for Run Event Recording. M03.1 makes it actually durable.
- **§4.3 Idempotency keys** — pre-existing on `policy_decisions`, `run_events`, `runs`. Worker depends on them for dedupe.
- **§5 CAP** — Run Event Recording → Eventual Consistency. M03.1 does not change the CAP analysis; it just removes the "if the machine crashes between HTTP response and queue write, that event is lost" caveat.
- **§7 Fail-open** — the outbox itself fails closed (the enqueue is synchronous; if the WAL write fails, the handler errors). The destination INSERT (run by the worker) fails open: a transient error retries, a max-attempts exhaustion logs and moves on, the agent already saw the response.
- **§16 pattern 3** — canonical Outbox.

## Verifications I'll run before declaring "no new deps"

- `pnpm exec turbo run typecheck lint test:unit` after S0 lands → no resolver errors.
- `pnpm install --frozen-lockfile` after each slice → lockfile unchanged across the slice plan.
- `npm view drizzle-orm version` (and parallel for `better-sqlite3`, `postgres`) at S0 to confirm the pinned versions match `External api and library reference.md`. If a major version has dropped, pin in the same change per `04-when-in-doubt.md` §4.2.

If at any slice I discover a new dep is genuinely required (e.g., a pure-JS UUID v7 implementation for ordered queue ids, IF we decide ordering matters), I'll surface it via `AskUserQuestion` rather than add silently.
