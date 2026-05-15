# Module 04 — Web App Phase 4 — Team-Mode Foundation — Spec

> **Status:** server-side foundation shipped 2026-05-09. Web app surfaces (Phase 4-web) deferred until UI design lands.
> **Depends on:** 01 Foundation, 02 MCP Server, 03 Hooks Bridge, 04a Sync Daemon, 06 Run Diff.
> **Branches:** all server-side wiring (this commit) precedes the web pages so the server contract is stable when web design ships.

## 1. Goal

Bring Coodra team mode from "scaffolded" to "functional" — every component the team UI will read from now exists, gets stamped with actor identity, and stays cross-team-member consistent.

This phase is **server-side only**:
- Schema additions for member attribution.
- Shared RBAC primitives + Clerk role mapping.
- Bridge + MCP-server stamping of the active user's clerk id on writes.
- Sync daemon bidirectional pull for cross-team visibility (Caveat 1 fix).
- CLI `team migrate` / `team join` / `team leave` commands.
- Architecture doc updates (Caveat 2 — local-only bridge in team mode).

## 2. What ships

### 2.1 Schema (migration 0012, 0013)

`0012_team_actor_attribution.sql` — adds `created_by_user_id` text columns to `runs`, `decisions`, `context_packs`, `policies`, `feature_packs`, `run_diffs`, plus `paused_by_user_id` + `resumed_by_user_id` on `kill_switches`. All nullable (solo + pre-Phase-4 rows = NULL).

`0013_team_migration_tables.sql` — postgres-only. Adds `_migration_attempts` + `_migration_map` for `coodra team migrate` checkpointing + rollback.

### 2.2 Shared RBAC primitives

`packages/shared/src/auth/roles.ts`:
- `Role = 'viewer' | 'member' | 'admin'`
- `parseClerkRole(clerkRoleString) → Role`
- `Actor = { userId, orgId, role, source }`
- `SOLO_ACTOR` (admin role; synthetic `__solo__` ids)
- `hasRole(actor, min)`, `requireRole(actor, min)`, `assertCanEdit(actor, resource, { allowOwner? })`, `assertCanResumeKillSwitch(actor, killSwitch)`

These are pure / testable / consumed by every server action that lands in Phase 4-web.

### 2.3 Team-config reader/writer

`packages/cli/src/lib/team-config.ts`:
- `readTeamConfig({ homeOverride? }) → TeamConfig` — tolerant of missing file / corrupt JSON; downgrades to solo on any partial-team-block detection.
- `writeTeamConfig(config)` — atomic via tmp-file rename.
- `upgradeToTeamConfig(team)` — promote solo → team.
- `demoteToSoloConfig()` — used by `team leave`.
- `updateLastPulledAt(table, ts)` — pull-tick state tracking (per-table watermarks).

Every consumer (bridge, MCP, sync-daemon, CLI) reads the same file → consistent identity across processes.

### 2.4 Actor identity wiring

`apps/hooks-bridge/src/lib/actor-identity.ts` and `apps/mcp-server/src/lib/actor-identity.ts`:
- `getActorIdentity() → { userId, orgId } | null`
- Read-on-every-call so `team migrate` mid-session picks up new identity without daemon restart.

Wired into:
- `apps/hooks-bridge/src/lib/run-recorder.ts` — `recordSessionStart` payload + `ensureSessionOpenInflight` direct insert.
- `apps/hooks-bridge/src/handlers/session-end.ts` — `saveAutoContextPack` call.
- `apps/mcp-server/src/tools/save-context-pack/handler.ts` — `ContextPackStoreWriteOptions.createdByUserId`.
- `apps/mcp-server/src/tools/record-decision/handler.ts` — `decisions.created_by_user_id`.

### 2.5 Sync daemon pull-tick (Caveat 1 fix)

`apps/sync-daemon/src/lib/team-rows-puller.ts`:
- Ticks every 10s (configurable via `COODRA_SYNC_TICK_MS`).
- Pulls `runs`, `decisions`, `context_packs`, `run_events` newer than local watermark.
- INSERT ... ON CONFLICT (id) DO NOTHING per ADR-007 append-only.
- `runs` pulled first so dependent FK lookups succeed in the same tick.

Without this, member A's decision was invisible to member B's local MCP. The M05 SessionStart recent-decisions injection silently broke. With this, cross-team awareness works.

### 2.6 CLI team commands

`packages/cli/src/commands/team-setup-cmd.ts` + `team-migrate-cmd.ts` + `packages/cli/src/lib/team-migrate/`:
- **`coodra team setup`** — admin bootstrap. Connects to the team's own Supabase / Postgres, installs pgvector, applies migrations, verifies 14 expected tables, generates local hook secret, writes admin config, prints credentials block for teammates. The first command an admin runs. **Bring-your-own-DB** posture documented in [docs/team-setup.md](../../team-setup.md).
- **`coodra team migrate`** — solo→team data move. 12-phase pipeline (preflight → snapshot → plan → reserve → projects → runs → children → org_scoped → verify → rewrite_local → commit → cleanup). Idempotent + resumable + rollback-able. Slug conflicts auto-renamed.
- **`coodra team join`** — teammate machine onboarding. Promotes local config to team mode; sync-daemon pull-tick handles the actual seed.
- **`coodra team leave --yes`** — demotes config back to solo.

### 2.6.1 Doctor check 36 — team-config well-formed

`packages/cli/src/doctor/checks/36-team-config.ts` — surfaces config drift:
- Solo + no team block → green.
- COODRA_MODE=team but config still solo → yellow with remediation.
- Team block present but missing required fields (clerkUserId, clerkOrgId, localHookSecret, weak secret) → yellow.
- Complete team block → green with abbreviated identity in detail.

`coodra doctor --full` runs all 36 checks. Essential subset (default `coodra doctor`) is unchanged at 11 checks.

### 2.6.2 cloud-migrate updated for the 14-table schema

`packages/cli/src/commands/cloud-migrate.ts`'s `EXPECTED_PUBLIC_TABLES` constant updated to include `kill_switches`, `run_diffs`, `_migration_attempts`, `_migration_map` (post-M06 + M04 Phase 4). The pre-flight unknown-table check no longer false-flags fresh DBs as suspect.

### 2.7 Architecture doc updates

`system-architecture.md`:
- §2 Service Inventory — drops Semantic Diff (M06 → in-process) + NL Assembly (M05 → agent-driven). Adds note on local-only bridge.
- §19 Auth Strategy — clarifies `LOCAL_HOOK_SECRET` scope (cloud-API auth only, never bridge), documents Caveat 1 + Caveat 2 fixes.

`essentialsforclaude/11-adrs.md`:
- ADR-014 — Tier 2.5 RBAC + local-only bridge in team mode.

## 3. What does NOT ship in this phase

- Web app pages (deferred until design lands): `/onboarding/org`, `/onboarding/connect`, `/welcome`, `/team/members`, `/team/members/[id]`, `/audit`, `/settings/integrations`.
- Web app components: `<MemberBadge>`, `<RolePill>`, `<SyncStatusIndicator>`, `<ActivityFeedRow>`, `<EmptyOrgState>`, `<RoleGate>`, `<InviteTeammateButton>`.
- Org-scope retrofit on existing web-v2 query files (Phase B from the original plan).
- Vitest port from apps/web/ → apps/web-v2/.
- Cutover (rm apps/web/ + rename web-v2 → web).

These all gate on the design system and will land in Phase 4-web after Phase 4 server-side is committed.

## 4. Acceptance criteria

1. `pnpm -r typecheck` clean across all 9 packages.
2. `pnpm -r test:unit` passes — 868 tests, 0 failures.
3. `pnpm --filter @coodra/db check:migration-lock` clean.
4. CLI `coodra team migrate --help` lists the new flags.
5. CLI `coodra team --help` lists `migrate / join / leave / login / logout` subcommands.
6. With `DATABASE_URL` set, `pnpm --filter @coodra/cli test:integration` exercises the full migrate / rollback / idempotent-replay flow.
7. With `DATABASE_URL` set, `pnpm --filter @coodra/sync-daemon test:integration` exercises the team-rows pull-tick.
8. RBAC unit tests cover admin / member / viewer behavior + ownership semantics + Clerk role parsing.

## 5. Open follow-ups

1. Phase 4-web — wire the new server foundation into web-v2 pages once design lands.
2. Multi-org user support — the actor-identity helper assumes one active org per machine. Future: org-switcher in topbar feeds into team-config.
3. `clean-team-data` CLI command — `team leave` doesn't delete team-tagged local rows; a future scrubbing command will.
4. Real Clerk OAuth handshake for `team join` — v1 accepts credentials via flags; future versions will exchange a one-time code for the credentials.
