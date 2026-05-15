# Team Setup — bring your own Supabase

Coodra team mode is **bring-your-own-database**. Each team owns their data: their own Supabase project (or any Postgres ≥ 16 with pgvector available), their own deploy of the web app, their own credentials. Coodra does not host or proxy any cloud database on the team's behalf.

This guide walks an admin through the one-time bootstrap, then walks each teammate through joining.

---

## What you'll need (admin)

1. A Supabase project — free tier works for evaluation. Other Postgres providers work too as long as `vector` extension is available (Neon, Railway, RDS with pgvector preinstalled, self-hosted with `apt install postgresql-16-pgvector`).
2. A Clerk application + organization for your team (you should have these from the web onboarding).
3. The `coodra` CLI installed: `npm install -g @coodra/cli`.
4. ~5 minutes.

## Step 1 — Create your Supabase project

1. Go to [database.new](https://database.new) and create a new project. Pick a region close to your team.
2. Wait for the project to provision (~1 minute).
3. Open **Settings → Database → Connection string** and copy the **URI** form. It looks like:
   ```
   postgresql://postgres:[YOUR-PASSWORD]@db.abcdefgh.supabase.co:5432/postgres
   ```
4. Replace `[YOUR-PASSWORD]` with the password you set during project creation. URL-encode any special characters (`@` → `%40`, `:` → `%3A`, etc.).

## Step 2 — Get your Clerk identifiers

1. Open [dashboard.clerk.com](https://dashboard.clerk.com).
2. Pick the application your team will use.
3. Open the **Organizations** tab. Either create the team's organization here OR have the team's admin create it from the web app once it's wired (Phase 4-web).
4. Copy:
   - Your Clerk **user id** — `user_2abcXYZ...` from the **Users** tab (your row).
   - Your Clerk **organization id** — `org_2abcXYZ...` from the **Organizations** tab.

## Step 3 — Run `coodra team setup`

This command:
1. Verifies the Postgres connection works.
2. Installs `pgvector` (`CREATE EXTENSION IF NOT EXISTS vector`).
3. Applies the Coodra schema (Drizzle migrations, idempotent).
4. Generates a 32-byte hex local hook secret.
5. Writes your local `~/.coodra/config.json` for team mode.
6. Prints the credentials your teammates will need.

```bash
coodra team setup \
  --user-id 'user_2abcXYZ...' \
  --org-id 'org_2abcXYZ...' \
  --org-slug 'acme-eng' \
  --database-url 'postgresql://postgres:...@db.abcdefgh.supabase.co:5432/postgres'
```

Output (success):
```
coodra team setup — bootstrapping team Postgres at postgresql://postgres:***@db.abcdefgh.supabase.co:5432/postgres
  ▸ verifying connectivity (SELECT 1)...
  ✓ connectivity ok
  ▸ installing pgvector extension...
  ✓ pgvector ready
  ▸ applying schema migrations (Drizzle)...
  ✓ schema applied
  ▸ verifying schema (15 expected tables)...
  ✓ 14 tables present
  ✓ local config promoted to team mode (~/.coodra/config.json)

────────  share these credentials with your teammates  ────────
  database url        postgresql://postgres:...@db.abcdefgh.supabase.co:5432/postgres
  clerk org id        org_2abcXYZ...
  local hook secret   a1b2c3d4...

Each teammate runs:
  coodra team join \
    --user-id <their-clerk-user-id> \
    --org-id org_2abcXYZ... \
    --secret a1b2c3d4... \
    --database-url 'postgresql://...'

Distribute the database url + secret via a secrets manager. They are sensitive.
───────────────────────────────────────────────────────────────
```

### What if pgvector install fails

Some hosting providers don't auto-grant `CREATE EXTENSION` to the connection role. Two options:

- **Run the extension install manually** as a superuser, then retry with `--skip-pgvector`:
  ```sql
  -- in Supabase SQL editor, or psql as a privileged role:
  CREATE EXTENSION IF NOT EXISTS vector;
  ```
  Then:
  ```bash
  coodra team setup --skip-pgvector --user-id ... --org-id ... --database-url ...
  ```
- **Use a different connection role** with the right grants. On Supabase the default `postgres` role has the privilege; check that you copied the correct connection string.

## Step 4 — Migrate your existing solo data (optional)

If you've been using Coodra solo mode and want to move that history to the team:

```bash
coodra team migrate --yes \
  --user-id 'user_2abcXYZ...' \
  --org-id 'org_2abcXYZ...' \
  --secret '<the secret from Step 3>' \
  --database-url '<your database url>'
```

The migrate command:
- Snapshots your local `~/.coodra/data.db` to `~/.coodra/data.db.pre-migrate-{timestamp}` before any destructive work.
- Runs a 12-phase pipeline (preflight → projects → runs → children → org_scoped → verify → rewrite_local → commit).
- If you've moved this org's identity from another machine and a project slug already exists in cloud, conflicts are auto-renamed with a `-<6-char-hex>` suffix.
- All your runs, decisions, context packs, and run-diffs land in cloud, stamped with your Clerk user id.

If something goes wrong mid-migration:
- `coodra team migrate --rollback` deletes the partially-written cloud rows and restores your local snapshot.
- `coodra team migrate --resume` continues from the last successfully-completed phase.

If you're starting team mode fresh (no solo history to keep), skip this step.

---

## What each teammate runs

Each member of the team, on each machine they want to use Coodra from:

```bash
# 1. Install the CLI
npm install -g @coodra/cli

# 2. Join the team
coodra team join \
  --user-id 'user_<their-own-clerk-id>' \
  --org-id 'org_<the-team-org>' \
  --secret '<the-shared-secret>' \
  --database-url '<the-shared-database-url>' \
  --org-slug 'acme-eng'  # optional, for nicer display
```

This writes their `~/.coodra/config.json` to team mode. The next time they:
- Open Claude Code: the bridge stamps `runs.created_by_user_id` with their Clerk id.
- Save a context pack via the agent's `save_context_pack` tool: stamped with their id.
- Record a decision via `record_decision`: stamped.

Their local sync daemon will push their writes to your shared Postgres on every audit-write tick (~50ms latency), and pull other team members' writes every 10s. Cross-team-member awareness "just works" — no further config.

## Verifying it worked

On any machine that has joined the team:

```bash
coodra doctor --full
```

Look for:
- **check 24** (`cloud Postgres reachability`) → green
- **check 36** (`team-config block well-formed`) → green
- **check 4** (`migrations at head`) → green

If any of those are yellow/red, the doctor output includes a `remediation` line.

## Common pitfalls

### "DATABASE_URL is set but I'm still in solo mode"

`COODRA_MODE` controls the mode env-side. Set it in `~/.coodra/.env` or your shell:
```
COODRA_MODE=team
DATABASE_URL=<your url>
```
Restart `coodra start` so the daemons pick up the change.

### "My teammate joined but I don't see their decisions in my Claude Code session"

The sync daemon's pull-tick runs every 10s. Decisions land in cloud immediately on the writer's side (via the audit outbox), but a 0–10s window exists where the reader's local SQLite hasn't pulled yet. Run `coodra doctor` and look at check 24 / 26 / 27 to verify sync is healthy.

If that doesn't help, manually trigger a pull from your machine:
```bash
coodra status  # will show last sync tick
```

### "I want to leave the team and go back to solo"

```bash
coodra team leave --yes
```

This:
- Demotes your local `~/.coodra/config.json` back to solo mode.
- Does NOT delete team-tagged rows from your local SQLite (they remain as historical state — a future `coodra clean-team-data` will offer scrubbing).
- Does NOT touch cloud data (other team members still see everything).

### "I want to rotate my team's local hook secret"

Re-run `coodra team setup` with `--secret '<new-hex-string>'`. This overwrites the local config block with the new secret. Distribute the new secret to teammates and have them re-join with `coodra team join --secret '<new>'`. Old secret continues to work until everyone has cycled (the secret is a per-machine bearer token, not enforced cluster-side yet).

---

## Cost / data ownership

- **Where your data lives**: in your Supabase project. Coodra does not store team data on any infrastructure we operate.
- **What flows where**: bridge writes go to local SQLite first (fast, durable), then to your cloud Postgres via the sync daemon. Reads happen from local SQLite (per ADR-008 local-first). The pull-tick brings other team members' writes back from cloud.
- **What's encrypted at rest**: whatever your Postgres provider offers. Supabase encrypts at rest by default. Check your provider's docs.
- **What's encrypted in transit**: every connection to Postgres uses SSL by default (the connection string includes `sslmode=require` implicitly in Supabase's URLs).
- **Backups**: your responsibility. Supabase offers daily backups on paid tiers; check your provider.
