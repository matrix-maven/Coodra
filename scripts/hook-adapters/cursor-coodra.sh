#!/usr/bin/env bash
# Cursor hook adapter for Coodra — per ADR-009.
#
# Cursor invokes hook scripts as commands with JSON on stdin and
# expects exit-code-based decisions. Same shape as the Windsurf
# adapter; only the URL differs (server-side adapter routes to the
# Cursor-specific normalizer).
#
# Install: copy this file to .cursor/hooks/coodra.sh and chmod +x.
# The hooks-bridge install script (S15) does this for you.

set -eu

URL="http://127.0.0.1:${HOOKS_BRIDGE_PORT:-3101}/v1/hooks/cursor"
SECRET="${LOCAL_HOOK_SECRET:-}"

PAYLOAD=$(cat)

CURL_ARGS=(-sS -X POST "$URL" -H "Content-Type: application/json" --data-binary @-)
if [ -n "$SECRET" ]; then
  CURL_ARGS+=(-H "X-Local-Hook-Secret: $SECRET")
fi

RESPONSE=$(printf '%s' "$PAYLOAD" | curl "${CURL_ARGS[@]}" 2>/dev/null) || {
  printf 'coodra-cursor-adapter: bridge unreachable; failing open\n' >&2
  exit 0
}

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
