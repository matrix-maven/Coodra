-- Phase F.1 — features (2026-05-11).
--
-- One row per on-demand "skill recipe" (Anthropic Skills pattern). The
-- agent indexes these at SessionStart via `coodra__list_features` and
-- pulls the full body via `coodra__get_feature` ONLY when a user
-- prompt matches the frontmatter trigger. Distinct from feature_packs
-- (push-at-SessionStart module blueprints): features are pull-on-trigger
-- skills.
--
-- In solo mode, the canonical source of truth is `docs/features/<slug>/feature.md`
-- on disk. In team mode the cloud Postgres row is the canonical distribution
-- channel (sync-daemon pushes file changes up and pulls cloud changes down
-- to the filesystem). Files stay primary for authoring; cloud is the
-- distribution channel.
--
-- Status lifecycle: draft (visible only to author + admins in web UI) →
-- published (visible to all teammates + agents). MCP `list_features`
-- handler filters to status='published' so unfinished drafts never reach
-- a live agent context.
--
-- Idempotency: UNIQUE(project_id, slug) — a re-publish of the same slug
-- in the same project is an UPDATE (checksum changes) not a duplicate.
-- The sync-daemon dispatch case keys cloud writes by (project_id, slug)
-- so file → cloud round-trips collapse cleanly.
--
-- created_by_user_id: Clerk user_id of the author. NULL on rows
-- ingested from disk by the sync-daemon's filesystem walker (no human
-- identity available) and on solo-mode rows.
--
-- Why frontmatter + body as separate columns (vs single feature_md text):
-- the agent's `list_features` response wants frontmatter without paying
-- the body cost (description + trigger are small; bodies can be many KB).
-- Storing separately lets the handler SELECT frontmatter only.

CREATE TABLE `features` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`slug` text NOT NULL,
	`frontmatter` text NOT NULL,
	`body` text NOT NULL,
	`checksum` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `features_project_slug_uk` ON `features` (`project_id`,`slug`);--> statement-breakpoint
CREATE INDEX `features_project_status_idx` ON `features` (`project_id`,`status`);
