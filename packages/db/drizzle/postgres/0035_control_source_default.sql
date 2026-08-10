-- COOD-34 follow-up: the control catalog shipped with `source` defaulting to
-- 'vxi' (the example catalog it was prototyped against). The importer is now
-- catalog-agnostic, so the default is renamed to the neutral 'catalog'.
ALTER TABLE "controls" ALTER COLUMN "source" SET DEFAULT 'catalog';
UPDATE "controls" SET "source" = 'catalog' WHERE "source" = 'vxi';
