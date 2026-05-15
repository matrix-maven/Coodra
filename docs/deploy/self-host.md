# Self-Hosting Coodra (Team Mode)

This guide walks one operator through bringing up the Coodra team-mode stack on their own infrastructure using Docker Compose. The canonical happy path is **Docker Compose**; Railway / Fly.io / any other platform that runs Docker images can derive from this guide. Reference: Module 04a Open Question 5.

The stack runs four long-lived services + one one-shot migration container:

| Service | Port (default) | Role |
|---|---|---|
| `postgres` (pgvector/pgvector:pg16) | 5432 | Cloud audit store |
| `cloud-migrate` (one-shot) | — | Runs `coodra cloud-migrate` once, then exits |
| `mcp-server` | 3100 | MCP HTTP transport for AI agents |
| `hooks-bridge` | 3101 | HTTP hook ingress for Claude Code / Cursor |
| `sync-daemon` | — | Pushes local SQLite audit rows to cloud Postgres |

Total time to a working stack on a fresh machine: **~10 minutes** (most of it the first Docker build).

## Prerequisites

- Docker Engine 25+ (or Docker Desktop)
- 2 GB free RAM, 4 GB free disk
- A clone of this repository

## 1. Configure the environment

```bash
cd deploy
cp .env.example .env
```

Edit `deploy/.env` and fill in:

- **`LOCAL_HOOK_SECRET`** — generate a fresh value: `openssl rand -hex 32`. Agents will fire hooks at the bridge using this as the shared secret.
- **`DATABASE_URL`** — leave as the default (`postgres://coodra:changeme@postgres:5432/coodra`) if you want Compose to manage its own Postgres. If you have a managed cloud Postgres, paste its URL here AND remove the `postgres` service from `compose.yaml` (or set `POSTGRES_PASSWORD` to a strong value if you keep the bundled DB).
- **`POSTGRES_PASSWORD`** — change from the default if you keep the bundled Postgres.

## 2. Bring the stack up

```bash
cd deploy   # if not already there
docker compose up -d
```

The first run takes ~5 minutes (Docker downloads the base image and runs `pnpm install` inside the build stage). Subsequent runs reuse the cache.

Watch progress in another terminal:

```bash
docker compose logs -f
```

Expected log lines:

- `cloud-migrate` exits 0 with a line like `coodra cloud-migrate: applied against postgres://coodra:***@postgres:5432/coodra`.
- `mcp-server` logs `tool_registered` for 9 tools, then `http_transport_ready`.
- `hooks-bridge` logs `migrations_applied` then `listener_started`.
- `sync-daemon` logs `cloud_db_opened` then `sync_worker_started`.

## 3. Smoke-test

From the host:

```bash
# MCP server is up
curl http://localhost:3100/healthz
# {"ok":true,...}

# Hooks bridge is up
curl http://localhost:3101/healthz
# {"ok":true,...}

# Cloud-side sanity: connect to the bundled postgres and list tables
docker compose exec postgres psql -U coodra -d coodra -c "\dt"
# 11 tables incl. runs, run_events, policy_decisions, decisions,
# pending_jobs, _runid_backfill_0005
```

Run the doctor inside the mcp-server container (it ships the CLI binary):

```bash
docker compose exec -e COODRA_MODE=team mcp-server \
  node /app/packages/cli/dist/index.js doctor
```

Expected: zero RED, zero unexpected YELLOW. The sync-daemon's checks 24–27 should be green.

## 4. Wire your agents

Point Claude Code / Cursor at:

- MCP transport: `http://<host>:3100/mcp`
- Hooks ingress: `http://<host>:3101/hooks/<agent-type>`

with the same `LOCAL_HOOK_SECRET` you set in `.env`.

## 5. Common operations

| Task | Command |
|---|---|
| Tail all logs | `docker compose logs -f` |
| Tail one service | `docker compose logs -f sync-daemon` |
| Restart one service | `docker compose restart sync-daemon` |
| Apply a new migration after pulling | `docker compose run --rm cloud-migrate` |
| Stop the stack | `docker compose down` |
| Stop AND wipe data | `docker compose down -v` (destroys postgres + ~/.coodra volumes) |

## 6. Upgrade workflow

1. `git pull` (or pull the new images if you publish them)
2. `docker compose build` — re-build images that changed
3. `docker compose run --rm cloud-migrate` — apply any new migrations idempotently
4. `docker compose up -d` — restart services

## 7. What this stack does NOT include

- **TLS termination / reverse proxy / WAF.** Front the stack with your own (nginx, Caddy, Traefik, Cloudflare, …) before exposing it publicly.
- **Backups.** Schedule `pg_dump` against the postgres service or use your managed-Postgres backup tooling.
- **Multi-tenancy.** Single `org_id` per deploy. Multi-tenant team-mode is post-launch.
- **Marketing site.** Out of scope per `essentialsforclaude/08-implementation-order.md`.

## 8. Other platforms (brief mentions)

The Compose definition is portable to any platform that runs Docker images.

- **Railway** — `railway init` and add each `Dockerfile.<service>` as a service. Wire env vars via the dashboard. Use Railway's managed Postgres (set `DATABASE_URL` from their connection string) and skip the bundled `postgres` service.
- **Fly.io** — `fly launch` per service with the same Dockerfile each. `fly postgres create` for the cloud DB. Note that sync-daemon has no public port — set `[processes] worker = "..."` rather than `[[services]]`.
- **Render / DigitalOcean App Platform** — same pattern: per-service Dockerfile + a managed Postgres, secrets set via the dashboard.

For all three, the `deploy/Dockerfile.cloud-migrate` runs once before the long-running services start; consult the platform's "deploy hook" / "release command" feature to wire it.

## 9. Troubleshooting

| Symptom | Diagnose |
|---|---|
| `cloud-migrate` refuses with "unknown non-empty tables" | Wrong `DATABASE_URL` — pointing at a different application's DB. Triple-check it. |
| `hooks-bridge` returns 401 to all hook calls | `LOCAL_HOOK_SECRET` mismatch between bridge env and agent config. |
| `sync-daemon` reports `transient_failure: local … row not found` | Bridge audit-dispatch hasn't landed the parent row yet. Self-corrects on next worker tick. |
| `doctor` check 24 RED for >1h | Cloud Postgres permanently unreachable. Check `DATABASE_URL` + network. Local audits continue to land. |
| Build fails with `gyp ERR! python` | Multi-stage build's `apk add python3` step failed. Re-run `docker compose build --no-cache <service>`. |

For deeper diagnostics: `docker compose logs <service>` shows pino structured JSON; pipe through `pino-pretty` for human reading.
