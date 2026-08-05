-- Append-only Context Packs redesign (2026-08-05) — see sqlite migration
-- 0026_context_packs_append_only.sql for the full rationale.
DROP INDEX "context_packs_run_idx";--> statement-breakpoint
CREATE INDEX "context_packs_run_idx" ON "context_packs" ("run_id");--> statement-breakpoint
ALTER TABLE "context_packs" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "context_packs" ADD COLUMN "importance" text;
