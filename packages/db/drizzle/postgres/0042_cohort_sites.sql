-- COOD-101: record WHERE a cohort item was surfaced and where it was pulled.
-- Postgres counterpart of sqlite/0040_cohort_sites.sql -- see that file
-- for why both columns are derived rather than part of the grain.
ALTER TABLE "memory_cohorts" ADD COLUMN "surfaced_site" text;
--> statement-breakpoint
ALTER TABLE "memory_cohorts" ADD COLUMN "pulled_site" text;
