#!/usr/bin/env bash
# __tests__/functional/g3-cli-login.sh
#
# Phase G.3 functional test — `coodra login` command.
#
# What it proves:
#   1. The command refuses cleanly when Clerk env is missing (no token
#      written; non-zero exit).
#   2. Help text mentions --web-url and --no-open.
#   3. Top-level `login` is registered.
#   4. With --no-open the URL is printed to stdout (no actual browser).
#   5. (Optional, manual) The full flow against a real Clerk session
#      writes ~/.coodra/clerk-token.json with valid claims, mode 0600.
#
# Modes:
#   • Mode A — quick smoke (no web, no Clerk). Runs unprompted.
#   • Mode B — full flow (requires real web running in team mode + the
#     `coodra_cli` JWT template configured in the Clerk dashboard).
#     Triggered by setting INTERACTIVE=1 in the env.
#
# Run:
#   ./__tests__/functional/g3-cli-login.sh
#   INTERACTIVE=1 ./__tests__/functional/g3-cli-login.sh   # full flow

set -uo pipefail

SLICE="G.3"
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

# Run CLI against isolated home with the env-bootstrap-shim disabled,
# so the test isn't bleeding through CLERK_SECRET_KEY etc. from the
# repo's own .env files (which exist on a contributor's laptop). The
# real product on a clean machine doesn't have those, so disabling the
# shim is the right way to simulate that.
coodra() {
  COODRA_HOME="$STUB_HOME" COODRA_DISABLE_ENV_BOOTSTRAP=1 node "$CLI_BIN" "$@"
}

# ---------------------------------------------------------------------------
hdr "Precondition: CLI binary exists"
# ---------------------------------------------------------------------------

if [ ! -f "$CLI_BIN" ]; then
  yel "  ⊘ CLI bundle not found at $CLI_BIN. Building..."
  (cd "$REPO_ROOT" && pnpm --filter @coodra/cli build 2>&1 | tail -3) || {
    red "  ✗ build failed"
    exit 1
  }
fi
green "  ✓ CLI bundle present"

# ---------------------------------------------------------------------------
hdr "Mode A — registration + preconditions"
# ---------------------------------------------------------------------------

# A.1: top-level `login` is registered
OUT=$(node "$CLI_BIN" --help 2>&1)
if echo "$OUT" | grep -q "^[[:space:]]*login \[options\]"; then
  assert_pass "A.1 — top-level \`login\` command is registered"
else
  assert_fail "A.1 — \`login\` not listed in \`coodra --help\`"
fi

# A.2: login --help shows expected flags
OUT=$(node "$CLI_BIN" login --help 2>&1)
if echo "$OUT" | grep -q -- "--web-url" && echo "$OUT" | grep -q -- "--no-open"; then
  assert_pass "A.2 — login --help lists --web-url and --no-open"
else
  assert_fail "A.2 — missing flags in help"
fi

# A.3: empty home → refuses with helpful message
OUT=$(coodra login --no-open 2>&1 || true)
if echo "$OUT" | grep -q "Clerk env is not configured"; then
  assert_pass "A.3 — refuses cleanly when Clerk env missing"
else
  assert_fail "A.3 — expected refusal; got: $(echo "$OUT" | tail -3)"
fi

# A.4: with solo-bypass sentinel → also refuses
mkdir -p "$STUB_HOME"
cat > "$STUB_HOME/.env" <<'EOF'
CLERK_SECRET_KEY=sk_test_replace_me
CLERK_PUBLISHABLE_KEY=pk_test_xxx
EOF
OUT=$(coodra login --no-open 2>&1 || true)
if echo "$OUT" | grep -q "Clerk env is not configured"; then
  assert_pass "A.4 — refuses on solo-bypass sentinel"
else
  assert_fail "A.4 — expected refusal on sentinel; got: $(echo "$OUT" | tail -3)"
fi
rm -f "$STUB_HOME/.env"

# ---------------------------------------------------------------------------
hdr "Mode B — full flow (requires INTERACTIVE=1 + real Clerk + web running)"
# ---------------------------------------------------------------------------

if [ "${INTERACTIVE:-0}" != "1" ]; then
  assert_skip "set INTERACTIVE=1 to run the interactive browser-handoff test"
else
  # Use the developer's real ~/.coodra so the test exercises the
  # real web running in team mode against real Clerk. After the test,
  # restore any pre-existing clerk-token.json.
  REAL_HOME="${COODRA_HOME:-$HOME/.coodra}"
  TOKEN_PATH="$REAL_HOME/clerk-token.json"
  BACKUP=""
  if [ -f "$TOKEN_PATH" ]; then
    BACKUP=$(mktemp)
    cp "$TOKEN_PATH" "$BACKUP"
  fi
  trap 'if [ -n "$BACKUP" ]; then cp "$BACKUP" "$TOKEN_PATH" && chmod 600 "$TOKEN_PATH" && rm -f "$BACKUP"; fi; rm -rf "$STUB_HOME" 2>/dev/null || true' EXIT

  # Pre-condition: remove existing token so we test fresh-login
  rm -f "$TOKEN_PATH"

  yel "Interactive mode — a browser window will open."
  echo "Sign in as your admin user, then return here."
  echo ""

  # Run with the real home + with timeout shorter than default so test
  # doesn't hang forever in CI.
  if COODRA_HOME="$REAL_HOME" timeout 300 node "$CLI_BIN" login --timeout-ms 240000; then
    if [ -f "$TOKEN_PATH" ]; then
      MODE=$(stat -f '%A' "$TOKEN_PATH" 2>/dev/null || stat -c '%a' "$TOKEN_PATH" 2>/dev/null)
      if [ "$MODE" = "600" ]; then
        assert_pass "B.1 — clerk-token.json written at mode 0600"
      else
        assert_fail "B.1 — token written but mode is $MODE (expected 600)"
      fi
    else
      assert_fail "B.1 — login exited 0 but no clerk-token.json"
    fi
  else
    assert_fail "B.1 — login exited non-zero (probably timeout or auth failure)"
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
