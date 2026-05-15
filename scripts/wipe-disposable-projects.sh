#!/bin/bash
# Wipe disposable projects from the local Coodra DB.
#
# Keeps:
#   __global__       — sentinel, required for orphan-event audit-fallback (F7)
#   coodra        — the active project
#   taskforge-demo   — has real decisions + packs
#   cli              — early M08a dev artifacts
#
# Wipes everything else (cascade: policy_decisions, run_events, decisions,
# context_packs, runs, policy_rules, policies, project-scoped kill_switches,
# projects).
#
# Idempotent — re-running deletes nothing already deleted. Safe to run
# while services are up.

set -euo pipefail

DB="${1:-$HOME/.coodra/data.db}"

# Slugs to KEEP (everything else gets nuked).
KEEP_SLUGS="__global__,coodra,taskforge-demo,cli"

if [[ ! -f "$DB" ]]; then
  echo "ERROR: db not found at $DB"
  exit 1
fi

echo "========================================"
echo "Coodra disposable-project wipe"
echo "DB: $DB"
echo "Keeping slugs: $KEEP_SLUGS"
echo "========================================"

# Build a SQL list of the slugs to keep.
KEEP_SQL_LIST=$(echo "$KEEP_SLUGS" | sed "s/,/','/g")

echo
echo "BEFORE:"
sqlite3 "$DB" "
SELECT '  total projects:        ' || COUNT(*) FROM projects;
SELECT '  total runs:            ' || COUNT(*) FROM runs;
SELECT '  total run_events:      ' || COUNT(*) FROM run_events;
SELECT '  total decisions:       ' || COUNT(*) FROM decisions;
SELECT '  total context_packs:   ' || COUNT(*) FROM context_packs;
SELECT '  total policy_rules:    ' || COUNT(*) FROM policy_rules;
"

# Capture project_ids to wipe.
WIPE_IDS=$(sqlite3 "$DB" "SELECT id FROM projects WHERE slug NOT IN ('$KEEP_SQL_LIST');" | tr '\n' ',' | sed 's/,$//')
WIPE_SLUGS=$(sqlite3 "$DB" "SELECT slug FROM projects WHERE slug NOT IN ('$KEEP_SQL_LIST');" | tr '\n' ',' | sed 's/,$//')

if [[ -z "$WIPE_IDS" ]]; then
  echo
  echo "Nothing to wipe — all projects already match the keep list."
  exit 0
fi

echo
echo "Wiping projects: $WIPE_SLUGS"

# Build a SQL-quoted list of ids.
WIPE_SQL_LIST=$(echo "$WIPE_IDS" | sed "s/,/','/g")
WIPE_SLUG_SQL_LIST=$(echo "$WIPE_SLUGS" | sed "s/,/','/g")

# Cascade in FK-safe order.
sqlite3 "$DB" <<SQL
-- policy_decisions FK to projects directly
DELETE FROM policy_decisions WHERE project_id IN ('$WIPE_SQL_LIST');

-- run_events FK to runs (ON DELETE SET NULL by schema, but we want them gone)
DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE project_id IN ('$WIPE_SQL_LIST'));

-- decisions FK to runs
DELETE FROM decisions WHERE run_id IN (SELECT id FROM runs WHERE project_id IN ('$WIPE_SQL_LIST'));

-- context_packs FK to projects + runs
DELETE FROM context_packs WHERE project_id IN ('$WIPE_SQL_LIST');

-- runs FK to projects
DELETE FROM runs WHERE project_id IN ('$WIPE_SQL_LIST');

-- policy_rules FK to policies (which FK to projects)
DELETE FROM policy_rules WHERE policy_id IN (SELECT id FROM policies WHERE project_id IN ('$WIPE_SQL_LIST'));
DELETE FROM policies WHERE project_id IN ('$WIPE_SQL_LIST');

-- kill_switches: project-scoped use 'target = projectSlug'
DELETE FROM kill_switches WHERE scope = 'project' AND target IN ('$WIPE_SLUG_SQL_LIST');

-- feature_packs has no project FK — they live in <repo>/docs/feature-packs
-- on disk; the table is keyed by slug. We leave them alone — operator can
-- manually delete via /packs/[slug] if desired.

-- Finally, projects rows themselves.
DELETE FROM projects WHERE id IN ('$WIPE_SQL_LIST');
SQL

echo
echo "AFTER:"
sqlite3 "$DB" "
SELECT '  total projects:        ' || COUNT(*) FROM projects;
SELECT '  total runs:            ' || COUNT(*) FROM runs;
SELECT '  total run_events:      ' || COUNT(*) FROM run_events;
SELECT '  total decisions:       ' || COUNT(*) FROM decisions;
SELECT '  total context_packs:   ' || COUNT(*) FROM context_packs;
SELECT '  total policy_rules:    ' || COUNT(*) FROM policy_rules;
"

echo
echo "Surviving projects:"
sqlite3 "$DB" "SELECT '  ' || slug FROM projects ORDER BY slug;"

echo
echo "Done."
