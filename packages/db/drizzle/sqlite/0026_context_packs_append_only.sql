-- Append-only Context Packs redesign (2026-08-05). Was one row per run
-- (unique index), which silently no-op'd a second save on the same run
-- regardless of content — a session touching more than one unit of work
-- (e.g. a Jira sync, then an unrelated ad hoc task) lost the second
-- recap entirely. Now a run can accumulate many Context Packs; retry
-- safety for an identical re-call is handled in application code
-- (context-pack.ts::write()), not by this constraint.
DROP INDEX `context_packs_run_idx`;--> statement-breakpoint
CREATE INDEX `context_packs_run_idx` ON `context_packs` (`run_id`);--> statement-breakpoint
ALTER TABLE `context_packs` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `context_packs` ADD `importance` text;
