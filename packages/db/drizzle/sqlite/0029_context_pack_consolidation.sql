ALTER TABLE `context_packs` ADD `archived_in_pack_id` text;
--> statement-breakpoint
CREATE INDEX `context_packs_archived_in_pack_idx` ON `context_packs` (`archived_in_pack_id`);
