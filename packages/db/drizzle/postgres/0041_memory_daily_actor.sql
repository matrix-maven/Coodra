-- COOD-99: add the actor dimension to the daily memory rollup.
-- Postgres counterpart of sqlite/0039_memory_daily_actor.sql -- see that
-- file for the full rationale (per-seat utilization, and a grain that
-- does not collide when two developers sync to one cloud).
ALTER TABLE "memory_access_daily" ADD COLUMN "actor_user_id" text NOT NULL DEFAULT 'local';
--> statement-breakpoint
DROP INDEX IF EXISTS "memory_access_daily_grain_uk";
--> statement-breakpoint
CREATE UNIQUE INDEX "memory_access_daily_grain_uk" ON "memory_access_daily" ("project_id","day","channel","site","memory_type","actor_user_id");
