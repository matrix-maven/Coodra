CREATE TABLE `memory_access_daily` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`project_id` text,
	`day` text NOT NULL,
	`channel` text NOT NULL,
	`site` text NOT NULL,
	`memory_type` text NOT NULL,
	`access_count` integer DEFAULT 0 NOT NULL,
	`distinct_items` integer DEFAULT 0 NOT NULL,
	`distinct_runs` integer DEFAULT 0 NOT NULL,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`total_latency_ms` integer DEFAULT 0 NOT NULL,
	`max_latency_ms` integer DEFAULT 0 NOT NULL,
	`stale_at_access_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_access_daily_grain_uk` ON `memory_access_daily` (`project_id`,`day`,`channel`,`site`,`memory_type`);
--> statement-breakpoint
CREATE INDEX `memory_access_daily_day_idx` ON `memory_access_daily` (`day`);
--> statement-breakpoint
CREATE TABLE `memory_cohorts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`project_id` text,
	`run_id` text,
	`baseline_generation` integer DEFAULT 0 NOT NULL,
	`memory_type` text NOT NULL,
	`memory_id` text NOT NULL,
	`surfaced_count` integer DEFAULT 0 NOT NULL,
	`pulled_count` integer DEFAULT 0 NOT NULL,
	`first_surfaced_at` integer,
	`first_pulled_at` integer,
	`time_to_first_pull_ms` integer,
	`stale_at_access` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_cohorts_grain_uk` ON `memory_cohorts` (`run_id`,`baseline_generation`,`memory_type`,`memory_id`);
--> statement-breakpoint
CREATE INDEX `memory_cohorts_item_idx` ON `memory_cohorts` (`memory_type`,`memory_id`);
--> statement-breakpoint
CREATE INDEX `memory_cohorts_project_idx` ON `memory_cohorts` (`project_id`,`created_at`);
