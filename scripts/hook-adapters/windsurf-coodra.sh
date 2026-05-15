#!/usr/bin/env bash
# Windsurf Cascade hook adapter for Coodra.
#
# Windsurf invokes hook scripts as commands with JSON on stdin and
# expects exit-code-based decisions (0 = allow; 2 = deny). Coodra
# Hooks Bridge speaks HTTP, so this adapter:
#
#   1. reads the raw payload from stdin
#   2. POSTs it (verbatim) to http://127.0.0.1:${HOOKS_BRIDGE_PORT:-3101}/v1/hooks/windsurf
#   3. authenticates via X-Local-Hook-Secret (LOCAL_HOOK_SECRET env)
#   4. parses the JSON response — { decision, reason } — and:
#       decision = 'deny'  → write reason to stderr; exit 2
#       decision = 'allow' → exit 0
#   5. on any transport / parse failure: fail-open → exit 0
#
# Per system-architecture.md §3.3 + ADR-009 + 03-hooks-bridge spec.
#
# Install: copy this file to ~/.windsurf/hooks/coodra.sh and
# chmod +x. The hooks-bridge install script (S15) does this for you.

set -eu

URL="http://127.0.0.1:${HOOKS_BRIDGE_PORT:-3101}/v1/hooks/windsurf"
SECRET="${LOCAL_HOOK_SECRET:-}"

# Read the entire stdin payload.
PAYLOAD=$(cat)

# Build curl args. Empty SECRET still works for solo-bypass mode
# (sentinel CLERK_SECRET_KEY); the server's auth chain accepts.
CURL_ARGS=(-sS -X POST "$URL" -H "Content-Type: application/json" --data-binary @-)
if [ -n "$SECRET" ]; then
  CURL_ARGS+=(-H "X-Local-Hook-Secret: $SECRET")
fi

# Talk to the bridge. On network error / non-200, fail open.
RESPONSE=$(printf '%s' "$PAYLOAD" | curl "${CURL_ARGS[@]}" 2>/dev/null) || {
  printf 'coodra-windsurf-adapter: bridge unreachable; failing open\n' >&2
  exit 0
}

# Parse decision. python3 is available on every macOS / ubuntu runner.
DECISION=$(printf '%s' "$RESPONSE" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get("decision", "allow"))
except Exception:
    print("allow")
') || DECISION="allow"

if [ "$DECISION" = "deny" ]; then
  REASON=$(printf '%s' "$RESPONSE" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get("reason", "Blocked by Coodra policy"))
except Exception:
    print("Blocked by Coodra policy")
')
  printf '%s\n' "$REASON" >&2
  exit 2
fi

exit 0
