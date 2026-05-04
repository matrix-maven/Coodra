-- M04 Phase 2 S1 (F3 backfill, OQ-2 lock 2026-05-04)
--
-- Background. The hooks-bridge `run-recorder.ts` historically wrote
-- `run_events` rows with `run_id = NULL` whenever no `runs` row
-- matched (sessionId, projectId) at dispatch time. Sessions running
-- in cwds without a registered `projects` row had every event land
-- this way. The 2026-05-04 audit found 1,405 of 1,407 historical
-- run_events were NULL-`run_id` orphans on the production developer
-- machine.
--
-- The runtime fix landed in this same slice — `resolveAndEnsure()` in
-- `apps/hooks-bridge/src/lib/resolve-project-slug.ts` now auto-
-- creates the missing `projects` row at SessionStart / first event,
-- so new orphans cannot accumulate.
--
-- This migration cleans up the historical mess. It binds every
-- existing NULL-`run_id` row to a synthetic `__global__`-scoped
-- "orphan-backfill" run so the events stay queryable + grep-able.
-- Per OQ-2 lock: backfill > drop (we keep the audit data).
--
-- Idempotent — re-running is a no-op (the synthetic run uses a
-- well-known id with INSERT OR IGNORE; the UPDATE WHERE clause
-- matches no rows after the first run).

-- 1. Ensure the __global__ sentinel project exists. Done by
--    `ensureGlobalProject()` at boot, but defensive here in case the
--    migration runs against a fresh schema before the seed call.
INSERT OR IGNORE INTO projects (id, slug, org_id, name)
  VALUES ('__global__', '__global__', '__global__', 'Global Policy Rules');
--> statement-breakpoint

-- 2. Insert the synthetic backfill run. Well-known id so the
--    migration is idempotent across re-runs.
INSERT OR IGNORE INTO runs (id, project_id, session_id, agent_type, mode, status, started_at, ended_at)
  VALUES (
    'run:__global__:orphan-backfill-0008',
    '__global__',
    'orphan-backfill-0008',
    'unknown',
    'solo',
    'completed',
    unixepoch(),
    unixepoch()
  );
--> statement-breakpoint

-- 3. Bind every NULL-`run_id` orphan to the backfill run. SQLite
--    UPDATE is fast even for thousands of rows because the only
--    index it needs to update is `run_events_run_created_idx`.
UPDATE run_events
  SET run_id = 'run:__global__:orphan-backfill-0008'
  WHERE run_id IS NULL;
