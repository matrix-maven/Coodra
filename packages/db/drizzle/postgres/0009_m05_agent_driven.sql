-- Module 05 (Agent-Driven NL Assembly, 2026-05-08 reshape) — postgres mirror.
--
-- See drizzle/sqlite/0009_m05_agent_driven.sql for the design rationale.
-- Same shape; dialect-appropriate types: BOOLEAN for `reversible`, plain
-- TEXT for the JSON-encoded `meta` / `impact` fields (kept aligned with
-- SQLite for parity rather than promoted to JSONB — the handler does
-- JSON.parse/stringify either way).

ALTER TABLE "context_packs" ADD COLUMN "source" text DEFAULT 'agent' NOT NULL;
--> statement-breakpoint
ALTER TABLE "context_packs" ADD COLUMN "meta" text;
--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "context" text;
--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "impact" text;
--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "confidence" text;
--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "reversible" boolean;
