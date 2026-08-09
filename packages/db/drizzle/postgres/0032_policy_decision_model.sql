ALTER TABLE "runs" ADD COLUMN "active_capabilities_json" text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "deny_on_policy_error" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "enforcement_decision" text;
--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "governance_verdict" text;
--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "enforcement_mode" text;
--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "required_capability" text;
--> statement-breakpoint
ALTER TABLE "policy_rules" ADD COLUMN "excluded_capability" text;
--> statement-breakpoint
UPDATE "policy_rules"
SET
  "enforcement_decision" = CASE
    WHEN "decision" = 'deny' THEN 'deny'
    WHEN "decision" = 'ask' THEN 'ask'
    ELSE 'allow'
  END,
  "governance_verdict" = CASE
    WHEN "decision" = 'deny' THEN 'block'
    WHEN "decision" = 'ask' THEN 'confirm'
    ELSE 'pass'
  END,
  "enforcement_mode" = CASE
    WHEN "decision" = 'deny' THEN 'preventive'
    WHEN "decision" = 'ask' THEN 'approval'
    ELSE 'detective'
  END;
--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "governance_verdict" text;
--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "evidence_json" text;
--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "result_labels_json" text;
--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "active_capabilities_json" text;
--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "matched_capability" text;
