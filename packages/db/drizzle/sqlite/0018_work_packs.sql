CREATE TABLE `integration_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider` text NOT NULL,
	`mode` text DEFAULT 'agent-mediated' NOT NULL,
	`site_url` text NOT NULL,
	`external_project_key` text NOT NULL,
	`board_id` text,
	`enabled_capabilities_json` text DEFAULT '{}' NOT NULL,
	`created_by_run_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_connections_project_provider_uk` ON `integration_connections` (`project_id`,`provider`,`site_url`,`external_project_key`);--> statement-breakpoint
CREATE INDEX `integration_connections_project_idx` ON `integration_connections` (`project_id`,`provider`);--> statement-breakpoint
CREATE TABLE `external_work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_key` text NOT NULL,
	`issue_type` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`url` text,
	`parent_external_key` text,
	`raw_external_json` text DEFAULT '{}' NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_work_items_project_provider_key_uk` ON `external_work_items` (`project_id`,`provider`,`external_key`);--> statement-breakpoint
CREATE INDEX `external_work_items_project_status_idx` ON `external_work_items` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `work_packs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`pack_type` text DEFAULT 'unknown' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`spec_markdown` text DEFAULT '' NOT NULL,
	`implementation_markdown` text DEFAULT '' NOT NULL,
	`sync_markdown` text DEFAULT '' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_by_run_id` text,
	`created_by_user_id` text,
	`org_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_packs_project_slug_uk` ON `work_packs` (`project_id`,`slug`);--> statement-breakpoint
CREATE INDEX `work_packs_project_type_idx` ON `work_packs` (`project_id`,`pack_type`);--> statement-breakpoint
CREATE INDEX `work_packs_project_status_idx` ON `work_packs` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `work_pack_external_links` (
	`id` text PRIMARY KEY NOT NULL,
	`work_pack_id` text NOT NULL,
	`external_work_item_id` text NOT NULL,
	`sync_direction` text DEFAULT 'bidirectional' NOT NULL,
	`sync_state` text DEFAULT 'synced' NOT NULL,
	`last_synced_hash` text,
	`conflict_state` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`work_pack_id`) REFERENCES `work_packs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`external_work_item_id`) REFERENCES `external_work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_pack_external_links_pair_uk` ON `work_pack_external_links` (`work_pack_id`,`external_work_item_id`);--> statement-breakpoint
CREATE INDEX `work_pack_external_links_external_idx` ON `work_pack_external_links` (`external_work_item_id`);--> statement-breakpoint
CREATE TABLE `work_pack_relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_work_pack_id` text,
	`target_work_pack_id` text,
	`source_external_key` text,
	`target_external_key` text NOT NULL,
	`relationship_type` text NOT NULL,
	`sync_level` text DEFAULT 'summary' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_work_pack_id`) REFERENCES `work_packs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_work_pack_id`) REFERENCES `work_packs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `work_pack_relationships_project_source_idx` ON `work_pack_relationships` (`project_id`,`source_external_key`);--> statement-breakpoint
CREATE INDEX `work_pack_relationships_project_target_idx` ON `work_pack_relationships` (`project_id`,`target_external_key`);--> statement-breakpoint
CREATE TABLE `sync_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`work_pack_id` text,
	`provider` text NOT NULL,
	`direction` text NOT NULL,
	`action` text NOT NULL,
	`result` text NOT NULL,
	`actor_run_id` text,
	`external_key` text,
	`summary` text DEFAULT '' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_pack_id`) REFERENCES `work_packs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sync_events_project_created_idx` ON `sync_events` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sync_events_work_pack_idx` ON `sync_events` (`work_pack_id`,`created_at`);
