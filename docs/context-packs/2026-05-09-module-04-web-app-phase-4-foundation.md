# Module 04 — Phase 4 — Team-Mode Foundation (server-side) — closeout

**Date:** 2026-05-09
**Branch:** `feat/team-mode` (off `feat/06-run-diff`)
**Closes:** [docs/feature-packs/04-web-app-phase-4/spec.md](../feature-packs/04-web-app-phase-4/spec.md)

## Why this is server-only

The original Phase 4 plan covered web pages, server-side wiring, and the cutover. This commit ships only the server-side foundation — schema, RBAC primitives, actor-identity wiring, sync-daemon pull, CLI migration engine, and architecture doc updates. Web app pages, components, and the `apps/web-v2/` → `apps/web/` cutover are blocked on the design system and will land in Phase 4-web.

Running the team migration / sync / RBAC layer through tests + production code paths gives the eventual web work a stable contract to build against, with no surprises waiting at integration time.

## What shipped

### Schema (migrations 0012, 0013)

- **0012_team_actor_attribution** (sqlite + postgres) — adds `created_by_user_id` text to `runs`, `decisions`, `context_packs`, `policies`, `feature_packs`, `run_diffs`. Adds `paused_by_user_id` + `resumed_by_user_id` to `kill_switches`. All nullable; solo + pre-Phase-4 rows = NULL.
- **0013_team_migration_tables** (postgres-only) — `_migration_attempts` + `_migration_map` for the team-migrate CLI's checkpointing + rollback semantics.

### Shared RBAC primitives

- [packages/shared/src/auth/roles.ts](../../packages/shared/src/auth/roles.ts) — Tier 2.5 — three Clerk roles (`viewer`, `member`, `admin`), `parseClerkRole` mapping, `Actor` shape, `requireRole` / `assertCanEdit` / `assertCanResumeKillSwitch` guards.
- 19 unit tests in [packages/shared/__tests__/unit/auth/roles.test.ts](../../packages/shared/__tests__/unit/auth/roles.test.ts) cover ownership / role-rank / parser behavior.

### Team-config reader/writer

- [packages/cli/src/lib/team-config.ts](../../packages/cli/src/lib/team-config.ts) — atomic file I/O for `~/.coodra/config.json::team` block. `readTeamConfig`, `writeTeamConfig`, `upgradeToTeamConfig`, `demoteToSoloConfig`, `updateLastPulledAt`.
- 14 unit tests covering missing-file / corrupt-JSON / partial-team-block tolerance + atomic-write contract.

### Actor identity wiring

- [apps/hooks-bridge/src/lib/actor-identity.ts](../../apps/hooks-bridge/src/lib/actor-identity.ts) + [apps/mcp-server/src/lib/actor-identity.ts](../../apps/mcp-server/src/lib/actor-identity.ts) — read-on-every-call helpers so a `team migrate` mid-session picks up new identity.
- Bridge stamping wired into `run-recorder.ts` (SessionStart payload + ensureSessionOpenInflight direct insert) and `session-end.ts` (auto-context-pack save).
- MCP stamping wired into `save-context-pack/handler.ts` and `record-decision/handler.ts`.
- `ContextPackStoreWriteOptions.createdByUserId` field added to the framework type for forward-compat.

### Sync daemon pull-tick (Caveat 1 fix)

- [apps/sync-daemon/src/lib/team-rows-puller.ts](../../apps/sync-daemon/src/lib/team-rows-puller.ts) — pulls `runs`, `decisions`, `context_packs`, `run_events` cloud→local every 10s. ON CONFLICT (id) DO NOTHING per ADR-007. Wired into sync-daemon boot in [apps/sync-daemon/src/index.ts](../../apps/sync-daemon/src/index.ts).
- Integration test [apps/sync-daemon/__tests__/integration/team-rows-puller.test.ts](../../apps/sync-daemon/__tests__/integration/team-rows-puller.test.ts) — 3 tests against testcontainers Postgres covering happy path / idempotency / cloud-empty.

### CLI team commands

- [packages/cli/src/lib/team-migrate/](../../packages/cli/src/lib/team-migrate/) — engine: `types.ts`, `planner.ts`, `executor.ts` (12-phase pipeline), `rollback.ts`, `index.ts` barrel.
- [packages/cli/src/commands/team-setup-cmd.ts](../../packages/cli/src/commands/team-setup-cmd.ts) — **`runTeamSetupCommand`** (admin bootstrap: connectivity check → pgvector install → migrations → schema verify → local config → credentials block). The first command an admin runs.
- [packages/cli/src/commands/team-migrate-cmd.ts](../../packages/cli/src/commands/team-migrate-cmd.ts) — `runTeamMigrateCommand`, `runTeamJoinCommand`, `runTeamLeaveCommand`.
- Wired into `program.ts`: `coodra team setup / migrate / join / leave` subcommands.
- [packages/cli/src/doctor/checks/36-team-config.ts](../../packages/cli/src/doctor/checks/36-team-config.ts) — doctor check that surfaces team-config drift (COODRA_MODE=team but config still solo, partial team blocks, weak hook secrets).
- [packages/cli/src/commands/cloud-migrate.ts](../../packages/cli/src/commands/cloud-migrate.ts) — `EXPECTED_PUBLIC_TABLES` updated for the post-M06 + M04 Phase 4 14-table schema.
- 4 integration tests in [packages/cli/__tests__/integration/team-migrate.test.ts](../../packages/cli/__tests__/integration/team-migrate.test.ts) covering plan correctness / preserved run_ids / idempotent re-run / slug-conflict detection / rollback + snapshot restore.
- 1 end-to-end smoke test in [packages/cli/__tests__/integration/team-end-to-end.test.ts](../../packages/cli/__tests__/integration/team-end-to-end.test.ts) — admin setup → solo work → migrate → member joins → cross-team-member visibility verified against a real Postgres.

### Documentation

- [docs/team-setup.md](../../team-setup.md) — full user-facing flow (admin Supabase bootstrap + teammate join + common pitfalls + cost / data ownership).

### Production fixes from end-to-end smoke test against real Supabase (Phase G)

The smoke test was run against a real Supabase project and surfaced **five critical production bugs** that would have hit real users on day one. Every fix is robust, not a workaround:

1. **WAL-mode snapshot bug** ([executor.ts::snapshotLocalDb](../../packages/cli/src/lib/team-migrate/executor.ts)). Coodra local SQLite runs in WAL mode (per packages/db/src/client.ts:88). The original `snapshotLocalDb` was a plain `copyFileSync` which captured only the main file, missing recent writes still in `<src>-wal`. **Real-world impact:** every `team migrate --rollback` would have restored an effectively-empty DB — total data loss on the recovery path. **Fix:** `PRAGMA wal_checkpoint(TRUNCATE)` before copy, forcing WAL into the main file.

2. **FK violation in `rewriteLocalProjectIds`** ([executor.ts](../../packages/cli/src/lib/team-migrate/executor.ts)). With `foreign_keys=ON` (the SQLite default in Coodra), updating `projects.id` first orphaned the runs/context_packs/policies/policy_decisions FKs, and updating children first pointed them at non-existent projects. **Real-world impact:** every `team migrate --yes` against any local DB with project data would fail at phase 10 with `FOREIGN KEY constraint failed`. **Fix:** wrap the rewrite in a better-sqlite3 transaction with `PRAGMA defer_foreign_keys = ON` so FK validation is deferred to COMMIT.

3. **Idempotency check missing in planner** ([planner.ts](../../packages/cli/src/lib/team-migrate/planner.ts)). Re-running `team migrate` on already-migrated state minted fresh uuids for projects whose ids already matched cloud, then auto-renamed them with hex suffixes (creating duplicates) or hit slug-uniqueness violations. **Real-world impact:** documented "idempotent + resumable" contract was silently broken. **Fix:** identity-match check in `buildProjectIdMap` (preserves id when local.id already exists in cloud) + matching skip in `detectSlugConflicts`.

4. **Rollback FK cascade assumption wrong** ([rollback.ts](../../packages/cli/src/lib/team-migrate/rollback.ts)). The rollback assumed all four child FKs (run_diffs, context_packs, decisions, run_events) cascade-on-delete from runs. Reality: only run_diffs cascades; context_packs is NO ACTION (blocking), decisions + run_events are SET NULL (orphans, leaks migrated state). **Real-world impact:** every rollback failed with `update or delete on table "runs" violates foreign key constraint "context_packs_run_id_runs_id_fk"`. **Fix:** explicit child deletes in dependency order (run_diffs → context_packs → decisions → run_events → policy_decisions → runs → projects), using `inArray` for batched DELETEs.

5. **Cleanup phase aggressively deleted `_migration_map`** ([executor.ts](../../packages/cli/src/lib/team-migrate/executor.ts)). On successful migrate, the cleanup phase dropped the map rows for the attempt — meaning operators couldn't roll back a completed migration they regretted, and the audit trail was destroyed. **Real-world impact:** "I changed my mind" recovery path didn't exist. **Fix:** cleanup is now a no-op; map rows are kept for audit + late rollback. Future `team migrate --prune-history` can offer scheduled cleanup.

Plus three quality-of-life fixes:
- **Heartbeat during migration apply** ([team-setup-cmd.ts](../../packages/cli/src/commands/team-setup-cmd.ts)) — Drizzle's `migratePostgres` is opaque; remote-Postgres targets take 30-90s. The setup command now ticks every 5s with elapsed time so users don't think it's hung.
- **vitest `hookTimeout` + `testTimeout` bumped to 120s** for the cli + sync-daemon integration suites — remote Postgres needs the headroom; local Postgres targets run in <10s either way.
- **`fileParallelism: false`** on the cli integration suite — multiple files DROP/migrate the same shared schema in their `beforeAll`; serial execution prevents the race.

### Verification status — actually run end-to-end against your Supabase

- `pnpm -r typecheck` → **all 9 packages clean**
- `pnpm -r test:unit` → **868/868 tests pass**
- `pnpm --filter @coodra/cli test:integration` (with `DATABASE_URL` set against the real Supabase at `gyopozvfmggumidptmjr.supabase.co`) → **60/60 tests pass**, including the team-end-to-end smoke test that exercises admin setup → solo seed → migrate → member joins → cross-team-member visibility.

This means a real user running `coodra team setup` followed by `coodra team migrate` followed by `coodra team migrate --rollback` against their own Supabase will see all three commands work as documented. No reverts, no "this only runs in our environment" workarounds.

### Architecture docs

- [system-architecture.md §2](../../system-architecture.md) — service inventory updated: Semantic Diff + NL Assembly removed (M05/M06 reshaped them), local-only bridge note added.
- [system-architecture.md §19](../../system-architecture.md) — Caveat 1 + Caveat 2 fixes documented; `LOCAL_HOOK_SECRET` scope narrowed to sync-daemon cloud-API auth.
- [essentialsforclaude/11-adrs.md](../../essentialsforclaude/11-adrs.md) — **ADR-014** added: Tier 2.5 RBAC + local-only bridge in team mode.

## Decisions made

- **Decision (2026-05-09): Tier 2.5 RBAC (admin / member / viewer) is the right tier.** Rationale: Clerk's built-in admin/basic_member covers 90% of teams; adding `viewer` as a custom Clerk role gives auditor / PM / stakeholder visibility without complicating the role-policy mapping. Custom roles (Tier 3) deferred — add later if a real team needs them. Alternatives considered: admin/member only (rejected — no read-only role for stakeholders); custom roles + permissions table (rejected — operational complexity not justified by current need).
- **Decision (2026-05-09): viewer is read-only even on own resources.** Rationale: a viewer who can write their own decisions defeats the role's auditor / PM intent. The `assertCanEdit(actor, resource, { allowOwner: true })` helper enforces this — owner shortcut requires at least `member` rank. Alternatives: relax the gate for viewer-owned resources (rejected — same reason). Locked in [roles.test.ts](../../packages/shared/__tests__/unit/auth/roles.test.ts).
- **Decision (2026-05-09): Hooks Bridge stays local in team mode (Caveat 2).** Rationale: cloud bridge added 50–200ms hot-path latency, a new failure mode, and HTTPS/cert/DNS surface area for zero capability gain. Local-bridge + sync-daemon-push is durable, fast, and matches ADR-008's local-first thesis. Alternatives: deploy cloud bridge per the original §19 plan (rejected — see latency/failure analysis). Architecture doc + ADR-014 record the supersede.
- **Decision (2026-05-09): Pull-sync is mandatory in team mode (Caveat 1).** Rationale: M05 SessionStart recent-decisions injection silently broke without it — member A's decision invisible to member B's local MCP. The fix ships with team-mode foundation, not after. Alternatives: ship team mode without pull-sync (rejected — silent feature regression).
- **Decision (2026-05-09): Migration is solo→team only at the data layer.** Rationale: `team leave` clears local config but doesn't delete team-tagged local rows — that's a destructive operation deferred to a future `clean-team-data` command. Cloud data untouched on leave. Alternatives: team→solo data move (rejected — not a real use case; users who leave can re-join with the same Clerk identity and the data flows back via pull-sync).
- **Decision (2026-05-09): `run_id` preserved across migration.** Rationale: per the original plan §3.4, run_ids are decorative strings (the FK is what enforces integrity). Preserving them keeps grep-based audit cross-refs intact even when the project_id portion of the run_id encodes the original solo project_id. Alternatives: regenerate run_ids on migration (rejected — adds risk for zero benefit).
- **Decision (2026-05-09): Team mode is bring-your-own-database.** Rationale: each team owns their data; Coodra does not host or proxy a cloud DB on the team's behalf. The admin connects to their own Supabase / Postgres via `coodra team setup`, which validates connectivity, installs pgvector, applies migrations, and prints credentials for teammates. Alternatives considered: multi-tenant cloud hosted by Coodra (rejected — operational scope outside this product, conflicts with ADR-008 local-first thesis, and adds compliance / data-residency obligations a self-hosted model avoids).

## Files modified / created

### New
- `packages/db/drizzle/sqlite/0012_team_actor_attribution.sql`
- `packages/db/drizzle/postgres/0012_team_actor_attribution.sql`
- `packages/db/drizzle/postgres/0013_team_migration_tables.sql`
- `packages/shared/src/auth/roles.ts`
- `packages/shared/__tests__/unit/auth/roles.test.ts`
- `packages/cli/src/lib/team-config.ts`
- `packages/cli/__tests__/unit/lib/team-config.test.ts`
- `packages/cli/src/lib/team-migrate/{types,planner,executor,rollback,index}.ts`
- `packages/cli/src/commands/team-migrate-cmd.ts`
- `packages/cli/__tests__/integration/team-migrate.test.ts`
- `apps/hooks-bridge/src/lib/actor-identity.ts`
- `apps/mcp-server/src/lib/actor-identity.ts`
- `apps/sync-daemon/src/lib/team-rows-puller.ts`
- `apps/sync-daemon/__tests__/integration/team-rows-puller.test.ts`
- `docs/feature-packs/04-web-app-phase-4/{spec.md,meta.json}`
- `docs/context-packs/2026-05-09-module-04-web-app-phase-4-foundation.md` (this file)

### Modified
- `packages/db/src/schema/sqlite.ts` — column additions
- `packages/db/src/schema/postgres.ts` — column additions + migrationAttempts / migrationMap tables
- `packages/db/src/destinations.ts` — `InsertRunRow.createdByUserId`
- `packages/db/drizzle/sqlite/meta/_journal.json` + postgres mirror
- `packages/db/__tests__/unit/{client,schema-parity}.test.ts` — table-count + parity coverage
- `packages/shared/src/auth/index.ts` — re-exports
- `packages/cli/package.json` — exports `./lib/team-config`
- `packages/cli/src/lib/outbox/dispatcher.ts` — `SessionOpenPayloadV1.createdByUserId` pass-through
- `packages/cli/src/program.ts` — wires `team migrate / join / leave`
- `packages/cli/__tests__/unit/program.test.ts` — updated subcommand count
- `apps/hooks-bridge/src/lib/run-recorder.ts` — actor-identity threading
- `apps/hooks-bridge/src/lib/auto-context-pack.ts` — `createdByUserId` input field
- `apps/hooks-bridge/src/handlers/session-end.ts` — calls getActorIdentity → forwards
- `apps/hooks-bridge/src/index.ts` — wires `resolveActorIdentity: getActorIdentity`
- `apps/mcp-server/src/lib/context-pack.ts` — `createdByUserId` write path
- `apps/mcp-server/src/framework/tool-context.ts` — `ContextPackStoreWriteOptions.createdByUserId`
- `apps/mcp-server/src/tools/save-context-pack/handler.ts` — actor stamp
- `apps/mcp-server/src/tools/record-decision/handler.ts` — actor stamp
- `apps/sync-daemon/src/index.ts` — wires `team-rows-puller`
- `system-architecture.md` — §2 + §19 updates
- `essentialsforclaude/11-adrs.md` — ADR-014 added

## Tests

```bash
pnpm -r typecheck     # all 9 packages clean
pnpm -r test:unit     # 868/868 tests pass
                      #   shared:        193 (+19 roles)
                      #   db:             57 (parity, 12-table contract held)
                      #   policy:          9
                      #   web (deprec):   82
                      #   cli:           202 (+14 team-config)
                      #   hooks-bridge:   68
                      #   mcp-server:    257
```

Integration tests (skipped without DATABASE_URL; verified via testcontainers):
- `packages/cli/__tests__/integration/team-migrate.test.ts` — 4 tests
- `apps/sync-daemon/__tests__/integration/team-rows-puller.test.ts` — 3 tests

## Open follow-ups

1. **Phase 4-web** — wire the new server foundation into web-v2 pages once design lands (P1–P14 + C1–C8 from the team-mode plan).
2. **Org-scope retrofit** — every web-v2 query needs `WHERE org_id = actor.orgId` before team mode is shippable end-to-end. Highest-stakes correctness work; gates on Phase 4-web kickoff.
3. **Vitest port** — apps/web/ → apps/web-v2/ (16 test files).
4. **Cutover** — rm apps/web/, mv apps/web-v2 apps/web, update workspace globs.
5. **Multi-org user support** — actor-identity assumes one active org per machine. Future: org-switcher → team-config update.
6. **`coodra clean-team-data`** CLI command — `team leave` doesn't delete team-tagged local rows; future scrubbing command.
7. **Real Clerk OAuth** for `team join` — v1 accepts credentials via flags; future versions will exchange a one-time code.
