ALTER TABLE "context_packs" ADD COLUMN "archived_in_pack_id" text;
--> statement-breakpoint
CREATE INDEX "context_packs_archived_in_pack_idx" ON "context_packs" USING btree ("archived_in_pack_id");
