# Module 04a — Sync Daemon + Self-Host Packaging — Tech Stack

## Runtime + dependencies

**Zero new external deps.** Everything M04a needs is already pinned by M01–M03.1:

| Surface | Lib (already pinned) | Why this lib stays |
|---|---|---|
| Postgres driver | `postgres` (postgres-js) — pinned by M01 | Same handle the cloud-mode-write integration test exercises since M02 §F3 |
| ORM | `drizzle-orm` — pinned by M01 | Schema parity tests already gate dialect drift; sync rides on the same row shapes |
| SQLite driver | `better-sqlite3` + `sqlite-vec` — pinned by M01 | Local handle is unchanged from M03.1 |
| Worker substrate | `@coodra/cli/lib/outbox` — landed in M03.1 | OutboxWorker class + lease/retry/dead-letter; reused with `queueKind: 'sync_to_cloud'` |
| Logger | `pino` (via `@coodra/shared`) — pinned by M01 | Same structured-log shape across the fleet |
| Validation | `zod` — pinned by M01 | Sync payload shape validation (§S3) |
| HTTP healthz | `hono` — pinned by M03 | Optional minimal /healthz on sync-daemon for Compose healthchecks (no public surface) |
| Test runner | `vitest` + `testcontainers` — pinned by M01 + §F3 helper | Sync integration tests and migration tests use the existing pgvector/pgvector:pg16 testcontainer |

Anything that looks like a "new tech choice" below is **packaging**, not runtime.

## Packaging — Docker + Compose

| Choice | Locked because |
|---|---|
| Base image: `node:22-alpine` for build, `node:22-alpine` for runtime (or `gcr.io/distroless/nodejs22-debian12` if size matters) | Matches `package.json::engines.node`; alpine keeps image small; non-root user enforced |
| `pnpm` install via corepack | Already the workspace's package manager |
| `turbo build --filter=@coodra/<service>` | Existing build pipeline; no new tool |
| Compose schema: v3.9 | Universally supported by Docker Engine + Podman |
| Postgres image: `pgvector/pgvector:pg16` | Already used by M02 §F3 integration tests; pgvector required for `context_packs.summary_embedding` |
| Healthcheck shape: `wget --spider http://localhost:<port>/healthz` | No curl in alpine by default; wget is present |
| Migration container: `deploy/Dockerfile.cloud-migrate` runs `coodra cloud-migrate` once and exits | Same binary as the runtime services; no Drizzle CLI shipped to ops |

**Not used.** Kubernetes manifests, Helm charts, Terraform modules, Pulumi, Docker Swarm. One Compose path is the v1 surface; managed-platform variants (Railway, Fly.io) get a "should also work" pointer.

## Self-host deploy guide platform

**Locked: Docker Compose.** Reasoning is in spec.md §6 OQ5. Any operator who can run Docker can run the stack. Managed-platform users adapt the Compose definition to their platform's service shape.

## Versions to pin (carry forward from M01–M03.1)

| Tool | Version | Source |
|---|---|---|
| Node.js | 22 LTS | repo `package.json::engines` |
| pnpm | 9.x | repo `package.json::packageManager` |
| Postgres | 16 | M01 + M02 testcontainer |
| pgvector | 0.7.x (bundled in pgvector/pgvector:pg16) | M01 |
| TypeScript | 5.x (matches workspace) | M01 |
| Vitest | 2.x | M01 |
| Hono | 4.x | M03 |
| Zod | 3.x | M01 |
| Pino | 9.x | M01 |
| Drizzle ORM | latest patch matching M03.1 lockfile | M01 |
| Drizzle Kit | matches drizzle-orm | M01 |
| Hadolint (CI lint for Dockerfiles) | latest stable in CI image | NEW for S7, non-blocking |

## Deploy targets explicitly ruled out

- **Railway/Fly.io as the canonical guide path.** Mentioned briefly in self-host.md; not the primary tutorial. Decision per OQ5.
- **Kubernetes / Helm.** Out of scope; future module if and when team-mode operators ask.
- **AWS Fargate / Cloud Run / managed Postgres bundlers.** Operator concern; not this module.
- **systemd unit files for bare-metal install.** Out of scope; Compose covers all single-machine bare-metal cases.

## What this module does NOT add to the dependency graph

- No BullMQ, no Redis (pending_jobs is the substrate; ADR-006 still applies for future cloud queues).
- No Prometheus client (locked OQ6 — doctor only).
- No new database — same postgres + sqlite pair from M01.
- No service mesh, no API gateway, no reverse proxy in the Compose stack (operator front-ends with their own; v1 stack ships ports directly for simplicity).
