ALTER TABLE `runs` ADD `active_capabilities_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `policies` ADD `deny_on_policy_error` integer NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE `policy_rules` ADD `enforcement_decision` text;
--> statement-breakpoint
ALTER TABLE `policy_rules` ADD `governance_verdict` text;
--> statement-breakpoint
ALTER TABLE `policy_rules` ADD `enforcement_mode` text;
--> statement-breakpoint
ALTER TABLE `policy_rules` ADD `required_capability` text;
--> statement-breakpoint
ALTER TABLE `policy_rules` ADD `excluded_capability` text;
--> statement-breakpoint
UPDATE `policy_rules`
SET
  `enforcement_decision` = CASE
    WHEN `decision` = 'deny' THEN 'deny'
    WHEN `decision` = 'ask' THEN 'ask'
    ELSE 'allow'
  END,
  `governance_verdict` = CASE
    WHEN `decision` = 'deny' THEN 'block'
    WHEN `decision` = 'ask' THEN 'confirm'
    ELSE 'pass'
  END,
  `enforcement_mode` = CASE
    WHEN `decision` = 'deny' THEN 'preventive'
    WHEN `decision` = 'ask' THEN 'approval'
    ELSE 'detective'
  END;
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `governance_verdict` text;
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `evidence_json` text;
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `result_labels_json` text;
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `active_capabilities_json` text;
--> statement-breakpoint
ALTER TABLE `policy_decisions` ADD `matched_capability` text;
