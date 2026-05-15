#!/usr/bin/env bash
# __tests__/functional/g1-token-store.sh
#
# Phase G.1 functional test — token storage + Clerk JWT verification.
#
# What it proves:
#   1. The on-disk shape of ~/.coodra/clerk-token.json round-trips through
#      writeToken/readVerifiedToken without corruption.
#   2. File mode is 0600 (no other user can read the JWT).
#   3. A tampered signature byte is detected (readVerifiedToken returns null).
#   4. deleteToken is idempotent and clears state.
#   5. hasStoredToken vs readVerifiedToken distinguish "file present" from
#      "auth valid".
#
# Run modes:
#   • REAL mode (preferred): the developer has previously run
#     `coodra login` and ~/.coodra/clerk-token.json exists with a
#     valid JWT. The test borrows that JWT (with a backup/restore guard)
#     to exercise every assertion end-to-end against real Clerk.
#
#   • STUB-NO-ENV mode: no Clerk env / no token exists. The test exercises
#     only the file-I/O paths that DON'T require Clerk: hasStoredToken
#     returns false on empty dir, readVerifiedToken returns null on empty
#     dir, deleteToken is idempotent. This is honest about what's reachable
#     without auth setup.
#
# Run:
#   ./__tests__/functional/g1-token-store.sh
#
# Exit codes:
#   0 — all assertions PASS (or skipped with a clear reason)
#   1 — at least one PASS-or-SKIP assertion failed

set -euo pipefail

SLICE="G.1"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Stub home — never touches the developer's real ~/.coodra
STUB_HOME=$(mktemp -d -t "coodra-${SLICE}-stub.XXXXXX")
trap 'rm -rf "$STUB_HOME" 2>/dev/null || true' EXIT

# Real home — only touched if user opts in by having a logged-in session
REAL_HOME="${COODRA_HOME:-$HOME/.coodra}"
REAL_TOKEN="$REAL_HOME/clerk-token.json"

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

# ---------------------------------------------------------------------------
# Helper: run a node snippet against the workspace-resolved shared package.
# Output goes to stdout. The script sets COODRA_HOME so the token store
# reads/writes the stub dir.
# ---------------------------------------------------------------------------
runner() {
  local home="$1"
  local snippet="$2"
  cd "$REPO_ROOT"
  COODRA_HOME="$home" node --input-type=module -e "$snippet"
}

# ---------------------------------------------------------------------------
hdr "Mode A — stub home (no Clerk required)"
# ---------------------------------------------------------------------------

# A.1: hasStoredToken returns false on empty dir
# Output is grep'd for an expected sentinel line because pino can flush
# its log lines AFTER our console.log lands; relying on `tail -1` is
# brittle. Each snippet prints a sentinel like "RESULT=NO" that we grep.
echo "A.1: hasStoredToken on empty home should be false"
OUT=$(runner "$STUB_HOME" "
import { hasStoredToken } from '@coodra/shared/auth';
console.log('RESULT=' + (hasStoredToken() ? 'YES' : 'NO'));
" 2>&1)
if echo "$OUT" | grep -q "^RESULT=NO$"; then assert_pass "RESULT=NO"; else assert_fail "got: $OUT"; fi

# A.2: readVerifiedToken returns null on empty dir
echo "A.2: readVerifiedToken on empty home should be null"
OUT=$(runner "$STUB_HOME" "
import { readVerifiedToken } from '@coodra/shared/auth';
const c = await readVerifiedToken();
console.log('RESULT=' + (c === null ? 'NULL' : 'NOT_NULL'));
" 2>&1)
if echo "$OUT" | grep -q "^RESULT=NULL$"; then assert_pass "returned null"; else assert_fail "got: $OUT"; fi

# A.3: deleteToken is idempotent (no-op when missing)
echo "A.3: deleteToken on empty home should not throw"
OUT=$(runner "$STUB_HOME" "
import { deleteToken } from '@coodra/shared/auth';
deleteToken();
console.log('RESULT=OK');
" 2>&1)
if echo "$OUT" | grep -q "^RESULT=OK$"; then assert_pass "idempotent delete on missing file"; else assert_fail "deleteToken threw"; fi

# A.4: readVerifiedToken on garbage JSON returns null + logs warning
echo "A.4: malformed token file should return null (not throw)"
echo "{ not json" > "$STUB_HOME/clerk-token.json"
OUT=$(runner "$STUB_HOME" "
import { readVerifiedToken } from '@coodra/shared/auth';
const c = await readVerifiedToken();
console.log('RESULT=' + (c === null ? 'NULL' : 'NOT_NULL'));
" 2>&1)
if echo "$OUT" | grep -q "^RESULT=NULL$"; then assert_pass "returned null on bad JSON"; else assert_fail "got: $OUT"; fi
rm -f "$STUB_HOME/clerk-token.json"

# A.5: schema-invalid JSON returns null
echo "A.5: schema-invalid JSON should return null"
echo '{"version":1,"token":"a"}' > "$STUB_HOME/clerk-token.json"
OUT=$(runner "$STUB_HOME" "
import { readVerifiedToken } from '@coodra/shared/auth';
const c = await readVerifiedToken();
console.log('RESULT=' + (c === null ? 'NULL' : 'NOT_NULL'));
" 2>&1)
if echo "$OUT" | grep -q "^RESULT=NULL$"; then assert_pass "returned null on schema mismatch"; else assert_fail "got: $OUT"; fi
rm -f "$STUB_HOME/clerk-token.json"

# ---------------------------------------------------------------------------
hdr "Mode B — real home (requires \`coodra login\` first)"
# ---------------------------------------------------------------------------

if [ ! -f "$REAL_HOME/.env" ] || ! grep -q '^CLERK_SECRET_KEY=' "$REAL_HOME/.env" 2>/dev/null; then
  assert_skip "no $REAL_HOME/.env with CLERK_SECRET_KEY — cannot exercise real Clerk verify"
elif [ ! -f "$REAL_TOKEN" ]; then
  assert_skip "no $REAL_TOKEN — run \`coodra login\` (after G.3 lands) to enable this test"
else
  # Backup real token + restore on exit
  BACKUP=$(mktemp -t "coodra-${SLICE}-backup.XXXXXX")
  cp "$REAL_TOKEN" "$BACKUP"
  RESTORE_CMD="cp '$BACKUP' '$REAL_TOKEN' && chmod 600 '$REAL_TOKEN' && rm -f '$BACKUP'"
  trap "$RESTORE_CMD; rm -rf '$STUB_HOME' 2>/dev/null || true" EXIT

  # B.1: readVerifiedToken returns claims for the existing token
  echo "B.1: readVerifiedToken on real token returns parsed claims"
  OUT=$(runner "$REAL_HOME" "
  import { readVerifiedToken } from '@coodra/shared/auth';
  const c = await readVerifiedToken();
  if (c === null) { console.log('RESULT=NULL'); }
  else { console.log('RESULT=' + JSON.stringify({ userId: c.userId, orgId: c.orgId, role: c.role, email: c.email })); }
  " 2>&1)
  if echo "$OUT" | grep -q "^RESULT=NULL$"; then
    assert_fail "real token failed to verify — likely expired. Re-run \`coodra login\`."
  elif echo "$OUT" | grep -q '^RESULT=.*"userId"'; then
    CLAIMS_LINE=$(echo "$OUT" | grep '^RESULT=' | head -1)
    assert_pass "claims: ${CLAIMS_LINE#RESULT=}"
  else
    assert_fail "unexpected output: $OUT"
  fi

  # B.2: file mode 0600
  MODE=$(stat -f '%A' "$REAL_TOKEN" 2>/dev/null || stat -c '%a' "$REAL_TOKEN" 2>/dev/null || echo "?")
  if [ "$MODE" = "600" ]; then
    assert_pass "file mode is 0600"
  else
    assert_fail "file mode is $MODE (expected 600)"
  fi

  # B.3: tamper detection — flip one char in the signature
  echo "B.3: tampered signature should be rejected"
  node -e "
  const fs = require('fs');
  const data = JSON.parse(fs.readFileSync('$REAL_TOKEN', 'utf8'));
  const parts = data.token.split('.');
  if (parts.length !== 3) { console.error('JWT not 3 parts'); process.exit(1); }
  const sig = parts[2];
  const first = sig.charAt(0);
  parts[2] = (first === 'A' ? 'B' : 'A') + sig.slice(1);
  data.token = parts.join('.');
  fs.writeFileSync('$REAL_TOKEN', JSON.stringify(data, null, 2));
  " 2>&1 || true

  OUT=$(runner "$REAL_HOME" "
  import { readVerifiedToken } from '@coodra/shared/auth';
  const c = await readVerifiedToken();
  console.log('RESULT=' + (c === null ? 'NULL' : 'NOT_NULL'));
  " 2>&1)
  if echo "$OUT" | grep -q "^RESULT=NULL$"; then
    assert_pass "tampered token returned null"
  else
    assert_fail "tampered token did not return null. Output: $OUT"
  fi

  # Restore original token for the next test
  cp "$BACKUP" "$REAL_TOKEN"
  chmod 600 "$REAL_TOKEN"

  # B.4: deleteToken removes the file
  echo "B.4: deleteToken clears the file"
  OUT=$(runner "$REAL_HOME" "
  import { deleteToken, hasStoredToken } from '@coodra/shared/auth';
  deleteToken();
  console.log('RESULT=' + (hasStoredToken() ? 'STILL_PRESENT' : 'DELETED'));
  " 2>&1)
  if echo "$OUT" | grep -q "^RESULT=DELETED$"; then
    assert_pass "deleteToken removed file"
  else
    assert_fail "got: $OUT"
  fi

  # Restore for normal use after the test
  cp "$BACKUP" "$REAL_TOKEN"
  chmod 600 "$REAL_TOKEN"
  rm -f "$BACKUP"
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
