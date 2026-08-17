-- COOD-90: reclassify `affects` edges whose target was never a file.
--
-- Postgres counterpart of sqlite/0038_impact_target_classification.sql.
-- See that file for the full rationale; the difference here is only that
-- Postgres has a regex operator, so the predicate is the same expression
-- `looksLikeFilePath` uses in `@coodra/shared/decision-targets` rather
-- than SQLite's six spelled-out GLOB alternatives.
--
-- Deliberately narrow: only `edge_type='affects'` with
-- `target_type='file'`. Supersession edges (`target_type='decision'`)
-- carry decision ids and must not be touched.
UPDATE "decision_edges"
SET "target_type" = 'concept'
WHERE "edge_type" = 'affects'
  AND "target_type" = 'file'
  AND NOT (
    "target_id" LIKE '%/%'
    AND "target_id" NOT LIKE '%...%'
    AND "target_id" NOT LIKE '%…%'
    AND "target_id" ~ '\.[A-Za-z0-9]{1,6}$'
  );
