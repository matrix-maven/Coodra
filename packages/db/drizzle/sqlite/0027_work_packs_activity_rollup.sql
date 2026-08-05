-- Append-only Context Packs redesign (2026-08-05) — Work Pack activity
-- rollup. Updated mechanically inside save_context_pack/record_decision's
-- existing write path, never by a background job.
ALTER TABLE `work_packs` ADD `last_activity_at` integer;--> statement-breakpoint
ALTER TABLE `work_packs` ADD `latest_context_pack_id` text REFERENCES `context_packs`(`id`);
