-- COOD-26 / COOD-27: DB-backed policy governance catalog.
--
-- Policies remain the mutable admin surface. Policy versions are immutable
-- activation snapshots, exceptions are explicit scoped overrides, and
-- policy_decisions records the evaluated version/exception/outcome context.

ALTER TABLE `policies` ADD `group_key` text DEFAULT 'agent_guardrails' NOT NULL;
--> statement-breakpoint
ALTER TABLE `policies` ADD `profile` text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
ALTER TABLE `policies` ADD `enforcement_mode` text DEFAULT 'detective' NOT NULL;
--> statement-breakpoint
ALTER TABLE `policy_rules` ADD `control_key` text;
--> statement-breakpoint
ALTER TABLE `policy_rules` ADD `match_command_pattern` text;
--> statement-breakpoint
ALTER TABLE `policy_rules` ADD `rule_type` text DEFAULT 'tool_call' NOT NULL;
--> statement-breakpoint
ALTER TABLE `policy_rules` ADD `severity` text DEFAULT 'medium' NOT NULL;
--> statement-breakpoint
ALTER TABLE `policy_rules` ADD `details` text;
--> statement-breakpoint
CREATE TABLE `policy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`project_id` text,
	`policy_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`snapshot_json` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`created_by_user_id` text,
	`activated_by_user_id` text,
	`change_summary` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`activated_at` integer,
	`retired_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_versions_policy_version_uk` ON `policy_versions` (`policy_id`,`version_number`);
--> statement-breakpoint
CREATE INDEX `policy_versions_policy_status_idx` ON `policy_versions` (`policy_id`,`status`,`version_number`);
--> statement-breakpoint
CREATE TABLE `policy_exceptions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`project_id` text,
	`policy_id` text NOT NULL,
	`policy_version_id` text,
	`rule_id` text,
	`scope_type` text NOT NULL,
	`scope_json` text DEFAULT '{}' NOT NULL,
	`decision_override` text NOT NULL,
	`reason` text NOT NULL,
	`justification` text NOT NULL,
	`requested_by_user_id` text,
	`approved_by_user_id` text,
	`updated_by_user_id` text,
	`status` text DEFAULT 'requested' NOT NULL,
	`starts_at` integer,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`revoked_at` integer,
	`revoked_by_user_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`policy_version_id`) REFERENCES `policy_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rule_id`) REFERENCES `policy_rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `policy_exceptions_active_idx` ON `policy_exceptions` (`project_id`,`status`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `policy_exceptions_policy_idx` ON `policy_exceptions` (`policy_id`,`status`);
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `policy_version_id` text REFERENCES `policy_versions`(`id`);
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `tool_use_id` text;
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `permission_mode` text;
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `matched_exception_id` text REFERENCES `policy_exceptions`(`id`);
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `base_decision` text;
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `effective_decision` text;
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `ask_outcome` text;
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `ask_outcome_at` integer;
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `correlated_run_event_id` text REFERENCES `run_events`(`id`);
--> statement-breakpoint
CREATE INDEX `policy_decisions_ask_correlation_idx` ON `policy_decisions` (`session_id`,`tool_use_id`,`tool_name`,`ask_outcome`);
