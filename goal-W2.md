# Goal W2 — Solo dashboard renders real data on every route

> Paste the block below into Claude Code after W1 is green:
>
>     /goal <PASTE THE CONDITION>

---

Web Bundle slice W2 — solo dashboard end-to-end. Assumes W1 done (web bundles into CLI, /api/healthz returns 200 from isolated install). Verify every route a solo user lands on renders with their real data, no 500s. Plan: /Users/abishaikc/Coodra/web-bundle-plan.md.

In an isolated /tmp install (same pattern as W1 — fresh tarball install in /tmp/h-w2-iso, fresh COODRA_HOME=/tmp/h-w2-home, fresh project in /tmp/h-w2-proj):

Setup:
(S1) Install the local tarball into /tmp/h-w2-iso (same pattern as W1).
(S2) `coodra init` in /tmp/h-w2-proj.
(S3) `coodra start`; wait for web /api/healthz.
(S4) Seed data: `coodra feature add greet --description "Say hi to the team"`, `coodra feature add caching --description "Memoize hot paths in /lib/query"`. Then via the CLI's existing record-decision flow if exposed (skip if not — `feature add` is enough to populate /features).

Acceptance — `curl -sSf http://127.0.0.1:3001/<path>` returns HTTP 200 and the body contains the listed pattern (case-insensitive grep). Each route checked TWICE from clean state:
(A) / — body contains BOTH ('dashboard' OR 'workspace') AND ('solo' OR 'local').
(B) /features — body contains literal 'greet' AND literal 'caching'.
(C) /decisions — returns 200 (empty list is acceptable; body should contain 'decisions' or 'No decisions' or similar).
(D) /packs — returns 200; body contains the project slug derived from /tmp/h-w2-proj basename.
(E) /context-packs — returns 200; body contains 'context' (header / empty-state).
(F) /policy — returns 200; body contains 'policy' (header / list of 25 baseline rules from `coodra init`).
(G) /sync — returns 200; body contains 'solo' OR 'no cloud sync' OR 'sync queue empty' (the solo-mode wording).

If ANY route returns 500 or fails the pattern check, that is a real bug to fix in this goal:
- Read the web server's stderr from `/tmp/h-w2-home/logs/web.log` (or wherever the daemon manager writes it).
- Likely culprits: queries assuming team mode / Clerk session present; routes assuming COODRA_PUBLIC_URL is set; queries hitting empty tables without an empty-state branch.
- Fix the route; rebuild; reinstall the tarball; re-run from clean state.

Run the full acceptance twice from clean state; paste both runs' verbatim outputs.

Boundaries: do NOT change the data model. Do NOT touch Phase G/H invariants. Do NOT publish to npm. Only fix routes that 500 or render empty when they shouldn't. If a route 500s only in isolated install (works in dev), check whether it depends on `pnpm` workspace symlinks or `.next/server/app/...` paths the standalone bundle missed.

Stop after 30 turns; report the route + first 50 lines of its server log.
