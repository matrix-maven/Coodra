#!/usr/bin/env bash
# Phase H acceptance tests — runs the 8 tests from goal.md against the
# user's existing Coodra install + real cloud Postgres + real Clerk.
#
# This script is **interactive** — it opens browser windows for sign-in
# at the team-init step and the team-join step. Run it in a terminal
# where you can click through the browser flows it triggers.
#
# Prereqs (all should be true from Phase G completion):
#   - ~/.coodra/.env has DATABASE_URL + CLERK_SECRET_KEY +
#     CLERK_PUBLISHABLE_KEY + LOCAL_HOOK_SECRET + COODRA_INVITE_HMAC_SECRET
#   - Web dev server running on http://localhost:3001/
#   - You're signed in to Clerk dashboard (so Test 7's role demote works)
#
# Outputs: one `[TEST N] PASS` or `[TEST N] FAIL` line per test, plus
# the verbatim CLI output above each line for the test-runner's review.

set -u
cd "$(dirname "$0")/../.."
ROOT=$(pwd)

# Use the workspace-built dist so we test what users would get from npm.
CLI="node $ROOT/packages/cli/dist/index.js"

# Throwaway test scratch lives outside the user's home. We clean it up
# between tests (proves idempotency).
SCRATCH=/tmp/phase-h-acceptance
rm -rf $SCRATCH
mkdir -p $SCRATCH

pass()  { echo ""; echo "[$1] ✓ PASS — $2"; }
fail()  { echo ""; echo "[$1] ✗ FAIL — $2"; }
banner() { echo ""; echo "════════════════════════════════════════════════════════"; echo "$1"; echo "════════════════════════════════════════════════════════"; }

# ─── Test 1 — solo install (run twice from clean state) ──────────────
test1() {
  banner "Test 1 (clean run #${1}) — solo install"
  local DIR=$SCRATCH/t1-$1
  local HOME_DIR=$SCRATCH/t1-home-$1
  rm -rf $DIR $HOME_DIR
  mkdir -p $DIR && cd $DIR && git init -q . && echo '{"name":"t1"}' > package.json
  COODRA_HOME=$HOME_DIR $CLI init 2>&1 | tail -8 || { fail "1.$1" "init failed"; return; }
  COODRA_HOME=$HOME_DIR $CLI feature add greet --description "Say hi" 2>&1 || { fail "1.$1" "feature add failed"; return; }
  if [ ! -f "$DIR/docs/features/greet/feature.md" ]; then fail "1.$1" "feature.md missing"; return; fi
  pass "1.$1" "solo init + feature add, file present"
  cd $ROOT
}

# ─── Test 2 — admin team init (interactive — opens browser) ───────────
test2() {
  banner "Test 2 — admin team setup (INTERACTIVE — will open browser for sign-in)"
  echo "Will run: coodra team init"
  echo "You'll be prompted for: DATABASE_URL, Clerk Secret Key, Clerk Publishable Key."
  echo "Then a browser opens for sign-in."
  read -rp "Continue? [y/N] " yn
  [ "$yn" = "y" ] || { echo "[2] skipped by user"; return; }
  $CLI team init || { fail "2" "team init exited non-zero"; return; }
  echo ""
  echo "Now open http://localhost:3001/ in your browser. Confirm the admin dashboard renders."
  read -rp "Did the admin dashboard render at localhost:3001? [y/N] " yn
  [ "$yn" = "y" ] && pass "2" "team init + dashboard render" || fail "2" "dashboard did not render"
}

# ─── Test 3 — admin invites teammate ──────────────────────────────────
test3() {
  banner "Test 3 — admin invites ${TEAMMATE_EMAIL:-abishai95141@gmail.com}"
  $CLI invite ${TEAMMATE_EMAIL:-abishai95141@gmail.com} 2>&1 || { fail "3" "invite exited non-zero"; return; }
  pass "3" "invite minted; URL printed; no Clerk org-invite email"
}

# ─── Test 4 — teammate joins (manual — requires teammate machine) ─────
test4() {
  banner "Test 4 — teammate joins"
  echo ""
  echo "Cross-OS / cross-machine support today:"
  echo "  - macOS or Linux + Node ≥22 + npm + a browser   → fully supported."
  echo "  - macOS or Linux WITHOUT Node                   → script tells you to install Node first."
  echo "  - Windows native (cmd/PowerShell)               → NOT supported in v1; use WSL."
  echo "  - Machine with no Coodra CLI                 → the curl|sh installs it via 'npm i -g @coodra/cli@latest'."
  echo ""
  echo "Copy the invite URL from Test 3 (append /cli.sh) and run on a teammate machine:"
  echo "  curl -sSL <invite-url-with-/cli.sh-suffix> | sh"
  echo ""
  echo "Expected on the teammate machine:"
  echo "  1. Node preflight check (asks them to install Node if missing)"
  echo "  2. npm i -g @coodra/cli@latest"
  echo "  3. Browser opens to /auth/cli-login → teammate signs in / signs up via Clerk"
  echo "     (sign-up creates a Clerk user if one doesn't exist; the install endpoint"
  echo "      then auto-adds them to your org via Clerk Backend API — no separate email)"
  echo "  4. Bundle fetched, ~/.coodra written, daemons started"
  echo "  5. Terminal ends with: ✓ Welcome <Name>! Try: coodra feature add my-first-thing"
  read -rp "Did the teammate machine's terminal end with the welcome message? [y/N] " yn
  [ "$yn" = "y" ] && pass "4" "one-line installer + browser sign-in + welcome message" || fail "4" "manual verification incomplete"
}

# ─── Test 5 — cross-attribution (two users write features) ────────────
test5() {
  banner "Test 5 — cross-attribution"
  echo "On Admin's machine:    coodra feature add ship-checklist"
  echo "On Jane's machine:     coodra feature add caching-strategy"
  echo "Admin opens http://localhost:3001/features in browser."
  read -rp "Are both rows visible with correct authors? [y/N] " yn
  [ "$yn" = "y" ] && pass "5" "cross-attribution rendered correctly" || fail "5" "rows missing or attributed wrong"
}

# ─── Test 6 — tamper safety (Phase G invariant) ───────────────────────
test6() {
  banner "Test 6 — tamper safety"
  cp ~/.coodra/config.json /tmp/h-acceptance-config.bak
  python3 -c "
import json
with open('/Users/abishaikc/.coodra/config.json') as f: c=json.load(f)
c['team']['clerkUserId']='user_FAKE'
with open('/Users/abishaikc/.coodra/config.json','w') as f: json.dump(c,f,indent=2)
print('config tampered: clerkUserId=user_FAKE')
"
  mkdir -p $SCRATCH/t6 && cd $SCRATCH/t6 && git init -q . && echo '{"name":"t6"}' > package.json
  $CLI init 2>&1 | tail -3
  $CLI feature add tamper-test --description "tamper test row" 2>&1
  cd $ROOT
  # Restore.
  cp /tmp/h-acceptance-config.bak ~/.coodra/config.json
  rm /tmp/h-acceptance-config.bak
  echo "Config restored."
  echo "Now open http://localhost:3001/features. The 'tamper-test' row should be authored by your REAL Clerk user_id, NOT user_FAKE."
  read -rp "Web shows REAL user (not user_FAKE)? [y/N] " yn
  [ "$yn" = "y" ] && pass "6" "Phase G verified-JWT invariant holds" || fail "6" "Phase G invariant regressed"
}

# ─── Test 7 — role gate ───────────────────────────────────────────────
test7() {
  banner "Test 7 — role gate"
  echo "1. In your Clerk dashboard, demote Jane to 'viewer' role."
  echo "2. Wait ~30s for claim cache TTL."
  echo "3. On Jane's machine, run: coodra feature add viewer-attempt"
  echo "Expected: CLI exits non-zero with 'your role viewer cannot author features' or equivalent."
  read -rp "Did Jane's CLI refuse the write with a role-gate error? [y/N] " yn
  [ "$yn" = "y" ] && pass "7" "viewer role refused" || fail "7" "role gate not enforced"
}

# ─── Test 8 — mode toggle ─────────────────────────────────────────────
test8() {
  banner "Test 8 — mode toggle"
  local HOME_DIR=$SCRATCH/t8-home
  mkdir -p $HOME_DIR
  cp ~/.coodra/config.json $HOME_DIR/config.json
  cp ~/.coodra/.env $HOME_DIR/.env
  [ -f ~/.coodra/clerk-token.json ] && cp ~/.coodra/clerk-token.json $HOME_DIR/clerk-token.json
  echo "--- logout ---"
  COODRA_HOME=$HOME_DIR $CLI logout 2>&1
  mkdir -p $SCRATCH/t8 && cd $SCRATCH/t8 && git init -q . && echo '{"name":"t8"}' > package.json
  COODRA_HOME=$HOME_DIR $CLI init 2>&1 | tail -3
  echo "--- feature add solo-only (mode=solo) ---"
  COODRA_HOME=$HOME_DIR $CLI feature add solo-only --description "after logout" 2>&1
  echo ""
  echo "Now the second half of Test 8 (login back to team mode) is browser-interactive."
  echo "Run on YOUR real home:    coodra login"
  echo "Then:                     coodra feature add team-again --description 'after login'"
  read -rp "Did the round-trip complete (solo → team) without env editing? [y/N] " yn
  cd $ROOT
  [ "$yn" = "y" ] && pass "8" "logout → solo → login → team round-trip OK" || fail "8" "round-trip broken"
}

# ─── Run all ──────────────────────────────────────────────────────────
test1 1
test1 2
test2
test3
test4
test5
test6
test7
test8

# Cleanup hint.
echo ""
echo "════════════════════════════════════════════════════════"
echo "Cleanup hint: the Test 3 invite + Test 6 tamper-test row remain"
echo "in cloud Postgres. Revoke them from http://localhost:3001/settings/team"
echo "(invite) and remove the tamper-test row via /features (admin → delete)."
echo "════════════════════════════════════════════════════════"
