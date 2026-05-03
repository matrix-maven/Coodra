# ContextOS Web App — Setup Guide

End-to-end setup for `apps/web` after `feat/04-web-app` lands on `main`. Covers solo mode (single developer, local SQLite) and team mode (cloud Supabase + Clerk auth).

## What you'll have when done

- `apps/web` running at `http://localhost:3000`
- The 7 top-level routes from `/` (dashboard) through `/kill-switches` (admin) all working
- In team mode: Clerk-hosted sign-in at `/auth/sign-in`, org switcher in the header, OrganizationProfile at `/settings/team`
- Bidirectional kill-switch sync between every developer's local SQLite and the cloud Postgres (when sync-daemon is running)

## Prerequisites

| Requirement | Version | Why |
|---|---|---|
| Node.js | ≥ 22.16.0 | Workspace floor (`essentialsforclaude/10-troubleshooting.md`) |
| pnpm | ≥ 10.0.0 | Workspace package manager |
| `~/.contextos/data.db` | populated by `contextos init` | Solo-mode primary store |
| ContextOS CLI installed | `@coodra/contextos-cli` | For `init`/`start`/`pause` commands the web wraps |
| (Team mode only) Supabase Postgres | provisioned with pgvector | Cloud-side audit-trail destination |
| (Team mode only) Clerk dev project | publishable + secret keys | JWT validation at the bridge + web |

The web app depends on the rest of the workspace being installed (`pnpm install` from repo root). It does not run standalone.

## Solo mode (single developer, ~5 minutes)

### 1. Initialise ContextOS in your project

```sh
cd /path/to/your-project
contextos init --project-slug my-project --no-graphify --ide claude
```

This writes:
- `~/.contextos/data.db` (SQLite primary store with the 11-table schema migrated to head)
- `~/.contextos/{logs,pids,config.json}` (operator state)
- `<cwd>/.contextos.json` (project sidecar pointing at `my-project`)
- `<cwd>/.mcp.json` (MCP server config for Claude Code)
- `<cwd>/.env` (baseline solo-mode env vars including `CLERK_SECRET_KEY=sk_test_replace_me` for the bypass)
- `~/.claude/settings.json` (5 hook events registered with the bridge)

### 2. Start the bridge + MCP server

```sh
contextos start
```

This launches the daemons (`hooks-bridge` on `:3101`, `mcp-server` on `:3100`) under launchd / systemd. Verify with `contextos doctor` — every essential check should be green.

### 3. Configure the web app's env

```sh
cd /path/to/Coodra
cp .env apps/web/.env.local
```

The repo root `.env` has all the env vars `apps/web` needs (it was provisioned by `contextos init` plus the Module 04 additions). The copy step is required because Next.js doesn't read parent-directory `.env` files automatically.

### 4. Boot the web app

```sh
pnpm install     # if you haven't already
pnpm --filter @coodra/contextos-web build
pnpm --filter @coodra/contextos-web start
```

Open `http://localhost:3000`. You should see:
- Header reading `[CTX]OS · my-project · Solo mode`
- Dashboard with 4 tiles (Active runs, Denials · 24h, Active pauses, Doctor) + a Latest events table
- All nav links (Runs / Policies / Projects / Packs / Templates / Kill switches) working

### 5. Generate some data

```sh
# In Claude Code, in your project directory:
# Trigger any tool use (Edit a file, run a Bash command, etc.)
# Watch the dashboard reflect the new run + events within ~1.5s of refresh.
```

### Solo-mode dev workflow

```sh
pnpm --filter @coodra/contextos-web dev
```

Hot-reload on file edits. The same env file (`.env.local`) is used; rebuild the bundled CLI separately if you're testing changes there.

## Team mode (cloud Postgres + Clerk auth, ~30 minutes)

Team mode adds three external dependencies: Supabase Postgres, Clerk auth, and (optionally) a deploy target. Follow this in order.

### 1. Provision Supabase

1. Create a project at https://supabase.com/dashboard.
2. In the SQL editor, enable the vector extension if not auto-enabled:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
   (The first Drizzle migration also runs this — but it's safer to confirm here.)
3. Grab the connection string from Project Settings → Database → Connection string. URL-encode the password if it contains special characters (e.g., `@` → `%40`).
4. Grab the publishable key from Project Settings → API → Project API keys → publishable.

### 2. Apply the Drizzle schema to Supabase

From the repo root with `DATABASE_URL` set:

```sh
DATABASE_URL='postgresql://postgres:<URLENCODEDPASSWORD>@db.<PROJECTREF>.supabase.co:5432/postgres' \
  node packages/cli/dist/index.js cloud-migrate
```

Verify:

```sh
psql "$DATABASE_URL" -c "\dt"
# Expected: 11 tables (context_packs, decisions, feature_packs, kill_switches,
# pending_jobs, policies, policy_decisions, policy_rules, projects, run_events, runs)
# + 1 leftover _runid_backfill_0005 artefact (harmless; M03 data backfill remnant)

psql "$DATABASE_URL" -c "\dx vector"
# Expected: vector 0.8.0 installed

psql "$DATABASE_URL" -c "SELECT count(*) FROM drizzle.__drizzle_migrations;"
# Expected: 8
```

### 3. Provision Clerk

1. Create a project at https://clerk.com.
2. Enable the SSO providers you want (Google + GitHub recommended for v1; email/password fallback always available).
3. Copy the publishable key (`pk_test_*` or `pk_live_*`) and secret key (`sk_test_*` or `sk_live_*`).
4. Note the tenant URL — for dev keys it's `https://<tenant>.clerk.accounts.dev` (the web's `lib/clerk-issuer.ts` decodes the publishable key to derive this; you don't have to paste it).

### 4. Configure team-mode env

Edit `apps/web/.env.local`:

```sh
CONTEXTOS_MODE=team

# Cloud DB
DATABASE_URL=postgresql://postgres:<URLENCODEDPASSWORD>@db.<PROJECTREF>.supabase.co:5432/postgres
NEXT_PUBLIC_SUPABASE_URL=https://<PROJECTREF>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_<...>

# Clerk auth
CLERK_PUBLISHABLE_KEY=pk_test_<...>
CLERK_SECRET_KEY=sk_test_<...>
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_<...>     # NEXT_PUBLIC_ prefix is required
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/auth/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/auth/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/

# Bridge / MCP shared secret (generate fresh per environment)
LOCAL_HOOK_SECRET=<openssl rand -hex 32>
```

Build + boot:

```sh
pnpm --filter @coodra/contextos-web build
CONTEXTOS_MODE=team pnpm --filter @coodra/contextos-web start
```

### 5. First sign-in

1. Open `http://localhost:3000/`.
2. You'll be redirected to `/auth/sign-in?redirect_url=%2F`.
3. Sign in (Clerk-hosted form, brand-styled).
4. Land on the dashboard with org switcher in the header.

### 6. Wire the sync-daemon (cross-developer kill-switch sync)

The sync-daemon pushes local audit rows to cloud AND pulls cloud kill_switches to local. Each developer in the team runs their own daemon:

```sh
DATABASE_URL='postgresql://...' \
  CONTEXTOS_MODE=team \
  pnpm --filter @coodra/contextos-sync-daemon start
```

Or wire it under launchd/systemd alongside `contextos start`. Logs land in `~/.contextos/logs/sync-daemon.log` (when started under the supervisor).

Verify the puller is alive: pause a kill-switch from the web admin (`/kill-switches`) and watch every developer's `~/.contextos/data.db` get the row within ~10s:

```sh
sqlite3 ~/.contextos/data.db "SELECT id, scope, target, mode, paused_by_session_id FROM kill_switches WHERE resumed_at IS NULL;"
```

### Team-mode deploy (Vercel / Railway / Fly.io — deferred per OQ-7)

`apps/web/next.config.ts` is portable. Pick a deploy target when you have a real build to deploy:

- **Vercel** — best Next.js DX. Drop a `vercel.json` with `apps/web` as the project root. Set env vars in the Vercel dashboard.
- **Railway** — set `apps/web` as the service root with `pnpm --filter @coodra/contextos-web start` as the start command.
- **Fly.io** — `fly.toml` + Dockerfile. Geographic distribution if you need it.

Production cutover also needs:
- A Clerk production tenant (separate from dev) with prod SSO providers
- A managed Supabase tier (paid) with pgvector enabled
- An Upstash Redis (for sync-daemon's BullMQ in production-scale deployments)

## Verification commands

After any change, run from the repo root:

```sh
pnpm --filter @coodra/contextos-web typecheck
pnpm --filter @coodra/contextos-web lint
pnpm --filter @coodra/contextos-web test:unit            # 27/27 expected
pnpm --filter @coodra/contextos-web build

# Live integration (requires real cloud + Clerk tenant)
LIVE_SUPABASE_TEST=1 CLERK_LIVE_TEST=1 \
  DATABASE_URL='...' NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY='pk_test_...' \
  pnpm --filter @coodra/contextos-web test:integration   # 7/7 expected
```

End-to-end smoke (boots the bundled binary, walks every route):

```sh
# Start in solo mode
CONTEXTOS_MODE=solo pnpm --filter @coodra/contextos-web start &
sleep 4

# Walk every route
for route in "/" /runs /policies /projects /packs /templates /kill-switches /api/healthz; do
  echo "$route → $(curl -sS -o /dev/null -w '%{http_code}' http://localhost:3000$route)"
done

# Should all be 200.
pkill -f "next-server"
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/api/healthz` returns 500 with "Missing publishableKey" | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` missing | Add it to `apps/web/.env.local` (the prefix is required for Next.js client bundle) |
| Protected routes 404 in team mode instead of redirecting | Clerk middleware can't find sign-in URL | Set `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/auth/sign-in` in env |
| `/runs/<id>` returns 404 even though the run exists | `params.id` not URL-decoded | Already fixed (S3) — `decodeURIComponent` in the page; if you see this, rebuild |
| `/packs` shows empty list when packs exist | `process.cwd()` is `apps/web/` not the repo root | Already fixed (S7) — walks up from cwd; or set `CONTEXTOS_PACKS_ROOT` env var |
| Tile values frozen on the dashboard | No polling client yet | Reserved S9 follow-up; refresh the page manually |
| `pnpm test:integration` skips silently | Env gates not set | Set `LIVE_SUPABASE_TEST=1` and/or `CLERK_LIVE_TEST=1` |
| Pause from web doesn't propagate to other developers | sync-daemon not running on those machines | Start sync-daemon there: see step 6 above |
| Clerk component looks wrong (rounded corners, wrong colors) | Brand appearance prop not loaded | Confirm `lib/clerk-appearance.ts` is imported and passed; the `borderRadius: '0'` override is mandatory |

For deeper issues, check `~/.contextos/logs/{hooks-bridge,mcp-server,sync-daemon}.log` and the `contextos doctor --full --json` output.

## Architecture references

- Spec: `docs/feature-packs/04-web-app/spec.md`
- Wireframes: `docs/feature-packs/04-web-app/wireframes/`
- Brand: `docs/brand/`
- Standing rules: `essentialsforclaude/`
- System architecture: `system-architecture.md`
