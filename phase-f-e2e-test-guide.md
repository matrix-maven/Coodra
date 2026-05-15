# Phase F — End-to-End Test Guide (verified 2026-05-11)

Every command in this guide was dry-run against the agent's setup. Two bugs
were found and fixed before writing the guide:
- `get_feature_pack` was pinned to the daemon's boot cwd; now resolves per-project cwd via `projects.cwd`.
- `coodra init` didn't write `meta.json::status='published'`; now does, so the bridge draft filter is consistent.

945 unit tests pass; workspace typecheck clean.

---

## Prerequisites (one-time, ~3 min)

### P1 — Apply the 3 cloud migrations

The agent isn't authorized to run psql against your Supabase. Run these
from the Coodra repo root:

```bash
cd ~/Coodra
source ~/.coodra/.env
psql "$DATABASE_URL" -f packages/db/drizzle/postgres/0015_features.sql
psql "$DATABASE_URL" -f packages/db/drizzle/postgres/0016_feature_packs_cloud_sync.sql
psql "$DATABASE_URL" -f packages/db/drizzle/postgres/0017_knowledge_audit.sql
```

Verify all three landed:

```bash
psql "$DATABASE_URL" -c "
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public' AND table_name
 IN ('features','feature_packs','knowledge_audit') ORDER BY table_name;
"
```

You should see 3 rows.

### P2 — Wipe cloud data (clean slate)

```bash
psql "$DATABASE_URL" <<'SQL'
TRUNCATE TABLE knowledge_audit, run_events, policy_decisions, decisions,
  context_packs, runs, kill_switches, run_diffs, team_invites,
  _migration_map, _migration_attempts CASCADE;
DELETE FROM features;
DELETE FROM feature_packs;
DELETE FROM projects WHERE id NOT IN ('__global__');
SQL
```

The truncate order matters because of FKs. The DELETE on projects skips
the `__global__` sentinel which other code expects to exist.

### P3 — Wipe local SQLite + restart daemons

```bash
cd ~/Coodra
node packages/cli/dist/index.js stop
rm -f ~/.coodra/data.db
node packages/cli/dist/index.js start
```

Output should end with `All Coodra services running.`. Verify the
local DB picked up all 15 migrations:

```bash
sqlite3 ~/.coodra/data.db "SELECT COUNT(*) FROM __drizzle_migrations;"
# expect 15
```

### P4 — Confirm web app is running

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/
# expect 307 (redirect to /auth/sign-in in team-hosted mode)
```

If 0 or connection refused:

```bash
cd ~/Coodra/apps/web-v2
pnpm dev &  # leave this running in a separate terminal
```

Web boots in ~3s.

---

## ACT 1 — Solo mode end-to-end (~10 min)

**Important:** the web app reflects the **machine's mode**
(`~/.coodra/config.json::mode`), NOT the project's org. To genuinely
test solo UI (no Clerk redirect, no team badge in the sidebar, solo
projects visible at /projects), the machine itself has to be flipped
to solo mode. We do that by moving the team config aside, restarting
daemons, then restoring at the end of Act 1.

### 1.1 — Flip the machine to solo mode

```bash
# Stop daemons so they release config
node ~/Coodra/packages/cli/dist/index.js stop

# Move team config aside (reversible — restored at the end of Act 1)
mv ~/.coodra/config.json ~/.coodra/config.json.team-bak
mv ~/.coodra/.env        ~/.coodra/.env.team-bak

# Wipe local DB for a clean solo start
rm -f ~/.coodra/data.db

# Start daemons fresh — they boot in solo mode when no config.json exists
node ~/Coodra/packages/cli/dist/index.js start
```

Verify the flip:

```bash
ls ~/.coodra/config.json 2>&1
# expect: "No such file or directory" — daemons treat absence as solo

curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/
# expect: 200 (no Clerk redirect)
```

### 1.2 — Create the solo project

```bash
mkdir -p ~/demos/solo-app
cd ~/demos/solo-app
git init -q  # any project root marker works: .git, package.json, pyproject.toml, Cargo.toml
node ~/Coodra/packages/cli/dist/index.js init \
  --project-slug solo-app \
  --template generic \
  --feature-pack template \
  --no-graphify \
  --ide claude
```

The output should end with `Coodra is ready (project 'solo-app').`.

Verify:

```bash
sqlite3 ~/.coodra/data.db \
  "SELECT slug, org_id, cwd FROM projects WHERE slug='solo-app';"
# expect: solo-app|__solo__|/Users/<you>/demos/solo-app
```

### 1.3 — Open the web app (now in solo mode)

Open: **http://localhost:3001/**

What you should see (versus team mode):

- Sidebar header: `LOCAL WORKSPACE · solo` (no `TEAM` badge)
- No Clerk sign-in redirect
- `Members + org` nav entry hidden
- `/projects` page: `solo-app` row visible with org `__solo__`

Click through to verify:

- **http://localhost:3001/packs** — `solo-app` pack listed with badges `SYNCED · PUBLISHED`
- **http://localhost:3001/features** — empty for now

### 1.4 — Add a feature via CLI

```bash
cd ~/demos/solo-app
node ~/Coodra/packages/cli/dist/index.js feature add greet \
  --description "Use this when the user asks for a friendly hello — covers tone, casual examples, and the project brand voice." \
  --maturity stable
```

Expected output (last 3 lines):

```
✓ Created feature "greet" at /Users/<you>/demos/solo-app/docs/features/greet/feature.md
✓ Index regenerated (1 feature total)
· Local DB mirror updated (team-mode sync skipped — local-only project org).
```

Reload **http://localhost:3001/features** — the `greet` row appears with
`PUBLISHED · stable` badges. The description renders below.

### 1.5 — Run a real Claude Code session

```bash
cd ~/demos/solo-app
claude
```

Inside Claude Code, paste:

```
What MCP tools do you have available? Then call coodra__get_feature_pack
for projectSlug "solo-app" and tell me what the spec.md says.
```

The agent will:
1. Read the additionalContext (the spec/impl/techstack injected at SessionStart)
2. Call `coodra__get_feature_pack({projectSlug:"solo-app"})` — should return the full pack body
3. Call `coodra__list_features({projectSlug:"solo-app"})` — should return `greet`

Then:

```
Record a decision: we'll use React Server Components for marketing pages.
Rationale: RSC streaming gives sub-100ms first-paint without client JS.
Alternatives considered: Astro and Next.js client components.

Then save a context pack titled "Marketing pages RSC decision" summarising
this exchange.
```

The agent calls:
- `coodra__record_decision` — writes a row to `decisions`
- `coodra__save_context_pack` — writes a row to `context_packs`

Close Claude Code (`/exit` or Ctrl-D).

### 1.6 — Verify in web app

- **http://localhost:3001/decisions** — the RSC decision shows. Click it: full description + rationale + alternatives + you as author
- **http://localhost:3001/context-packs** — the marketing pack shows. Click it: full markdown renders
- **http://localhost:3001/runs** — one run row for the Claude Code session

### 1.7 — Test the draft filter

Go to **http://localhost:3001/packs/solo-app**. You should see two badges:
`ACTIVE` and `PUBLISHED`. Next to `Regenerate` there's a `Move to draft` button.

Click `Move to draft`. Banner confirms: "Pack status flipped → draft."

Verify the on-disk meta was patched too:

```bash
grep status ~/demos/solo-app/docs/feature-packs/solo-app/meta.json
# expect: "status": "draft",
```

Open a fresh Claude Code session in `~/demos/solo-app`:

```bash
cd ~/demos/solo-app
claude
```

Watch the bridge log in another terminal:

```bash
tail -f ~/.coodra/logs/hooks-bridge.log | grep -i feature_pack
```

You should see `feature_pack_skipped_draft` and NO `feature_pack_injected_via_additional_context`. The agent's `additionalContext` no longer contains spec/impl/techstack.

Inside Claude Code:

```
Call coodra__get_feature_pack for projectSlug "solo-app".
```

Expected: returns `{ ok: false, error: "pack_not_found", howToFix: ... }` —
the draft filter masks it.

Close Claude. Web: click `Publish`. Banner: "Pack status flipped → published." Reopen Claude Code — pack returns.

### Act 1 pass criteria

- [ ] Machine flipped to solo mode (config.json absent, web no Clerk redirect)
- [ ] CLI init created the project + 4 pack files + DB row
- [ ] CLI feature add wrote FS + DB row, web /features renders it
- [ ] Claude Code SessionStart injected pack into agent context
- [ ] MCP tools fired: get_feature_pack, list_features, record_decision, save_context_pack
- [ ] Web /decisions and /context-packs render the new rows
- [ ] Pack toggled to draft → bridge skips injection → agent can't see it
- [ ] Pack toggled back to published → agent sees it again

### 1.8 — Restore team mode (REQUIRED before Act 2)

```bash
# Stop solo daemons
node ~/Coodra/packages/cli/dist/index.js stop

# Restore the team config you set aside in step 1.1
mv ~/.coodra/config.json.team-bak ~/.coodra/config.json
mv ~/.coodra/.env.team-bak        ~/.coodra/.env

# Wipe the SQLite trio (data.db + WAL + SHM together — leaving stale
# WAL/SHM files alongside a fresh data.db triggers "disk I/O error")
rm -f ~/.coodra/data.db ~/.coodra/data.db-shm ~/.coodra/data.db-wal

# Sanity check the .env has Clerk keys (team mode refuses to boot without them)
grep -E "^CLERK_(SECRET|PUBLISHABLE)_KEY=" ~/.coodra/.env || cat <<'NOTE'
  ⚠ .env is missing CLERK keys. Copy them from apps/web-v2/.env.local:
  grep -E "^CLERK_(SECRET|PUBLISHABLE)_KEY=" ~/Coodra/apps/web-v2/.env.local >> ~/.coodra/.env
NOTE

# Restart daemons in team mode
node ~/Coodra/packages/cli/dist/index.js start
```

Verify:

```bash
cat ~/.coodra/config.json | head -3
# expect: "mode": "team", ...

curl -s http://localhost:3101/healthz
# expect: {"ok":true,"service":"hooks-bridge","mode":"team",...}

# Web app — restart in LOCAL-TEAM mode (NOT team-hosted!) in another terminal.
# Why local-team: team-hosted is for remote-server deployments and refuses
# every local-write action (uploadPackAction, regeneratePackAction, etc.)
# because a deployment server has no ~/.coodra/. On a single dev laptop
# you want local-team — Clerk identity comes from config.json, writes are
# allowed, sync-daemon pushes to cloud.
pkill -f "next dev --port 3001"; sleep 2
cd ~/Coodra/apps/web-v2 && env -i HOME="$HOME" PATH="$PATH" pnpm dev &

sleep 5 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/
# expect: 200 (no Clerk redirect — local-team reads identity from config.json directly)
```

---

## ACT 2 — Team admin (~12 min)

**This Act uses your existing team-mode setup that you just restored.**

### 2.1 — Confirm team mode is active

```bash
cat ~/.coodra/config.json | head -8
# expect: "mode": "team", with clerkUserId + clerkOrgId
```

If you want to test the wizard from scratch:

```bash
node ~/Coodra/packages/cli/dist/index.js stop
rm ~/.coodra/config.json ~/.coodra/.env  # WARNING: this clears team setup
rm -f ~/.coodra/data.db
node ~/Coodra/packages/cli/dist/index.js team init
# follow the 3-step wizard (Postgres → Clerk → Local)
```

Or skip and use the existing setup. Either way, daemons are running team-mode.

### 2.2 — Initialize a team project

```bash
mkdir -p ~/demos/team-app
cd ~/demos/team-app
git init -q
node ~/Coodra/packages/cli/dist/index.js init \
  --project-slug team-app \
  --template generic \
  --feature-pack template \
  --no-graphify \
  --ide claude
```

(No `COODRA_MODE=solo` this time — picks up the machine's team mode.)

Verify:

```bash
sqlite3 ~/.coodra/data.db \
  "SELECT slug, org_id, cwd FROM projects WHERE slug='team-app';"
# org_id should be org_<your-clerk-org-id> — NOT __solo__
```

Wait ~10s for the sync-daemon to push to cloud:

```bash
psql "$DATABASE_URL" \
  -c "SELECT slug, org_id FROM projects WHERE slug='team-app';"
# expect one row with your org_id
```

### 2.3 — Upload a feature pack via web

Open **http://localhost:3001/packs/new** in your browser.

Fill in:

- **Slug:** `auth-module`
- **Body:** paste this markdown:

```markdown
# Auth module

We use Clerk JWTs for authentication. Phase 4 layers Tier 2.5 RBAC on top:
admin / member / viewer. The hot path for actor resolution is
`apps/web-v2/lib/auth.ts::getActor`.

## Hot files

- `apps/web-v2/lib/auth.ts` — actor resolution
- `apps/web-v2/middleware.ts` — Clerk session check
- `packages/shared/src/auth/roles.ts` — Tier 2.5 RBAC helpers
```

Click **Upload pack**. You're redirected to `/packs/auth-module`.

Watch the sync push:

```bash
tail -f ~/.coodra/logs/sync-daemon.log | grep -E 'sync_feature_packs_pushed|sync_dispatch_threw'
```

Within ~1s: `sync_feature_packs_pushed` event.

Verify cloud:

```bash
psql "$DATABASE_URL" \
  -c "SELECT slug, status, length(content_json) AS bytes FROM feature_packs WHERE slug='auth-module';"
# expect: auth-module|published|<a few hundred bytes>
```

### 2.4 — Add a feature via CLI (team mode)

```bash
cd ~/demos/team-app
node ~/Coodra/packages/cli/dist/index.js feature add ship-checklist \
  --description "Use this whenever the user wants to ship: pre-flight checks, rollout, rollback criteria." \
  --maturity beta
```

Expected last lines:

```
✓ Created feature "ship-checklist" at ...
✓ Index regenerated (1 feature total)
✓ Queued for cloud sync (team mode) — teammates will pull within ~10s.
```

Verify cloud (~10s wait):

```bash
psql "$DATABASE_URL" \
  -c "SELECT slug, status, length(body) AS body_bytes, created_by_user_id FROM features WHERE slug='ship-checklist';"
```

You should see your Clerk user_id as `created_by_user_id`.

### 2.5 — Run Claude Code as admin

```bash
cd ~/demos/team-app
claude
```

Paste:

```
List the feature packs and features available in this project. Then show
me the auth-module pack content.
```

Then:

```
Record a decision: standardise on pnpm 9 across all workspaces.
Rationale: lockfile reproducibility + workspace protocol support.
Alternatives: npm, yarn berry.

Save a context pack titled "pnpm 9 standardisation" with what we discussed.
```

Close Claude.

### 2.6 — Verify in web (admin sees everything)

Visit:

- **http://localhost:3001/decisions** — the pnpm decision attributed to you by name (Clerk display name)
- **http://localhost:3001/context-packs** — the pnpm pack
- **http://localhost:3001/packs** — `team-app` and `auth-module` both PUBLISHED
- **http://localhost:3001/features** — `ship-checklist` PUBLISHED, attributed to you
- **http://localhost:3001/packs/auth-module** — you see `Regenerate`, `Move to draft`, and `Delete pack` buttons (admin)

### 2.7 — Generate an invite for the teammate

Open **http://localhost:3001/settings/team**. You see your own member row.

Click **Invite teammate** (or the equivalent button). Fill in:

- **Email:** any second email you can sign in with — gmail aliases work great: `abishaioff+teammate@gmail.com`
- **Role:** `member` (we'll test viewer later)

Click **Generate invite**. Copy the install URL — it looks like:

```
http://localhost:3001/install/<base64-token>
```

**Don't redeem yet** — keep this URL handy for Act 3.

### Act 2 pass criteria

- [ ] Team-mode project registered with real Clerk org_id
- [ ] Web pack upload landed in cloud Postgres
- [ ] CLI feature add synced to cloud within 10s
- [ ] Claude Code: decisions + context packs landed in cloud
- [ ] All web pages render with your name as author
- [ ] Invite URL generated

---

## ACT 3 — Teammate joins (~10 min)

**Goal:** prove a fresh teammate gets the admin's full context with zero
manual work, and the RBAC gating actually shows up in the UI.

### 3.1 — Isolate the teammate's state

We simulate a second machine via `COODRA_HOME` so we don't blow away
your admin setup:

```bash
export COODRA_HOME=~/demos/teammate-home
mkdir -p "$COODRA_HOME"
echo "teammate home: $COODRA_HOME"
```

**Keep this terminal open for all Act 3 steps** — every command in Act 3
relies on `COODRA_HOME` being set.

### 3.2 — Redeem the invite

Open the invite URL from step 2.7 in an **incognito** browser window:

```
http://localhost:3001/install/<base64-token>
```

You'll be asked to sign in with the invited email. Sign up + verify if
needed. The page then renders a `curl ... | bash` command. **Copy it.**

Paste into the teammate terminal (the one with `COODRA_HOME` set):

```bash
# Example — substitute your actual command
curl -fsSL "http://localhost:3001/api/install/<token>/cli.sh" | bash
```

This will:

1. POST to redeem the token
2. Write `$COODRA_HOME/config.json` + `.env` with team settings
3. Start daemons in team mode (on different ports? — actually same ports, but the launchd plist re-targets `COODRA_HOME` via env)

**IMPORTANT — port conflict:** since the daemons share ports 3100/3101/3001
with the admin's daemons, only ONE set runs at a time. The install script
will stop the admin's daemons first.

Verify:

```bash
cat "$COODRA_HOME/config.json" | head -8
# mode: "team", team.clerkUserId: user_<DIFFERENT from admin>
sqlite3 "$COODRA_HOME/data.db" "SELECT COUNT(*) FROM projects;"
# expect 0+ depending on how puller did
```

### 3.3 — Watch the puller catch up

```bash
tail -f "$COODRA_HOME/logs/sync-daemon.log" | grep team_rows_pulled
```

Within 10s you should see:

```
team_rows_pulled projects=1 runs=N decisions=M contextPacks=K
                 runEvents=J features=1 featurePacks=1
```

Then verify the teammate's local SQLite has the admin's data:

```bash
sqlite3 "$COODRA_HOME/data.db" "SELECT slug FROM features;"
# ship-checklist
sqlite3 "$COODRA_HOME/data.db" "SELECT slug, status FROM feature_packs;"
# auth-module|published
sqlite3 "$COODRA_HOME/data.db" "SELECT count(*) AS decisions FROM decisions;"
sqlite3 "$COODRA_HOME/data.db" "SELECT count(*) AS context_packs FROM context_packs;"
```

### 3.4 — Verify the pack landed on the teammate's disk

The puller writes pack files to the first registered non-sentinel
project's cwd. For this test you need the team-app dir to exist on the
teammate's "machine":

```bash
# Simulate the teammate cloning the repo
mkdir -p ~/demos/team-app
cd ~/demos/team-app

# Register the project under the teammate's COODRA_HOME
[ ! -f .coodra.json ] && echo '{"projectSlug":"team-app"}' > .coodra.json
[ ! -f package.json ]   && echo '{"name":"team-app"}'        > package.json

# The puller writes packs into <projects.cwd>/docs/feature-packs/.
# Refresh the cwd in the local DB:
sqlite3 "$COODRA_HOME/data.db" \
  "UPDATE projects SET cwd='$HOME/demos/team-app' WHERE slug='team-app';"
```

Wait 10s for the next puller tick, then:

```bash
ls ~/demos/team-app/docs/feature-packs/auth-module/
# spec.md  implementation.md  techstack.md  meta.json
cat ~/demos/team-app/docs/feature-packs/auth-module/meta.json | grep status
# "status": "published"
```

### 3.5 — Open the web app as the teammate (incognito browser)

You should still be signed in as the teammate user in the incognito
window. Go to **http://localhost:3001/packs**.

What to look for (member role):

- Top-right user badge: **You · member** (not admin)
- `+ Upload pack` button: **visible** (members CAN author)
- Listed packs: same as admin (you see everyone's published work)

Click into `/packs/auth-module`:

- `Regenerate` button: **visible** (members can author)
- `Move to draft` / `Publish` button: **HIDDEN** (admin-only)
- `Delete pack…` button: **HIDDEN** (admin-only)
- Top-right badges: `ACTIVE · PUBLISHED`

Click into `/features`:

- `ship-checklist` row visible
- `+ New feature (CLI)` hint visible (members can author)

### 3.6 — Teammate authors a feature (continuing admin's work)

In the teammate terminal:

```bash
export COODRA_HOME=~/demos/teammate-home  # if you opened a new shell
cd ~/demos/team-app
node ~/Coodra/packages/cli/dist/index.js feature add caching-strategy \
  --description "Use this when the user asks about Redis, BullMQ, or memoization patterns we agreed on." \
  --maturity beta
```

Expected:

```
✓ Created feature "caching-strategy"
✓ Index regenerated (2 features total)
✓ Queued for cloud sync (team mode) — teammates will pull within ~10s.
```

Verify cloud:

```bash
psql "$DATABASE_URL" -c "
SELECT slug, created_by_user_id FROM features
 WHERE slug IN ('ship-checklist','caching-strategy')
 ORDER BY slug;
"
# expect 2 rows with DIFFERENT created_by_user_id
```

### 3.7 — Teammate runs Claude Code (gets admin's context for free)

```bash
cd ~/demos/team-app
claude
```

Paste:

```
What decisions has the team recorded? What features are available?
Then summarise the auth-module pack.
```

The agent calls:
- `coodra__query_decisions` → returns admin's pnpm + RSC decisions
- `coodra__list_features` → returns BOTH ship-checklist (admin) and caching-strategy (you)
- `coodra__get_feature_pack({projectSlug:"team-app"})` → returns the team-app pack
- `coodra__get_feature_pack({projectSlug:"auth-module"})` → returns the auth-module pack (synced from cloud, written to disk by puller in 3.4)

Close Claude.

### 3.8 — Admin verifies teammate's work

Switch back to the **admin browser** window (not incognito).

Reload **http://localhost:3001/features**. You see:

- `ship-checklist` — attributed to you
- `caching-strategy` — attributed to the teammate by name

Reload **http://localhost:3001/decisions** — you see any new decisions
the teammate recorded.

### 3.9 — Flip the teammate to viewer role (RBAC test)

In your **admin browser**: open Clerk Dashboard
(`https://dashboard.clerk.com/`), navigate to your org, find the teammate
member, and change their role to **viewer**.

Reload the teammate's incognito browser. Visit **http://localhost:3001/packs**:

- Top-right user badge: **You · viewer**
- `+ Upload pack` button: **HIDDEN** — replaced with a `Read-only · viewer role` pill

Visit **http://localhost:3001/packs/auth-module**:

- `Regenerate` button: **HIDDEN**
- `Move to draft` / `Publish`: **HIDDEN**
- `Delete pack…`: **HIDDEN**
- A `Read-only · viewer role` pill is shown in the action bar

Visit **http://localhost:3001/features**:

- The `+ New feature (CLI)` hint is replaced with `Read-only · viewer role`

### 3.10 — Restore the teammate's admin daemon (cleanup)

After testing, restore your admin setup:

```bash
# Stop the teammate's daemons
unset COODRA_HOME
node ~/Coodra/packages/cli/dist/index.js stop  # uses default COODRA_HOME=~/.coodra

# Start admin daemons
node ~/Coodra/packages/cli/dist/index.js start
```

### Act 3 pass criteria

- [ ] Invite redemption wrote $COODRA_HOME/config.json + started daemons
- [ ] Puller pulled admin's data into teammate's local SQLite within 10s
- [ ] Pack files materialised in teammate's docs/feature-packs/ after cwd registration
- [ ] Teammate's Claude Code session has admin's decisions + features + pack
- [ ] Teammate authored a new feature → admin sees it on /features
- [ ] Viewer role flip hid all write buttons + showed read-only pill

---

## Quick reference — what each role sees in the web

| Page / Element | Solo (= admin) | Admin | Member | Viewer |
|---|---|---|---|---|
| `/packs` — Upload button | ✓ | ✓ | ✓ | read-only pill |
| `/packs/[slug]` — Regenerate | ✓ | ✓ | ✓ | hidden |
| `/packs/[slug]` — Publish / Move to draft | ✓ | ✓ | hidden | hidden |
| `/packs/[slug]` — Delete pack | ✓ | ✓ | hidden | hidden |
| `/features` — New feature hint | ✓ | ✓ | ✓ | read-only pill |
| `/decisions`, `/context-packs`, `/runs` | ✓ read | ✓ read | ✓ read | ✓ read |

In Claude Code (the agent context layer), every role gets the same
read access — RBAC gates AUTHORING, never CONSUMING.

---

## Identity model (the canonical reference)

Coodra has three modes and three identity-resolution paths. Phase F.6+
(2026-05-12) unified them; here's the canonical model:

```
solo mode
  └─ SOLO_ACTOR everywhere (admin role, no Clerk, no roles)

team mode (whether web is local-team or team-hosted — same story)
  ├─ Web → identity AND role come from Clerk session cookie.
  │       Sign-in required on every visit. Sign-out actually works.
  ├─ CLI / MCP child / bridge → stamp `created_by_user_id` from
  │       `~/.coodra/config.json::team.clerkUserId`.
  │       All writes default to role='member' (NEVER admin).
  │       Admin operations (publish/demote, delete others') refuse
  │       and surface "this is an admin-only action — use the web".
  └─ The split: laptop tools = authoring, web = governance.
```

Pre-fix (the bug you hit), `local-team` mode hardcoded `role: 'admin'`
from config.json regardless of actual Clerk role. After:

- Both local-team and team-hosted require Clerk sign-in
- Sign-out clears your session everywhere
- Role flips when admin promotes/demotes you in the Clerk dashboard
- Browser cache no longer determines what you see — Clerk does

## Known limitations (acceptable for now)

Documented so you know the rough edges:

0. **team-hosted partial — pack upload + status toggle now work,
   regenerate/delete don't yet.** Phase F.6+ wired `uploadPackAction` and
   `togglePackStatusAction` to write to cloud Postgres directly when in
   `team-hosted` mode (cloud is the source of truth; every laptop's
   sync-daemon pulls + materializes .md files). Other actions still
   refuse (regenerate, delete, installTemplate) because they involve
   local shell-outs to the CLI. Roadmap: cloud-direct rewrites for the
   remaining actions, so a team-hosted web can be a full
   admin-from-anywhere surface.

1. **`feature_packs` has no `org_id` column** — for your single-Clerk-org test
   this doesn't matter. A second org would collide on the global `UNIQUE(slug)`.
   Future fix: add `org_id` + change to `UNIQUE(org_id, slug)`.

2. **Sync-daemon puller doesn't filter by active org** — single-org safe.
   Multi-org would cross-pollinate.

3. **`feature remove` doesn't delete the cloud row** — teammates would re-pull
   a deleted feature on the next tick. Future fix: tombstone column.

4. **`knowledge_audit` table is structural only** — no rows are written yet.
   The audit page (`/audit`) doesn't exist. The table exists for future use.

5. **Multi-project pack FS write** — puller picks the first registered
   project's cwd. If a teammate has 3 projects, only one gets the files.

6. **`togglePackStatusAction` doesn't delete FS files on demote** — by design.
   The bridge skips drafts via meta.json; the FS files stay so the admin can
   keep editing in their text editor.

---

## When something goes wrong

### Sync jobs stuck in `pending` with errors

```bash
sqlite3 ~/.coodra/data.db "
SELECT id, queue, status, attempts, substr(last_error, 1, 200)
 FROM pending_jobs WHERE queue='sync_to_cloud'
 ORDER BY created_at DESC LIMIT 5;
"
```

Most common cause: cloud migration missing. Re-run P1 / P2 from
prerequisites.

### Daemon not picking up code changes

```bash
cd ~/Coodra
pnpm --filter @coodra/cli build
node packages/cli/dist/index.js stop
node packages/cli/dist/index.js start
```

### `list_features` returns empty when you expect features

```bash
sqlite3 ~/.coodra/data.db \
  "SELECT slug, cwd FROM projects WHERE slug='<your-slug>';"
ls <that-cwd>/docs/features/
```

If `cwd` is null in the DB, re-run `coodra init` from the project root.
If the directory is missing files, that's the bug — file an issue.

### `get_feature_pack` returns `pack_not_found`

This used to be a bug (daemon's boot cwd was the only pack root). Fixed
2026-05-11. Now resolves per-project via `projects.cwd`. If it still
happens:

```bash
sqlite3 ~/.coodra/data.db \
  "SELECT slug, cwd FROM projects WHERE slug='<your-slug>';"
ls <that-cwd>/docs/feature-packs/<your-slug>/
# expect: spec.md  implementation.md  techstack.md  meta.json
```

### Web shows "no projects"

```bash
cat ~/.coodra/config.json
# mode must be "team" and the team block must have your real Clerk org id
```

If the config is wrong, re-run `coodra team init`.

### Doctor — runs 35+ health checks

```bash
node ~/Coodra/packages/cli/dist/index.js doctor
```

Use this any time something's off; it'll point at the broken layer.

---

## After the test

Wrap up by saving a context pack from inside Claude Code:

```
Save a context pack titled "Phase F end-to-end smoke test passed" with a
brief recap of what worked and what didn't.
```

This itself is a final acceptance test: the save_context_pack tool fires
correctly and the row lands in cloud Postgres tagged with your Clerk
user_id.
