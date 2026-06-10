CREATE TABLE "wikis" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"mode" text DEFAULT 'comprehensive' NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"structure_json" text NOT NULL,
	"generated_by_run_id" text,
	"created_by_user_id" text,
	"org_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"wiki_id" text NOT NULL,
	"page_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"content_markdown" text DEFAULT '' NOT NULL,
	"citations" text DEFAULT '[]' NOT NULL,
	"authored_by_run_id" text,
	"created_by_user_id" text,
	"org_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wikis" ADD CONSTRAINT "wikis_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wikis" ADD CONSTRAINT "wikis_generated_by_run_id_runs_id_fk" FOREIGN KEY ("generated_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_authored_by_run_id_runs_id_fk" FOREIGN KEY ("authored_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wikis_project_slug_uk" ON "wikis" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "wikis_project_updated_idx" ON "wikis" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_wiki_page_uk" ON "wiki_pages" USING btree ("wiki_id","page_id");--> statement-breakpoint
CREATE INDEX "wiki_pages_wiki_state_idx" ON "wiki_pages" USING btree ("wiki_id","state");
