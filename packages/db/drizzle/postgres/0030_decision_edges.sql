CREATE TABLE "decision_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"from_decision_id" text NOT NULL,
	"edge_type" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"metadata_json" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decision_edges" ADD CONSTRAINT "decision_edges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decision_edges" ADD CONSTRAINT "decision_edges_from_decision_id_decisions_id_fk" FOREIGN KEY ("from_decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "decision_edges_unique" ON "decision_edges" USING btree ("from_decision_id","edge_type","target_type","target_id");
--> statement-breakpoint
CREATE INDEX "decision_edges_project_target_idx" ON "decision_edges" USING btree ("project_id","edge_type","target_type","target_id");
--> statement-breakpoint
CREATE INDEX "decision_edges_from_idx" ON "decision_edges" USING btree ("from_decision_id","edge_type");
