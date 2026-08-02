-- Audit-ready tenancy and actor attribution columns.
--
-- Columns are nullable because existing solo/team rows cannot be truthfully
-- backfilled in every case. New write paths can populate them from project/run
-- context and the actor identity layer.

ALTER TABLE "runs" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "run_events" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "run_events" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "context_packs" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "pending_jobs" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "pending_jobs" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "pending_jobs" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "features" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "features" ADD COLUMN "updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "external_work_items" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "work_packs" ADD COLUMN "updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "work_pack_external_links" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "work_pack_external_links" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "work_pack_external_links" ADD COLUMN "updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "work_pack_relationships" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "work_pack_relationships" ADD COLUMN "updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "sync_events" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "kill_switches" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "kill_switches" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "kill_switches" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "run_diffs" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "run_diffs" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "wikis" ADD COLUMN "updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "updated_by_user_id" text;--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"run_id" text,
	"actor_user_id" text,
	"actor_run_id" text,
	"event_type" text NOT NULL,
	"subject_table" text NOT NULL,
	"subject_id" text NOT NULL,
	"action" text NOT NULL,
	"result" text DEFAULT 'success' NOT NULL,
	"reason" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"before_hash" text,
	"after_hash" text,
	"prev_hash" text,
	"hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_run_id_runs_id_fk" FOREIGN KEY ("actor_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_org_created_idx" ON "audit_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_project_created_idx" ON "audit_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_subject_idx" ON "audit_events" USING btree ("subject_table","subject_id","created_at");
