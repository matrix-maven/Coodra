-- COOD-34 follow-up: the control catalog shipped with `source` defaulting to
-- 'vxi' (the example catalog it was prototyped against). The importer is now
-- catalog-agnostic, so the default is renamed to the neutral 'catalog'.
-- SQLite cannot ALTER a column default in place, so rewrite the value and let
-- application code supply `source` explicitly on every insert.
UPDATE `controls` SET `source` = 'catalog' WHERE `source` = 'vxi';
