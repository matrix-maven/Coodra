CREATE TABLE "kill_switches" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"target" text,
	"mode" text DEFAULT 'hard' NOT NULL,
	"reason" text NOT NULL,
	"paused_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paused_by_session_id" text,
	"expires_at" timestamp with time zone,
	"resumed_at" timestamp with time zone,
	"resumed_by_session_id" text
);
--> statement-breakpoint
CREATE INDEX "kill_switches_active_idx" ON "kill_switches" USING btree ("resumed_at","scope","target");