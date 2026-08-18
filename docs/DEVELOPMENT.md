# Coodra Development Guide

This guide gets a contributor from a fresh clone to the same checks CI runs.
For the product and architecture overview, start with `docs/index.html`.

## Prerequisites

- Node.js 22.16 or newer. `.nvmrc` is the CI baseline.
- pnpm 10.33 or newer through Corepack.
- npm 10 or newer for published-package/global-install smoke checks.
- Docker and Docker Compose for Postgres-backed integration work.
- git 2.40 or newer.

## First-Time Setup

```bash
git clone git@github.com:matrix-maven/Coodra.git
cd Coodra
nvm use
corepack enable
pnpm install
pnpm --filter @coodra/shared build
pnpm --filter @coodra/db build
```

That is enough for the main local checks:

```bash
pnpm typecheck
pnpm test:unit
pnpm lint
```

Integration work needs Postgres:

```bash
docker compose up -d
export DATABASE_URL="postgres://coodra:coodra_dev_password@127.0.0.1:5432/coodra"
export REDIS_URL="redis://127.0.0.1:6379/0"
pnpm test:integration
```

Reset local services:

```bash
docker compose down -v
```

## Monorepo Layout

```text
apps/
  mcp-server/    Coodra MCP server, lifecycle_event, memory, wiki, policy, Work Packs
  sync-daemon/   Team-mode outbox push and cloud-to-local pull
  web-v2/        Local/self-hosted web dashboard

packages/
  cli/           @coodra/cli npm package
  db/            Drizzle schemas and migrations for SQLite and Postgres
  lifecycle/     Shared lifecycle helpers
  policy/        Policy decision engine
  shared/        Shared schemas, auth, utilities, and contracts

docs/
  index.html     Public developer documentation source
  DEVELOPMENT.md This file
  deploy/        Self-host notes
```

Every workspace package follows the same general shape: `src/`,
`__tests__/unit/`, optional `__tests__/integration/`, `tsconfig.json`,
`tsconfig.typecheck.json`, and package exports.

## Daily Workflow

```bash
pnpm lint
pnpm lint:fix
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm build
pnpm --filter @coodra/db db:generate
```

CI currently runs `verify`, `integration`, `hook-adapter-smoke`,
`windows-core-smoke`, `windows-native-full-smoke`, and `e2e`. See
`.github/workflows/ci.yml` for exact commands.

## Iterating On The MCP Server

```bash
pnpm --filter @coodra/mcp-server dev
pnpm --filter @coodra/mcp-server test:unit --watch
```

The MCP server supports stdio and HTTP. In stdio mode, stdout is protocol data;
logs must go to stderr.

Native Coodra plugins call the server's `lifecycle_event` MCP tool for session,
prompt, tool-use, compaction, and session-end events. Normal development should
exercise that path, not retired bridge-era HTTP hooks.

If you rebuild the server while an agent session is already open, restart the
agent or reconnect MCP. Agents usually spawn the MCP subprocess once per
session.

## Iterating On The CLI

Do not install the published npm package when testing local CLI edits; it can
shadow your workspace changes.

```bash
pnpm --filter @coodra/cli build
pnpm --filter @coodra/cli cli --help
pnpm --filter @coodra/cli cli doctor
pnpm --filter @coodra/cli cli init --dry-run

pnpm --filter @coodra/cli dev doctor
```

`coodra install` writes machine runtime state under `~/.coodra/` (or
`$XDG_CONFIG_HOME/coodra/` on Linux when set). `coodra init` writes project-local
state under `.coodra/{config.json,manifest.json,recipes/,graphify/,wiki/,work-packs/}`.
Agent-facing native plugins are installed or repaired with
`coodra agent add <agent>` / `coodra agent repair <agent>`.

When testing daemon lifecycle, use a temp home to avoid touching your real
Coodra install:

```bash
HOME=/tmp/coodra-dev-home \
XDG_CONFIG_HOME=/tmp/coodra-dev-xdg \
pnpm --filter @coodra/cli cli install

HOME=/tmp/coodra-dev-home \
XDG_CONFIG_HOME=/tmp/coodra-dev-xdg \
pnpm --filter @coodra/cli cli init --project-slug devtest
```

## Team-Mode Auth Development

Local Coodra services write to local SQLite in solo and team mode. Team mode
adds identity and sync behavior; the sync daemon owns Postgres mirroring.

To exercise the MCP server's team-mode auth surface locally:

```bash
COODRA_MODE=team \
CLERK_SECRET_KEY=sk_test_replace_me \
CLERK_PUBLISHABLE_KEY=pk_test_xxx \
pnpm --filter @coodra/mcp-server dev
```

For cloud-write behavior, use `@coodra/db::createDb({ kind: 'cloud', postgres:
{ databaseUrl } })` or the sync-daemon integration tests.

## Graphify Development

Coodra consumes Graphify as an independent managed MCP server. Coodra owns the
local wiring and project artifact paths; Graphify owns the graph engine.

Useful commands:

```bash
coodra graphify status
coodra graphify build --no-llm
coodra graphify open
coodra graphify clean
```

Generated graph artifacts live under `.coodra/graphify/out/`.

## Drizzle Migrations

After changing `packages/db/src/schema/{sqlite,postgres}.ts`:

```bash
pnpm --filter @coodra/db db:generate
pnpm --filter @coodra/db run check:migration-lock
```

Commit schema changes and generated SQL together. Do not edit published
migrations in place; add a new migration.

Some SQL blocks are intentionally hand-written and protected by
`packages/db/migrations.lock.json`. If a protected block changed intentionally:

```bash
pnpm --filter @coodra/db run check:migration-lock -- --write
git diff packages/db/migrations.lock.json
```

## Windows Smoke

The Windows x64 path is covered by CI. You can run the core smoke locally after
building:

```bash
pnpm --filter @coodra/cli build
pnpm --filter @coodra/cli smoke:core
```

The smoke covers install, init, start, MCP health, status, and stop against a
temporary Coodra home.

## Troubleshooting

- `Cannot find module '@coodra/shared'`: rebuild dependencies or run
  `pnpm typecheck` from the root.
- `better-sqlite3` native build failure: confirm Node matches `.nvmrc`, then run
  `pnpm rebuild better-sqlite3`.
- Integration tests cannot connect: check `docker compose ps` and make sure
  Postgres is healthy and port 5432 is free.
- Drizzle cannot find schema: run DB scripts through
  `pnpm --filter @coodra/db ...`.
- Agent does not see a new MCP tool: rebuild, restart the agent, and confirm
  the native plugin wiring with `coodra agent status`.

## Before Opening A PR

```bash
pnpm typecheck
pnpm test:unit
pnpm lint
```

Add focused integration or e2e coverage for service-boundary, lifecycle, sync,
database, packaging, or public CLI behavior changes.
