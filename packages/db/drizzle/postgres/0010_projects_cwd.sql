-- 0010_projects_cwd (2026-05-08) — postgres mirror.
-- See drizzle/sqlite/0010_projects_cwd.sql for the design rationale.

ALTER TABLE "projects" ADD COLUMN "cwd" text;
