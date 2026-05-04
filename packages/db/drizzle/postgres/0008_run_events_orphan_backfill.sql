-- M04 Phase 2 S1 (F3 backfill, OQ-2 lock 2026-05-04)
--
-- Mirror of `sqlite/0008_run_events_orphan_backfill.sql`. See that
-- file for full background.
--
-- Cloud-side reality: the 2026-05-04 audit found the cloud Postgres
-- (Supabase project `gyopozvfmggumidptmjr`) had 0 rows in every
-- table — it has never been written to. So in practice this
-- migration is a no-op on cloud today; it ships for symmetry and to
-- stay green when team-mode deployments accumulate orphan events
-- before the runtime fix here lands in their bridge image.
--
-- Idempotent — re-running is a no-op.

-- 1. Ensure the __global__ sentinel project exists.
INSERT INTO projects (id, slug, org_id, name)
  VALUES ('__global__', '__global__', '__global__', 'Global Policy Rules')
  ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- 2. Insert the synthetic backfill run.
INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at, ended_at)
  VALUES (
    'run:__global__:orphan-backfill-0008',
    '__global__',
    'orphan-backfill-0008',
    'unknown',
    'solo',
    'completed',
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- 3. Bind every NULL-run_id orphan to the backfill run.
UPDATE run_events
  SET run_id = 'run:__global__:orphan-backfill-0008'
  WHERE run_id IS NULL;
