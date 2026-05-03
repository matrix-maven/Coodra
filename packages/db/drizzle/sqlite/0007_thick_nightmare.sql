CREATE TABLE `kill_switches` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`target` text,
	`mode` text DEFAULT 'hard' NOT NULL,
	`reason` text NOT NULL,
	`paused_at` integer DEFAULT (unixepoch()) NOT NULL,
	`paused_by_session_id` text,
	`expires_at` integer,
	`resumed_at` integer,
	`resumed_by_session_id` text
);
--> statement-breakpoint
CREATE INDEX `kill_switches_active_idx` ON `kill_switches` (`resumed_at`,`scope`,`target`);