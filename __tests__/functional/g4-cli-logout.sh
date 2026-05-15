#!/usr/bin/env bash
# __tests__/functional/g4-cli-logout.sh
#
# Phase G.4 functional test — `coodra logout` command.
#
# What it proves:
#   1. Idempotent — logout on already-solo home is a no-op exiting 0.
#   2. Tear-down — logout on team-state home:
#        - removes clerk-token.json
#        - flips config.json::mode from team→solo
#        - strips COODRA_MODE / DATABASE_URL / LOCAL_HOOK_SECRET /
#          COODRA_TEAM_ORG_ID from .env
#        - leaves user-managed env vars intact
#   3. `team logout` is wired as a backward-compat alias.
#
# Run:
#   ./__tests__/functional/g4-cli-logout.sh

set -uo pipefail

SLICE="G.4"
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
hdr "Precondition: CLI binary"
# ---------------------------------------------------------------------------

if [ ! -f "$CLI_BIN" ]; then
  yel "Building CLI bundle..."
  (cd "$REPO_ROOT" && pnpm --filter @coodra/cli build 2>&1 | tail -3) || {
    red "build failed"
    exit 1
  }
fi
green "  ✓ CLI bundle present"

# ---------------------------------------------------------------------------
hdr "Section 1 — idempotent no-op on empty home"
# ---------------------------------------------------------------------------

OUT=$(coodra logout 2>&1)
RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q "Already logged out"; then
  assert_pass "1.1 — empty home logout exits 0 with no-op message"
else
  assert_fail "1.1 — got rc=$RC, out: $OUT"
fi

# Re-run; still no-op
OUT2=$(coodra logout 2>&1)
RC2=$?
if [ $RC2 -eq 0 ] && echo "$OUT2" | grep -q "Already logged out"; then
  assert_pass "1.2 — second invocation is also idempotent"
else
  assert_fail "1.2 — got rc=$RC2, out: $OUT2"
fi

# ---------------------------------------------------------------------------
hdr "Section 2 — full tear-down"
# ---------------------------------------------------------------------------

# Seed team state
cat > "$STUB_HOME/config.json" <<'EOF'
{
  "mode": "team",
  "team": {
    "clerkUserId": "user_abc",
    "clerkOrgId": "org_xyz",
    "clerkOrgSlug": "acme",
    "localHookSecret": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "joinedAt": 1700000000000
  }
}
EOF

cat > "$STUB_HOME/.env" <<'EOF'
# A user comment that should survive
COODRA_MODE=team
DATABASE_URL=postgres://x/y
LOCAL_HOOK_SECRET=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
COODRA_TEAM_ORG_ID=org_xyz
CLERK_SECRET_KEY=sk_test_real
CLERK_PUBLISHABLE_KEY=pk_test_real
EOF

# Seed a stub clerk-token.json (with structurally-valid JSON; verification
# will fail because the JWT itself is fake, but readVerifiedToken returning
# null is fine — logout doesn't require verifiable claims to operate.)
cat > "$STUB_HOME/clerk-token.json" <<'EOF'
{
  "version": 1,
  "token": "stub.jwt.fake",
  "webUrl": "http://localhost:3001",
  "fetchedAt": 1700000000000
}
EOF
chmod 600 "$STUB_HOME/clerk-token.json"

# Run logout
OUT=$(coodra logout 2>&1)
RC=$?

# 2.1: exit 0
if [ $RC -eq 0 ]; then
  assert_pass "2.1 — logout exits 0"
else
  assert_fail "2.1 — got rc=$RC, out: $OUT"
fi

# 2.2: confirmation printed
if echo "$OUT" | grep -q "Logged out"; then
  assert_pass "2.2 — prints confirmation"
else
  assert_fail "2.2 — no confirmation in: $OUT"
fi

# 2.3: clerk-token.json removed
if [ ! -f "$STUB_HOME/clerk-token.json" ]; then
  assert_pass "2.3 — clerk-token.json deleted"
else
  assert_fail "2.3 — clerk-token.json still present"
fi

# 2.4: config.json mode flipped
MODE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STUB_HOME/config.json', 'utf8')).mode)")
if [ "$MODE" = "solo" ]; then
  assert_pass "2.4 — config.json mode=solo"
else
  assert_fail "2.4 — config.json mode is $MODE"
fi

# 2.5: config.json team block removed
HAS_TEAM=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STUB_HOME/config.json', 'utf8')).team === undefined ? 'no' : 'yes')")
if [ "$HAS_TEAM" = "no" ]; then
  assert_pass "2.5 — config.json team block removed"
else
  assert_fail "2.5 — team block still in config.json"
fi

# 2.6: team env keys stripped
ENV_AFTER=$(cat "$STUB_HOME/.env")
STRIPPED=0
for key in COODRA_MODE DATABASE_URL LOCAL_HOOK_SECRET COODRA_TEAM_ORG_ID; do
  if echo "$ENV_AFTER" | grep -q "^$key="; then
    assert_fail "2.6 — $key still in .env after logout"
    STRIPPED=1
  fi
done
if [ $STRIPPED -eq 0 ]; then
  assert_pass "2.6 — all four team env keys stripped"
fi

# 2.7: user-managed keys preserved
if echo "$ENV_AFTER" | grep -q "^CLERK_SECRET_KEY=sk_test_real"; then
  assert_pass "2.7 — user-managed CLERK_SECRET_KEY preserved"
else
  assert_fail "2.7 — user-managed key was stripped"
fi
if echo "$ENV_AFTER" | grep -q "^# A user comment"; then
  assert_pass "2.8 — user comment preserved"
else
  assert_fail "2.8 — user comment was stripped"
fi

# ---------------------------------------------------------------------------
hdr "Section 3 — team-logout alias"
# ---------------------------------------------------------------------------

# Re-seed minimal state to verify alias also tears down
cat > "$STUB_HOME/config.json" <<'EOF'
{
  "mode": "team",
  "team": {
    "clerkUserId": "user_abc",
    "clerkOrgId": "org_xyz",
    "localHookSecret": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "joinedAt": 1700000000000
  }
}
EOF

OUT=$(coodra team logout 2>&1)
RC=$?

MODE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STUB_HOME/config.json', 'utf8')).mode)" 2>/dev/null || echo "ERR")

if [ $RC -eq 0 ] && [ "$MODE" = "solo" ]; then
  assert_pass "3.1 — \`team logout\` alias tears down team state"
else
  assert_fail "3.1 — alias failed (rc=$RC mode=$MODE)"
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
green "✓ $SLICE PASS ($PASS passed)"
