#!/usr/bin/env bash
# __tests__/functional/g5-team-join.sh
#
# Phase G.5 functional test — `coodra team join <invite-url>`.
#
# What it proves (without a live cloud Postgres):
#   1. Missing invite URL → clean refusal with usage hint.
#   2. Malformed invite URL → clean refusal.
#   3. Bare token without COODRA_WEB_URL → clean refusal.
#   4. Help text describes the Phase G browser-handoff flow.
#
# Mode B (INTERACTIVE=1) would exercise the full two-machine flow
# against real Clerk + real web + a real admin-minted invite.
# Currently skipped because it requires an admin to have minted an
# invite first; the overall 00-full-flow.sh test covers that.
#
# Run:
#   ./__tests__/functional/g5-team-join.sh

set -uo pipefail

SLICE="G.5"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI_BIN="$REPO_ROOT/packages/cli/dist/index.js"
STUB_HOME=$(mktemp -d -t "coodra-${SLICE}-stub.XXXXXX")
trap 'rm -rf "$STUB_HOME" 2>/dev/null || true' EXIT

PASS=0
FAIL=0
SKIP=0

green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
red()   { printf "\033[1;31m%s\033[0m\n" "$*"; }
yel()   { printf "\033[1;33m%s\033[0m\n" "$*"; }
hdr()   { printf "\n\033[1;36m=== %s ===\033[0m\n" "$*"; }

assert_pass() { green "  ✓ PASS — $*"; PASS=$((PASS + 1)); }
assert_fail() { red "  ✗ FAIL — $*"; FAIL=$((FAIL + 1)); }
assert_skip() { yel "  ⊘ SKIP — $*"; SKIP=$((SKIP + 1)); }

coodra() {
  COODRA_HOME="$STUB_HOME" COODRA_DISABLE_ENV_BOOTSTRAP=1 node "$CLI_BIN" "$@"
}

# ---------------------------------------------------------------------------
hdr "Precondition"
# ---------------------------------------------------------------------------

if [ ! -f "$CLI_BIN" ]; then
  yel "Building CLI..."
  (cd "$REPO_ROOT" && pnpm --filter @coodra/cli build 2>&1 | tail -3) || exit 1
fi
green "  ✓ CLI bundle present"

# ---------------------------------------------------------------------------
hdr "Section 1 — input validation"
# ---------------------------------------------------------------------------

# 1.1: no argument
OUT=$(coodra team join 2>&1 || true)
if echo "$OUT" | grep -q "missing invite URL"; then
  assert_pass "1.1 — missing invite URL refused with usage"
else
  assert_fail "1.1 — got: $(echo "$OUT" | head -3)"
fi

# 1.2: malformed URL (no scheme + no dot — neither URL nor bare token)
OUT=$(coodra team join "garbage" 2>&1 || true)
if echo "$OUT" | grep -q "Invalid invite"; then
  assert_pass "1.2 — malformed input refused"
else
  assert_fail "1.2 — got: $(echo "$OUT" | head -3)"
fi

# 1.3: invalid URL shape
OUT=$(coodra team join "http://bad.url/no/install/path" 2>&1 || true)
if echo "$OUT" | grep -q "Could not extract token"; then
  assert_pass "1.3 — URL without /install/<token> path refused"
else
  assert_fail "1.3 — got: $(echo "$OUT" | head -3)"
fi

# 1.4: bare token (with dot, like a JWT) but no COODRA_WEB_URL
OUT=$(coodra team join "abc.def" 2>&1 || true)
if echo "$OUT" | grep -q "COODRA_WEB_URL"; then
  assert_pass "1.4 — bare token without web URL refused with helpful message"
else
  assert_fail "1.4 — got: $(echo "$OUT" | head -3)"
fi

# ---------------------------------------------------------------------------
hdr "Section 2 — help text"
# ---------------------------------------------------------------------------

OUT=$(node "$CLI_BIN" team join --help 2>&1)
if echo "$OUT" | grep -q "Phase G" && echo "$OUT" | grep -q "invite-url"; then
  assert_pass "2.1 — help mentions Phase G + invite-url"
else
  assert_fail "2.1 — help missing Phase G markers"
fi

if echo "$OUT" | grep -q -- "--no-open"; then
  assert_pass "2.2 — --no-open flag advertised"
else
  assert_fail "2.2 — --no-open not in help"
fi

# Legacy flags still listed (backward-compat)
if echo "$OUT" | grep -q -- "--user-id"; then
  assert_pass "2.3 — legacy --user-id flag preserved for backward compat"
else
  assert_fail "2.3 — legacy --user-id flag missing"
fi

# ---------------------------------------------------------------------------
hdr "Section 3 — Mode B (INTERACTIVE full flow, requires real invite)"
# ---------------------------------------------------------------------------

if [ "${INTERACTIVE:-0}" != "1" ]; then
  assert_skip "set INTERACTIVE=1 + INVITE_URL=<url> to run the full join flow"
elif [ -z "${INVITE_URL:-}" ]; then
  assert_skip "INTERACTIVE=1 but INVITE_URL=<url> not provided"
else
  yel "Browser-handoff flow — sign in as the invited teammate."
  if COODRA_HOME="$STUB_HOME" COODRA_DISABLE_ENV_BOOTSTRAP=1 \
      node "$CLI_BIN" team join "$INVITE_URL" --timeout-ms 240000; then
    if [ -f "$STUB_HOME/clerk-token.json" ] && [ -f "$STUB_HOME/config.json" ] && [ -f "$STUB_HOME/.env" ]; then
      assert_pass "3.1 — team join wrote all three files"
      # Verify config.json says team mode
      MODE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STUB_HOME/config.json', 'utf8')).mode)")
      if [ "$MODE" = "team" ]; then
        assert_pass "3.2 — config.json mode=team"
      else
        assert_fail "3.2 — config.json mode is $MODE"
      fi
    else
      assert_fail "3.1 — team join exited 0 but did not write all files"
    fi
  else
    assert_fail "3.1 — team join exited non-zero"
  fi
fi

# ---------------------------------------------------------------------------
hdr "Summary"
# ---------------------------------------------------------------------------
echo "PASS: $PASS"
echo "SKIP: $SKIP"
echo "FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  red "✗ $SLICE FAIL ($FAIL assertion(s) failed)"
  exit 1
fi
green "✓ $SLICE PASS ($PASS passed, $SKIP skipped)"
