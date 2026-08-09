CREATE TABLE "policy_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"project_id" text,
	"run_id" text,
	"scope_type" text NOT NULL,
	"scope_json" text DEFAULT '{}' NOT NULL,
	"grant_kind" text NOT NULL,
	"target_rule_id" text,
	"target_capability" text,
	"grant_fingerprint" text,
	"decision_override" text,
	"source_policy_decision_id" text,
	"reason" text NOT NULL,
	"created_by_user_id" text,
	"approved_by_user_id" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "policy_grants" ADD CONSTRAINT "policy_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "policy_grants" ADD CONSTRAINT "policy_grants_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "policy_grants" ADD CONSTRAINT "policy_grants_target_rule_id_policy_rules_id_fk" FOREIGN KEY ("target_rule_id") REFERENCES "public"."policy_rules"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "policy_grants_active_idx" ON "policy_grants" USING btree ("project_id","grant_kind","expires_at","revoked_at");
--> statement-breakpoint
CREATE INDEX "policy_grants_target_idx" ON "policy_grants" USING btree ("target_rule_id","target_capability");
--> statement-breakpoint
CREATE INDEX "policy_grants_run_idx" ON "policy_grants" USING btree ("run_id","scope_type");
--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "matched_grant_id" text;
--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_matched_grant_id_policy_grants_id_fk" FOREIGN KEY ("matched_grant_id") REFERENCES "public"."policy_grants"("id") ON DELETE no action ON UPDATE no action;
