CREATE TABLE `decision_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_decision_id` text NOT NULL,
	`edge_type` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`metadata_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decision_edges_unique` ON `decision_edges` (`from_decision_id`,`edge_type`,`target_type`,`target_id`);
--> statement-breakpoint
CREATE INDEX `decision_edges_project_target_idx` ON `decision_edges` (`project_id`,`edge_type`,`target_type`,`target_id`);
--> statement-breakpoint
CREATE INDEX `decision_edges_from_idx` ON `decision_edges` (`from_decision_id`,`edge_type`);
