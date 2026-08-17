-- COOD-90: reclassify `affects` edges whose target was never a file.
--
-- `record_decision`'s old `impactTarget()` stored ANY `impact` entry
-- without a `graph_node:` / `work_pack:` prefix as `target_type='file'`,
-- so prose agents supplied in good faith ("identity", "licensing") was
-- filed as if it named a path. COOD-86's gardening worker then had to
-- filter it out to stop reporting code deleted that never existed.
--
-- The writer classifies now, so this backfills the rows written before
-- it did. No schema change: `target_type` is unconstrained text.
--
-- The predicate mirrors `looksLikeFilePath` in
-- `@coodra/shared/decision-targets`: contains a separator, ends in a
-- 1-6 character alphanumeric extension, and is not an elision like
-- `apps/.../handler.ts` (prose ABOUT a path, which can never resolve).
--
-- The six GLOB alternatives spell out `\.[A-Za-z0-9]{1,6}$` because
-- SQLite has no regex operator. GLOB's `*` backtracks, so each branch
-- matches when SOME dot is followed by exactly N alphanumerics and then
-- end-of-string — the same condition the anchored regex expresses.
--
-- Deliberately narrow: only `edge_type='affects'` with
-- `target_type='file'`. Supersession edges (`target_type='decision'`)
-- carry decision ids and must not be touched.
UPDATE `decision_edges`
SET `target_type` = 'concept'
WHERE `edge_type` = 'affects'
  AND `target_type` = 'file'
  AND NOT (
    `target_id` LIKE '%/%'
    AND `target_id` NOT LIKE '%...%'
    AND `target_id` NOT LIKE '%…%'
    AND (
      `target_id` GLOB '*.[A-Za-z0-9]'
      OR `target_id` GLOB '*.[A-Za-z0-9][A-Za-z0-9]'
      OR `target_id` GLOB '*.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]'
      OR `target_id` GLOB '*.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]'
      OR `target_id` GLOB '*.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]'
      OR `target_id` GLOB '*.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]'
    )
  );
