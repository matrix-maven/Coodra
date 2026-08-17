-- COOD-99: add the actor dimension to the daily memory rollup.
--
-- `memory_access_events` has always carried `actor_user_id`; the rollup
-- aggregated it away. That cost per-seat utilization (the reason the
-- PRD gave for the column existing) and it made team sync unsafe: with
-- no actor in the grain, two developers on one project produce the SAME
-- (project, day, channel, site, memory_type) row, so pushing to a shared
-- cloud loses one of them under any conflict policy (COOD-98).
--
-- NOT NULL with a `local` sentinel, not a nullable column. Solo mode has
-- no Clerk actor, and a NULL inside a UNIQUE index is treated as
-- distinct by SQL -- the COOD-79 trap that already forces this rollup to
-- recompute by delete-then-insert rather than upsert.
--
-- Existing rows predate the dimension and were produced on one machine,
-- so backfilling them to `local` is accurate, not a guess.
ALTER TABLE `memory_access_daily` ADD COLUMN `actor_user_id` text NOT NULL DEFAULT 'local';
--> statement-breakpoint
DROP INDEX IF EXISTS `memory_access_daily_grain_uk`;
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_access_daily_grain_uk` ON `memory_access_daily` (`project_id`,`day`,`channel`,`site`,`memory_type`,`actor_user_id`);
