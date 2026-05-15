#!/bin/bash
# Cleanup script for Coodra data fatigue.
#
# What this fixes (root causes documented inline):
#   1. Stuck `in_progress` runs > 30 min old (SessionEnd hook missed)
#   2. Orphan `run_events` with NULL run_id from races + missing-project sessions
#   3. Doctor-synthetic abandoned runs with no audit value
#
# Idempotent — re-running is safe. Reports counts before/after.

set -euo pipefail

DB="${1:-$HOME/.coodra/data.db}"

if [[ ! -f "$DB" ]]; then
  echo "ERROR: db not found at $DB"
  exit 1
fi

echo "========================================"
echo "Coodra data-fatigue cleanup"
echo "DB: $DB"
echo "========================================"

echo
echo "BEFORE:"
sqlite3 "$DB" "
SELECT '  runs by status:        ' || status || ' = ' || COUNT(*) FROM runs GROUP BY status;
SELECT '  orphan run_events:     ' || COUNT(*) FROM run_events WHERE run_id IS NULL;
SELECT '  doctor-synthetic runs: ' || COUNT(*) FROM runs WHERE session_id LIKE '__coodra_synthetic__%';
"

# ---------------------------------------------------------------------------
# Fix 1 — Cancel stuck in_progress runs older than 30 min.
# Root cause: SessionEnd hook missed (process crash, tool exit without /exit,
# direct-MCP smoke tests). UI has a manual "Cancel N stuck" button; this is
# the automated one-shot equivalent for the cleanup case.
# ---------------------------------------------------------------------------

CANCELLED_STUCK=$(sqlite3 "$DB" "
UPDATE runs SET status = 'cancelled', ended_at = unixepoch()
WHERE status = 'in_progress' AND started_at < unixepoch() - 1800
RETURNING id;" | wc -l | tr -d ' ')

# ---------------------------------------------------------------------------
# Fix 2 — Backfill orphan run_events to a synthetic 'orphan-backfill-2'
# run. Mirrors the M04 0008 migration's approach but for the new orphans
# accumulated since.
#
# Why bind rather than delete: the events carry tool_input + outcome data
# (real Edit/Bash invocations) that has audit value; we just lose the
# session affiliation. Binding to a sentinel run keeps them queryable
# without polluting the runs list.
# ---------------------------------------------------------------------------

BACKFILL_RUN_ID="run:__global__:orphan-backfill-2-$(date +%s)"
BACKFILLED=$(sqlite3 "$DB" "
-- Create the synthetic backfill run if there are orphans to bind.
INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at, ended_at)
SELECT '$BACKFILL_RUN_ID', '__global__', 'orphan-backfill-2-$(date +%s)', 'unknown', 'solo', 'completed', MIN(created_at), MAX(created_at)
FROM run_events WHERE run_id IS NULL
HAVING COUNT(*) > 0;

-- Bind orphans to the synthetic run.
UPDATE run_events SET run_id = '$BACKFILL_RUN_ID' WHERE run_id IS NULL
RETURNING id;
" | wc -l | tr -d ' ')

# ---------------------------------------------------------------------------
# Fix 3 — Hard-delete doctor-synthetic abandoned runs.
# Root cause: `coodra doctor` opens probe runs that never close; they
# accumulate as 'abandoned' on every doctor invocation. They have no audit
# value (no events, no decisions, no packs).
# ---------------------------------------------------------------------------

DELETED_DOCTOR=$(sqlite3 "$DB" "
DELETE FROM runs
WHERE session_id LIKE '__coodra_synthetic__%'
  AND status = 'abandoned'
  AND id NOT IN (SELECT DISTINCT run_id FROM run_events WHERE run_id IS NOT NULL)
  AND id NOT IN (SELECT DISTINCT run_id FROM context_packs WHERE run_id IS NOT NULL)
  AND id NOT IN (SELECT DISTINCT run_id FROM decisions WHERE run_id IS NOT NULL)
RETURNING id;
" | wc -l | tr -d ' ')

# ---------------------------------------------------------------------------
# Optional: Hard-delete really-old abandoned runs (>14 days) with no events.
# These are dev artifacts from the early development phase.
# ---------------------------------------------------------------------------

DELETED_OLD_ABANDONED=$(sqlite3 "$DB" "
DELETE FROM runs
WHERE status = 'abandoned'
  AND started_at < unixepoch() - 14*86400
  AND id NOT IN (SELECT DISTINCT run_id FROM run_events WHERE run_id IS NOT NULL)
  AND id NOT IN (SELECT DISTINCT run_id FROM context_packs WHERE run_id IS NOT NULL)
  AND id NOT IN (SELECT DISTINCT run_id FROM decisions WHERE run_id IS NOT NULL)
RETURNING id;
" | wc -l | tr -d ' ')

echo
echo "AFTER:"
sqlite3 "$DB" "
SELECT '  runs by status:        ' || status || ' = ' || COUNT(*) FROM runs GROUP BY status;
SELECT '  orphan run_events:     ' || COUNT(*) FROM run_events WHERE run_id IS NULL;
SELECT '  doctor-synthetic runs: ' || COUNT(*) FROM runs WHERE session_id LIKE '__coodra_synthetic__%';
"

echo
echo "Summary:"
echo "  ✓ Cancelled stuck in_progress runs (>30min old):  $CANCELLED_STUCK"
echo "  ✓ Backfilled orphan run_events to synthetic run:   $BACKFILLED"
echo "  ✓ Deleted doctor-synthetic empty abandoned runs:   $DELETED_DOCTOR"
echo "  ✓ Deleted old (>14d) abandoned runs without audit: $DELETED_OLD_ABANDONED"
echo
echo "Done."
