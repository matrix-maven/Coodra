-- @preserve-begin hand-written:fts-search
-- Block owner: BM25 full-text search (2026-08-03). Drizzle-Kit does NOT
-- emit any of this — these FTS5 virtual tables and their sync triggers
-- are intentionally absent from packages/db/src/schema/sqlite.ts, same
-- convention as the context_packs_vec block above (0001_chief_turbo.sql).
-- sha256 of this block is locked in packages/db/migrations.lock.json.
-- If drizzle-kit regenerates this migration and wipes this block,
-- restore from git and re-run `pnpm --filter @coodra/db check:migration-lock`.
--
-- Standalone (not "external content") FTS5 tables: context_packs/
-- decisions/work_packs all use TEXT primary keys, which don't map onto
-- FTS5's rowid-based external-content mode, so each FTS table carries
-- its own copy of the indexed text plus an UNINDEXED id column to join
-- back. Ranking uses FTS5's built-in bm25(fts_table).
--
-- decisions_fts only needs an AFTER INSERT trigger — decisions are
-- append-only (idempotency-key UNIQUE constraint means a "duplicate"
-- record_decision call never reaches an UPDATE/DELETE path). context_packs
-- and work_packs are both mutable (re-saved / upserted), so they get
-- INSERT + UPDATE triggers; context_packs additionally gets a DELETE
-- trigger for correctness even though no code path deletes rows today.
CREATE VIRTUAL TABLE context_packs_fts USING fts5(
  context_pack_id UNINDEXED,
  title,
  content_excerpt
);
--> statement-breakpoint
CREATE TRIGGER context_packs_fts_ai AFTER INSERT ON context_packs BEGIN
  INSERT INTO context_packs_fts(context_pack_id, title, content_excerpt)
  VALUES (new.id, new.title, new.content_excerpt);
END;
--> statement-breakpoint
CREATE TRIGGER context_packs_fts_au AFTER UPDATE ON context_packs BEGIN
  DELETE FROM context_packs_fts WHERE context_pack_id = old.id;
  INSERT INTO context_packs_fts(context_pack_id, title, content_excerpt)
  VALUES (new.id, new.title, new.content_excerpt);
END;
--> statement-breakpoint
CREATE TRIGGER context_packs_fts_ad AFTER DELETE ON context_packs BEGIN
  DELETE FROM context_packs_fts WHERE context_pack_id = old.id;
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE decisions_fts USING fts5(
  decision_id UNINDEXED,
  description,
  rationale
);
--> statement-breakpoint
CREATE TRIGGER decisions_fts_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(decision_id, description, rationale)
  VALUES (new.id, new.description, new.rationale);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE work_packs_fts USING fts5(
  work_pack_id UNINDEXED,
  title,
  spec_markdown,
  implementation_markdown,
  sync_markdown
);
--> statement-breakpoint
CREATE TRIGGER work_packs_fts_ai AFTER INSERT ON work_packs BEGIN
  INSERT INTO work_packs_fts(work_pack_id, title, spec_markdown, implementation_markdown, sync_markdown)
  VALUES (new.id, new.title, new.spec_markdown, new.implementation_markdown, new.sync_markdown);
END;
--> statement-breakpoint
CREATE TRIGGER work_packs_fts_au AFTER UPDATE ON work_packs BEGIN
  DELETE FROM work_packs_fts WHERE work_pack_id = old.id;
  INSERT INTO work_packs_fts(work_pack_id, title, spec_markdown, implementation_markdown, sync_markdown)
  VALUES (new.id, new.title, new.spec_markdown, new.implementation_markdown, new.sync_markdown);
END;
-- @preserve-end hand-written:fts-search
