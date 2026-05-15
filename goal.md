# Goal — Phase H seamless UX

> Paste the block below (everything between the `---` markers) into Claude
> Code after compact:
>
>     /goal <PASTE THE CONDITION BELOW>
>
> Claude will then keep working turn-after-turn until the condition holds.
> A fast-model evaluator checks the condition after every turn. Quit early
> with `/goal clear`.

---

Phase H — make Coodra's end-user UX seamless. Phase G already shipped the security model (verified Clerk JWT beats config.json forgery, proven end-to-end). Phase H eliminates the 18 sharp-edge UX gaps documented in /Users/abishaikc/.claude/projects/-Users-abishaikc-Coodra/memory/phase-h-seamless-ux-gaps.md — sync-daemon parent-FK ordering, env-file propagation across three locations, team init wizard idempotency, remaining `team-hosted` 404 gates, CLI write-path forgery audit, daemon health-check timing, two-email teammate-onboarding confusion, and others. Read that memory file at the start to load the full inventory.

The achievement criterion: all 8 acceptance tests below pass from a clean state. For EACH test, paste the actual terminal output verbatim in the conversation. A test passes ONLY if the user types ONLY the commands shown — no `source ~/.coodra/.env`, no `psql`, no `sqlite3`, no `curl /healthz`, no `sed`, no `openssl rand`, no manual file edits, no incognito-window juggling. If a test required any of those, that is a bug — fix it, rerun from clean state, paste the new output.

Test 1 (solo install): `npm i -g @coodra/cli` then in a fresh project dir `coodra init && coodra feature add greet --description "Say hi"`. Exits 0. Feature file exists. Local DB row stamped `__solo__`.

Test 2 (admin team setup): `coodra team init` runs interactively. Prompts for Postgres URL, Clerk keys. Opens browser for sign-in. Auto-creates the `coodra_cli` JWT template via Clerk Backend API. Generates LOCAL_HOOK_SECRET + COODRA_INVITE_HMAC_SECRET. Migrates cloud schema idempotently (no error on already-applied migrations). Captures verified Clerk JWT. Writes config.json + .env. Finishes by opening the web at http://localhost:3001/ with admin dashboard rendered.

Test 3 (admin invites teammate): `coodra invite jane@example.com` mints invite, prints a single shareable URL. That URL alone is enough — Jane does NOT receive a separate Clerk org-invitation email she must accept first.

Test 4 (teammate joins): Jane clicks URL. Page shows "Set up on my laptop" button. Clicking shows a one-line install command (curl | sh). Running that one line on Jane's laptop signs her in, writes her config, starts daemons. Her terminal ends with "Welcome Jane! Try: coodra feature add my-first-thing". No two-browser dance. No env editing.

Test 5 (cross-attribution): admin runs `coodra feature add ship-checklist`, Jane runs `coodra feature add caching-strategy`. Admin opens http://localhost:3001/features in browser, sees both rows with correct authors. No psql verification needed — the web shows it.

Test 6 (tamper safety, Phase G invariant): admin edits ~/.coodra/config.json::team.clerkUserId to "user_FAKE", runs `coodra feature add tamper-test`. Web UI at /features shows the row authored by admin's REAL Clerk user, not the forged value. Phase G's core security property must not regress.

Test 7 (role gate): admin demotes Jane to viewer in Clerk dashboard. After ~30s Jane runs `coodra feature add viewer-attempt`. CLI exits non-zero with human-readable "your role 'viewer' cannot author features" message. No row created.

Test 8 (mode toggle): `coodra logout` then `coodra feature add solo-only` (writes locally as solo), then `coodra login` then `coodra feature add team-again` (writes team-attributed). Full round-trip with no manual env editing.

Boundaries: do NOT re-implement Phase G's identity model. Do NOT touch the verified-JWT-beats-config.json security invariant. The legacy `local-team` / `team-hosted` types stay marked @deprecated. Build orchestration that hides plumbing — don't rewrite plumbing that already works.

Proof requirement: after EVERY code change that touches a tested flow, delete the affected state (`rm -rf /tmp/test-* && rm -f ~/.coodra/clerk-token.json` and delete the cloud test rows in `team_invites`, `projects`, `features`) and re-run the test from scratch. A test passes only if the SECOND clean run also passes — not the first lucky attempt. Paste both runs' outputs to demonstrate idempotency.

Stop after 80 turns if not converged, and report which tests still failed plus the smallest blocker.
