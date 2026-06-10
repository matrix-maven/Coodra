CREATE TABLE `wikis` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`mode` text DEFAULT 'comprehensive' NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`structure_json` text NOT NULL,
	`generated_by_run_id` text,
	`created_by_user_id` text,
	`org_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`generated_by_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wikis_project_slug_uk` ON `wikis` (`project_id`,`slug`);--> statement-breakpoint
CREATE INDEX `wikis_project_updated_idx` ON `wikis` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `wiki_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`wiki_id` text NOT NULL,
	`page_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`content_markdown` text DEFAULT '' NOT NULL,
	`citations` text DEFAULT '[]' NOT NULL,
	`authored_by_run_id` text,
	`created_by_user_id` text,
	`org_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`wiki_id`) REFERENCES `wikis`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`authored_by_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_pages_wiki_page_uk` ON `wiki_pages` (`wiki_id`,`page_id`);--> statement-breakpoint
CREATE INDEX `wiki_pages_wiki_state_idx` ON `wiki_pages` (`wiki_id`,`state`);
