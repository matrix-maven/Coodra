# Self-Hosting Coodra Team Mode

This guide covers the Docker Compose stack under `deploy/`. It is an operator
starting point for a team-owned Postgres mirror and Coodra runtime services.

For local developer use, prefer the npm CLI path in `docs/index.html`.

## Stack

| Service | Port | Role |
|---|---:|---|
| `postgres` | 5432 | Optional bundled Postgres with pgvector. |
| `cloud-migrate` | none | One-shot migration container. |
| `mcp-server` | 3100 | Coodra MCP HTTP transport and lifecycle-event runtime. |
| `sync-daemon` | none | Pushes local outbox rows and pulls team rows. |

The Compose stack does not include the local web dashboard. Run `coodra start`
locally for the normal local dashboard on port 3001.

## Prerequisites

- Docker Engine 25 or Docker Desktop.
- 2 GB free RAM and 4 GB free disk.
- A clone of this repository.
- A Postgres URL, either the bundled Compose Postgres or a managed Postgres you
  operate.

## Configure

```bash
cp deploy/.env.example deploy/.env
```

Edit `deploy/.env`:

- `DATABASE_URL`: leave the default when using bundled Compose Postgres, or set
  your managed Postgres URL.
- `LOCAL_HOOK_SECRET`: generate a fresh value with `openssl rand -hex 32`.
- `POSTGRES_PASSWORD`: change the default if Compose manages Postgres.
- `MCP_SERVER_PORT`: optional host port override for the MCP server.

`LOCAL_HOOK_SECRET` protects local lifecycle/tool ingress where that secret is
used. Treat it like an internal runtime secret.

## Start

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d
```

Watch logs:

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env logs -f
```

Expected shape:

- `postgres` becomes healthy.
- `cloud-migrate` exits successfully.
- `mcp-server` starts and exposes `/healthz`.
- `sync-daemon` starts its worker loop.

## Smoke Test

```bash
curl http://localhost:3100/healthz
docker compose -f deploy/compose.yaml --env-file deploy/.env exec postgres \
  psql -U coodra -d coodra -c "\dt"
```

Run the CLI doctor inside the MCP container:

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env exec \
  -e COODRA_MODE=team mcp-server \
  node /app/packages/cli/dist/index.js doctor --full
```

## Agent Wiring

For most users, native local plugin wiring is still the supported path:

```bash
npm i -g @coodra/cli
coodra install
coodra agent add codex
coodra init
coodra start
```

Advanced MCP clients can point at the hosted MCP HTTP endpoint:

```text
http://<host>:3100/mcp
```

Lifecycle events should enter through the `lifecycle_event` MCP tool.

## Operations

| Task | Command |
|---|---|
| Tail all logs | `docker compose -f deploy/compose.yaml --env-file deploy/.env logs -f` |
| Tail one service | `docker compose -f deploy/compose.yaml --env-file deploy/.env logs -f sync-daemon` |
| Restart one service | `docker compose -f deploy/compose.yaml --env-file deploy/.env restart sync-daemon` |
| Apply migrations after pulling | `docker compose -f deploy/compose.yaml --env-file deploy/.env run --rm cloud-migrate` |
| Stop the stack | `docker compose -f deploy/compose.yaml --env-file deploy/.env down` |
| Stop and wipe bundled data | `docker compose -f deploy/compose.yaml --env-file deploy/.env down -v` |

## Upgrade

```bash
git pull
docker compose -f deploy/compose.yaml --env-file deploy/.env build
docker compose -f deploy/compose.yaml --env-file deploy/.env run --rm cloud-migrate
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d
```

## Not Included

- TLS termination, reverse proxy, or WAF.
- Backups.
- Hosted multi-tenant control plane.
- Public marketing site.

Use your platform's normal tooling for those responsibilities.

## Troubleshooting

| Symptom | Check |
|---|---|
| `cloud-migrate` fails on unknown tables | `DATABASE_URL` may point at the wrong database. |
| `mcp-server` returns 401 | Check `LOCAL_HOOK_SECRET` and client config. |
| `sync-daemon` reports transient missing local rows | Usually self-corrects on the next worker tick. |
| Doctor cloud checks stay red | Check Postgres reachability, credentials, and network policy. |
| Build fails around native modules | Rebuild without cache and confirm the image has Python/build prerequisites. |

For deeper diagnostics, inspect structured service logs with `docker compose
logs <service>`.
