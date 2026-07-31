-- COOD-12 — link smart Work Pack sessions to runs and Context Packs.
ALTER TABLE "runs" ADD COLUMN "work_pack_id" text;--> statement-breakpoint
ALTER TABLE "context_packs" ADD COLUMN "work_pack_id" text;--> statement-breakpoint
CREATE INDEX "context_packs_work_pack_idx" ON "context_packs" ("work_pack_id","created_at");
