#!/usr/bin/env bash
# __tests__/functional/g7-bridge-auth.sh
#
# Phase G.7 functional test — hooks-bridge actor identity reads
# clerk-token.json::claimsMirror (Phase G), with config.json fallback.
#
# What it proves:
#   1. With a Phase G clerk-token.json (mirror present), getActorIdentity
#      returns userId/orgId from the mirror with source='clerk'.
#   2. With only legacy config.json::team (no clerk-token.json),
#      returns userId/orgId from config with source='config'.
#   3. With neither, returns null.
#   4. Expired mirror is refused (falls through to legacy or null).
#
# Mode A — direct invocation via tsx (no live bridge needed).
# Mode B — live bridge end-to-end (deferred to 00-full-flow.sh).
#
# Run:
#   ./__tests__/functional/g7-bridge-auth.sh

set -uo pipefail

SLICE="G.7"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
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

runner() {
  local body="$1"
  local tmpdir
  tmpdir=$(mktemp -d -t "coodra-${SLICE}-runner.XXXXXX")
  local tmpfile="$tmpdir/runner.mjs"
  cat > "$tmpfile" <<EOF
import { getActorIdentity } from '${REPO_ROOT}/apps/hooks-bridge/src/lib/actor-identity.ts';
${body}
EOF
  cd "$REPO_ROOT"
  COODRA_HOME="$STUB_HOME" COODRA_DISABLE_ENV_BOOTSTRAP=1 npx tsx "$tmpfile" 2>&1
  rm -rf "$tmpdir"
}

# ---------------------------------------------------------------------------
hdr "Section 1 — Phase G primary path (clerk-token.json mirror)"
# ---------------------------------------------------------------------------

# 1.1: clerk-token.json with valid claimsMirror → source=clerk
echo "1.1: clerk-token.json with mirror → source=clerk"
EXPIRY=$(node -e "console.log(new Date(Date.now() + 3600000).toISOString())")
cat > "$STUB_HOME/clerk-token.json" <<EOF
{
  "version": 1,
  "token": "stub.jwt.fake",
  "webUrl": "http://localhost:3001",
  "fetchedAt": 1700000000000,
  "claimsMirror": {
    "userId": "user_real_g7",
    "orgId": "org_real_g7",
    "role": "admin",
    "email": "g7@example.com",
    "expiresAt": "$EXPIRY"
  }
}
EOF
chmod 600 "$STUB_HOME/clerk-token.json"

# Also seed config.json with stale legacy values to make sure clerk wins
cat > "$STUB_HOME/config.json" <<'EOF'
{
  "mode": "team",
  "team": {
    "clerkUserId": "STALE_user",
    "clerkOrgId": "STALE_org",
    "localHookSecret": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "joinedAt": 1700000000000
  }
}
EOF

OUT=$(runner "
const id = getActorIdentity();
console.log('RESULT=' + JSON.stringify(id));
")
if echo "$OUT" | grep -q '"source":"clerk"' && echo "$OUT" | grep -q '"userId":"user_real_g7"'; then
  assert_pass "1.1 — clerk mirror beats legacy config"
else
  assert_fail "1.1 — got: $OUT"
fi

# 1.2: expired clerk-token mirror → falls through to legacy
echo "1.2: expired mirror → falls through"
EXPIRED=$(node -e "console.log(new Date(Date.now() - 3600000).toISOString())")
cat > "$STUB_HOME/clerk-token.json" <<EOF
{
  "version": 1,
  "token": "stub.jwt.fake",
  "webUrl": "http://localhost:3001",
  "fetchedAt": 1700000000000,
  "claimsMirror": {
    "userId": "user_expired",
    "orgId": "org_expired",
    "role": "admin",
    "email": null,
    "expiresAt": "$EXPIRED"
  }
}
EOF
OUT=$(runner "
const id = getActorIdentity();
console.log('RESULT=' + JSON.stringify(id));
")
if echo "$OUT" | grep -q '"source":"config"' && echo "$OUT" | grep -q '"userId":"STALE_user"'; then
  assert_pass "1.2 — expired mirror falls through to legacy"
else
  assert_fail "1.2 — got: $OUT"
fi

# ---------------------------------------------------------------------------
hdr "Section 2 — fallback paths"
# ---------------------------------------------------------------------------

rm -f "$STUB_HOME/clerk-token.json"

# 2.1: legacy config only → source=config
OUT=$(runner "
const id = getActorIdentity();
console.log('RESULT=' + JSON.stringify(id));
")
if echo "$OUT" | grep -q '"source":"config"' && echo "$OUT" | grep -q '"userId":"STALE_user"'; then
  assert_pass "2.1 — legacy config returns source=config"
else
  assert_fail "2.1 — got: $OUT"
fi

# 2.2: solo mode → null
echo '{"mode":"solo"}' > "$STUB_HOME/config.json"
OUT=$(runner "
const id = getActorIdentity();
console.log('RESULT=' + (id === null ? 'NULL' : JSON.stringify(id)));
")
if echo "$OUT" | grep -q "RESULT=NULL"; then
  assert_pass "2.2 — solo mode returns null"
else
  assert_fail "2.2 — got: $OUT"
fi

# 2.3: nothing at all → null
rm -f "$STUB_HOME/config.json"
OUT=$(runner "
const id = getActorIdentity();
console.log('RESULT=' + (id === null ? 'NULL' : JSON.stringify(id)));
")
if echo "$OUT" | grep -q "RESULT=NULL"; then
  assert_pass "2.3 — no creds → null"
else
  assert_fail "2.3 — got: $OUT"
fi

# ---------------------------------------------------------------------------
hdr "Section 3 — malformed file"
# ---------------------------------------------------------------------------

echo '{ not json' > "$STUB_HOME/clerk-token.json"
cat > "$STUB_HOME/config.json" <<'EOF'
{
  "mode": "team",
  "team": {
    "clerkUserId": "user_legacy_only",
    "clerkOrgId": "org_legacy",
    "localHookSecret": "f",
    "joinedAt": 0
  }
}
EOF
OUT=$(runner "
const id = getActorIdentity();
console.log('RESULT=' + JSON.stringify(id));
")
if echo "$OUT" | grep -q '"userId":"user_legacy_only"'; then
  assert_pass "3.1 — malformed clerk-token.json falls through to legacy"
else
  assert_fail "3.1 — got: $OUT"
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
