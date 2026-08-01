-- Audit-ready tenancy and actor attribution columns.
--
-- Columns are nullable because existing solo/team rows cannot be truthfully
-- backfilled in every case. New write paths can populate them from project/run
-- context and the actor identity layer.

ALTER TABLE `runs` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `run_events` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `run_events` ADD `project_id` text;
--> statement-breakpoint
ALTER TABLE `context_packs` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `pending_jobs` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `pending_jobs` ADD `project_id` text;
--> statement-breakpoint
ALTER TABLE `pending_jobs` ADD `run_id` text;
--> statement-breakpoint
ALTER TABLE `policies` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `policies` ADD `updated_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `policy_rules` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `policy_rules` ADD `project_id` text;
--> statement-breakpoint
ALTER TABLE `policy_rules` ADD `created_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `policy_rules` ADD `updated_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `policy_rules` ADD `updated_at` integer;
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `features` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `features` ADD `updated_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `integration_connections` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `integration_connections` ADD `updated_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `external_work_items` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `work_packs` ADD `updated_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `work_pack_external_links` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `work_pack_external_links` ADD `project_id` text;
--> statement-breakpoint
ALTER TABLE `work_pack_external_links` ADD `updated_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `work_pack_relationships` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `work_pack_relationships` ADD `updated_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `sync_events` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `decisions` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `decisions` ADD `project_id` text;
--> statement-breakpoint
ALTER TABLE `kill_switches` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `kill_switches` ADD `project_id` text;
--> statement-breakpoint
ALTER TABLE `kill_switches` ADD `run_id` text;
--> statement-breakpoint
ALTER TABLE `run_diffs` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `run_diffs` ADD `project_id` text;
--> statement-breakpoint
ALTER TABLE `wikis` ADD `updated_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `wiki_pages` ADD `project_id` text;
--> statement-breakpoint
ALTER TABLE `wiki_pages` ADD `updated_by_user_id` text;
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text,
	`run_id` text,
	`actor_user_id` text,
	`actor_run_id` text,
	`event_type` text NOT NULL,
	`subject_table` text NOT NULL,
	`subject_id` text NOT NULL,
	`action` text NOT NULL,
	`result` text DEFAULT 'success' NOT NULL,
	`reason` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`before_hash` text,
	`after_hash` text,
	`prev_hash` text,
	`hash` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_events_org_created_idx` ON `audit_events` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `audit_events_project_created_idx` ON `audit_events` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `audit_events_subject_idx` ON `audit_events` (`subject_table`,`subject_id`,`created_at`);
