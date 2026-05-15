# Module 04a — Sync Daemon + Self-Host Packaging — Implementation

> Linear slices, one commit each, test/fix/document inline. Same cadence as M02/M03/M03.1. No separate verification report — the manual harness suite + CI green is the closeout signal.

The seven OQs in `spec.md` §6 are PRE-implementation. Do not start S0 until they are signed off.

## Slice S0 — feature-pack triplet (THIS COMMIT, the one you are reading)

**Land:** `docs/feature-packs/04a-sync-daemon/{spec,implementation,techstack}.md` + `meta.json`. STOP. Post the seven OQs back with recommendations. One round of decisions.

Commit message: `docs(feature-pack): Module 04a sync-daemon + self-host packaging — spec/implementation/techstack`.

Pause. Wait for OQ sign-off.

---

## Slice S1 — Postgres-side schema + cloud-migrate command

**Goal:** the cloud database can receive a freshly-migrated stack with no manual intervention.

- Add `coodra cloud-migrate` command in `packages/cli/src/commands/cloud-migrate.ts`. Reads `DATABASE_URL` from env, opens a Postgres handle via `createDb({kind:'cloud'})`, runs `migrate(handle.db, { migrationsFolder: <pkg-path>/drizzle/postgres })` from `drizzle-orm/postgres-js/migrator`. Idempotent (drizzle's migration table dedupes).
- Wire it into `packages/cli/src/program.ts` and the help/version surfaces.
- New unit test under `packages/cli/__tests__/unit/commands/cloud-migrate.test.ts` (against a testcontainers Postgres).
- Existing migration files unchanged — this slice is the operator-runnable wrapper, not a new schema.

**Verify:** `pnpm --filter @coodra/cli test:unit` green. `DATABASE_URL=... pnpm exec coodra cloud-migrate` against a fresh postgres lands all 4 migrations.

**Commit:** `feat(cli): coodra cloud-migrate runs Drizzle pg migrations idempotently`.

---

## Slice S2 — paired sync enqueue at M03.1 callsites

**Goal:** every audit-write enqueue at the M03.1 callsites ALSO enqueues a paired `sync_to_cloud` job. Local writes are unchanged.

- Extend `scheduleDurableWrite` (or wrap it via a thin helper `scheduleAuditWriteWithSync` that ALSO enqueues the sync job) at the 7 callsites M03.1 enumerated. The audit-destination INSERT is local-only; the paired sync job carries a reference to the destination row by id + table-name.
- Sync job payload shape: `{ table: 'policy_decisions' | 'run_events' | 'runs' | 'decisions' | 'context_packs', rowId: string, idempotencyKey?: string }`. Daemon SELECTs the row from local SQLite by id at dispatch time (so the payload stays small and a row mutation between enqueue and dispatch is harmless — last-write-wins on the SQLite side, but local writes are append-only so no mutations exist).
- Solo mode (COODRA_MODE=solo): the paired enqueue is a no-op (gated by env). No daemon, no sync.
- Unit + integration tests:
  - `packages/db/__tests__/integration/schedule-audit-write-with-sync.test.ts` — asserts both jobs land for one logical audit; only the audit job lands in solo mode.
  - Bridge + MCP integration tests pick up the paired enqueue automatically (they assert audit destination state, which is unchanged).

**Verify:** `pnpm --filter @coodra/db test:integration` green; bridge + MCP integration green; M03.1 crash-safety harness still passes (M03.1 path untouched).

**Commit:** `feat(db,bridge,mcp-server): paired sync_to_cloud enqueue at M03.1 audit callsites (team mode only)`.

---

## Slice S3 — sync-daemon scaffold + dispatch handler

**Goal:** new `apps/sync-daemon` package boots, opens dual handles, runs an OutboxWorker against the `sync_to_cloud` queue, dispatches to cloud Postgres, drains.

- New package `apps/sync-daemon` with `package.json`, `tsconfig.json`, `src/index.ts`, `src/lib/dispatch.ts`.
- `src/index.ts`: parse env (`DATABASE_URL` required, `COODRA_HOME` optional), open `localDb = createDb({kind:'local'})` + `cloudDb = createDb({kind:'cloud', postgres: {databaseUrl}})`, instantiate `OutboxWorker` with `queueKind: 'sync_to_cloud'`, dispatch handler from `lib/dispatch.ts`. Start. SIGTERM → await worker.stop() → close both handles.
- `src/lib/dispatch.ts`: factory `createSyncDispatchHandler({localDb, cloudDb, logger})` returning an `OutboxDispatchHandler`. For each job:
  1. SELECT row from local by `(table, rowId)`.
  2. INSERT into cloud table with ON CONFLICT DO NOTHING (per table's natural unique key — `id` for run_events / context_packs, `idempotency_key` for policy_decisions / decisions, `(project_id, session_id)` for runs which uses UPSERT).
  3. Return `success` if INSERT count ≥ 0 (DO NOTHING is fine — already synced is idempotent success).
  4. Return `transient_failure` on connection errors; `permanent_failure` on schema mismatch (logged with the row payload for ops triage).
- Tests:
  - `apps/sync-daemon/__tests__/integration/dispatch.test.ts` — spin a SQLite in-memory + a testcontainers postgres; enqueue 5 sync jobs across 5 tables; tick the worker; assert 5 cloud rows landed; tick again, assert no duplicates.
  - `apps/sync-daemon/__tests__/integration/cloud-unreachable.test.ts` — break the cloud handle mid-tick; assert jobs go to retry; restore; assert eventual drain.
- Wire `pnpm --filter @coodra/sync-daemon` into the workspace + turbo pipeline (build + test:unit + test:integration). Lint passes.

**Verify:** new package's tests green; existing tests unaffected.

**Commit:** `feat(sync-daemon): scaffold service with OutboxWorker dispatching to cloud Postgres`.

---

## Slice S4 — sync-daemon lifecycle managed by `coodra start`

**Goal:** `coodra start` in team mode launches sync-daemon as a third managed process; `coodra stop` cleanly shuts it down; `coodra status` reports its PID.

- Extend `packages/cli/src/lib/services.ts` with the sync-daemon entry (port-less; same plist/systemd/fallback supervision as bridge + mcp-server).
- New PID file at `~/.coodra/run/sync-daemon.pid`.
- Status output adds a row.
- Update existing `start`/`stop`/`status` command tests to cover the third service.
- Solo mode: `coodra start` skips the sync-daemon entry (no `DATABASE_URL` expected).

**Verify:** `pnpm --filter @coodra/cli test:unit` green; manual smoke (`coodra start && coodra status && coodra stop`) shows three services in team mode, two in solo.

**Commit:** `feat(cli): supervise sync-daemon as third managed process in team mode`.

---

## Slice S5 — doctor checks 24/25/26/27 + functest finding #4 fix

**Goal:** ops surface for sync health; close finding #4.

- New checks `packages/cli/src/doctor/checks/{24-cloud-reachability,25-sync-queue-depth,26-sync-lag,27-sync-dead-letter}.ts`. Severity per spec §3.1.8.
- Edit `packages/cli/src/doctor/checks/{17-port-3100,18-port-3101}.ts`: when port is occupied AND `/healthz` answers OK on that port, return GREEN ("port in use by healthy daemon — expected"). Otherwise YELLOW.
- Update `packages/cli/__tests__/unit/doctor/checks-fixture.test.ts` with the 4 new checks + the suppressed-warn case for 17/18.
- Edit doctor registry to include the four new checks.

**Verify:** doctor on a fresh team-mode stack reports 0 RED, 0 YELLOW. Doctor on a stack with cloud disconnected reports check 24 YELLOW (5min) → RED (1h).

**Commit:** `feat(cli): doctor checks 24–27 surface sync health; close functest finding #4 (port-availability false warn)`.

---

## Slice S6 — bridge runId format unification (functest finding #9)

**Goal:** bridge auto-create-run path produces canonical 4-segment runIds; existing dev DBs get a backfill.

- Locate the bridge auto-create path (likely `apps/hooks-bridge/src/lib/run-recorder.ts::recordSessionStart` when no MCP get_run_id has fired). Replace the bare-UUID generator with the canonical encoder from `packages/shared/src/run-id.ts` (or wherever the MCP-side encoder lives — re-export if needed).
- Add migration 0005 (sqlite + postgres) that scans `runs` for rows whose `id` does not match the canonical regex and rewrites them. Migration is idempotent and FK-safe (run_events.run_id, decisions.run_id are SET NULL on delete; we UPDATE in place, so FKs follow).
- Migration uses `@preserve`-block locking per M01 discipline; `migrations.lock.json` updated with the new sha256.
- Tests:
  - `apps/hooks-bridge/__tests__/integration/handlers/session-start-runid-format.test.ts` — fire SessionStart with no preceding get_run_id; assert `runs.id` matches the canonical regex.
  - Migration unit tests: seed a row with bare UUID; run migrate; assert the row's id matches canonical regex; FKs intact.

**Verify:** integration green; full e2e green; canonical regex enforced everywhere.

**Commit:** `feat(bridge,db): unify bridge auto-create runId to canonical 4-segment encoding; close functest finding #9`.

---

## Slice S7 — Dockerfiles + Compose + deploy guide

**Goal:** team-mode stack is `docker compose up`-installable.

- `deploy/Dockerfile.mcp-server`, `deploy/Dockerfile.hooks-bridge`, `deploy/Dockerfile.sync-daemon` — multi-stage; pnpm fetch + install + turbo build → distroless or alpine runtime; non-root user; healthcheck for the two HTTP services.
- `deploy/Dockerfile.cloud-migrate` — one-shot image that runs `coodra cloud-migrate`. Used as a Compose `command` for first-boot migration.
- `deploy/compose.yaml` — postgres (pgvector/pgvector:pg16), one-shot cloud-migrate (depends_on postgres healthy, exits 0), then mcp-server + hooks-bridge + sync-daemon (depends_on cloud-migrate completed). Bind mount `~/.coodra` for SQLite parity. Healthchecks on the HTTP services.
- `deploy/.env.example` — every var commented.
- `docs/deploy/self-host.md` — happy-path operator guide. Covers: clone + cd into deploy/, copy .env.example → .env, fill DATABASE_URL + LOCAL_HOOK_SECRET + COODRA_MODE=team, `docker compose up -d`, smoke test (`curl /healthz` against bridge + mcp-server, `docker compose exec sync-daemon coodra doctor`).
- Lint: `hadolint` on the Dockerfiles (added to CI as a non-blocking job for v1).
- CI: a new GitHub workflow job that builds the three Dockerfiles on PR (cache-aware; only runs if `apps/**` or `deploy/**` changed).

**Verify:** `cd deploy && cp .env.example .env && docker compose up -d && curl localhost:3100/healthz && curl localhost:3101/healthz` all green within 30s on a fresh checkout. `docker compose logs sync-daemon` shows the worker tick log line.

**Commit:** `feat(deploy): Dockerfiles + Compose stack + self-host operator guide`.

---

## Slice S8 — sync-roundtrip harness + closeout

**Goal:** the primary AC is verifiable end-to-end; closeout pack lands.

- `__tests__/integration/manual/verify-sync-roundtrip.ts` — per spec §4. Spawns bridge + sync-daemon subprocesses against a Compose-launched (or testcontainers) Postgres; fires hooks; polls cloud for rows; runs the disconnect/reconnect variant.
- Re-run the existing harness suite (`verify-phase5-closed-loop.ts`, `verify-outbox-crash-safety.ts`, `verify-f5-live.ts`) against `main` post-merge.
- New context pack `docs/context-packs/<date>-module-04a-sync-daemon.md` covering: scope, files touched, decisions (the 7 OQ outcomes), tests added, harness output. Save via `coodra__save_context_pack`.
- `context_memory/current-session.md` updated; "Next action: Module 04b (Web App) kickoff per `docs/feature-packs/04b-web-app/spec.md`."

**Verify:** all four manual harnesses pass. `pnpm exec turbo run typecheck lint test:unit` green. Bridge + MCP + sync-daemon integration green. e2e green. Doctor on the running stack reports 0 RED, 0 YELLOW.

**Commit:** `test(integration): verify-sync-roundtrip + M04a closeout pack`.

---

## Risks + mitigations

- **Risk:** paired-job pattern doubles `pending_jobs` row count. *Mitigation:* deletion on success keeps steady-state low; doctor check 25 catches runaway depth.
- **Risk:** schema drift between local SQLite and cloud Postgres breaks dispatch silently. *Mitigation:* the sync dispatch handler validates payload shape against the destination schema via Zod before INSERTing; mismatch = permanent_failure with operator-triageable log line.
- **Risk:** cloud unreachability for >1h drains nothing; backlog grows unbounded. *Mitigation:* doctor check 24 → RED at 1h; operator-action contract documented in self-host.md.
- **Risk:** Compose stack drifts from local-dev quirks (pnpm versions, Node versions). *Mitigation:* Dockerfile pins exact versions matching the repo's `package.json::engines`; CI builds the images on every PR touching apps/ or deploy/.
- **Risk:** Migration 0005 rewrites runIds while a sync-daemon is mid-flight. *Mitigation:* `cloud-migrate` is operator-run before sync-daemon starts; the local migration runs at boot before bridge/mcp-server accept hooks. The runId rewrite is FK-safe (UPDATE in place).
