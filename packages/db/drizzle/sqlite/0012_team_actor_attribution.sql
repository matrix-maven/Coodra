-- Module 04 Phase 4 — Team Actor Attribution (2026-05-09)
--
-- Adds Clerk user-id columns to every table where the web team-mode UI
-- needs "created by" / "paused by" / "resumed by" attribution. All
-- columns are nullable: solo-mode rows + pre-Phase-4 rows have NULL.
-- The bridge (apps/hooks-bridge) and MCP server (apps/mcp-server) read
-- the active user id from `~/.coodra/config.json::clerk_user_id` at
-- boot in team mode and pass it through to write paths via the actor
-- identity layer (packages/shared/src/auth).
--
-- Why nullable: forcing NOT NULL would either lie ('__solo__' as a
-- sentinel for solo rows pollutes the value space) or require a
-- backfill migration that has no truth source. NULL = "no user
-- identity recorded" is the cleanest semantics; consumers branch on it.
--
-- No FK to a `users` table: Coodra never owns a users table — Clerk
-- is the user identity source of truth. The `created_by_user_id` is a
-- text reference into Clerk's `user_<id>` namespace; the web app
-- resolves these via the Clerk SDK at render time.
--
-- Used by: Module 04 Phase 4 web team-mode pages (member badges, audit
-- log, "created by" columns). Tier 2.5 RBAC enforcement reads from this
-- column to evaluate "members can resume their own pauses but not
-- others'" (apps/web/lib/auth/assertions.ts::assertCanResumeKillSwitch).

ALTER TABLE `runs` ADD `created_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `decisions` ADD `created_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `context_packs` ADD `created_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `policies` ADD `created_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `feature_packs` ADD `created_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `kill_switches` ADD `paused_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `kill_switches` ADD `resumed_by_user_id` text;
