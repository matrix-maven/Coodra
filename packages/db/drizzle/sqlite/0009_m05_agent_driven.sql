-- Module 05 (Agent-Driven NL Assembly, 2026-05-08 reshape)
--
-- Adds:
--   - context_packs.source       — 'agent' | 'bridge_auto' provenance
--   - context_packs.meta         — JSON-encoded agent-curated metadata
--   - decisions.context          — what triggered this decision
--   - decisions.impact           — JSON-encoded array of affected surfaces
--   - decisions.confidence       — 'high' | 'medium' | 'low' | NULL
--   - decisions.reversible       — boolean (integer in SQLite)
--
-- Defaults are chosen so legacy rows (zero today) and existing code paths
-- keep working: `source` defaults to 'agent' so any pre-M05 row is treated
-- as canonical; the four `decisions` fields are nullable so legacy
-- recorders keep compiling.
--
-- The `summary_embedding` column on context_packs and the
-- `context_packs_vec` virtual table are deliberately NOT dropped here —
-- 0010_drop_embeddings.sql does that in a separate migration so the two
-- changes can roll back independently if dist tarball regeneration
-- surfaces issues.

ALTER TABLE `context_packs` ADD `source` text DEFAULT 'agent' NOT NULL;
--> statement-breakpoint
ALTER TABLE `context_packs` ADD `meta` text;
--> statement-breakpoint
ALTER TABLE `decisions` ADD `context` text;
--> statement-breakpoint
ALTER TABLE `decisions` ADD `impact` text;
--> statement-breakpoint
ALTER TABLE `decisions` ADD `confidence` text;
--> statement-breakpoint
ALTER TABLE `decisions` ADD `reversible` integer;
