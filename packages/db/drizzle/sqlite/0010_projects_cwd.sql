-- 0010_projects_cwd (2026-05-08)
--
-- Adds `projects.cwd` — absolute filesystem path of the project root (the
-- directory containing `.contextos.json`). Recorded by the bridge on first
-- SessionStart from a registered cwd, and by the CLI's `init` command.
--
-- Why nullable: pre-2026-05-08 projects rows have no recorded cwd, and
-- forcing a default would either lie (process.cwd() of whoever runs the
-- migration) or block migration entirely. Nullable + caller-side fallback
-- (`process.cwd()`) is the clean shape.
--
-- Used by the web app's per-project pack uploader so writes land in the
-- project's own `<cwd>/docs/feature-packs/<slug>/`, not the web-v2 server's
-- cwd. See `apps/web-v2/lib/queries/packs.ts:packsRoot()` for the read side.

ALTER TABLE `projects` ADD `cwd` text;
