CREATE TABLE `work_pack_decision_links` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`project_id` text,
	`work_pack_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_pack_id`) REFERENCES `work_packs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_pack_decision_links_pair_uk` ON `work_pack_decision_links` (`work_pack_id`,`decision_id`);--> statement-breakpoint
CREATE INDEX `work_pack_decision_links_decision_idx` ON `work_pack_decision_links` (`decision_id`);--> statement-breakpoint
CREATE TABLE `work_pack_context_pack_links` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`project_id` text,
	`work_pack_id` text NOT NULL,
	`context_pack_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_pack_id`) REFERENCES `work_packs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`context_pack_id`) REFERENCES `context_packs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_pack_context_pack_links_pair_uk` ON `work_pack_context_pack_links` (`work_pack_id`,`context_pack_id`);--> statement-breakpoint
CREATE INDEX `work_pack_context_pack_links_context_pack_idx` ON `work_pack_context_pack_links` (`context_pack_id`);
