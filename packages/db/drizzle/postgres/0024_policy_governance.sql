-- COOD-26 / COOD-27: DB-backed policy governance catalog.
--
-- Policies remain the mutable admin surface. Policy versions are immutable
-- activation snapshots, exceptions are explicit scoped overrides, and
-- policy_decisions records the evaluated version/exception/outcome context.

ALTER TABLE "policies" ADD COLUMN "group_key" text DEFAULT 'agent_guardrails' NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "profile" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "enforcement_mode" text DEFAULT 'detective' NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "control_key" text;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "match_command_pattern" text;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "rule_type" text DEFAULT 'tool_call' NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "severity" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "details" text;--> statement-breakpoint
CREATE TABLE "policy_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"project_id" text,
	"policy_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"snapshot_json" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"created_by_user_id" text,
	"activated_by_user_id" text,
	"change_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_versions_policy_version_uk" ON "policy_versions" USING btree ("policy_id","version_number");--> statement-breakpoint
CREATE INDEX "policy_versions_policy_status_idx" ON "policy_versions" USING btree ("policy_id","status","version_number");--> statement-breakpoint
CREATE TABLE "policy_exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"project_id" text,
	"policy_id" text NOT NULL,
	"policy_version_id" text,
	"rule_id" text,
	"scope_type" text NOT NULL,
	"scope_json" text DEFAULT '{}' NOT NULL,
	"decision_override" text NOT NULL,
	"reason" text NOT NULL,
	"justification" text NOT NULL,
	"requested_by_user_id" text,
	"approved_by_user_id" text,
	"updated_by_user_id" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text
);
--> statement-breakpoint
ALTER TABLE "policy_exceptions" ADD CONSTRAINT "policy_exceptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_exceptions" ADD CONSTRAINT "policy_exceptions_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_exceptions" ADD CONSTRAINT "policy_exceptions_policy_version_id_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_exceptions" ADD CONSTRAINT "policy_exceptions_rule_id_policy_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."policy_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "policy_exceptions_active_idx" ON "policy_exceptions" USING btree ("project_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "policy_exceptions_policy_idx" ON "policy_exceptions" USING btree ("policy_id","status");--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "policy_version_id" text;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "tool_use_id" text;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "permission_mode" text;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "matched_exception_id" text;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "base_decision" text;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "effective_decision" text;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "ask_outcome" text;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "ask_outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "correlated_run_event_id" text;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_policy_version_id_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_matched_exception_id_policy_exceptions_id_fk" FOREIGN KEY ("matched_exception_id") REFERENCES "public"."policy_exceptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_correlated_run_event_id_run_events_id_fk" FOREIGN KEY ("correlated_run_event_id") REFERENCES "public"."run_events"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "policy_decisions_ask_correlation_idx" ON "policy_decisions" USING btree ("session_id","tool_use_id","tool_name","ask_outcome");
