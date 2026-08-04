CREATE TABLE "work_pack_decision_links" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"project_id" text,
	"work_pack_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_pack_context_pack_links" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"project_id" text,
	"work_pack_id" text NOT NULL,
	"context_pack_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_pack_decision_links" ADD CONSTRAINT "work_pack_decision_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_pack_decision_links" ADD CONSTRAINT "work_pack_decision_links_work_pack_id_work_packs_id_fk" FOREIGN KEY ("work_pack_id") REFERENCES "public"."work_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_pack_decision_links" ADD CONSTRAINT "work_pack_decision_links_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_pack_context_pack_links" ADD CONSTRAINT "work_pack_context_pack_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_pack_context_pack_links" ADD CONSTRAINT "work_pack_context_pack_links_work_pack_id_work_packs_id_fk" FOREIGN KEY ("work_pack_id") REFERENCES "public"."work_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_pack_context_pack_links" ADD CONSTRAINT "work_pack_context_pack_links_context_pack_id_context_packs_id_fk" FOREIGN KEY ("context_pack_id") REFERENCES "public"."context_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_pack_decision_links_pair_uk" ON "work_pack_decision_links" USING btree ("work_pack_id","decision_id");--> statement-breakpoint
CREATE INDEX "work_pack_decision_links_decision_idx" ON "work_pack_decision_links" USING btree ("decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_pack_context_pack_links_pair_uk" ON "work_pack_context_pack_links" USING btree ("work_pack_id","context_pack_id");--> statement-breakpoint
CREATE INDEX "work_pack_context_pack_links_context_pack_idx" ON "work_pack_context_pack_links" USING btree ("context_pack_id");
