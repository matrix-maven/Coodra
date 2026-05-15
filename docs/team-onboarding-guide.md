# Team Mode Onboarding Guide

> Real, end-to-end-verified runbook. Every command in this guide was executed
> against the user's actual Supabase + Clerk during the v2 onboarding test.
> Nothing here is theoretical.

This guide takes one **admin** through provisioning a brand-new team, recording
work, and inviting a teammate. Total time: ~5 minutes once you have your
Supabase + Clerk projects ready.

---

## What you'll need before you start

| Credential | Where to get it | What it does |
|---|---|---|
| **Supabase Postgres URL** | `supabase.com/dashboard` → your project → Settings → Database → **Connection string** → Session pooler (port 5432) | The cloud DB everyone's local SQLite syncs to. Each row carries `created_by_user_id` so reading the table answers "who decided what". |
| **Clerk Publishable Key** | `dashboard.clerk.com` → your app → API Keys → **NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY** | The web app's React tree uses this on the client to start sign-in flows; the daemons' env validators also check for the unprefixed copy. |
| **Clerk Secret Key** | same panel → **CLERK_SECRET_KEY** | The web app's server actions use this to verify Clerk JWTs before reading/writing org-scoped rows. |
| **Your Clerk user id** | Sign in to your Clerk app once → user profile (`user_…`) | Stamped on every write you make so the team UI can show "decided by you" / "decided by Alice". |
| **Your Clerk org id** | After enabling Organizations in Clerk, create an org → `org_…` | Scopes everything. Rows with this `org_id` are visible to teammates with the same `org_id`. |

You do **not** need to provide:
- A separate "Coodra account" — there is none. We don't host an account system.
- A paid Supabase or Clerk tier — free is fine for a small team.
- Any keys Coodra-managed — the only secret we generate is the local hook secret, automatically, during `team setup`.

---

## Phase 1 · Admin runs `team setup`

**Where:** in your terminal, anywhere on your machine.

```bash
coodra team setup \
  --database-url 'postgresql://postgres.PROJECT_REF:YOUR_PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres' \
  --user-id 'user_2nKjYourClerkUserId' \
  --org-id 'org_2nKjYourClerkOrgId' \
  --org-slug 'your-team-slug'
```

What it does, in order:

1. Verifies `SELECT 1` against the URL.
2. Runs `CREATE EXTENSION IF NOT EXISTS vector` (pgvector for context-pack search).
3. Applies all 13 Drizzle migrations (creates 14 tables — 12 audit + 2 migration metadata).
4. Verifies the schema (counts the tables it expects).
5. Generates a 32-byte random `localHookSecret`.
6. Writes `~/.coodra/config.json::team` block.
7. Writes `~/.coodra/.env` with `COODRA_MODE=team`, `DATABASE_URL`, `LOCAL_HOOK_SECRET`, `COODRA_TEAM_ORG_ID`.
8. Prints the four credentials your teammates need.

Successful output ends with:

```
────────  share these credentials with your teammates  ────────
  database url        postgresql://...:5432/postgres
  clerk org id        org_...
  local hook secret   <64-char hex>
───────────────────────────────────────────────────────────────
```

**Save the `local hook secret` somewhere durable.** Re-running `team setup` against the same DB rotates it. Anyone with `(URL, secret)` can write to your team Postgres.

## Phase 2 · Admin appends Clerk keys to `~/.coodra/.env`

Step 1's CLI doesn't touch Clerk credentials. You append them manually so the
MCP server, Hooks Bridge, and web app all see them at boot:

```bash
cat >> ~/.coodra/.env <<'EOF'
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_…
CLERK_PUBLISHABLE_KEY=pk_live_…
CLERK_SECRET_KEY=sk_live_…
EOF
```

> Both `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and **`CLERK_PUBLISHABLE_KEY`** lines are required.
> The first goes to the browser bundle; the second is what the MCP server's Zod env validator looks for.
> Skipping the unprefixed one crashes `coodra start` with `CLERK_PUBLISHABLE_KEY required when CLERK_SECRET_KEY is set`.
> *(Verified during the v2 onboarding test — Bob's daemons wouldn't boot until I added this line.)*

## Phase 3 · Admin runs `init` in their first repo

**Where:** `cd` into the repo you want Coodra to track. *(Important — running from a different cwd registers Coodra against whatever `.coodra.json` is in that directory.)*

```bash
cd ~/projects/my-app
coodra init --project-slug my-app --ide claude --no-graphify
```

This (a) registers the project in your local SQLite, (b) seeds the 25-rule
default policy chain, (c) scaffolds `docs/feature-packs/<slug>/`, (d) wires
Claude Code hook entries in `~/.claude/settings.json`, (e) enqueues a
`sync_to_cloud` job for the project.

## Phase 4 · Admin runs `start`

**Still inside the repo dir.**

```bash
coodra start
```

Spins up three daemons via launchd (macOS) or systemd (Linux) or fallback
process supervisor:

- **MCP Server** on `127.0.0.1:3100` — agents (Claude Code, Cursor, Windsurf) call its 26 tools.
- **Hooks Bridge** on `127.0.0.1:3101` — fires SessionStart / PostToolUse / SessionEnd policy + audit work.
- **Sync Daemon** — drains `pending_jobs` to cloud + pulls teammates' rows from cloud every ~10 s.

Verify with `coodra status`. All three should be `running` and `Mode` should be `team`.

## Phase 5 · Admin opens Claude Code and works

```bash
# Inside the repo:
claude
```

Claude Code reads `.mcp.json`, spawns the bundled MCP server in stdio mode, and
calls `record_decision`, `save_context_pack`, `query_decisions`, etc. as you
work. Each write lands in **local SQLite first** (sub-millisecond) and is then
mirrored to your Supabase Postgres by the sync daemon. All writes carry your
`user_v2_test_admin` (the user_id you passed in Phase 1).

## Phase 6 · Admin opens the web app

**In a new terminal:**

```bash
cd ~/Coodra/apps/web-v2
export COODRA_HOME=$HOME/.coodra
export COODRA_MODE=team
# Source the env that ~/.coodra/.env already has so the dev server sees it:
set -a; source ~/.coodra/.env; set +a
pnpm dev
# Open http://localhost:3001
```

What you see:

- **`/`** — dashboard with a green "team mode · org_… · syncing every 10 s" banner. Stats include active runs, decisions in 24 h, narrative coverage.
- **`/welcome`** — mode picker. In team mode, shows a "team mode is already configured" pill at the top.
- **`/onboarding/team`** — the same five-step wizard you went through. Re-runnable to rotate the hook secret.
- **`/decisions`** — workspace-wide decisions browser with a **"Decided by"** column showing **You** for your own writes and `user_…` for teammates'.
- **`/context-packs`** — same shape for session recaps. Includes an `Authored by` column.
- **`/settings/team`** — your active team config (org id, joined-at, masked DB URL, hook-secret hint) + a **Members observed** table that lists every teammate the audit union has seen locally.

## Phase 7 · Invite a teammate

Share **(database URL, org_id, hook_secret, Clerk publishable, Clerk secret)** via 1Password / Bitwarden / Vault. They run on their own machine:

```bash
coodra team join \
  --user-id 'user_THEIR_clerk_user_id' \
  --org-id 'org_YOUR_org_id' \
  --secret '<the-hook-secret-you-shared>' \
  --database-url 'postgresql://...'
```

Then they append their own copy of the three Clerk env lines to `~/.coodra/.env`, run `coodra init` in their repo, and `coodra start`. Within ~10 s, **their sync daemon's team-rows-puller pulls all your existing decisions / packs / runs into their local SQLite**, and from then on every write either of you make is visible to the other within 10 s.

*(Verified during the v2 onboarding test — Bob's first puller tick at +2s pulled `projects=2 runs=2 decisions=1 run_events=18` from cloud.)*

---

## What's running on your machine right now (after this guide's verification)

| Service | Where | Mode |
|---|---|---|
| MCP Server | http://127.0.0.1:3100 | team |
| Hooks Bridge | http://127.0.0.1:3101 | team |
| Sync Daemon | (no port, queue worker) | team |
| Web app (dev) | http://127.0.0.1:3001 | team — admin view |

Test home directory: `~/coodra-test-v2-admin-home`
Test repo: `~/coodra-test-v2-admin`
Cloud project ref: `gyopozvfmggumidptmjr` (your Supabase)

Cloud state right now (verifiable with `psql` against your DATABASE_URL):

```
projects:        v2-admin-test (org_v2_test_team) + __global__
runs:            1 in_progress run for admin's session
decisions:       1 — "Use TypeScript strict-mode for v2 onboarding test" by user_v2_test_admin
policy_decisions: ~18 entries from the SessionStart policy check
```

---

## Common footguns we hit during the test

1. **Running `coodra start` from the wrong cwd.** If you `cd` somewhere outside your project, your `.env` layering picks up *that* directory's `.env`, which can clobber `COODRA_MODE=team`. Always `cd` into the project before running `start`.
2. **Forgetting the unprefixed `CLERK_PUBLISHABLE_KEY` line.** The wizard now shows both lines explicitly.
3. **Two admins on one machine for testing.** launchd labels are per-machine-singletons. To run admin + bob daemons concurrently, either: (a) run them on different machines (real-world), or (b) stop one before starting the other.
4. **Editing `~/.coodra/.env` while daemons are running.** Daemons read env at boot only. Run `coodra stop && coodra start` after any env edit.

---

## How to clean up the verification artifacts

If you want to reset the cloud back to empty + remove the test homes:

```bash
# Stop daemons
coodra stop

# Drop cloud schema
psql "$DATABASE_URL" -c "DROP SCHEMA IF EXISTS drizzle CASCADE; \
  DO \$\$ DECLARE r record; BEGIN \
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public') LOOP \
      EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE'; \
    END LOOP; END \$\$;"

# Remove the verification homes
rm -rf ~/coodra-test-v2-admin-home ~/coodra-test-v2-bob-home
rm -rf ~/coodra-test-v2-admin ~/coodra-test-v2-bob
```
