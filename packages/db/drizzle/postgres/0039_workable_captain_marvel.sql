ALTER TABLE "context_packs" ADD COLUMN "freshness_status" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "context_packs" ADD COLUMN "last_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "context_packs" ADD COLUMN "stale_reason" text;--> statement-breakpoint
ALTER TABLE "context_packs" ADD COLUMN "verified_against_commit" text;--> statement-breakpoint
ALTER TABLE "context_packs" ADD COLUMN "verified_against_files" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "freshness_status" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "stale_reason" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "verified_against_commit" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "verified_against_files" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "last_verified_at" timestamp with time zone;