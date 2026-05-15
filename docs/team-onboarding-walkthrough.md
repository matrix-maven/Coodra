# Team mode — manual onboarding walkthrough

This document walks you through onboarding Coodra team mode end-to-end as a real user would, from scratch. It's the verified sequence of commands the bug-hunt + smoke-test pass produced — every step has been executed against a real Supabase project.

If something goes wrong, every command surfaces a clear error with a `hint:` line. Don't stress. Worst case you `coodra team leave --yes` and start over.

---

## What you'll need

- macOS or Linux with **Node 22+** (`node --version`).
- A Supabase project (or any Postgres ≥ 16 with `vector` extension available — Neon / Railway / RDS-with-pgvector / self-hosted all work).
- Your Clerk **user id** and Clerk **organization id** (from the Clerk dashboard, format: `user_2abc...` / `org_2abc...`).
- The current Coodra CLI built locally OR `npm i -g @coodra/cli`.

This walkthrough builds locally (faster iteration than npm publish):

```bash
cd ~/Coodra
pnpm install
pnpm --filter @coodra/cli build
alias coodra="node $PWD/packages/cli/dist/index.js"   # for this shell only
coodra --version   # should print 0.1.0
```

(Once you ship via npm, replace this with `npm i -g @coodra/cli`.)

---

## Step 1 — Get your Supabase URL

1. Open [database.new](https://database.new) and create a project. Pick a region close to your team. Wait ~1 min for provisioning.
2. **Settings → Database → Connection string → URI**. It looks like:
   ```
   postgresql://postgres:[YOUR-PASSWORD]@db.abcdefgh.supabase.co:5432/postgres
   ```
3. Replace `[YOUR-PASSWORD]` with the password you set during creation. URL-encode special chars (`@` → `%40`, `:` → `%3A`).
4. Save it somewhere safe — you'll paste it shortly.

**Skip this step if you already did it once before** — running the smoke test against your existing project at `gyopozvfmggumidptmjr.supabase.co` worked. If you want a fresh project per teammate, repeat the steps above.

---

## Step 2 — Get your Clerk identifiers

1. Open [dashboard.clerk.com](https://dashboard.clerk.com).
2. Pick your application.
3. **Users tab** — copy your row's id (`user_2abc...`).
4. **Organizations tab** — create the team's organization (or use an existing one). Copy its id (`org_2abc...`).
5. (Optional) note its slug for nicer display, e.g. `acme-eng`.

---

## Step 3 — Run `coodra team setup` (admin, one-time)

This is the bootstrap. It validates connectivity, installs `pgvector`, applies the schema, and writes the credentials your teammates will need.

```bash
coodra team setup \
  --user-id 'user_2abc...' \
  --org-id 'org_2abc...' \
  --org-slug 'acme-eng' \
  --database-url 'postgresql://postgres:...@db.abcdefgh.supabase.co:5432/postgres'
```

Expected output:

```
coodra team setup — bootstrapping team Postgres at postgresql://postgres:***@db.abcdefgh.supabase.co:5432/postgres
  ▸ verifying connectivity (SELECT 1)...
  ✓ connectivity ok
  ▸ installing pgvector extension (CREATE EXTENSION IF NOT EXISTS vector)...
  ✓ pgvector ready
  ▸ applying schema migrations (Drizzle) — this can take 30-90s on remote Postgres targets...
  ✓ schema applied in 1s
  ▸ verifying schema (15 expected tables)...
  ✓ 14 tables present
  ✓ local config promoted to team mode (~/.coodra/config.json)
  ✓ ~/.coodra/.env updated (COODRA_MODE=team, DATABASE_URL, LOCAL_HOOK_SECRET)

────────  share these credentials with your teammates  ────────
  database url        postgresql://postgres:...@db.abcdefgh.supabase.co:5432/postgres
  clerk org id        org_2abc...
  local hook secret   <64-char hex>
───────────────────────────────────────────────────────────────

Each teammate runs:
  coodra team join \
    --user-id <their-clerk-user-id> \
    --org-id org_2abc... \
    --secret <64-char hex> \
    --database-url 'postgresql://...'
```

**Save this credentials block** — your teammates need the database URL + secret to run `team join` on their machines. Distribute via Bitwarden / 1Password / Vault. Anyone with both can write to your team Postgres.

### What this command did

- Verified connectivity (`SELECT 1`) — fast fail if URL is wrong.
- Installed pgvector (idempotent — no-op if already there).
- Applied 13 Drizzle migrations to your Postgres (idempotent on re-run).
- Verified 14 expected tables landed.
- Wrote `~/.coodra/config.json::team` (CLI's source of truth).
- Wrote `~/.coodra/.env` with `COODRA_MODE=team`, `DATABASE_URL`, `LOCAL_HOOK_SECRET`, `COODRA_TEAM_ORG_ID` so `coodra start` launches in team mode.

### If it fails

- **"missing user id / org id / database url"** → set them via `--flag` or via env vars `COODRA_TEAM_USER_ID`, `COODRA_TEAM_ORG_ID`, `DATABASE_URL`.
- **"SELECT 1 against the database threw"** → wrong password / unreachable host / firewall. Check the URL.
- **"CREATE EXTENSION vector threw"** → role lacks privileges. On Supabase, ensure you copied the connection string from Settings → Database (uses the `postgres` role which has the privilege). Or run `CREATE EXTENSION vector` manually in the Supabase SQL editor and re-run with `--skip-pgvector`.
- **"migration apply threw"** → rare; usually means a previous partial migration. Compare `__drizzle_migrations` rows in your Postgres against `packages/db/drizzle/postgres/meta/_journal.json`.

---

## Step 4 — Initialize your demo project

`team setup` configured your machine for team mode. Now you need to register a project so the agent has somewhere to write context.

```bash
mkdir ~/coodra-demo
cd ~/coodra-demo
git init
echo '# demo' > README.md
git add . && git commit -m 'init'

coodra init --project-slug demo-app
```

Expected output:

```
✓ Detected project root: /Users/<you>/coodra-demo
✓ Detected IDEs: claude, cursor, windsurf
✓ Resolved Coodra home: /Users/<you>/.coodra
✓ Applied migrations + seeded __global__ + registered project 'demo-app' (new id <uuid>)
✓ Seeded default policy with 25 baseline rules
✓ Resolved mcp-server runtime: bundled

  + .coodra.json (wrote projectSlug='demo-app')
  + .mcp.json (created baseline .mcp.json with coodra entry)
  + .env (created baseline .env)
  ! ~/.claude/settings.json (overwrote Coodra hook entries)
  + docs/feature-packs/demo-app/{meta.json,spec.md,implementation.md,techstack.md}

Coodra is ready (project 'demo-app').
  → Restart your IDE so it picks up .mcp.json.
  → Run `coodra doctor` to verify the install.
  → Run `coodra start` to launch the MCP server + Hooks Bridge daemons.
```

### What `init` wrote

- `.coodra.json` — pins the project slug.
- `.mcp.json` — Claude Code / Cursor / Windsurf use this to spawn the Coodra MCP server.
- `.env` — Clerk sentinels + `LOCAL_HOOK_SECRET` + ports. **Note**: `COODRA_MODE` is intentionally NOT in this file (per Phase 4 H5) — your `~/.coodra/.env::COODRA_MODE=team` from `team setup` governs.
- `~/.claude/settings.json` — wires Coodra hooks into Claude Code's hook events.
- `docs/feature-packs/demo-app/` — seed feature pack the agent reads at session start.

---

## Step 5 — Verify the install with `coodra doctor`

```bash
coodra doctor --full
```

Look for these key checks:

```
  check  3 data.db opens (sqlite-vec virtual table present)            green
  check  4 DB migrations are at head                                   green
  check 12 project registered                                          green
  check 24 cloud Postgres reachability                                 green
  check 25 sync_to_cloud queue depth                                   green
  check 26 sync lag                                                    yellow (cloud has no runs rows yet)
  check 27 sync_to_cloud dead-letter count                             green
  check 36 team-config block well-formed                               green (env synced)
```

**Check 26 yellow is expected** for a fresh team setup — cloud has no runs yet because you haven't started a session. The remediation tells you to run `coodra start` (which the next step does).

If any check is **red**, it includes a `remediation:` line telling you what to do.

---

## Step 6 — Start the daemons

```bash
coodra start
```

This launches three background services:

- **MCP Server** at `127.0.0.1:3100` — exposes the `coodra__*` tools to Claude Code.
- **Hooks Bridge** at `127.0.0.1:3101` — intercepts agent hook events.
- **Sync Daemon** — pushes audit events to cloud Postgres + pulls cross-team-member rows back every 10s.

You should see ~3 lines confirming each daemon started. Daemon logs go to `~/.coodra/logs/`.

Verify with:

```bash
coodra status
```

You'll see the three services with PIDs + healthcheck status.

---

## Step 7 — Run the demo session in Claude Code

This is where the agent actually does something.

1. **Restart Claude Code** so it picks up the new `.mcp.json` from your demo project.
2. Open `~/coodra-demo` in Claude Code.
3. Start a session. Try a basic prompt: *"Edit README.md to add a project description."*
4. Claude Code's hooks fire on `SessionStart`, `PreToolUse`, `PostToolUse`, `SessionEnd`. The bridge audits each event into local SQLite. The agent uses the `coodra__*` MCP tools to record decisions and save context packs.

Watch the logs:

```bash
tail -f ~/.coodra/logs/hooks-bridge.log
tail -f ~/.coodra/logs/mcp-server.log
tail -f ~/.coodra/logs/sync-daemon.log
```

---

## Step 8 — Verify data flowed to cloud

After your demo session ends:

```bash
# query cloud directly via psql (or Supabase SQL editor)
psql "<your DATABASE_URL>" -c "
SELECT id, project_id, agent_type, status, created_by_user_id, started_at, ended_at
FROM runs
ORDER BY started_at DESC
LIMIT 5;
"
```

You should see **at least one row** with:
- `agent_type = 'claude_code'`
- `status = 'completed'`
- `created_by_user_id = '<your-clerk-user-id>'` ← actor attribution working
- `started_at` / `ended_at` timestamps

Same for `decisions` and `context_packs`:

```sql
SELECT id, description, created_by_user_id, created_at FROM decisions ORDER BY created_at DESC LIMIT 3;
SELECT id, title, source, created_by_user_id, created_at FROM context_packs ORDER BY created_at DESC LIMIT 3;
```

If `created_by_user_id` is set on these rows → the actor identity layer works end-to-end.

---

## Step 9 — Onboard a teammate

On their machine (they need their own Clerk user_id; everything else they get from you):

```bash
# Same prerequisites — Node 22+, CLI installed.
coodra team join \
  --user-id 'user_<their-clerk-id>' \
  --org-id '<your-team-org-id>' \
  --org-slug 'acme-eng' \
  --secret '<the-shared-secret-from-step-3>' \
  --database-url '<the-shared-database-url>'

cd ~/their-project
coodra init --project-slug their-project
coodra start
```

Now both of you write to the same Postgres. The sync daemon's pull-tick brings the other's writes into local within 10s. Cross-team awareness works.

Verify cross-team visibility:

1. You record a decision (e.g., via Claude Code in your session).
2. On their machine, wait ~10s, then run:
   ```bash
   sqlite3 ~/.coodra/data.db "SELECT description, created_by_user_id FROM decisions ORDER BY created_at DESC LIMIT 1"
   ```
3. They should see your decision with your `clerk_user_id` stamped.

---

## Common issues + fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| `coodra start` fails: "DATABASE_URL is required" | `team setup` wasn't run, or `~/.coodra/.env` was deleted | Re-run `coodra team setup ...` |
| Cloud-reachability check 24 is red | Wrong password, network blocked, Supabase project paused | Try `psql "<URL>" -c 'SELECT 1'` directly |
| Check 26 stays yellow forever | Sync daemon not running or wedged | `coodra status` (is sync-daemon listed?), check `~/.coodra/logs/sync-daemon.log` |
| Decisions don't show up on teammate's machine | Pull-tick hasn't fired yet (10s window) OR sync-daemon down on writer | Wait 10s; check `coodra doctor --full`'s sync checks (24-27) |
| `coodra doctor` says COODRA_MODE != team | Project `.env` overrode home `.env` | Check your project `.env` doesn't have `COODRA_MODE=solo` (post-Phase-4 init no longer writes this; if you have a legacy `.env`, delete the line) |
| Need to undo a migration | `coodra team migrate --rollback` | Restores local snapshot + deletes cloud rows from this attempt |
| Need to leave team mode | `coodra team leave --yes` | Demotes config back to solo. Cloud data untouched (other team members still see it). |

---

## What's next (Phase 4-web — gated on design)

Phase 4 server-side is complete and verified. Once the design system lands, the web UI plugs into this contract:

- `/onboarding/org` — first-time team creation (replaces "manually grab IDs from Clerk dashboard").
- `/onboarding/connect` — auto-detects whether the user has run `coodra team join` and shows a green check.
- `/team/members` — directory view of all team members + their activity.
- `/audit` — org-wide compliance feed.
- `/settings/integrations` — placeholder for M09 JIRA.

Until then: the CLI flow above is the way to onboard. It's tested end-to-end against real Supabase and works.
