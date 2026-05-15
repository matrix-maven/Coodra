-- 0016_feature_packs_org_id.sql — Phase G slice G.9 (2026-05-12).
--
-- Multi-tenancy column. Local SQLite is single-tenant on a developer's
-- laptop (one org per ~/.coodra), so org_id is informational for
-- parity with the cloud schema. The cloud sync path populates org_id
-- from the verified Clerk JWT on every push; multi-tenancy enforcement
-- happens at the cloud query layer.
--
-- The partial unique index allows NEW rows with org_id to enforce
-- (org_id, slug) uniqueness while preserving the legacy UNIQUE(slug)
-- on the column itself (rows with org_id IS NULL fall back to the
-- original constraint).

ALTER TABLE `feature_packs` ADD `org_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `feature_packs_org_slug_uk` ON `feature_packs` (`org_id`,`slug`) WHERE `org_id` IS NOT NULL;
