#!/usr/bin/env bash
# __tests__/functional/g8-web-unified.sh
#
# Phase G.8 functional test — web mode unification.
#
# What it proves:
#   1. New `resolveIdentityMode` + `isCloudHostedWeb` helpers exist in
#      `apps/web-v2/lib/deployment-mode.ts`.
#   2. Legacy `resolveDeploymentMode` is preserved (backward compat).
#   3. Middleware uses COODRA_MODE (binary), not COODRA_DEPLOYMENT,
#      for identity-mode resolution.
#   4. `lib/auth.ts` uses `resolveIdentityMode` for the solo bypass.
#
# Why grep-based: the deployment-mode.ts module imports `server-only`
# which only resolves inside the Next.js bundle. Behavioral tests are
# covered by the in-process vitest at:
#   apps/web-v2/__tests__/unit/lib/deployment-mode.test.ts
# This shell test is the cross-file integration check that complements
# the unit tests.
#
# Run:
#   ./__tests__/functional/g8-web-unified.sh

set -uo pipefail

SLICE="G.8"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEB_DIR="$REPO_ROOT/apps/web-v2"

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
hdr "Section 1 — new Phase G exports"
# ---------------------------------------------------------------------------

# 1.1: resolveIdentityMode exists
if grep -q "^export function resolveIdentityMode" "$WEB_DIR/lib/deployment-mode.ts"; then
  assert_pass "1.1 — resolveIdentityMode() exported"
else
  assert_fail "1.1 — resolveIdentityMode() missing"
fi

# 1.2: isCloudHostedWeb exists
if grep -q "^export function isCloudHostedWeb" "$WEB_DIR/lib/deployment-mode.ts"; then
  assert_pass "1.2 — isCloudHostedWeb() exported"
else
  assert_fail "1.2 — isCloudHostedWeb() missing"
fi

# 1.3: resolveIdentityMode returns 'solo' | 'team' (binary)
if grep -q "'solo' | 'team'" "$WEB_DIR/lib/deployment-mode.ts"; then
  assert_pass "1.3 — identity mode is binary 'solo' | 'team'"
else
  assert_fail "1.3 — identity mode return type unclear"
fi

# ---------------------------------------------------------------------------
hdr "Section 2 — legacy API preserved + marked deprecated"
# ---------------------------------------------------------------------------

# 2.1: resolveDeploymentMode still exported
if grep -q "^export function resolveDeploymentMode" "$WEB_DIR/lib/deployment-mode.ts"; then
  assert_pass "2.1 — resolveDeploymentMode() preserved for backward compat"
else
  assert_fail "2.1 — resolveDeploymentMode() unexpectedly removed"
fi

# 2.2: it's marked @deprecated (check the file has @deprecated somewhere
# referencing the legacy three-mode API — the comment can be anywhere
# in the file).
if grep -q "@deprecated.*Phase G\|@deprecated Phase G" "$WEB_DIR/lib/deployment-mode.ts"; then
  assert_pass "2.2 — Phase G deprecation markers present in file"
else
  assert_fail "2.2 — deprecation marker missing"
fi

# ---------------------------------------------------------------------------
hdr "Section 3 — middleware uses Phase G binary mode"
# ---------------------------------------------------------------------------

# 3.1: middleware.ts no longer uses COODRA_DEPLOYMENT for identity
if grep -q "COODRA_DEPLOYMENT" "$WEB_DIR/middleware.ts"; then
  assert_fail "3.1 — middleware.ts still references COODRA_DEPLOYMENT (Phase G drops this)"
else
  assert_pass "3.1 — middleware.ts does not reference COODRA_DEPLOYMENT for identity"
fi

# 3.2: middleware.ts uses COODRA_MODE
if grep -q "COODRA_MODE" "$WEB_DIR/middleware.ts"; then
  assert_pass "3.2 — middleware.ts uses COODRA_MODE for binary mode resolution"
else
  assert_fail "3.2 — middleware.ts missing COODRA_MODE reference"
fi

# 3.3: middleware exports a single teamModeHandler (no longer split)
if grep -q "teamModeHandler" "$WEB_DIR/middleware.ts"; then
  assert_pass "3.3 — middleware uses unified teamModeHandler"
else
  assert_fail "3.3 — teamModeHandler not found"
fi

# ---------------------------------------------------------------------------
hdr "Section 4 — auth.ts uses resolveIdentityMode"
# ---------------------------------------------------------------------------

if grep -q "resolveIdentityMode" "$WEB_DIR/lib/auth.ts"; then
  assert_pass "4.1 — lib/auth.ts uses resolveIdentityMode"
else
  assert_fail "4.1 — lib/auth.ts still uses legacy resolveDeploymentMode"
fi

# ---------------------------------------------------------------------------
hdr "Section 5 — unit tests cover the helpers"
# ---------------------------------------------------------------------------

if [ -f "$WEB_DIR/__tests__/unit/lib/deployment-mode.test.ts" ]; then
  assert_pass "5.1 — deployment-mode.test.ts exists"
else
  assert_fail "5.1 — deployment-mode.test.ts missing"
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
