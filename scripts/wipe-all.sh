#!/bin/bash
# Full wipe of the local Coodra DB — fresh-slate reset.
#
# Preserves:
#   - schema (table definitions + indexes)
#   - __drizzle_migrations history (so migrate runner knows what's applied)
#   - __global__ sentinel project (required for orphan-event audit fallback)
#
# Wipes everything else: every project, run, run_event, decision,
# context_pack, policy/policy_rule/policy_decision, kill_switch,
# feature_pack row, pending_jobs row.
#
# Filesystem materialisations under ~/.coodra/packs/ and
# <repo>/docs/feature-packs/ are NOT touched — those are user content.
# If you want to wipe them too, do it manually after this script runs.

set -euo pipefail

DB="${1:-$HOME/.coodra/data.db}"

if [[ ! -f "$DB" ]]; then
  echo "ERROR: db not found at $DB"
  exit 1
fi

echo "========================================"
echo "Coodra FULL WIPE"
echo "DB: $DB"
echo "========================================"

# Stop services so the worker doesn't fight us mid-wipe.
node /Users/abishaikc/Coodra/packages/cli/dist/index.js stop 2>&1 | tail -3 || true

echo
echo "BEFORE:"
sqlite3 "$DB" "
SELECT '  projects:        ' || COUNT(*) FROM projects;
SELECT '  runs:            ' || COUNT(*) FROM runs;
SELECT '  run_events:      ' || COUNT(*) FROM run_events;
SELECT '  decisions:       ' || COUNT(*) FROM decisions;
SELECT '  context_packs:   ' || COUNT(*) FROM context_packs;
SELECT '  policies:        ' || COUNT(*) FROM policies;
SELECT '  policy_rules:    ' || COUNT(*) FROM policy_rules;
SELECT '  policy_decisions:' || COUNT(*) FROM policy_decisions;
SELECT '  kill_switches:   ' || COUNT(*) FROM kill_switches;
SELECT '  feature_packs:   ' || COUNT(*) FROM feature_packs;
SELECT '  pending_jobs:    ' || COUNT(*) FROM pending_jobs;
"

# FK-safe delete order. SQLite doesn't enforce FKs by default in our schema;
# we still walk the dependency graph to keep the script readable + portable.
sqlite3 "$DB" <<'SQL'
DELETE FROM policy_decisions;
DELETE FROM run_events;
DELETE FROM decisions;
DELETE FROM context_packs;
DELETE FROM runs;
DELETE FROM policy_rules;
DELETE FROM policies;
DELETE FROM kill_switches;
DELETE FROM feature_packs;
DELETE FROM pending_jobs;
-- Keep __global__ as the sentinel; nuke every other projects row.
DELETE FROM projects WHERE slug != '__global__';
SQL

echo
echo "AFTER:"
sqlite3 "$DB" "
SELECT '  projects:        ' || COUNT(*) FROM projects;
SELECT '  runs:            ' || COUNT(*) FROM runs;
SELECT '  run_events:      ' || COUNT(*) FROM run_events;
SELECT '  decisions:       ' || COUNT(*) FROM decisions;
SELECT '  context_packs:   ' || COUNT(*) FROM context_packs;
SELECT '  policies:        ' || COUNT(*) FROM policies;
SELECT '  policy_rules:    ' || COUNT(*) FROM policy_rules;
SELECT '  policy_decisions:' || COUNT(*) FROM policy_decisions;
SELECT '  kill_switches:   ' || COUNT(*) FROM kill_switches;
SELECT '  feature_packs:   ' || COUNT(*) FROM feature_packs;
SELECT '  pending_jobs:    ' || COUNT(*) FROM pending_jobs;
"

echo
echo "Surviving rows:"
sqlite3 "$DB" "SELECT 'projects: ' || slug FROM projects;"

# Restart services so the user can immediately move on.
node /Users/abishaikc/Coodra/packages/cli/dist/index.js start 2>&1 | tail -5 || true

echo
echo "Done — DB is fresh. Schema + migration history + __global__ sentinel preserved."
