# Phase G — End-to-End Test Guide

> Supersedes `phase-f-e2e-test-guide.md`. Phase G's identity unification
> makes the prior three-mode (local-solo / local-team / team-hosted) UX
> obsolete — what you test now is the binary `solo | team` model with a
> Clerk-verified JWT as the single source of identity.
>
> **Estimated time:** ~35 minutes interactive (browser pauses included)
> or ~10 minutes with Playwright automation of the Clerk sign-in step.
>
> **Prerequisites:**
> - Postgres reachable at `DATABASE_URL` with migrations 0015-0018 applied
> - Clerk app configured with a `coodra_cli` JWT template (24h TTL,
>   includes `org_id` + `org_role` + `email` claims)
> - `COODRA_INVITE_HMAC_SECRET` set in the web's env (≥ 32 bytes hex)
> - `COODRA_EXPECTED_ORG_ID` matches the team's Clerk org_id
> - The CLI bundle is built (`pnpm --filter @coodra/cli build`)
> - Two test accounts in Clerk: an admin and a basic_member, both in
>   the same org

---

## Three-act walkthrough

The canonical test exercises the entire product lifecycle: solo →
admin team → teammate joining → role flips → mode toggle. The 12
phases are gated by `__tests__/functional/00-full-flow.sh` which is
the **acceptance gate** for shipping Phase G.

### Act 1 — Solo developer (~5 min)

```bash
# Fresh laptop: pretend ~/.coodra doesn't exist
export COODRA_HOME=/tmp/phase-g-solo
mkdir -p /tmp/phase-g-solo

mkdir -p /tmp/phase-g-solo-proj && cd /tmp/phase-g-solo-proj
coodra init                     # solo mode, no Clerk
coodra start
coodra feature add greet --description "Greet a person by name"
```

**What to verify:**
- `~/.coodra/config.json` has `"mode": "solo"`, no `team` block, no
  `clerk-token.json` file alongside it
- Web at http://localhost:3001 returns 200 with no Clerk redirect
- The `features` page shows `greet`
- MCP `list_features` returns `greet` (Claude Code or curl)
- Local SQLite `runs` rows have `created_by_user_id = NULL`

### Act 2 — Solo → team init (admin) (~10 min)

```bash
coodra team init                # opens browser wizard
                                   # admin signs into Clerk
                                   # picks/creates an org
                                   # provides Postgres URL
                                   # writes everything
# After completion:
coodra login                    # browser handoff captures JWT
                                   # writes ~/.coodra/clerk-token.json
coodra start                    # restarts daemons in team mode
```

**What to verify:**
- `~/.coodra/clerk-token.json` exists, mode 0600
- `coodra org status` prints email + org + role = admin
- Web at http://localhost:3001 redirects to `/auth/sign-in` (unauthed)
- Sign in via browser → web renders admin UI
- CLI writes (`feature add`, `pack publish`) stamp with admin's
  clerkUserId — verify via cloud Postgres:
  ```sql
  SELECT created_by_user_id, slug FROM features WHERE slug = 'caching-strategy';
  ```
  Should show admin's `user_…` id, NOT `__solo__`.
- Open Claude Code, prompt to "record a decision: use pnpm 9".
  Verify cloud `decisions` row has admin's clerkUserId.

### Act 3 — Teammate joins (~10 min)

Admin side:
1. Open `/settings/team` in the web
2. Click "Invite", enter `teammate@your-test-domain.com`, role=member
3. Copy the invite URL

Teammate side (simulated via isolated `COODRA_HOME`):
```bash
export COODRA_HOME=/tmp/phase-g-teammate
mkdir -p /tmp/phase-g-teammate
mkdir -p /tmp/phase-g-teammate-proj && cd /tmp/phase-g-teammate-proj

coodra team join '<the-invite-url>'
# Browser opens at /install/<token>
# Sign in as teammate@your-test-domain.com (Clerk's hosted UI)
# After sign-in, CLI captures the JWT, fetches install bundle,
# writes config.json + .env + clerk-token.json
# Daemons start
```

**What to verify:**
- `/tmp/phase-g-teammate/clerk-token.json` exists; `claimsMirror.email`
  matches the invited email
- `/tmp/phase-g-teammate/clerk-token.json::claimsMirror.userId` is
  DIFFERENT from admin's clerkUserId
- Cloud `team_invites` row marked `used_at` + `used_by_user_id` =
  teammate's clerkUserId
- Re-running the same invite URL → "already_redeemed" error (jti
  single-use)
- Teammate's CLI `feature add caching-strategy` writes a row in cloud
  with `created_by_user_id` = teammate's clerkUserId
- Switch back to admin's `COODRA_HOME`, open web `/features` →
  both admin's `ship-checklist` AND teammate's `caching-strategy`
  appear, correctly attributed

---

## Per-role + per-mode UX matrix

Run a quick sanity check across every role × mode combination:

| Mode | Role | CLI `feature add` | Web "Publish" button | MCP `record_decision` |
|---|---|---|---|---|
| solo | n/a | ✓ stamps __solo__ | not applicable (no UI) | ✓ stamps __solo__ |
| team / admin | admin | ✓ stamps admin | ✓ visible + works | ✓ stamps admin |
| team / member | member | ✓ stamps member | ✘ button hidden, server action 403s | ✓ stamps member |
| team / viewer | viewer | ✘ refused via Tier 2.5 RBAC | ✘ button hidden | ✘ refused |

**How to test the role flip:**
1. Admin opens Clerk dashboard, demotes teammate to viewer
2. Teammate's next CLI write → refused with `auth_required` /
   role-too-low error
3. Web request from teammate → 403 + redirect to `/forbidden?reason=insufficient_role`
4. Cache TTL is 30s — wait 30s for the role refresh to land

---

## Known Phase G limitations

These are **acknowledged-but-deferred** work items for Phase G+1 / H:

1. **`feature_packs.org_id` is nullable.** Phase G adds the column +
   partial unique index but doesn't backfill or tighten the legacy
   `UNIQUE(slug)`. Phase G+1 will backfill NULL → `__legacy__` and
   replace the unique constraint.

2. **MCP server still falls back to `config.json::team` for identity
   reads (not writes).** Read-only paths (`getActorIdentity`) prefer
   the verified Clerk JWT but degrade to legacy config when no token
   exists. Mutating writes (`requireActorIdentityForTeamMode`) REQUIRE
   the verified JWT in team mode.

3. **The bridge reads `claimsMirror` from clerk-token.json without
   re-verifying the JWT signature on every event.** The mirror was
   verified at write-time (`writeToken` in shared/auth). File-system
   permissions (0600) are the trust boundary for same-machine usage.
   Per-event verification is overkill for the hot path.

4. **Cross-org access via direct URLs is not yet blocked.** Phase G's
   `feature_packs.org_id` is the foundation; Phase G+1 adds the WHERE
   filters in sync-daemon + web queries.

5. **`coodra org switch` is browser-mediated only.** The user
   picks the target org in Clerk's UI. There's no `--org=<slug>`
   non-interactive switch (Clerk doesn't expose that for member-side
   org selection).

6. **No automatic `coodra login` prompt.** When a token expires,
   the CLI / MCP / bridge return `auth_required` soft-failures with
   the howToFix message. The user runs `coodra login` manually.

---

## Acceptance gate — `00-full-flow.sh`

```bash
pnpm test:functional   # runs every g*-*.sh in order, then 00-full-flow.sh
```

If you're testing manually, run the slice scripts individually first:
```bash
bash __tests__/functional/g1-token-store.sh
bash __tests__/functional/g3-cli-login.sh
# … etc
```

The integrated `00-full-flow.sh` runs 12 phases against real Clerk +
real Postgres. **All 12 phases must pass for Phase G to be shippable.**
Phase F's E2E guide remains useful for the underlying knowledge-layer
sync mechanics — re-run it alongside Phase G's guide to confirm no
regressions land.

---

## Recovery procedures

### "I'm stuck in a bad auth state"

```bash
coodra logout                # tear down team state
rm -f ~/.coodra/clerk-token.json   # safety net
coodra login                 # fresh login
```

### "The Clerk JWT template `coodra_cli` doesn't exist"

The `coodra login` flow surfaces this as a clear error. Resolution:

1. Open Clerk dashboard → Configure → JWT Templates → New
2. Name: `coodra_cli`
3. Token lifetime: 86400 seconds (24h)
4. Claims: include `org_id`, `org_role`, `email` (defaults from the
   session JWT)
5. Save + redeploy if needed
6. Re-run `coodra login`

### "Cloud Postgres rows have NULL created_by_user_id"

If you see NULL attribution after Phase G ships, the row was written
either by:
- The legacy MCP path (pre-Phase-G install with stale code)
- Solo mode (intentional — solo writes NULL)
- A daemon that started BEFORE `coodra login` (the daemon caches
  identity at boot; restart with `coodra stop && coodra start`)

The Phase G migration story: any laptop that had `config.json::team`
populated before upgrading needs to run `coodra login` once. The
on-disk identity migrates automatically — the verified JWT supersedes
the trusted-but-unverified config.json reads.
