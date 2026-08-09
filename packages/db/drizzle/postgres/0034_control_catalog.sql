CREATE TABLE "controls" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"project_id" text,
	"control_key" text NOT NULL,
	"source" text DEFAULT 'vxi' NOT NULL,
	"domain" text,
	"subdomain" text,
	"title" text NOT NULL,
	"description" text,
	"owner" text,
	"relevance_track" text NOT NULL,
	"implementation_mode" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"guidance" text,
	"source_metadata_json" text DEFAULT '{}' NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "controls_project_source_key_idx" ON "controls" USING btree ("project_id","source","control_key");
--> statement-breakpoint
CREATE INDEX "controls_track_idx" ON "controls" USING btree ("project_id","relevance_track");
--> statement-breakpoint
CREATE TABLE "control_attestations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"project_id" text,
	"control_id" text NOT NULL,
	"run_id" text,
	"work_pack_id" text,
	"status" text DEFAULT 'recorded' NOT NULL,
	"evidence_type" text DEFAULT 'note' NOT NULL,
	"evidence_ref" text,
	"evidence_json" text DEFAULT '{}' NOT NULL,
	"notes" text,
	"created_by_user_id" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "controls" ADD CONSTRAINT "controls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "control_attestations" ADD CONSTRAINT "control_attestations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "control_attestations" ADD CONSTRAINT "control_attestations_control_id_controls_id_fk" FOREIGN KEY ("control_id") REFERENCES "public"."controls"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "control_attestations" ADD CONSTRAINT "control_attestations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "control_attestations_control_idx" ON "control_attestations" USING btree ("control_id","created_at");
--> statement-breakpoint
CREATE INDEX "control_attestations_project_status_idx" ON "control_attestations" USING btree ("project_id","status","expires_at");
