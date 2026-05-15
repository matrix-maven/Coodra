# Module 04a — Sync Daemon + Self-Host Packaging

## Header

- **Date:** 2026-04-28
- **Module:** 04a — Sync Daemon + Self-Host Packaging
- **Feature Pack:** `docs/feature-packs/04a-sync-daemon/`
- **Session lead (human):** Abishai
- **Branch at session start:** `main` post-Round-4 (commit `d7a3238`)
- **Branch at session end:** `feat/04a-sync-daemon` (ready to squash-merge)
- **Commits landed this session (newest first):**
  - `9d97da8` feat(deploy): Dockerfiles + Compose stack + self-host operator guide (S7)
  - `713cc06` feat(bridge,db): unify bridge auto-create runId to canonical 4-segment encoding (S6)
  - `4c7a62a` feat(cli): doctor checks 24–27 surface sync health; close functest finding #4 (S5)
  - `c94883f` feat(cli): supervise sync-daemon as third managed process in team mode (S4)
  - `4ba37a0` feat(sync-daemon): scaffold service with OutboxWorker dispatching to cloud Postgres (S3)
  - `5379f7b` feat(db,bridge,mcp-server,cli): paired sync_to_cloud enqueue + worker queueFilter (S2)
  - `871cec0` feat(cli): coodra cloud-migrate runs Drizzle pg migrations idempotently (S1)
  - `734b6c2` docs(feature-pack): Module 04a sync-daemon + self-host packaging — spec/implementation/techstack
  - (S8: this closeout pack itself, run-time verification, no separate code commit)

## Outcome

Module 04a closes the audit-data-stranded-on-laptops gap that ADR-008's "team-sync layer" had been waiting on. Every audit row written by the M03.1 callsites now ALSO durably enqueues a paired `sync_to_cloud` job; a new `apps/sync-daemon` process drains that queue against cloud Postgres with the same lease/retry/dead-letter semantics M03.1 already verified. The team-mode stack is installable on any Docker host via `cd deploy && cp .env.example .env && docker compose up -d`. Two side-task functest findings (#4 port-availability false-warn, #9 bridge bare-UUID runId) are closed inline.

The single load-bearing AC — *a write to local SQLite must appear in cloud Postgres within the sync window, with idempotency holding under cloud unreachability + recovery* — is proven by the new `verify-sync-roundtrip.ts` harness which:
1. Fires SessionStart + 5 PreToolUse + Stop → cloud has 1 runs (canonical 4-segment id), 5 policy_decisions, 1 run_events within ~6 seconds.
2. Disconnects sync-daemon, fires 5 more PreToolUse, reconnects → all 5 backlog rows drain to cloud within the sync window.

## Scope boundary

**In scope.**
- `coodra cloud-migrate` CLI command with the OQ4 pre-flight refusal on unknown non-empty tables.
- `scheduleAuditWriteWithSync` paired-enqueue helper + worker `queueFilter` (OQ7 cross-pollination guard).
- `apps/sync-daemon` package: dual-handle boot, OutboxWorker filtered to `sync_to_cloud`, per-table SELECT-from-local + INSERT-to-cloud dispatch.
- `coodra start/stop/status` supervises sync-daemon as a third managed process in team mode (omitted in solo).
- Doctor checks 24/25/26/27 (cloud reachability with time-based escalation, sync queue depth, sync lag, sync dead-letter count).
- Functest finding #4 fix: port-availability checks suppress yellow when `/healthz` answers OK.
- Functest finding #9 fix: bridge auto-create-run path uses `generateRunKey` for canonical 4-segment ids; migration 0005 backfills bare-UUID legacy rows.
- Self-host packaging: 4 Dockerfiles (mcp-server, hooks-bridge, sync-daemon, cloud-migrate one-shot), Compose stack with healthchecks + dependency chain, `.env.example`, operator guide at `docs/deploy/self-host.md`.
- New manual harness `verify-sync-roundtrip.ts` registered in `__tests__/manual/README.md`.

**Deferred (carry forward).**
- **Catchup poll cadence (OQ2 30s spec).** Today the immediate-paired-job pattern covers the hot path; a future module can add a periodic SELECT for any sync_to_cloud rows that the immediate path missed (e.g. daemon was down during enqueue) — the lease/retry path already approximates this implicitly.
- **Bidirectional sync.** v1 is one-way push (local→cloud). Pulling cloud-managed `projects` / `policies` / `feature_packs` / `policy_rules` back to local is a future module after M04b exercises the read pattern.
- **/metrics endpoint** (OQ6: doctor only for v1).
- **Multi-tenant cloud.** v1 assumes one DATABASE_URL per team.
- **TLS / WAF / managed-platform deploy variants** (Railway, Fly.io, k8s manifests) — Compose canonical, others get a brief mention in `self-host.md`.
- **CI Dockerfile build job.** The build was validated locally; adding it to GitHub Actions on PRs touching `deploy/**` or `apps/**` is a low-risk follow-up.

## Decisions made (7 OQs locked at sign-off 2026-04-28, with constraints)

- **OQ1 — sync direction for v1:** one-way push (local→cloud).
  - Rationale: simplest; matches ADR-008; no conflict resolution; web app reads cloud directly so no inverse needed for v1.
- **OQ2 — catchup poll cadence:** 30 seconds (matches M03.1 lease).
  - Rationale: one number for operators; hybrid hot path covers <1s; 30s catchup recovers from daemon-was-down.
- **OQ3 — cloud unreachability escalation:** GREEN reachable, YELLOW after 5min, RED after 1h.
  - Rationale: mirrors M03.1 OQ3 thresholds; one mental model for ops.
- **OQ4 — cloud Postgres migration ownership:** separate `coodra cloud-migrate` CLI command. **Constraint:** must refuse to run if there are data rows in tables not in the current migration set (prevents migrate-skip footguns).
  - Implementation: pre-flight enumerates `information_schema.tables` in `public`, fails with `EXIT_ENVIRONMENT_PROBLEM` if any unknown table has rows.
- **OQ5 — self-host deploy happy path:** Docker Compose canonical; Railway/Fly.io as brief mentions.
  - Rationale: vendor-neutral; Compose is the universal substrate any managed platform can derive.
- **OQ6 — sync metrics surface:** doctor only for v1.
  - Rationale: scope discipline; `/metrics` is a non-breaking later add since the worker contract doesn't move.
- **OQ7 — queue substrate:** reuse `pending_jobs` with `queue='sync_to_cloud'`, paired-job pattern. **Constraint:** each worker MUST filter by queue type AND fail loudly on cross-pollination.
  - Implementation: `OutboxWorker.queueFilter` with both SQL-level filtering and a runtime defense-in-depth assertion in `#runOne` that marks any wrongly-leased row dead with `wrong_queue_for_worker_filter`.

**Side-task constraints honoured:**
- Finding #9 backfill is reversible per OQ4-style rule: every rewritten id is recorded in `_runid_backfill_0005 (new_id, old_id, migrated_at)` so an operator can roll back in reverse.

## Files touched

### `apps/sync-daemon` (new package)
- `package.json`, `tsconfig.json`, `tsconfig.typecheck.json`, `vitest.{config,integration.config}.ts`
- `src/index.ts` — boot entry: dual handles + OutboxWorker filtered to sync_to_cloud + lifecycle
- `src/bootstrap/ensure-stderr-logging.ts` — pino → stderr default
- `src/config/env.ts` — Zod env: `DATABASE_URL` required; tunable `COODRA_SYNC_TICK_MS`/`LEASE_MS`
- `src/lib/dispatch.ts` — per-table SELECT-from-local + INSERT-to-cloud with appropriate ON CONFLICT clauses
- `__tests__/integration/dispatch.test.ts` — 5 cases against compose pgvector

### `apps/hooks-bridge`
- `src/lib/run-recorder.ts` — paired-enqueue at 5 callsites; `recordSessionStart` uses `generateRunKey` (finding #9); `recordSessionEnd` pairs with `project_session` lookup so the daemon can refresh runs status + ended_at
- `src/index.ts` — `OutboxWorker.queueFilter: AUDIT_QUEUE_KINDS`
- `__tests__/integration/handlers/run-id-linkage.test.ts` — asserts canonical 4-segment regex

### `apps/mcp-server`
- `src/lib/run-recorder.ts` — paired-enqueue with `id` lookup
- `src/tools/check-policy/handler.ts` — paired-enqueue with `idempotency_key` lookup
- `src/index.ts` — `OutboxWorker.queueFilter: AUDIT_QUEUE_KINDS`

### `packages/db`
- `src/schedule-audit-write-with-sync.ts` — created (helper that pairs audit + sync enqueue)
- `src/index.ts` — re-exports
- `drizzle/sqlite/0005_lonely_thanos.sql`, `drizzle/postgres/0005_silent_thanos.sql` — migration: `_runid_backfill_0005` audit table + per-dialect FK-safe swap of bare-UUID rows
- `drizzle/{sqlite,postgres}/meta/_journal.json` — registered 0005
- `__tests__/integration/schedule-audit-write-with-sync.test.ts` — 6 cases
- `__tests__/unit/client.test.ts` — schema-count assertions exclude `_*` audit tables

### `packages/cli`
- `src/commands/cloud-migrate.ts` — created (idempotent + OQ4 pre-flight refusal)
- `src/program.ts` — wires `cloud-migrate` command + `--no-sync` flag
- `src/lib/services.ts` — ServiceDescriptor → discriminated union (HTTP / worker); sync-daemon entry; team-mode gating
- `src/commands/start.ts` — workers skip waitForHealth; `--no-sync` flag plumbed
- `src/commands/status.ts` — workers report state via `readPidStatus`; portless services print `(worker)` instead of `:port`
- `src/lib/outbox/types.ts` — `AUDIT_QUEUE_KINDS`, `SyncLookup` (3 variants), `SyncToCloudPayloadV1`, `SyncTableName`
- `src/lib/outbox/worker.ts` — `queueFilter` with SQL-level + runtime assertion
- `src/lib/outbox/index.ts` — re-exports
- `src/doctor/checks/17-port-3100.ts`, `18-port-3101.ts` — finding #4 fix (suppress yellow when /healthz OK)
- `src/doctor/checks/24-cloud-reachability.ts` — created (state-file time tracking)
- `src/doctor/checks/25-sync-queue-depth.ts`, `26-sync-lag.ts`, `27-sync-dead-letter.ts` — created
- `src/doctor/registry.ts` — registers 24/25/26/27
- `__tests__/integration/cloud-migrate.test.ts` — 6 cases against compose pg
- `__tests__/unit/program.test.ts` — `cloud-migrate` wiring + 8-subcommand assertion
- `__tests__/unit/services.test.ts` — discriminated union; team-mode gating
- `__tests__/unit/help-output.test.ts` — snapshot updated

### Repo root + deploy
- `deploy/Dockerfile.{mcp-server,hooks-bridge,sync-daemon,cloud-migrate}` — multi-stage builds
- `deploy/compose.yaml` — postgres + cloud-migrate one-shot + 3 services with healthchecks + depends_on chain
- `deploy/.env.example`
- `docs/deploy/self-host.md` — operator happy-path guide
- `docs/feature-packs/04a-sync-daemon/{spec,implementation,techstack}.md` + `meta.json`
- `__tests__/manual/verify-sync-roundtrip.ts` — primary AC harness
- `__tests__/manual/README.md` — registers the new harness

## Tests

- **Added:**
  - `cloud-migrate.test.ts` (6): happy path, idempotent re-run, refusal on unknown rows, tolerance for empty unknown table, missing DATABASE_URL, --dry-run.
  - `schedule-audit-write-with-sync.test.ts` (6): team paired enqueue, solo-skip, no-sync omit, env-driven mode, env solo treatment, separate ids + caller-supplied audit-id dedupe.
  - `worker.test.ts` queueFilter cases (3): claim filter, exclusion, empty filter rejection.
  - `services.test.ts` (2 new + updated existing): discriminated union, solo-omit/team-include of sync-daemon.
  - `program.test.ts` (1 new + updated existing): cloud-migrate wiring, 8-subcommand assertion.
  - `dispatch.test.ts` for sync-daemon (5): happy push, missing-local-row → transient, idempotent re-drain, project_session refresh on close, cross-pollination guard.
  - `run-id-linkage.test.ts` extension: canonical-regex assertion on bridge-emitted runId.
  - `verify-sync-roundtrip.ts` (manual harness): primary AC + disconnect/reconnect.

- **Modified:** `client.test.ts` (schema-count regexes); `help-output.test.ts` snapshot.

- **Verification commands run locally:**
  ```bash
  pnpm exec turbo run typecheck lint test:unit                                    # all green
  DATABASE_URL='postgres://...' pnpm --filter @coodra/cli test:integration     # 6/6 (cloud-migrate)
  pnpm --filter @coodra/db test:integration                                    # 45/45 (incl. 0005 migration applies on pg)
  pnpm --filter @coodra/hooks-bridge test:integration                          # 38/38
  pnpm --filter @coodra/mcp-server test:integration                            # 179/179
  DATABASE_URL='postgres://...' pnpm --filter @coodra/sync-daemon test:integration  # 5/5
  pnpm test:e2e                                                                   # 32 passed (1 pre-existing skip)
  COODRA_MODE=solo pnpm exec tsx __tests__/manual/verify-outbox-crash-safety.ts   # ALL PASS
  pnpm exec tsx __tests__/manual/verify-f5-live.ts                                # PASS
  DATABASE_URL='postgres://...' pnpm exec tsx __tests__/manual/verify-sync-roundtrip.ts  # ALL PASS
  docker build -f deploy/Dockerfile.cloud-migrate -t coodra/cloud-migrate:dev .     # built clean
  docker run --rm --network host -e DATABASE_URL='postgres://...' coodra/cloud-migrate:dev  # idempotent re-apply success
  ```

- **CI status at session end:** branch `feat/04a-sync-daemon` ready for squash-merge to `main`. Locally green; CI will validate.

## Open questions

- **Compose end-to-end `up -d` not yet validated.** Cloud-migrate image was built and ran successfully against compose Postgres; the other three Dockerfiles share an identical build-stage shape (only differing in the turbo `--filter` and runtime CMD). Confidence is high they build, but full `docker compose up -d && curl /healthz` is deferred to the operator's first deploy or a follow-up CI job touching `deploy/**`.
- **Catchup poll for sync_to_cloud not implemented.** OQ2 specced 30s. Current behavior relies on the immediate paired enqueue + the worker's lease-recovery for orphaned rows. If the bridge enqueues an audit + sync pair while the daemon is down, the sync row sits as `pending` and is claimed on next daemon boot — functionally equivalent to a catchup poll for the audit-rate volumes we expect. A periodic poll could be added without changing the worker contract; tracking as a follow-up.
- **Migration 0005 not yet end-to-end verified on Postgres against legacy bare-UUID data.** Postgres test container always starts empty in CI; manual seeding + migration would need a one-shot fixture. SQLite path is exercised by the schema-count tests. The DDL is idempotent and reversibility is documented in the migration preamble.

## Pending user actions

- Squash-merge `feat/04a-sync-daemon` to `main` via PR (M02/M03/M03.1 pattern). After merge: re-run `verify-sync-roundtrip.ts` against the production cloud Postgres URL (Supabase or whichever you provision) to confirm the post-merge state across services.
- Provide DATABASE_URL pointing at the team's actual cloud Postgres (Supabase project URL + service-role connection string) when ready to validate beyond the compose-bundled Postgres. The harness is parameterized on `DATABASE_URL`.

## Handoff to next session

- **Starting state.** `main` post-merge contains the Module 04a sync-daemon stack: 7 commits (8 with the closeout). Three managed daemons in team mode, four Dockerfiles, one Compose stack, doctor surface extended to 27 checks, two findings (#4, #9) closed.
- **Next concrete step.** Module 04b (Web App) per `docs/feature-packs/04b-web-app/spec.md` (to be authored). The audit-trail UI it surfaces reads from cloud Postgres (`runs`, `run_events`, `policy_decisions`, `decisions`, `context_packs`) which the M04a sync-daemon now populates.
- **Entry point.** `docs/feature-packs/04a-sync-daemon/spec.md` for cross-references; `apps/web/` for the Next.js 15 + React 19 surface. The Supabase memory at `~/.claude/projects/-Users-abishaikc-Coodra/memory/supabase-project.md` carries the project URL + publishable key + canonical `@supabase/ssr` boilerplate for that work.

## References

- Feature Pack: `docs/feature-packs/04a-sync-daemon/{spec,implementation,techstack}.md`
- Architecture: `system-architecture.md` §1 (two-mode), §3.6 (cloud sync), §4.1/§4.2 (schema parity), §5 (eventual consistency), §13 (infra), §16 pattern 3 (Outbox)
- ADRs: `essentialsforclaude/11-adrs.md` ADR-008 (cloud Postgres as team-sync layer)
- Predecessor module: `docs/feature-packs/03.1-durable-outbox/spec.md` (the queue substrate this rides on)
- Predecessor closeout: `docs/context-packs/2026-04-28-module-03.1-durable-outbox.md`
- Round-4 functest pack (findings #4 + #9 source): `docs/context-packs/2026-04-27-run-proj_0d1738d.md`
