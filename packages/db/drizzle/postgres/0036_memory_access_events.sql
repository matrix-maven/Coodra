CREATE TABLE "memory_access_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"project_id" text,
	"run_id" text,
	"session_id" text,
	"actor_user_id" text,
	"agent_type" text,
	"run_event_id" text,
	"channel" text NOT NULL,
	"site" text NOT NULL,
	"memory_type" text NOT NULL,
	"memory_id" text,
	"position" integer,
	"bytes" integer,
	"latency_ms" integer,
	"trigger_type" text NOT NULL,
	"query_hash" text,
	"trigger_text_hash" text,
	"result_count" integer,
	"freshness_status_at_access" text,
	"baseline_generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_access_events" ADD CONSTRAINT "memory_access_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_access_events" ADD CONSTRAINT "memory_access_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_access_events" ADD CONSTRAINT "memory_access_events_run_event_id_run_events_id_fk" FOREIGN KEY ("run_event_id") REFERENCES "public"."run_events"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "memory_access_events_project_created_idx" ON "memory_access_events" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE INDEX "memory_access_events_cohort_idx" ON "memory_access_events" USING btree ("run_id","baseline_generation","memory_type","memory_id");
--> statement-breakpoint
CREATE INDEX "memory_access_events_memory_idx" ON "memory_access_events" USING btree ("memory_type","memory_id","created_at");
