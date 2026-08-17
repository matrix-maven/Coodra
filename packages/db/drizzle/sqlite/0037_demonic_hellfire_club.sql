ALTER TABLE `context_packs` ADD `freshness_status` text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE `context_packs` ADD `last_verified_at` integer;--> statement-breakpoint
ALTER TABLE `context_packs` ADD `stale_reason` text;--> statement-breakpoint
ALTER TABLE `context_packs` ADD `verified_against_commit` text;--> statement-breakpoint
ALTER TABLE `context_packs` ADD `verified_against_files` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `freshness_status` text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE `decisions` ADD `stale_reason` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `verified_against_commit` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `verified_against_files` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `last_verified_at` integer;