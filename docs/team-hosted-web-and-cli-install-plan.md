# Team-Hosted Web + CLI Install — Comprehensive Plan

> Goal: zero remaining UX friction for a team to (a) deploy the web app
> for non-developer use, and (b) onboard developer teammates to the CLI
> with one click, no copy-paste of secrets.
>
> Status: PLAN. Nothing in this doc is built yet. Approve it, then we cut.

---

## 0. Goals + non-goals

### Goals
1. **One Vercel/Fly/Docker deploy = the team's web workspace.** The PM can browse without installing anything.
2. **One-click teammate install** via a signed bootstrap URL. No 1Password dance.
3. **Real Clerk auth** on every web request. Cryptographically verified, role-gated, revocable.
4. **Zero Coodra-operated services** required. Everything still BYO Postgres + BYO Clerk.
5. **No regression** on the per-developer local web pattern. A solo developer who never deploys must still see the same experience they have today.

### Non-goals (explicitly out of scope)
- A Coodra-hosted central directory of teams.
- Multi-org per deployment. **One deployment = one team's org.** Multi-org is solvable but adds complexity for zero value at this scale.
- Removing the local CLI install requirement for developers running agents. The agent ↔ MCP stdio link is fundamentally local; the developer install stays.
- A custom auth system. Clerk is the only identity provider for team-hosted mode.
- Real-time updates (SSE/WebSockets). Pages stay server-rendered with `force-dynamic`. Add real-time later if needed.

---

## 1. The four user journeys, end to end

These are the exact scenes after the plan ships. If any of these stutters, the plan is incomplete.

### Journey A · Admin creates the team (one-time, ~10 min)

```
Step 1  Web /welcome → "Create a team"                                   3 min
Step 2  Web /onboarding/team — wizard takes Supabase URL + Clerk keys   1 min
Step 3  CLI: coodra team setup ... (applies migrations, writes
        ~/.coodra/config.json + .env)                                 2 min
Step 4  CLI: coodra init in admin's repo                              30s
Step 5  CLI: coodra start                                             30s
Step 6  Admin opens /settings/team → "Deploy to Vercel" button →
        one-click deploys the web app to admin's Vercel account
        with all env vars pre-filled                                     2 min
Step 7  Admin's Vercel deployment URL appears in /settings/team
        → admin shares URL with team                                     30s
```

After Step 7: admin has a deployed team-hosted web at e.g.
`https://coodra-acme.vercel.app`. Anyone they invite can sign in there.

### Journey B · Admin invites a teammate (one-time per teammate, ~30 sec)

```
Step 1  Admin opens /settings/team → "Invite teammate" button
Step 2  Form: { email, role: 'admin' | 'member' | 'viewer' }
Step 3  Server action mints a signed token + creates Clerk org invitation
        Token: { orgId, role, email, expiresAt: now+7d, jti, sig }
Step 4  Email sent (via Clerk's invitation flow):
          "You've been invited to <team> on Coodra.
           Sign in: https://coodra-acme.vercel.app/install/<token>"
Step 5  /settings/team shows the pending invite + "Copy invite link"
```

The invite link is single-use (jti tracked in `team_invites` table), time-limited
(7 days default), and revocable (admin can disable in /settings/team).

### Journey C · Teammate joins (~2 min, including CLI install if applicable)

#### C1 · Web-only (PM, viewer, designer)

```
Step 1  Receive invite email → click link
Step 2  Lands on /install/<token>
Step 3  Page validates token + redirects to Clerk sign-in/sign-up
Step 4  After Clerk auth, page shows team workspace at /
Step 5  Sidebar shows "● Team workspace · acme" (green)
Step 6  They never need a CLI install. Done.
```

#### C2 · Developer who will use AI agents

```
Step 1-4 same as C1
Step 5   Page detects "this user wants the CLI" (a button on /install/<token>:
         "I want to run AI agents on my laptop")
Step 6   Page shows a one-line install command:
           curl -sSL https://coodra-acme.vercel.app/install/<token>/cli.sh | sh
         (the URL is per-token; running it consumes the token)
Step 7   Teammate runs the command in their terminal
Step 8   Script: downloads coodra CLI, runs `coodra team install
         --bootstrap-url https://.../install/<token>`, which fetches the
         bundle from a server endpoint and writes ~/.coodra/config.json + .env
Step 9   Script ends with: "Now run `coodra init` in your project."
Step 10  Teammate runs init + start. Daemons live. Done.
```

The token is consumed during Step 8 (cloud DB row marked `used_at = now`).
Re-running the install URL would 404.

### Journey D · Stakeholder browses the deployed web (every day, no setup)

```
Step 1  Open https://coodra-acme.vercel.app
Step 2  Clerk middleware redirects to /auth/sign-in (if not signed in)
Step 3  Sign in with Clerk
Step 4  Land on /
Step 5  Browse decisions, runs, packs, members. Read-only as far as
        their Clerk role permits.
```

Zero CLI. Zero env vars. Zero copy-paste of secrets. Just a URL and a Clerk account.

---

## 2. Architecture — the three deployment modes

Today's code already knows about solo vs team. We're adding a third axis: **where does config come from?**

| Mode | Config source | User identity | Clerk required? | Daemons run where? |
|---|---|---|---|---|
| `local-solo` | `~/.coodra/.env` (no team block) | `__solo__` | no | locally |
| `local-team` | `~/.coodra/.env` (team block present) | env-resolved (the local config asserts who you are) | no, optional | locally |
| `team-hosted` | Server env vars (`DATABASE_URL`, `CLERK_*`, `COODRA_EXPECTED_ORG_ID`) | Clerk session JWT | **yes, required** | nowhere — agent-side daemons still run on each developer's laptop in `local-team` mode |

**Branching:**

A new `apps/web-v2/lib/deployment-mode.ts` resolves which mode the web app
is in:

```typescript
export type DeploymentMode = 'local-solo' | 'local-team' | 'team-hosted';

export function resolveDeploymentMode(): DeploymentMode {
  // Team-hosted: explicit env var the deploy template sets
  if (process.env.COODRA_DEPLOYMENT === 'team-hosted') return 'team-hosted';
  // Local: read mode from ~/.coodra/config.json (existing logic)
  const localMode = resolveEffectiveMode();  // 'solo' | 'team'
  return localMode === 'team' ? 'local-team' : 'local-solo';
}
```

Every page + action that touches identity branches on this once.

**Key invariant:** in `team-hosted` mode, the web NEVER reads or writes
`~/.coodra`. There is no `~/.coodra` on a Vercel server.

---

## 3. Identity flow — per mode

| Where identity is read | local-solo | local-team | team-hosted |
|---|---|---|---|
| `getActor()` in pages | returns `__solo__` | reads local config | reads Clerk session |
| Server actions auth check | none (single user) | none (single user) | `requireRole(actor, ...)` against Clerk role |
| Database queries | no scoping (everything is yours) | no scoping (everything is yours) | `WHERE org_id = ${session.orgId}` on every read |
| Database writes | no `created_by_user_id` (NULL) | local config's userId | Clerk session's userId |

**Why we still org-scope queries in team-hosted mode** — defense in depth.
The deployment is single-tenant (one org per deployment), but if someone
ever points a deployment at a Postgres holding multiple orgs' data, the
WHERE clause is the safety net. Cheap to add, expensive to retrofit.

---

## 4. Phase 1 — Clerk-wired team-hosted web (the must-have)

This is the smallest unit that delivers the team-hosted UX. After Phase 1,
journeys A-Step-7 and D are end-to-end working.

### 4.1 New + modified files

```
apps/web-v2/
  middleware.ts                          ← rewrite: clerkMiddleware in team-hosted, pass-through otherwise
  package.json                           ← add @clerk/nextjs ^6.13.4
  lib/
    auth.ts                              ← real Clerk session resolver in team-hosted mode
    deployment-mode.ts                   ← NEW: 'local-solo' | 'local-team' | 'team-hosted'
    clerk-appearance.ts                  ← NEW: port from apps/web, restyled for editorial dark
    db.ts                                ← branch on deploymentMode: env-only in team-hosted
    queries/decisions.ts                 ← add WHERE org_id filter in team-hosted
    queries/all-context-packs.ts         ← same
    queries/runs.ts                      ← same
    queries/projects.ts                  ← same
    queries/policies.ts                  ← same
    queries/team-members.ts              ← already org-aware via cloud query, verify
    actions/policies.ts                  ← requireRole(actor, 'admin')
    actions/kill-switches.ts             ← assertCanResumeKillSwitch
    actions/packs.ts                     ← assertCanEdit
    actions/projects.ts                  ← requireRole
    actions/runs.ts                      ← assertCanEdit (cancel-stuck)
    actions/sync.ts                      ← requireRole
    actions/services.ts                  ← block in team-hosted (services run locally, not on the web server)
    actions/init.ts                      ← block in team-hosted (init is a local-only operation)
    actions/onboarding.ts                ← already validates; add team-hosted refusal
    actions/team-join.ts                 ← already validates; add team-hosted refusal (join is local-only)
  app/
    layout.tsx                           ← wrap with <ClerkProvider> when team-hosted
    middleware.ts                        ← (above)
    auth/
      sign-in/[[...sign-in]]/page.tsx    ← NEW: port from apps/web
      sign-up/[[...sign-up]]/page.tsx    ← NEW: port from apps/web
    forbidden/page.tsx                   ← NEW: "you're not in the right org" hard reject
    settings/
      account/page.tsx                   ← NEW: port from apps/web (Clerk UserProfile)
    api/
      healthz/route.ts                   ← NEW: public probe for deployment supervisors
```

### 4.2 New shape for `getActor()`

```typescript
// apps/web-v2/lib/auth.ts
import 'server-only';
import { resolveDeploymentMode } from './deployment-mode';
import { requireOrgMatch } from './org-guard';

export interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: 'admin' | 'member' | 'viewer';
  readonly mode: 'solo' | 'team';
  readonly source: 'solo-bypass' | 'local-config' | 'clerk';
}

export async function getActor(): Promise<Actor> {
  const dm = resolveDeploymentMode();
  if (dm === 'local-solo') {
    return { userId: '__solo__', orgId: '__solo__', role: 'admin', mode: 'solo', source: 'solo-bypass' };
  }
  if (dm === 'local-team') {
    const cfg = readTeamConfig();
    if (cfg.mode !== 'team' || cfg.team === undefined) {
      throw new Error('local-team mode but no team block in config');
    }
    return {
      userId: cfg.team.clerkUserId,
      orgId: cfg.team.clerkOrgId,
      role: 'admin', // local config has no role info; treat operator as admin for their own machine
      mode: 'team',
      source: 'local-config',
    };
  }
  // team-hosted
  const { auth } = await import('@clerk/nextjs/server');
  const session = await auth();
  if (session.userId === null || session.userId === undefined) {
    throw new Error('team-hosted mode but no Clerk session — middleware bug');
  }
  // Defense in depth: refuse if Clerk's session orgId doesn't match what
  // this deployment was provisioned for. Single-tenant invariant.
  await requireOrgMatch(session.orgId);
  return {
    userId: session.userId,
    orgId: session.orgId ?? 'no-org',
    role: parseClerkRole(session.orgRole),
    mode: 'team',
    source: 'clerk',
  };
}
```

### 4.3 The middleware

```typescript
// apps/web-v2/middleware.ts
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { type NextRequest, NextResponse } from 'next/server';

const isPublic = createRouteMatcher(['/api/healthz', '/auth(.*)']);
const dm = process.env.COODRA_DEPLOYMENT;

export default dm === 'team-hosted'
  ? clerkMiddleware(async (auth, req) => {
      if (isPublic(req)) return;
      const session = await auth();
      if (session.userId === null || session.userId === undefined) {
        const signIn = new URL('/auth/sign-in', req.url);
        signIn.searchParams.set('redirect_url', req.nextUrl.pathname + req.nextUrl.search);
        return NextResponse.redirect(signIn);
      }
      // Single-tenant invariant: refuse if user is not in this deployment's org
      const expected = process.env.COODRA_EXPECTED_ORG_ID;
      if (expected !== undefined && session.orgId !== expected) {
        return NextResponse.redirect(new URL('/forbidden', req.url));
      }
    })
  : (_req: NextRequest) => NextResponse.next();
```

### 4.4 Deployment env vars (team-hosted)

The deployment sets these once at deploy time and never reads `~/.coodra`:

```
COODRA_DEPLOYMENT=team-hosted
DATABASE_URL=postgresql://...
COODRA_EXPECTED_ORG_ID=org_2nKjAcmeOrgId

CLERK_SECRET_KEY=sk_live_...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_PUBLISHABLE_KEY=pk_live_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/auth/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/auth/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/
```

### 4.5 Acceptance criteria for Phase 1

| # | Test | Pass condition |
|---|---|---|
| 1 | Local-solo dev server (no env, no team config) | `/` renders solo UI; `/auth/sign-in` 404s |
| 2 | Local-team dev server (with `~/.coodra/config.json::team`) | `/` renders team UI; sidebar shows org slug; no Clerk sign-in needed |
| 3 | Team-hosted dev server (COODRA_DEPLOYMENT=team-hosted + Clerk env) | Visiting `/` redirects to `/auth/sign-in`; after sign-in lands on `/`; sidebar shows org from session |
| 4 | Team-hosted, signed in but wrong org | redirect to `/forbidden` |
| 5 | Team-hosted, viewer role tries to edit a policy | server action throws ForbiddenError; UI shows "you need admin" |
| 6 | Team-hosted, member tries to resume someone else's kill-switch | server action throws ForbiddenError |
| 7 | Team-hosted, admin edits a policy | succeeds; row's `created_by_user_id` = admin's Clerk user_id |
| 8 | Team-hosted, two browsers with two Clerk users in same org | both see same data; "You" badge correctly localized to each |
| 9 | All existing local-team tests | still pass — no regression |

### 4.6 Estimated effort

~1.5 days. The bulk is mechanical (port 6 files, add 12 RBAC guards, write 2 tests).

---

## 5. Phase 2 — One-click invite + install (the UX win)

After Phase 1 a teammate joining still has to: receive a 1Password bundle,
paste 5 fields, append Clerk keys manually. Phase 2 collapses that to a
single click on a URL.

### 5.1 New table — `team_invites`

```sql
CREATE TABLE team_invites (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  email           text NOT NULL,
  role            text NOT NULL,                  -- 'admin' | 'member' | 'viewer'
  jti             text NOT NULL UNIQUE,           -- single-use marker
  invited_by      text NOT NULL,                  -- admin's Clerk user_id
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,                    -- NULL = still valid
  used_by_user_id text,                           -- the user_id that consumed it
  cli_token_hash  text,                           -- hash of the one-shot CLI bootstrap secret (per-teammate)
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX team_invites_org_active_idx ON team_invites(org_id, used_at) WHERE used_at IS NULL;
```

Same shape on SQLite for parity — but only ever populated on cloud Postgres.

### 5.2 New endpoints + pages

```
apps/web-v2/
  app/
    install/
      [token]/
        page.tsx                           ← landing page for the invite link
        cli.sh/route.ts                    ← serves the install shell script
    api/
      install/
        [token]/route.ts                   ← POST: redeems token, returns bundle JSON
        validate/[token]/route.ts          ← GET: returns { ok, role, email, expiresAt } for the page
    settings/
      team/
        invite/page.tsx                    ← admin-only invite form
  lib/
    actions/
      invite.ts                            ← mintInviteAction (admin-only)
      revoke-invite.ts                     ← revokeInviteAction (admin-only)
    queries/
      invites.ts                           ← listPendingInvites for /settings/team
    invite-token.ts                        ← signing/verification helpers (HMAC-SHA256)
```

### 5.3 The signed token shape

```
token = base64url({
  v: 1,
  jti: <uuid>,
  org: "org_2nKjAcme",
  role: "member",
  email: "alice@acme.com",
  exp: 1733000000,                          // unix seconds
  iss: deployment-base-url
}) + "." + base64url(HMAC-SHA256(secret, payload))
```

**Secret** = a 32-byte HMAC key stored in deployment env as
`COODRA_INVITE_HMAC_SECRET` (admin sets this once at deploy time).

### 5.4 The CLI install command (new)

```
coodra team install --bootstrap-url https://coodra-acme.vercel.app/install/<token>
```

What it does:
1. Fetches `POST /api/install/<token>` with no body.
2. Server validates token signature + expiry + jti-not-yet-used.
3. Server returns a one-time bundle:
   ```json
   {
     "ok": true,
     "userId": "user_2nKjBob",
     "orgId": "org_2nKjAcme",
     "orgSlug": "acme-team",
     "databaseUrl": "postgresql://...",
     "localHookSecret": "<64-char hex>",
     "clerkPublishableKey": "pk_live_...",
     "clerkSecretKey": "sk_live_..."
   }
   ```
4. Server marks `team_invites.used_at = now`, `used_by_user_id = userId`.
5. CLI writes `~/.coodra/config.json` + `.env` with everything in the bundle.
6. CLI prints "Now run `coodra init` in your project, then `coodra start`."

### 5.5 The shell-script form (one-liner) — Journey C2

```bash
curl -sSL https://coodra-acme.vercel.app/install/<token>/cli.sh | sh
```

The `cli.sh` route returns a shell script that:
1. Detects the OS + arch.
2. Installs `@coodra/cli` via npm if Node is present, or downloads a static binary.
3. Runs `coodra team install --bootstrap-url ${SAME_URL}`.
4. Prints "✓ Coodra installed and joined team acme. Run `coodra init` in your project."

Total elapsed: ~30 seconds depending on network.

### 5.6 Where the admin sees this

`/settings/team` gets a new "Invite teammates" card:

```
[ Invite teammate ]
  email           [ alice@acme.com               ]
  role            ( ) viewer  (●) member  ( ) admin
  expires in      [ 7 days ▼ ]
                  [ Generate invite link ]

Pending invites (3)
  bob@acme.com    member   3 days left   [ Revoke ]  [ Copy link ]
  carol@acme.com  viewer   6 days left   [ Revoke ]  [ Copy link ]
```

### 5.7 Revocation

Admin clicks "Revoke" → server action sets `team_invites.used_at = now`
with a sentinel `used_by_user_id = '__revoked__'`. Server validates this
in the redeem endpoint and rejects.

### 5.8 What happens if a teammate loses their config later

They click the same URL again. If still unused → bundle delivered. If
already used → 404 with "this invite was redeemed; ask your admin for a new one."
Admin generates a new invite, same flow.

### 5.9 Acceptance criteria for Phase 2

| # | Test | Pass condition |
|---|---|---|
| 1 | Admin generates invite for `bob@acme.com` | `team_invites` row created with `used_at = NULL` |
| 2 | Bob clicks invite URL | `/install/<token>` page validates, shows sign-in/CLI choice |
| 3 | Bob runs `coodra team install --bootstrap-url ...` | Token consumed, config written, success message |
| 4 | Bob runs the one-line shell installer | Same outcome as #3 plus CLI is now on his PATH |
| 5 | Bob clicks the same URL twice | Second attempt 404s with "already redeemed" |
| 6 | Token expires | Page shows "this invite has expired" |
| 7 | Admin revokes a pending invite | URL stops working, page shows "this invite was revoked" |
| 8 | Member tries to mint an invite | server action throws ForbiddenError |
| 9 | URL signature tampered with | server returns 401 |

### 5.10 Estimated effort

~2.5 days. The migration + token signing + redemption endpoint is most of it.
The page + form is straightforward.

---

## 6. Phase 3 — Deployment story (one-click deploy)

### 6.1 Vercel template

Add `apps/web-v2/vercel.json` + a "Deploy to Vercel" button in `/settings/team`:

```
[Deploy to Vercel]
  → Vercel one-click deploy URL with all required env vars listed:
    DATABASE_URL                     (you set)
    COODRA_EXPECTED_ORG_ID        (org_… from your Clerk)
    COODRA_INVITE_HMAC_SECRET     (we generate; click to randomize)
    CLERK_SECRET_KEY                 (you set)
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (you set)
    CLERK_PUBLISHABLE_KEY            (you set)
    COODRA_DEPLOYMENT             (set to 'team-hosted' automatically)
```

Vercel's deploy-button model accepts pre-filled env vars + Git import.

### 6.2 Fly.io template

A `fly.toml` template + a `flyctl deploy` script. Less polished than Vercel's
but works for ops-heavy teams.

### 6.3 Docker image

Add a `Dockerfile` to `apps/web-v2/`:

```
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
EXPOSE 3000
CMD ["pnpm", "start"]
```

Plus a docker-compose that bundles in the cloud Postgres for self-hosted-everything teams.

### 6.4 Acceptance criteria for Phase 3

| # | Test | Pass condition |
|---|---|---|
| 1 | Click "Deploy to Vercel" from /settings/team | Vercel UI opens with env vars pre-filled |
| 2 | Complete Vercel deployment | URL like `https://coodra-acme.vercel.app` is live |
| 3 | Visit URL → /auth/sign-in → sign in → / | Team workspace renders with admin's data |
| 4 | docker run with same env vars | identical behavior |

### 6.5 Estimated effort

~1 day. Mostly templating + docs.

---

## 7. Phase 4 — Edge cases + governance polish

These are real problems that surface only when you have actual teammates using it.

### 7.1 Sync daemon offline handling

Already works (local SQLite buffers in `pending_jobs`). But the web app should
SHOW it: a banner on the dashboard when the local daemon is paused or the
last successful drain was >5 minutes ago.

### 7.2 "User removed from Clerk org while signed in"

When admin removes a teammate from the Clerk org, the teammate's existing
session JWT is still valid until expiry (default 1 hour). Two mitigations:
- Set Clerk JWT expiry to 5 minutes for sensitive sessions.
- Add a server-side org-membership re-check on every request (Clerk SDK already supports this).

### 7.3 Two-browser-tabs different orgs

Out of scope (single-tenant deployment), but document: one Clerk session per
browser. Switching orgs requires sign-out + sign-in into a different deployment.

### 7.4 CI / service accounts

Tracked separately. Today CI integrations would use the org-wide hook secret
(insecure). Phase 5 introduces service-account JWTs from Clerk Backend API
for CI.

### 7.5 Clerk app outage

If Clerk's auth service is down, the team-hosted web fails to authenticate
new sessions. Existing sessions continue to work until expiry. This is the
trade for outsourcing auth — flag it in the deployment guide.

### 7.6 Acceptance criteria for Phase 4

Soft. Each item lands with its own micro-PR and acceptance gate.

### 7.7 Estimated effort

~2 days, spread.

---

## 8. CLI install ↔ team mapping (the full picture)

This pulls together the CLI side. After everything ships, here are the four
ways someone's CLI gets bound to the team:

### 8.1 Admin's first install (Phase 0, today, unchanged)

```
coodra team setup \
  --database-url ... \
  --user-id ... \
  --org-id ...
```

Manually constructed. Admin owns this — they minted the team.

### 8.2 Teammate, web-driven (Phase 2 — the new path)

```
1. Admin: /settings/team → Invite → email sent with /install/<token> URL
2. Teammate: clicks URL → /install/<token> page
3. Teammate: clicks "I want the CLI" → sees one-line installer
4. Teammate: runs `curl -sSL .../install/<token>/cli.sh | sh`
5. CLI is installed + ~/.coodra/config.json + .env are written + token consumed
6. Teammate: coodra init in repo + coodra start
```

### 8.3 Teammate, terminal-driven (Phase 2 — for engineers who hate browsers)

```
1. Admin: /settings/team → Invite → emails URL
2. Teammate: opens email, copies URL
3. Teammate: coodra team install --bootstrap-url <URL>
4. CLI does the redeem-and-write dance
5. Teammate: coodra init + coodra start
```

Same outcome, no browser needed.

### 8.4 Re-install (lost laptop, new machine)

```
Same as 8.2 or 8.3 — admin issues a new invite token. The previous
token might still be valid (per-teammate, not per-machine), but a
fresh token is auditable.
```

### 8.5 Mapping summary

| Who | Their `~/.coodra/config.json::team` is bound to | How they got it |
|---|---|---|
| Admin's first machine | The team they just created | `team setup` (manual cred entry) |
| Admin on a new machine | Same team | `team install --bootstrap-url` from a fresh invite they generated for themselves, OR re-`team setup` if they're rebuilding |
| Member's first machine | Admin's team | `team install` from invite URL |
| Member's new machine | Same team | New invite, same flow |
| Viewer (no CLI) | — | Doesn't get an install. Just signs into the team-hosted web URL |

There is no other path. Every CLI install on every machine traces back to
either (a) an explicit `team setup` invocation by the admin or (b) a
`team install` consuming a signed invite token. Audit trail intact.

---

## 9. The full file/code delta

Aggregating Phases 1-3 (Phase 4 is per-PR):

### New files
- `apps/web-v2/middleware.ts` (rewrite)
- `apps/web-v2/lib/deployment-mode.ts`
- `apps/web-v2/lib/clerk-appearance.ts`
- `apps/web-v2/lib/org-guard.ts`
- `apps/web-v2/lib/invite-token.ts`
- `apps/web-v2/lib/queries/invites.ts`
- `apps/web-v2/lib/actions/invite.ts`
- `apps/web-v2/lib/actions/revoke-invite.ts`
- `apps/web-v2/app/auth/sign-in/[[...sign-in]]/page.tsx`
- `apps/web-v2/app/auth/sign-up/[[...sign-up]]/page.tsx`
- `apps/web-v2/app/forbidden/page.tsx`
- `apps/web-v2/app/api/healthz/route.ts`
- `apps/web-v2/app/api/install/[token]/route.ts`
- `apps/web-v2/app/api/install/validate/[token]/route.ts`
- `apps/web-v2/app/install/[token]/page.tsx`
- `apps/web-v2/app/install/[token]/cli.sh/route.ts`
- `apps/web-v2/app/settings/account/page.tsx`
- `apps/web-v2/app/settings/team/invite/page.tsx`
- `apps/web-v2/Dockerfile`
- `apps/web-v2/vercel.json`
- `apps/web-v2/fly.toml`
- `packages/db/drizzle/postgres/00XX_team_invites.sql`
- `packages/db/drizzle/sqlite/00XX_team_invites.sql`
- `packages/cli/src/commands/team-install.ts`

### Modified files
- `apps/web-v2/package.json` (add `@clerk/nextjs`)
- `apps/web-v2/app/layout.tsx` (wrap with ClerkProvider in team-hosted)
- `apps/web-v2/lib/auth.ts` (real getActor)
- `apps/web-v2/lib/db.ts` (env-only path)
- `apps/web-v2/lib/queries/{decisions,all-context-packs,runs,projects,policies}.ts` (org-scope)
- `apps/web-v2/lib/actions/{policies,kill-switches,packs,projects,runs,sync,services,init,onboarding,team-join}.ts` (RBAC + team-hosted refusals)
- `apps/web-v2/app/settings/team/page.tsx` (invite card + pending list)
- `packages/db/src/schema/{sqlite,postgres}.ts` (team_invites table)
- `packages/cli/src/program.ts` (register team-install command)

Total: 24 new files, 11 modified. Roughly 4 days end-to-end.

---

## 10. Test plan

### Unit
- `getActor` per mode (3 cases)
- `parseClerkRole` mapping
- `requireOrgMatch` redirect
- `mintInviteToken` + `verifyInviteToken` round-trip
- Each RBAC-gated action with all 3 roles

### Integration
- Boot web-v2 with `COODRA_DEPLOYMENT=team-hosted` against testcontainers Postgres + a Clerk-test-mode app
- Generate invite, redeem invite, assert `team_invites.used_at` is set
- Two-user concurrent edit on policies (admin + member) — member rejected

### E2E
- Playwright/MCP browser test: sign in via Clerk test mode, click /decisions, see seeded data, sign out
- One-line installer test: spawn a Docker container, run `curl ... | sh`, assert Coodra CLI is on PATH and config.json was written

---

## 11. Rollout

### Step 0 — merge plan + acceptance criteria (this doc)
### Step 1 — Phase 1 lands behind a feature flag (`COODRA_DEPLOYMENT`)
- Local-solo + local-team users see no change
- Team-hosted only when explicitly opted in
### Step 2 — admin tests against their own deployment
### Step 3 — Phase 2 (invites) lands
### Step 4 — Phase 3 (deploy templates) lands
### Step 5 — admin invites first viewer/member via the new path
### Step 6 — Phase 4 polish lands as PRs

### Backward compatibility
The existing per-developer-local pattern continues to work without any
changes. `COODRA_DEPLOYMENT` defaults to absent, which means web-v2
keeps reading `~/.coodra/config.json`. No breakage.

---

## 12. Open questions for you to answer before we cut

1. **Email delivery for invites** — Clerk has `clerkClient.invitations.createInvitation` which sends the email through Clerk's infrastructure. Do you want to use that (zero-config but Clerk-branded), or BYO email provider (Resend / SendGrid)?
2. **Invite expiry default** — 7 days reasonable? Common choices are 24h (security) or 30 days (convenience).
3. **Single CLI binary or `npm i -g`** — for the one-line installer, do we ship a static binary or rely on Node being present? Static binary is cleaner UX but more build engineering.
4. **First-class self-host docs** — ship a `docs/deployment/{vercel,fly,docker}.md` set as part of Phase 3, or defer?
5. **Clerk roles vs custom permissions** — Tier 2.5 from ADR-014 (admin/member/viewer) is what we have. Is that sufficient for your foreseeable use, or do you want me to design a Tier 3 (custom roles + permission matrix)?

---

## 13. The single sentence

After Phases 1-3 ship: **the admin clicks "Deploy to Vercel" once, then
clicks "Invite teammate" for each teammate, and every other person on the
team — developer or not — gets in with one click and zero copy-paste.**
