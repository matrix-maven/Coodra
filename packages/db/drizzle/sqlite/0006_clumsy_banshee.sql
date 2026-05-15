-- Slice 7 (2026-05-03 audit §14.2) — UNIQUE constraint on policy_rules.
--
-- Pre-Slice-7 the table had no UNIQUE constraint on
--   (policy_id, priority, match_event_type, match_tool_name, match_path_glob)
-- so any raw INSERT that bypassed ensureDefaultPolicy's WHERE NOT EXISTS
-- guard could introduce duplicate rows. presentation/setup.sh's pre-Fix-F
-- block did exactly this; the audit observed 9 priority-1 rows in the
-- demo DB where 3 was the design intent (3 tools × 3 setup re-runs).
--
-- This migration runs in two steps:
--
--   1. Pre-cleanup: collapse any existing duplicates to a single row per
--      key tuple, keeping the row with the lexicographically smallest id
--      (deterministic; the choice is arbitrary for our purposes since
--      duplicates carry identical decision/reason values by definition
--      under ensureDefaultPolicy's seed contract).
--      Without this step, the CREATE UNIQUE INDEX below would abort with
--      a constraint violation on databases that ran setup.sh more than
--      once before Slice 6 deleted the inserter.
--
--   2. Create the UNIQUE INDEX so future raw-SQL adventurism cannot
--      reintroduce duplicates.
--
-- Reversibility: dropping the index is `DROP INDEX policy_rules_dedup_uk;`.
-- The pre-cleanup DELETE is NOT reversible — but since collapsed rows
-- carried identical (policy_id, priority, match_event_type, match_tool_name,
-- match_path_glob) and identical decisions per ensureDefaultPolicy's seed
-- contract, no information is lost.

-- @preserve-begin hand-written:policy-rules-dedup-cleanup-sqlite
-- Block owner: Slice 7 (2026-05-03 audit §14.2). Pre-cleanup before the
-- UNIQUE INDEX. Drizzle-Kit does NOT emit this; sha256 of this block is
-- locked in `packages/db/migrations.lock.json`. If drizzle-kit regenerates
-- this migration and wipes this block, restore from git and re-run
-- `pnpm --filter @coodra/db check:migration-lock --write`.
--
-- Step 1: NULL out policy_decisions.matched_rule_id FK references that
-- would prevent the duplicate DELETE below. The schema FK has no
-- ON DELETE clause (defaults to RESTRICT in SQLite when foreign_keys
-- pragma is on), so deleting a referenced rule row would otherwise
-- fail with SQLITE_CONSTRAINT_FOREIGNKEY. Setting the audit's
-- matched_rule_id to NULL preserves the audit row's existence; the
-- canonical rule_id (the surviving MIN(id) per key tuple) is the one
-- that future audits will reference.
UPDATE policy_decisions
SET matched_rule_id = NULL
WHERE matched_rule_id IN (
  SELECT id FROM policy_rules
  WHERE id NOT IN (
    SELECT MIN(id) FROM policy_rules
    GROUP BY policy_id, priority, match_event_type, match_tool_name, match_path_glob
  )
);
-- @preserve-end hand-written:policy-rules-dedup-cleanup-sqlite
--> statement-breakpoint
-- @preserve-begin hand-written:policy-rules-dedup-delete-sqlite
-- Block owner: Slice 7 (2026-05-03 audit §14.2). Step 2 of the dedup —
-- collapse duplicates to a single row per key tuple, keeping MIN(id)
-- as the survivor. Drizzle-Kit does NOT emit this; sha256 of this
-- block is locked in `packages/db/migrations.lock.json`.
DELETE FROM policy_rules
WHERE id NOT IN (
  SELECT MIN(id) FROM policy_rules
  GROUP BY policy_id, priority, match_event_type, match_tool_name, match_path_glob
);
-- @preserve-end hand-written:policy-rules-dedup-delete-sqlite
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_rules_dedup_uk` ON `policy_rules` (`policy_id`,`priority`,`match_event_type`,`match_tool_name`,`match_path_glob`);
