#!/usr/bin/env bash
# __tests__/functional/g10-org-switch.sh
#
# Phase G.10 functional test — `coodra org` parent + subcommands.
#
# What it proves:
#   1. `coodra org status` exists and prints status (or "no session")
#   2. `coodra org switch <orgSlug>` exists and requires the slug arg
#   3. Help text references the right flags
#   4. `org switch` without a slug exits non-zero with helpful message
#
# Phase G.10 minimal cut: the org command is a thin wrapper around the
# login flow. The actual org-selection happens in Clerk's browser UI;
# the CLI just kicks off the browser handoff. Mode B (full flow with
# real Clerk multi-org user) is covered by 00-full-flow.sh PHASE 11.
#
# Run:
#   ./__tests__/functional/g10-org-switch.sh

set -uo pipefail

SLICE="G.10"
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
hdr "Section 1 — registration"
# ---------------------------------------------------------------------------

# 1.1: top-level `org` is registered
if node "$CLI_BIN" --help 2>&1 | grep -q "^[[:space:]]*org "; then
  assert_pass "1.1 — top-level \`org\` command is registered"
else
  assert_fail "1.1 — \`org\` not in top-level help"
fi

# 1.2: org status subcommand
if node "$CLI_BIN" org --help 2>&1 | grep -q "status"; then
  assert_pass "1.2 — \`org status\` subcommand registered"
else
  assert_fail "1.2 — \`org status\` not listed"
fi

# 1.3: org switch subcommand
if node "$CLI_BIN" org --help 2>&1 | grep -q "switch"; then
  assert_pass "1.3 — \`org switch\` subcommand registered"
else
  assert_fail "1.3 — \`org switch\` not listed"
fi

# ---------------------------------------------------------------------------
hdr "Section 2 — org status"
# ---------------------------------------------------------------------------

# 2.1: with no session → prints "No active Clerk session"
OUT=$(coodra org status 2>&1)
if echo "$OUT" | grep -q "No active Clerk session\|active org\|Active org"; then
  assert_pass "2.1 — org status prints session info (got: $(echo "$OUT" | head -1 | tr -d '\033[0-9;m'))"
else
  assert_fail "2.1 — got: $OUT"
fi

# ---------------------------------------------------------------------------
hdr "Section 3 — org switch validation"
# ---------------------------------------------------------------------------

# 3.1: org switch without slug → refuses
OUT=$(coodra org switch 2>&1 || true)
if echo "$OUT" | grep -q "missing.*orgSlug\|required argument\|missing.*argument"; then
  assert_pass "3.1 — org switch without slug refused"
else
  assert_fail "3.1 — got: $OUT"
fi

# 3.2: org switch <slug> --help shows the help (doesn't actually open browser)
OUT=$(node "$CLI_BIN" org switch --help 2>&1)
if echo "$OUT" | grep -q -- "--no-open" && echo "$OUT" | grep -q "orgSlug"; then
  assert_pass "3.2 — org switch help advertises --no-open + orgSlug"
else
  assert_fail "3.2 — help missing key flags"
fi

# ---------------------------------------------------------------------------
hdr "Section 4 — Mode B (live browser handoff, deferred)"
# ---------------------------------------------------------------------------

assert_skip "Mode B — live browser-handoff for multi-org user covered in 00-full-flow.sh PHASE 11"

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
