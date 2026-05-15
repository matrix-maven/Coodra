CREATE TABLE `feature_packs` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`parent_slug` text,
	`is_active` integer DEFAULT true NOT NULL,
	`checksum` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feature_packs_slug_unique` ON `feature_packs` (`slug`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `policy_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`run_id` text,
	`session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`agent_type` text NOT NULL,
	`event_type` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_input_snapshot` text NOT NULL,
	`permission_decision` text NOT NULL,
	`matched_rule_id` text,
	`reason` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`matched_rule_id`) REFERENCES `policy_rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_decisions_idempotency_key_unique` ON `policy_decisions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `policy_decisions_session_idx` ON `policy_decisions` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `policy_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_id` text NOT NULL,
	`priority` integer NOT NULL,
	`match_event_type` text NOT NULL,
	`match_tool_name` text NOT NULL,
	`match_path_glob` text,
	`match_agent_type` text,
	`decision` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `policy_rules_policy_priority_idx` ON `policy_rules` (`policy_id`,`priority`);--> statement-breakpoint
ALTER TABLE `context_packs` ADD `content_excerpt` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- @preserve-begin hand-written:sqlite-vec
-- Block owner: Module 02. Creates the vec0 virtual table paired with
-- `context_packs`. Drizzle-Kit does NOT emit this; sha256 of this block
-- is locked in `packages/db/migrations.lock.json`. If drizzle-kit regenerates
-- this migration and wipes this block, restore from git and re-run
-- `pnpm --filter @coodra/db check:migration-lock` to verify the sha256.
-- EMBEDDING_DIM (384) is sourced from `@coodra/shared/constants`; change
-- via the checklist in `packages/shared/src/constants.ts`.
CREATE VIRTUAL TABLE IF NOT EXISTS context_packs_vec USING vec0(
  context_pack_id TEXT PRIMARY KEY,
  embedding FLOAT[384]
);
-- @preserve-end hand-written:sqlite-vec