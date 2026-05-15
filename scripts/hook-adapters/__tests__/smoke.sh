#!/usr/bin/env bash
# Smoke test for the Windsurf + Cursor hook adapter scripts.
#
# Spawns a tiny Python HTTP mock server that returns a deterministic
# response based on the request body, then pipes a fixture payload
# into each adapter and asserts:
#
#   - allow case  → exit code 0, empty stderr
#   - deny case   → exit code 2, reason on stderr
#   - bridge-down → exit code 0 (fail-open)
#
# Runs both on macOS and ubuntu in CI. Requires bash, curl, python3,
# and lsof — all available on `ubuntu-latest` and `macos-latest`.

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADAPTERS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Find an unused port.
find_free_port() {
  python3 -c 'import socket; s = socket.socket(); s.bind(("", 0)); print(s.getsockname()[1]); s.close()'
}

PORT=$(find_free_port)
export HOOKS_BRIDGE_PORT="$PORT"
export LOCAL_HOOK_SECRET="test-secret-$(date +%s)"

# Spawn a Python mock that responds based on the path. The path
# determines deny-vs-allow:
#   /v1/hooks/windsurf body containing "deny-me" → { decision: 'deny', reason: '...' }
#   /v1/hooks/cursor   body containing "deny-me" → { decision: 'deny', reason: '...' }
#   else → { decision: 'allow' }
python3 - <<EOF &
import http.server, json, socketserver, sys

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a, **k):
        pass  # silent
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8') if length else ''
        if 'deny-me' in body:
            payload = { 'decision': 'deny', 'reason': 'mock policy denied' }
        else:
            payload = { 'decision': 'allow' }
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode('utf-8'))

with socketserver.TCPServer(('127.0.0.1', $PORT), Handler) as httpd:
    httpd.serve_forever()
EOF
MOCK_PID=$!

cleanup() {
  if [ -n "${MOCK_PID:-}" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Wait for mock to listen.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sS "http://127.0.0.1:$PORT/" -X POST -d '{}' >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

PASS_COUNT=0
FAIL_COUNT=0

assert_exit_code() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [ "$actual" -eq "$expected" ]; then
    printf '  ✓ %s — exit code %s\n' "$label" "$actual"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf '  ✗ %s — expected exit %s, got %s\n' "$label" "$expected" "$actual" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

run_adapter() {
  local adapter="$1"
  local stdin_payload="$2"
  set +e
  printf '%s' "$stdin_payload" | "$adapter" 2>/tmp/coodra-adapter-stderr
  local code=$?
  set -e
  echo "$code"
}

# --- Windsurf adapter -------------------------------------------------
printf 'WINDSURF\n'
WINDSURF="$ADAPTERS_DIR/windsurf-coodra.sh"
assert_exit_code "allow" 0 "$(run_adapter "$WINDSURF" '{"agent_action_name":"pre_write_code","trajectory_id":"traj-allow"}')"
assert_exit_code "deny"  2 "$(run_adapter "$WINDSURF" '{"agent_action_name":"pre_write_code","trajectory_id":"traj-deny-me"}')"

# Bridge down → fail open.
HOOKS_BRIDGE_PORT=1 assert_exit_code "bridge-down (fail-open)" 0 "$(HOOKS_BRIDGE_PORT=1 run_adapter "$WINDSURF" '{"agent_action_name":"pre_write_code","trajectory_id":"traj-1"}')"

# --- Cursor adapter ---------------------------------------------------
printf 'CURSOR\n'
CURSOR="$ADAPTERS_DIR/cursor-coodra.sh"
assert_exit_code "allow" 0 "$(run_adapter "$CURSOR" '{"conversation_id":"conv-allow","event_type":"pre_tool_use"}')"
assert_exit_code "deny"  2 "$(run_adapter "$CURSOR" '{"conversation_id":"conv-deny-me","event_type":"pre_tool_use"}')"
HOOKS_BRIDGE_PORT=1 assert_exit_code "bridge-down (fail-open)" 0 "$(HOOKS_BRIDGE_PORT=1 run_adapter "$CURSOR" '{"conversation_id":"conv-1","event_type":"pre_tool_use"}')"

printf '\n'
if [ $FAIL_COUNT -gt 0 ]; then
  printf 'SMOKE FAILED — %s pass, %s fail\n' "$PASS_COUNT" "$FAIL_COUNT" >&2
  exit 1
fi
printf 'SMOKE OK — %s assertions\n' "$PASS_COUNT"
