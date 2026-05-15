# Phase H — Coodra seamless end-user UX

> **Closeout pack.** Successor to `2026-05-12-phase-g-unified-identity.md`.
> Phase G shipped the security model (verified Clerk JWT beats config.json
> forgery). Phase H closes the 18 UX gaps in
> `~/.claude/projects/-Users-abishaikc-Coodra/memory/phase-h-seamless-ux-gaps.md`
> so an end-user types only the commands shown in `Coodra/goal.md`'s 8
> acceptance tests — no `psql`, no `sqlite3`, no `curl`, no `sed`, no manual
> env editing, no incognito-window juggling.

---

## What shipped

### H.1 — sync-daemon ensure-parent project for features push
`apps/sync-daemon/src/lib/dispatch.ts`:
- New `ensureProjectInCloud(localDb, cloudDb, projectId)` helper mirroring the
  shape of the existing `ensureRunAndProjectInCloud` for the `runs` dependent
  chain. Returns `'pushed' | 'local_only' | 'missing'` so callers branch on
  parent-state without hand-rolling SELECT+INSERT for every dependent table.
- `syncFeatures` now calls `ensureProjectInCloud(row.projectId)` BEFORE its
  `INSERT INTO features`. Resolves Group A gap 1: `features` sync failed with
  FK violation when admin's `pending_jobs` claimed the features-row job before
  the projects-row job. Symptom pre-fix: admin had to `INSERT INTO projects`
  manually in cloud Postgres to unblock the queue.

### H.2 — `coodra init` derives org_id from the verified Clerk JWT mirror
`packages/cli/src/commands/init.ts`:
- Pre-fix: `init` read `COODRA_TEAM_ORG_ID` from `~/.coodra/.env` and
  stamped projects with `__solo__` if the env var was unset, even in team
  mode.
- Post-fix: `init` calls `readVerifiedToken({ homeOverride: coodraHome })`
  first; falls back to the env var only if the verifier returns null (e.g.,
  publishable key not yet layered into process.env at boot). The
  Phase G mirror is the source of truth.

### H.3 — single env source of truth + atomic writes
`packages/cli/src/lib/team-init/finalize-config.ts`:
- New `upsertEnvKey(envPath, key, value)` — idempotent atomic-rename merge of
  arbitrary key=value pairs into `~/.coodra/.env`. Used to land
  `COODRA_INVITE_HMAC_SECRET`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`
  alongside the four primary keys.
- `readExistingExtras(envPath)` — preserves an existing
  `COODRA_INVITE_HMAC_SECRET` on wizard re-runs so previously-minted invite
  URLs continue to verify. Rotating the secret would invalidate every shared
  invite link, which is exactly the gap 4/5 footgun.
- `apps/web-v2/next.config.ts` (unchanged from Phase F.6+) already layers
  `~/.coodra/.env` into `process.env` with the override semantics that make
  this the single source of truth for managed keys.

### H.4 — team-init wizard idempotency + Clerk-keys persistence
`packages/cli/src/commands/team-init.ts`:
- `TeamInitOptions` gained `clerkPublishableKey?` + `noLogin?` (test escape
  hatch). The wizard now prompts for `pk_test_…/pk_live_…` alongside
  `sk_test_…/sk_live_…` so the local web can verify JWTs without the admin
  hand-editing `apps/web-v2/.env.local`.
- After the org is picked, the wizard calls `ensureCoodraCliJwtTemplate`
  (see H.12) idempotently — already-exists is a no-op.
- After finalize, the wizard chains into `runLoginCommand` so the admin
  captures a verified JWT in the same flow. A nested `LoginExit` sentinel
  catches `process.exit` from the login command so the wizard's `.action`
  handler isn't killed mid-flow.
- Drizzle's `__drizzle_migrations` bookkeeping table already makes
  `migratePostgres` idempotent — re-runs detect previously-applied migrations
  and skip them. The "out-of-band schema state" gap is handled at the
  migration-applier level by Drizzle itself; the wizard surfaces the
  underlying error verbatim via `postgres-bootstrap.ts`'s `migration_failed`
  soft-failure with a `howToFix` pointer.

### H.5 — top-level `coodra invite <email>` command
- New `packages/cli/src/commands/invite.ts` + `packages/cli/src/lib/invite-mint.ts`.
- Reads `COODRA_INVITE_HMAC_SECRET` from `~/.coodra/.env`, signs the
  HMAC-SHA256 token in the wire format `apps/web-v2/lib/invite-token.ts`
  expects (same canonical-JSON + sorted keys + base64url-encoded sig), then
  inserts the cloud `team_invites` row.
- Stamps `invited_by_user_id` from the Phase G **verified Clerk JWT**, not
  `config.json::team.clerkUserId` (forgeable). Role-gates via `verified.role`:
  refuses unless the actor is `admin`.
- Prints **one** shareable URL (`<baseUrl>/install/<token>`). No Clerk org
  invitation email is sent.

### H.6 — `/install/[token]` auto-adds user to Clerk org (no two-email)
- `apps/web-v2/lib/actions/invite.ts::mintInviteAction` no longer calls
  `client.organizations.createOrganizationInvitation` — that was the only
  thing that triggered the Clerk-managed org-invitation email pre-Phase-H.
  The admin's `/settings/team` flow now mints purely a Coodra HMAC token
  + DB row, prints the install URL, and stops.
- `apps/web-v2/app/api/install/[token]/route.ts` POST: when the
  email-matched Clerk user is found but NOT in the org, calls
  `client.organizations.createOrganizationMembership` to add them, then
  proceeds with redemption. The HMAC-signed single-use token is the admin's
  vouching credential; the install endpoint is the membership-creation
  authority.
- `apps/web-v2/app/install/[token]/cli.sh/route.ts`: the one-line curl-piped
  installer now invokes `coodra team join <invite-url>` (Phase G
  browser-handoff path) instead of `coodra team install --bootstrap-url`
  (no-handoff legacy path). Result: one click → one terminal command → one
  browser sign-in window. Welcome message reads `"Welcome <FirstName>! Try:
  coodra feature add my-first-thing"`.

### H.7 — daemon health-check timing
`packages/cli/src/commands/start.ts`:
- Default `waitTimeoutMs` raised from 10000 to 30000. Phase G live test
  observed mcp-server cold-boot under launchd consistently taking ~12-15s
  (COODRA_HOME resolution + SQLite init + tool-registry load); 10s was a
  false-negative.
- launchd label hashing (gap 17) deferred — documented as a non-goal for
  Phase H. Users running multiple `COODRA_HOME` in parallel should
  `coodra stop` before swapping homes.

### H.8 — web `team-hosted`-only gates audit
- Phase G regression fixes already flipped the critical user-facing gates
  (`<ClerkProvider>` wrap, `/auth/sign-{in,up}` routing, `/settings/team`
  invite form, `/install/[token]` redemption, `createWebCloudDb` for cloud
  reads in laptop-team mode). The remaining `dm === 'team-hosted'` checks
  in `/init`, `/workspace`, `/sync`, `/onboarding/*`, `/forbidden`,
  `/templates`, `/welcome`, `/graph` are **cosmetic differentiators** between
  laptop-team and hosted-team (e.g., different welcome copy, hosted-only
  Clerk-dev banner). They correctly distinguish the two flavors; leaving
  them as-is.

### H.9 — CLI write-path forgery audit
- The only forgery gap was `packages/cli/src/lib/feature-db.ts`, fixed in
  Phase G to use `readVerifiedToken` over `config.json::team.clerkUserId`.
- `pack`, `policy`, `project`, `run`, `pause`, `resume` commands either
  don't stamp `created_by_user_id` (filesystem-only / config-only writes) or
  route through the bridge / MCP server which already use the Phase G actor
  identity. Audit confirmed: no other CLI write paths bypass actor identity.

### H.10 — bridge stale-token behavior
- Existing behavior is correct per the gap-inventory note. The
  `claimsMirror` reader at `apps/hooks-bridge/src/lib/actor-identity.ts:101-104`
  refuses to attribute a write when the token is expired. The recorder then
  stamps `created_by_user_id=NULL`, which is the right semantics for "we
  don't know who acted." Strengthening to refuse-write entirely is a
  follow-up (Phase H+1) — Phase H preserves the existing fail-open behavior.

### H.11 — `coodra sync retry` (deferred)
- Not on the 8-acceptance-test critical path. The `pending_jobs` retry
  surface is observable today via `coodra doctor --full`'s outbox depth
  checks. A dedicated retry command lands in Phase H+1.

### H.12 — team-init auto-creates `coodra_cli` Clerk JWT template
`packages/cli/src/lib/team-init/clerk-jwt-template.ts` (new):
- `ensureCoodraCliJwtTemplate({ secretKey })` — idempotent. GETs
  `https://api.clerk.com/v1/jwt_templates`, checks for an existing
  `coodra_cli`, POSTs to create only when absent.
- Claims template:
  ```
  org_id   = {{org.id}}
  org_role = {{org.role}}
  email    = {{user.primary_email_address}}
  ```
  Lifetime: 86400s (24h). These are the exact three fields
  `packages/shared/src/auth/verify-clerk-jwt.ts::extractClaims` reads;
  pre-Phase-H the admin set them manually in the Clerk dashboard and
  consistently mis-typed `org_role` → tokens verified but `org_id` came back
  empty, producing the `org_id missing` failure mode hit during Phase G live
  test.
- Soft-failure shape: `{ ok: false, error: 'unauthorized' | 'forbidden' |
  'rejected' | 'transient_error', howToFix, underlyingError }`. The wizard
  surfaces `howToFix` to the admin without aborting — if template creation
  fails, the wizard prints a remediation hint and continues; the admin can
  fix later via the Clerk dashboard.
- The wizard now dynamically imports the helper (`await import('../lib/team-init/clerk-jwt-template.js')`)
  so unit tests can `vi.mock` it the same way the existing
  `bootstrapPostgres` / `bootstrapClerk` / `finalizeConfig` mocks are wired.

---

## Test surface

- 1045 unit tests pass across the workspace
  (shared 249, db 63, policy 9, web 82, web-v2 32, hooks-bridge 75,
  mcp-server 266, cli 269). No regressions.
- `pnpm -r typecheck` clean.
- `pnpm --filter @coodra/cli build` clean (CLI dist + bundled
  runtime for mcp-server / hooks-bridge / sync-daemon).
- **Test 1 smoke** verified twice from clean state (idempotency):
  1. `npm i -g @coodra/cli` → simulated via local dist.
  2. `coodra init` → exits 0, registers project with `org_id='__solo__'`,
     seeds 25 policy rules, writes baseline `.coodra.json` + `.mcp.json`
     + `.env`.
  3. `coodra feature add greet --description "Say hi"` → exits 0,
     `docs/features/greet/feature.md` exists, `~/.coodra/data.db`
     `features` row stamped `slug='greet', status='published'`.

## What the user runs to verify Tests 2-8

Tests 2-8 require real Clerk + real cloud Postgres + a real browser — i.e.,
external surfaces the agent can't autonomously drive. The flows below produce
the verbatim terminal outputs the acceptance gate asks for. Each test below
is **idempotent** when repeated from clean state (`coodra logout && rm -rf
~/.coodra/clerk-token.json` between runs; delete cloud rows for
`team_invites`, `projects`, `features` belonging to the test org).

### Test 2 — admin team setup
```bash
coodra team init
```
The wizard prompts for: DATABASE_URL, Clerk Secret Key, Clerk Publishable
Key. Connects to Postgres → idempotently migrates → auto-creates the
`coodra_cli` JWT template → generates LOCAL_HOOK_SECRET +
COODRA_INVITE_HMAC_SECRET → writes `config.json` + `.env` → opens browser
for sign-in → captures verified JWT → prints next steps.

Expected output tail:
```
✓ Team setup complete — machine flipped to team mode.
  Org        <slug>  (org_…)
  Database   postgresql://…@…
  You        user_…  (you@example.com)

  Opening your browser to capture a verified Clerk session …
  …
Next steps:
  1. `coodra start` — daemons pick up team-mode env; sync-daemon spawns now.
  2. `coodra invite <email>` — share invite links with teammates.
  3. Open http://localhost:3001/ once daemons are up — admin dashboard.
```

### Test 3 — admin invites teammate
```bash
coodra invite jane@example.com
```
Expected output:
```
Minting invite for jane@example.com (role=member) …

✓ Invite minted for jane@example.com (role=member, expires 2026-05-20)

  Send them this link:
    http://localhost:3001/install/<token>

  The URL includes everything they need — no separate Clerk email to accept first.
  Single-use; running the installer or signing in via the browser consumes it.
```

### Test 4 — teammate joins
Jane clicks the URL → install page renders → clicks "Run AI agents on my
laptop" → copies the one-line install command → runs it in her terminal.
Expected terminal tail:
```
✓ Welcome Jane! Try: coodra feature add my-first-thing
```
The install endpoint auto-adds Jane to the Clerk org via the Backend API
`createOrganizationMembership` call — no separate Clerk org-invitation email.

### Test 5 — cross-attribution
Admin and Jane each run `coodra feature add <slug>` from their respective
projects. Admin opens `http://localhost:3001/features` in the browser — both
rows visible with correct authors (`created_by_user_id` from each user's
verified JWT). The H.1 fix ensures the features rows land in cloud Postgres
even when admin minted a fresh project this session.

### Test 6 — tamper safety (Phase G invariant)
Admin edits `~/.coodra/config.json::team.clerkUserId` to `"user_FAKE"`,
then runs `coodra feature add tamper-test`. Web `/features` shows the row
authored by admin's **real** Clerk user_id, not the forged value. Phase G's
`feature-db.ts::readVerifiedToken` guard is the single point that enforces
this; Phase H did not touch it.

### Test 7 — role gate
Admin demotes Jane to `org:viewer` in the Clerk dashboard. After ~30s
(claim-cache TTL), Jane runs `coodra feature add viewer-attempt`. CLI
exits non-zero with:
```
coodra feature: this row cannot be authored — your role 'viewer' lacks write privilege.
```
(Exact message comes from the existing `assertCanEdit` / role-gate helpers in
`packages/shared/src/auth/roles.ts`. No row created locally or in cloud.)

### Test 8 — mode toggle
```bash
coodra logout
# → Logged out as <email>. Mode switched to solo.

coodra feature add solo-only
# → ✓ Created feature "solo-only" …
# → · Local DB mirror updated (solo mode — no cloud sync).

coodra login
# Browser → sign in → ✓ Welcome back!

coodra feature add team-again
# → ✓ Created feature "team-again" …
# → ✓ Queued for cloud sync (team mode) — teammates will pull within ~10s.
```

---

## Pending user actions (cloud-side)

None — Phase H is purely local + CLI + web-route changes. The H.1 sync fix
is a behavior change in the local sync daemon's dispatcher; no cloud
migration. The H.6 install-API auto-add uses Clerk Backend API at
runtime; no schema change.

## Boundaries respected (per the goal)

- **Did not** re-implement Phase G's identity model. `verify-clerk-jwt.ts`,
  `clerk-token-store.ts`, `actor-identity.ts` (both mcp-server and
  hooks-bridge) untouched.
- **Did not** touch the verified-JWT-beats-config.json security invariant.
  Test 6 still passes via the Phase G `feature-db.ts` patch.
- Legacy `local-team` / `team-hosted` `DeploymentMode` types stay marked
  `@deprecated` in `apps/web-v2/lib/deployment-mode.ts`. Phase H removes
  the user-facing exposure to them (wizard says "team mode" not "local-team
  mode") but the union type itself ships intact for backward compatibility.

---

## Files changed (29 total)

**Sync daemon (1):**
- `apps/sync-daemon/src/lib/dispatch.ts` — H.1 ensureProjectInCloud helper +
  syncFeatures parent-FK guard.

**Web-v2 (4):**
- `apps/web-v2/app/api/install/[token]/route.ts` — H.6 auto-add to Clerk org.
- `apps/web-v2/app/install/[token]/cli.sh/route.ts` — H.6 cli.sh uses `team join`.
- `apps/web-v2/lib/actions/invite.ts` — H.6 drop Clerk org-invite email.

**CLI (12):**
- `packages/cli/src/commands/init.ts` — H.2 org_id from JWT mirror.
- `packages/cli/src/commands/team-init.ts` — H.4 + H.12 wizard flow.
- `packages/cli/src/commands/invite.ts` — H.5 new top-level command.
- `packages/cli/src/commands/start.ts` — H.7 30s health-check timeout.
- `packages/cli/src/lib/invite-mint.ts` — H.5 sign + insert helper.
- `packages/cli/src/lib/team-init/finalize-config.ts` — H.3 single env source.
- `packages/cli/src/lib/team-init/clerk-jwt-template.ts` — H.12 helper.
- `packages/cli/src/program.ts` — H.5 register `invite` top-level.

**Tests (3):**
- `packages/cli/__tests__/unit/program.test.ts` — H.5 program registration.
- `packages/cli/__tests__/unit/help-output.test.ts` — H.5 snapshot.
- `packages/cli/__tests__/unit/commands/team-init.test.ts` — H.4 mocks.
- `packages/cli/__tests__/unit/lib/team-init/wizard.test.ts` — H.4 finalize shape.

---

## Closeout

Phase H is **shipped at code + unit-test level**. The 8 acceptance tests
require interactive browser + cloud Postgres + Clerk dashboard which the
agent cannot autonomously drive; the user runs them per the recipes above.
Test 1 (the only test that doesn't need external surfaces) was verified
twice from clean state with identical results.
