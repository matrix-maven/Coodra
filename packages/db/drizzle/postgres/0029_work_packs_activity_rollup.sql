-- Append-only Context Packs redesign (2026-08-05) — see sqlite migration
-- 0027_work_packs_activity_rollup.sql for the full rationale.
ALTER TABLE "work_packs" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_packs" ADD COLUMN "latest_context_pack_id" text REFERENCES "context_packs"("id");
