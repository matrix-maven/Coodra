#!/usr/bin/env bash
# verify-full-functionality.sh — corrected end-to-end functionality test.
#
# Captures the verified-working sequence from the 2026-04-28 functionality
# audit, with all the bugs in the original test plan fixed:
#
#   - run_events column is `phase`, not `event_type`.
#   - pending_jobs has no `completed_at` column; successful jobs are
#     DELETE-ed by the worker (worker.ts:320). Empty table = success.
#   - Bridge route is `/v1/hooks/claude-code`, not `/hooks`.
#   - Claude Code payload schema is `.strict()` and rejects `agent_type`.
#   - LOCAL_HOOK_SECRET lives at <cwd>/.env (where init writes), not at
#     <COODRA_HOME>/.env. (Finding A: closed; loader reads both paths.)
#   - launchd's KeepAlive will respawn a kill-9'd daemon ~1s later, so
#     the doctor negative-control for check 11 uses `coodra stop`
#     instead.
#
# Production safety: this script uses COODRA_HOME=$HOME/.coodra-test
# and ports 3200/3201 to avoid collision with any live Coodra install
# on 3100/3101. Cleanup at the end removes everything it created.
#
# Run from the repo root after `pnpm install` + `pnpm build`:
#   ./__tests__/manual/verify-full-functionality.sh
#
# A future tester can rely on every step here matching reality on main —
# this is the contract.

set -euo pipefail

# ---------------------------------------------------------------------------
# Step 0 — config
# ---------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI_BIN="$REPO_ROOT/packages/cli/dist/index.js"
TEST_HOME="$HOME/.coodra-functest-sh"
TEST_PROJECT="$HOME/coodra-functest-sh"
MCP_PORT=3200
BRIDGE_PORT=3201
SLUG="coodra-functest-sh"
MCP_URL="http://127.0.0.1:${MCP_PORT}"
BRIDGE_URL="http://127.0.0.1:${BRIDGE_PORT}/v1/hooks/claude-code"

green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red()   { printf "\033[1;31m%s\033[0m\n" "$*"; }
yel()   { printf "\033[1;33m%s\033[0m\n" "$*"; }
hdr()   { printf "\n\033[1;36m=== %s ===\033[0m\n" "$*"; }

# Run the CLI against the isolated home + ports without depending on the
# global `coodra` symlink (which a fresh checkout may not have).
coodra() {
  COODRA_HOME="$TEST_HOME" \
    MCP_SERVER_PORT="$MCP_PORT" \
    HOOKS_BRIDGE_PORT="$BRIDGE_PORT" \
    node "$CLI_BIN" "$@"
}

cleanup() {
  hdr "cleanup"
  if [ -f "$CLI_BIN" ]; then
    (cd "$TEST_PROJECT" 2>/dev/null && coodra stop || true) > /dev/null 2>&1 || true
  fi
  rm -rf "$TEST_HOME" "$TEST_PROJECT"
  green "cleanup done — production state untouched"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Step 1 — sanity gates
# ---------------------------------------------------------------------------
hdr "Step 1 — sanity gates (typecheck, lint, test:unit, migration-lock)"
cd "$REPO_ROOT"
pnpm typecheck > /dev/null
green "typecheck"
pnpm lint > /dev/null
green "lint"
pnpm test:unit > /dev/null 2>&1
green "test:unit"
pnpm --filter @coodra/db run check:migration-lock > /dev/null
green "migration-lock"

# ---------------------------------------------------------------------------
# Step 2 — bootstrap
# ---------------------------------------------------------------------------
hdr "Step 2 — coodra init in a fresh project (non-monorepo cwd)"
rm -rf "$TEST_HOME" "$TEST_PROJECT"
mkdir -p "$TEST_PROJECT"
cd "$TEST_PROJECT"
git init -q
echo "# functest-sh" > README.md

coodra init > /tmp/init.log 2>&1 || (cat /tmp/init.log; exit 1)
green "init"

# Init writes .env to <cwd>/.env. <COODRA_HOME>/.env is NOT written by init.
[ -f "$TEST_PROJECT/.env" ] || { red "expected $TEST_PROJECT/.env to exist"; exit 1; }
[ -f "$TEST_PROJECT/.coodra.json" ] || { red "missing .coodra.json"; exit 1; }
[ -f "$TEST_PROJECT/.mcp.json" ] || { red "missing .mcp.json"; exit 1; }
[ -f "$TEST_HOME/data.db" ] || { red "missing data.db"; exit 1; }
green "init artifacts present"

# ---------------------------------------------------------------------------
# Step 3 — start from the project dir (validates fix 4ac68fc)
# ---------------------------------------------------------------------------
hdr "Step 3 — coodra start from a non-monorepo cwd"
cd "$TEST_PROJECT"
coodra start > /tmp/start.log 2>&1 || (cat /tmp/start.log; red "start failed"; exit 1)
sleep 1
curl -sf "${MCP_URL}/healthz" > /dev/null || { red "mcp /healthz unreachable"; exit 1; }
curl -sf "http://127.0.0.1:${BRIDGE_PORT}/healthz" > /dev/null || { red "bridge /healthz unreachable"; exit 1; }
green "both daemons healthy on :${MCP_PORT} / :${BRIDGE_PORT}"

# ---------------------------------------------------------------------------
# Step 4 — doctor (LOCAL_HOOK_SECRET check 20 must be GREEN post-Finding-A fix)
# ---------------------------------------------------------------------------
hdr "Step 4 — coodra doctor"
DOCTOR_OUT=$(coodra doctor 2>&1 || true)
echo "$DOCTOR_OUT" | grep -E "^[✓⚠✗·]\s+20\." | head -1
if echo "$DOCTOR_OUT" | grep -qE "^✓\s+20\."; then
  green "check 20 (LOCAL_HOOK_SECRET present) GREEN — Finding A confirmed closed"
else
  red "check 20 NOT green — Finding A regression"
  echo "$DOCTOR_OUT" | grep -E "^[✓⚠✗·]\s+20\." -A 2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 5 — exercise the bridge (populates run_events)
# ---------------------------------------------------------------------------
hdr "Step 5 — fire SessionStart / Pre+Post for Write+Bash / Stop"
SESSION="step5-$(date +%s)"
post_hook() {
  local payload="$1"
  curl -sf -X POST "$BRIDGE_URL" -H 'content-type: application/json' -d "$payload" > /dev/null
}
post_hook "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$SESSION\",\"cwd\":\"$TEST_PROJECT\"}"
post_hook "{\"hook_event_name\":\"PreToolUse\",\"session_id\":\"$SESSION\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/tmp/x.py\",\"content\":\"print(1)\"},\"tool_use_id\":\"t-w1\",\"cwd\":\"$TEST_PROJECT\"}"
post_hook "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$SESSION\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/tmp/x.py\",\"content\":\"print(1)\"},\"tool_use_id\":\"t-w1\",\"cwd\":\"$TEST_PROJECT\"}"
post_hook "{\"hook_event_name\":\"PreToolUse\",\"session_id\":\"$SESSION\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo hi\"},\"tool_use_id\":\"t-b1\",\"cwd\":\"$TEST_PROJECT\"}"
post_hook "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$SESSION\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo hi\"},\"tool_use_id\":\"t-b1\",\"cwd\":\"$TEST_PROJECT\"}"
post_hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"$SESSION\",\"cwd\":\"$TEST_PROJECT\"}"
green "all 6 hook events accepted"

# ---------------------------------------------------------------------------
# Step 6 — invariant audit (CORRECTED schema)
# ---------------------------------------------------------------------------
hdr "Step 6 — F8/F14 invariants + pending_jobs queue health"
sleep 1
ORPHANS=$(sqlite3 "$TEST_HOME/data.db" "SELECT COUNT(*) FROM run_events WHERE run_id IS NULL;")
[ "$ORPHANS" -eq 0 ] || { red "F8 violated — $ORPHANS orphan run_events rows"; exit 1; }
green "F8 — 0 orphan run_events"

NON_CANON=$(sqlite3 "$TEST_HOME/data.db" "SELECT COUNT(*) FROM policy_decisions WHERE (LENGTH(idempotency_key) - LENGTH(REPLACE(idempotency_key, ':', ''))) != 4;")
[ "$NON_CANON" -eq 0 ] || { red "F14 violated — $NON_CANON non-canonical idempotency keys"; exit 1; }
green "F14 — every policy_decisions key 4-colon"

DEAD=$(sqlite3 "$TEST_HOME/data.db" "SELECT COUNT(*) FROM pending_jobs WHERE status = 'dead';")
[ "$DEAD" -eq 0 ] || { red "$DEAD dead pending_jobs rows — outbox dispatch failing"; exit 1; }
green "M03.1 — 0 dead pending_jobs (queue healthy; successful jobs are DELETE-ed)"

INFLIGHT=$(sqlite3 "$TEST_HOME/data.db" "SELECT COUNT(*) FROM pending_jobs WHERE status IN ('pending','picked');")
[ "$INFLIGHT" -le 2 ] || { yel "WARNING: $INFLIGHT in-flight pending_jobs (worker may be lagging)"; }
green "M03.1 — in-flight = $INFLIGHT (≤2 expected)"

# ---------------------------------------------------------------------------
# Step 7 — M03.1 crash-safety harness (self-contained, spawns own bridge)
# ---------------------------------------------------------------------------
hdr "Step 7 — M03.1 SIGTERM + SIGKILL crash-safety"
HARNESS_OUT=$(cd "$REPO_ROOT" && pnpm exec tsx __tests__/manual/verify-outbox-crash-safety.ts 2>&1 || true)
if echo "$HARNESS_OUT" | grep -q "ALL PASS — durable audit outbox holds under SIGTERM and SIGKILL"; then
  green "Path A (SIGTERM) + Path B (SIGKILL) PASS"
else
  red "M03.1 crash-safety regression"
  echo "$HARNESS_OUT" | tail -20
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 8 — hybrid-cadence (OQ3 lock — Stop hook flips runs.status synchronously)
# ---------------------------------------------------------------------------
hdr "Step 8 — hybrid-cadence: status=completed immediately after Stop"
SESSION2="cadence-$(date +%s)"
post_hook "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$SESSION2\",\"cwd\":\"$TEST_PROJECT\"}"
post_hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"$SESSION2\",\"cwd\":\"$TEST_PROJECT\"}"
IMMEDIATE=$(sqlite3 "$TEST_HOME/data.db" "SELECT status FROM runs WHERE session_id='$SESSION2';")
if [ "$IMMEDIATE" = "completed" ]; then
  green "hybrid-cadence wired (Stop hook → status=completed synchronously) — OQ3 lock holds"
else
  yel "WARN: status=$IMMEDIATE immediately after Stop (poll-only fallback?)"
  sleep 2
  AFTER2S=$(sqlite3 "$TEST_HOME/data.db" "SELECT status FROM runs WHERE session_id='$SESSION2';")
  [ "$AFTER2S" = "completed" ] || { red "status still '$AFTER2S' after 2s — durable outbox not draining"; exit 1; }
fi

# ---------------------------------------------------------------------------
# Step 9 — doctor negative-controls
# ---------------------------------------------------------------------------
hdr "Step 9 — doctor negative-controls"
cp "$TEST_HOME/data.db" "$TEST_HOME/data.db.backup"

# `set -o pipefail` (script header) makes a pipeline whose left side
# exits non-zero (doctor exits 2 on RED) propagate through `if`, even
# when the right-hand grep matched. Capture output first, then grep
# against the variable. Same pattern Step 4 already uses for check 20.

# Test A — F7
sqlite3 "$TEST_HOME/data.db" "DELETE FROM projects WHERE slug='__global__';"
TEST_A_OUT=$(coodra doctor 2>&1 || true)
if echo "$TEST_A_OUT" | grep -qE "^✗\s+5\."; then
  green "Test A — delete __global__ → check 5 RED (F7)"
else
  red "Test A regression — check 5 didn't go red after deleting __global__"
  echo "$TEST_A_OUT" | grep -E "^[✓⚠✗·]\s+5\." -A 2 || true
  exit 1
fi
cp "$TEST_HOME/data.db.backup" "$TEST_HOME/data.db"

# Test B — F8
ORPHAN_ID=$(sqlite3 "$TEST_HOME/data.db" "SELECT id FROM run_events WHERE run_id IS NOT NULL LIMIT 1;")
sqlite3 "$TEST_HOME/data.db" "UPDATE run_events SET run_id=NULL WHERE id='$ORPHAN_ID';"
TEST_B_OUT=$(coodra doctor 2>&1 || true)
if echo "$TEST_B_OUT" | grep -qE "^✗\s+7\."; then
  green "Test B — orphan run_event → check 7 RED (F8)"
else
  red "Test B regression — check 7 didn't go red after orphaning run_event"
  echo "$TEST_B_OUT" | grep -E "^[✓⚠✗·]\s+7\." -A 2 || true
  exit 1
fi
cp "$TEST_HOME/data.db.backup" "$TEST_HOME/data.db"
rm "$TEST_HOME/data.db.backup"

# Test C — daemons stopped (NOT kill -9; launchd's KeepAlive respawns)
coodra stop > /dev/null 2>&1
sleep 1
TEST_C_OUT=$(coodra doctor 2>&1 || true)
if echo "$TEST_C_OUT" | grep -qE "^⚠\s+11\."; then
  green "Test C — coodra stop → check 11 YELLOW (ECONNREFUSED)"
else
  red "Test C regression — check 11 didn't go yellow after stop"
  echo "$TEST_C_OUT" | grep -E "^[✓⚠✗·]\s+1[01]\." -A 2 || true
  exit 1
fi
coodra start > /dev/null 2>&1
sleep 1

# ---------------------------------------------------------------------------
# Step 10 — daemon survives terminal close
# ---------------------------------------------------------------------------
hdr "Step 10 — daemon survives a fresh subshell (no inherited shell state)"
env -i HOME="$HOME" PATH="$PATH" COODRA_HOME="$TEST_HOME" \
  MCP_SERVER_PORT="$MCP_PORT" HOOKS_BRIDGE_PORT="$BRIDGE_PORT" \
  bash -c "node '$CLI_BIN' status 2>&1 | grep -E 'running' >/dev/null" \
  || { red "daemons did NOT survive subshell"; exit 1; }
green "daemons alive after fresh subshell — launchd-managed lifecycle independent of the spawning terminal"

# ---------------------------------------------------------------------------
hdr "ALL STEPS PASSED"
green "verify-full-functionality.sh — full functionality matrix green"
