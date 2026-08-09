CREATE TABLE `policy_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`project_id` text,
	`run_id` text,
	`scope_type` text NOT NULL,
	`scope_json` text DEFAULT '{}' NOT NULL,
	`grant_kind` text NOT NULL,
	`target_rule_id` text,
	`target_capability` text,
	`grant_fingerprint` text,
	`decision_override` text,
	`source_policy_decision_id` text,
	`reason` text NOT NULL,
	`created_by_user_id` text,
	`approved_by_user_id` text,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_rule_id`) REFERENCES `policy_rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `policy_grants_active_idx` ON `policy_grants` (`project_id`,`grant_kind`,`expires_at`,`revoked_at`);
--> statement-breakpoint
CREATE INDEX `policy_grants_target_idx` ON `policy_grants` (`target_rule_id`,`target_capability`);
--> statement-breakpoint
CREATE INDEX `policy_grants_run_idx` ON `policy_grants` (`run_id`,`scope_type`);
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `matched_grant_id` text REFERENCES `policy_grants`(`id`);
