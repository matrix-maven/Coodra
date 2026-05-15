-- Slice 7 (2026-05-03 audit §14.2) — UNIQUE constraint on policy_rules.
-- See drizzle/sqlite/0006_clumsy_banshee.sql for the full rationale.
--
-- Postgres mirror of the SQLite migration. Pre-cleanup uses a CTE
-- because Postgres's GROUP BY ... DELETE pattern requires a different
-- shape than SQLite's. Same end state: at most one row per
-- (policy_id, priority, match_event_type, match_tool_name, match_path_glob)
-- tuple, then a UNIQUE INDEX backstop.

-- @preserve-begin hand-written:policy-rules-dedup-cleanup-postgres
-- Block owner: Slice 7 (2026-05-03 audit §14.2). Pre-cleanup before the
-- UNIQUE INDEX. Drizzle-Kit does NOT emit this; sha256 of this block is
-- locked in `packages/db/migrations.lock.json`. If drizzle-kit regenerates
-- this migration and wipes this block, restore from git and re-run
-- `pnpm --filter @coodra/db check:migration-lock --write`.
--
-- Step 1: NULL out policy_decisions.matched_rule_id FK references that
-- would prevent the duplicate DELETE below. See sqlite mirror for the
-- full rationale.
WITH duplicate_rule_ids AS (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY policy_id, priority, match_event_type, match_tool_name, match_path_glob
             ORDER BY id ASC
           ) AS rn
    FROM policy_rules
  ) r WHERE rn > 1
)
UPDATE policy_decisions
SET matched_rule_id = NULL
WHERE matched_rule_id IN (SELECT id FROM duplicate_rule_ids);
-- @preserve-end hand-written:policy-rules-dedup-cleanup-postgres
--> statement-breakpoint
-- @preserve-begin hand-written:policy-rules-dedup-delete-postgres
-- Step 2: collapse duplicates to a single row per key tuple, keeping
-- the lexicographically smallest id as the survivor.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY policy_id, priority, match_event_type, match_tool_name, match_path_glob
           ORDER BY id ASC
         ) AS rn
  FROM policy_rules
)
DELETE FROM policy_rules WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
-- @preserve-end hand-written:policy-rules-dedup-delete-postgres
--> statement-breakpoint
CREATE UNIQUE INDEX "policy_rules_dedup_uk" ON "policy_rules" USING btree ("policy_id","priority","match_event_type","match_tool_name","match_path_glob");
