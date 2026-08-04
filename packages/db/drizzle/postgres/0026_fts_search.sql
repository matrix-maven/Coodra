-- @preserve-begin hand-written:fts-search
-- Block owner: BM25 full-text search (2026-08-03). Drizzle-Kit does NOT
-- emit any of this — these generated tsvector columns and GIN indexes
-- are intentionally absent from packages/db/src/schema/postgres.ts, same
-- convention as the pgvector-hnsw block above (0001_clean_rafael_vega.sql).
-- sha256 of this block is locked in packages/db/migrations.lock.json.
-- If drizzle-kit regenerates this migration and wipes this block,
-- restore from git and re-run `pnpm --filter @coodra/db check:migration-lock`.
--
-- Unlike SQLite's FTS5 (0024_fts_search.sql, which needs hand-rolled
-- sync triggers), a STORED GENERATED column is auto-maintained by
-- Postgres itself on every INSERT/UPDATE — no triggers needed here.
-- Ranking uses ts_rank(search_vector, to_tsquery(...)).
ALTER TABLE "context_packs" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("title", '') || ' ' || coalesce("content_excerpt", ''))) STORED;
--> statement-breakpoint
CREATE INDEX "context_packs_search_vector_idx" ON "context_packs" USING gin ("search_vector");
--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("description", '') || ' ' || coalesce("rationale", ''))) STORED;
--> statement-breakpoint
CREATE INDEX "decisions_search_vector_idx" ON "decisions" USING gin ("search_vector");
--> statement-breakpoint
ALTER TABLE "work_packs" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce("title", '') || ' ' || coalesce("spec_markdown", '') || ' ' || coalesce("implementation_markdown", '') || ' ' || coalesce("sync_markdown", '')
    )
  ) STORED;
--> statement-breakpoint
CREATE INDEX "work_packs_search_vector_idx" ON "work_packs" USING gin ("search_vector");
-- @preserve-end hand-written:fts-search
