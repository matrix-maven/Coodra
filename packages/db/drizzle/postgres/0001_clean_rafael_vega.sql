CREATE TABLE "feature_packs" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"parent_slug" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"checksum" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_packs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"run_id" text,
	"session_id" text NOT NULL,
	"project_id" text NOT NULL,
	"agent_type" text NOT NULL,
	"event_type" text NOT NULL,
	"tool_name" text NOT NULL,
	"tool_input_snapshot" text NOT NULL,
	"permission_decision" text NOT NULL,
	"matched_rule_id" text,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_decisions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "policy_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text NOT NULL,
	"priority" integer NOT NULL,
	"match_event_type" text NOT NULL,
	"match_tool_name" text NOT NULL,
	"match_path_glob" text,
	"match_agent_type" text,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "context_packs" ADD COLUMN "content_excerpt" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_matched_rule_id_policy_rules_id_fk" FOREIGN KEY ("matched_rule_id") REFERENCES "public"."policy_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "policy_decisions_session_idx" ON "policy_decisions" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "policy_rules_policy_priority_idx" ON "policy_rules" USING btree ("policy_id","priority");--> statement-breakpoint
-- @preserve-begin hand-written:pgvector-hnsw
-- Block owner: Module 02. Ensures the pgvector extension is loaded and
-- materialises the HNSW index on `context_packs.summary_embedding` with
-- cosine distance. Drizzle-Kit does NOT emit this; sha256 of this block
-- is locked in `packages/db/migrations.lock.json`. If drizzle-kit
-- regenerates this migration and wipes this block, restore from git and
-- re-run `pnpm --filter @coodra/db check:migration-lock` to verify.
-- HNSW params per decision 2026-04-22 22:10: m=16, ef_construction=64
-- (pgvector 0.8.x defaults — balanced recall/build-time for datasets up
-- to ~1M rows; revisit in Module 05 if recall degrades measurably).
-- ef_search stays at the session default (40) and is tunable via
-- `SET hnsw.ef_search` in the query path.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE INDEX IF NOT EXISTS context_packs_embedding_hnsw_idx
  ON context_packs
  USING hnsw (summary_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
-- @preserve-end hand-written:pgvector-hnsw