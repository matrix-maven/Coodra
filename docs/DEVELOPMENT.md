# Coodra — Development Guide

This is the single page you need to get a local Coodra monorepo
running, make a change, and ship it through the same pipeline CI uses.
It is intentionally short: anything that would bloat it belongs in a
Feature Pack (`docs/feature-packs/<id>/`) or in the canonical
standing-context docs at the repo root (`system-architecture.md`,
`essentialsforclaude/`, `module-wise plan.md`,
`External api and library reference.md`, `implementation plan and strategy.md`).

## Prerequisites

- **Node.js** exactly at the version pinned in `.nvmrc` (22.x). Use
  `nvm use` or `fnm use` — the CI workflow reads the same file.
- **pnpm 10+** (`corepack enable && corepack prepare pnpm@latest`).
- **Docker + Docker Compose** for the Postgres + Redis services in
  team mode and for integration tests.
- **git** ≥ 2.40. Make sure your commits sign cleanly if the project
  has signed-commits enforcement (none today; Module 05 may add it).

## First-time setup

```bash
git clone git@github.com:Abishai95141/Coodra.git
cd Coodra
nvm use                 # picks the version from .nvmrc
corepack enable
pnpm install            # resolves workspaces + runs postinstalls
pnpm --filter @coodra/shared build   # builds the workspace package
                                        # that others import
```

That is enough to run `pnpm lint`, `pnpm typecheck`, and
`pnpm test:unit`. Integration work needs Postgres:

```bash
docker compose up -d             # brings up postgres + redis
# Wait ~5 s for health-checks, then:
export DATABASE_URL="postgres://coodra:coodra_dev_password@127.0.0.1:5432/coodra"
export REDIS_URL="redis://127.0.0.1:6379/0"
pnpm test:integration            # currently: @coodra/db Postgres smoke
```

Stop and reset:

```bash
docker compose down -v           # removes named volumes too
```

## Monorepo layout

```
packages/
  shared/                 # @coodra/shared — logger, errors, zod env, idempotency
  db/                     # @coodra/db     — Drizzle schemas (sqlite + postgres), createDb
  # (Module 02+ adds: mcp-server, hooks-bridge, ai-core, sync-daemon, ui, cli)

docs/
  DEVELOPMENT.md          # this file
  feature-packs/<NN>-*/   # spec, implementation plan, techstack per module
  context-packs/          # run-after-run summaries; the primary handoff artefact

context_memory/           # per-session working notes (gitignored bodies, committed structure)
```

Every workspace package follows the same shape:
`src/` for implementation, `__tests__/unit/` and
`__tests__/integration/` for tests, `tsconfig.json` for the build
(rootDir=src), `tsconfig.typecheck.json` for everything-else
typechecking, and a `package.json` whose `exports` maps
subpaths for consumers.

## Daily workflow

The commands you actually run:

```bash
pnpm lint               # biome check across the repo
pnpm lint:fix           # biome check --write
pnpm typecheck          # turbo run typecheck (builds deps first)
pnpm test:unit          # turbo run test:unit across workspaces
pnpm test:integration   # turbo run test:integration (needs Postgres)
pnpm build              # turbo run build
pnpm --filter @coodra/db db:generate   # regenerate Drizzle migrations
```

All of these are the same commands CI runs. If they pass locally they
pass in CI.

### Iterating on the MCP server (Claude Code subprocess staleness)

Closes verification finding §8.2 (`docs/verification/2026-04-25-module-01-02-verification.md`).

Claude Code's `.mcp.json` points at `apps/mcp-server/dist/index.js`. The
IDE spawns this subprocess **once** at session start; rebuilds during
the session do not reach the running process. If you `pnpm build`
mid-session and don't restart, the IDE keeps using the old binary.

Two workarounds:

1. **Production-shaped flow** — after `pnpm build`, fully restart Claude
   Code (or trigger an MCP reconnect from the IDE). The new dist takes
   effect on the next subprocess spawn.

2. **Live-reload dev flow** — replace `.mcp.json` with the
   `.mcp.dev.json` profile (or copy it over). It runs the server under
   `tsx watch` directly from `src/`, so saving any file in
   `apps/mcp-server/src/**` reloads the subprocess without an IDE
   restart. Note: `tsx watch` adds ~200 ms boot overhead per reload —
   fine for dev, not appropriate for production.

```bash
# One-shot dev profile swap
cp .mcp.dev.json .mcp.json   # then restart Claude Code once
```

After the swap, edit a tool description, save, call the tool from a
fresh Claude Code message — observe the new description.

### Local team-mode auth dev

Closes verification finding §8.3 (final fix landed in Module 03 S4).

Local services always write to local SQLite per `system-architecture.md` §1 — in BOTH solo and team mode. `COODRA_MODE` is an auth-strategy hint (solo bypass vs Clerk) and does NOT change DB routing. Module 02 introduced a `COODRA_DB_OVERRIDE_MODE` env knob as a stop-gap; Module 03 S4 made it unnecessary by refactoring `createDb` to take a `kind: 'local' | 'cloud'` discriminator. The knob is removed.

To exercise the team-mode auth chain locally:

```bash
COODRA_MODE=team \
CLERK_SECRET_KEY=sk_test_replace_me \
CLERK_PUBLISHABLE_KEY=pk_test_xxx \
pnpm --filter @coodra/mcp-server dev
```

The auth client routes through the solo-bypass branch (because the secret is the sentinel), the DB stays SQLite, and `tools/list` returns all 9 tools. Use this for local UI smoke tests where you want to exercise the team-mode auth surface but don't need real Clerk JWTs.

### Iterating on Module 03 (Hooks Bridge)

The Hooks Bridge is a separate Hono service on `127.0.0.1:3101`. Claude Code POSTs PreToolUse / PostToolUse / SessionStart / Stop / UserPromptSubmit events to it via the `hooks` block in `.mcp.json`. To run live:

```bash
# Terminal 1 — bridge in watch mode
LOCAL_HOOK_SECRET=$(openssl rand -hex 24) \
  pnpm --filter @coodra/hooks-bridge dev

# Terminal 2 — tail the bridge log to watch hooks land
# (the bridge writes pino JSON to stderr by default)

# In your shell that launches Claude Code, export the same secret:
export LOCAL_HOOK_SECRET=<paste from terminal 1>

# Restart Claude Code so it re-reads .mcp.json with the new hooks block.
# Trigger any agent action (read a file, bash command, etc.) and confirm
# the bridge logs `hook_ingress` events.
```

For Windsurf / Cursor adapters, run `bash scripts/hook-adapters/install.sh` to copy the shell adapters into the IDE's hooks directory. The adapter scripts read `LOCAL_HOOK_SECRET` and `HOOKS_BRIDGE_PORT` from the environment. (Module 08a's `coodra init` CLI will automate this.)

### Iterating on the CLI (Module 08a)

`@coodra/cli` is a regular workspace TypeScript package — same `tsc → dist/` pipeline as `@coodra/shared` and every other package. There is no separate build tool. Module 08a Decision 5 ships it as a published npm package (`@coodra/cli`); the publish step itself is out of 08a scope.

For contributors working on the CLI itself, **do not** `npm i -g @coodra/cli` from a published version — you'd shadow your local edits with the registry copy. Instead, invoke the workspace `cli` script:

```bash
# One-time per branch
pnpm --filter @coodra/cli build       # tsc — writes packages/cli/dist/

# Run any subcommand against the freshly-built dist
pnpm --filter @coodra/cli cli --help
pnpm --filter @coodra/cli cli doctor
pnpm --filter @coodra/cli cli init --dry-run

# Faster edit/run loop — runs from src/ via tsx, no rebuild needed
pnpm --filter @coodra/cli dev doctor
```

The `cli` script in `packages/cli/package.json` runs `node dist/index.js`. We use a script (not `pnpm exec coodra`) because pnpm does not auto-link a workspace package's *own* `bin` into `node_modules/.bin/` — `bin` is a contract for downstream installers (`npm i -g`, the published-tarball path), not a self-link in workspace dev. The script keeps the invocation workspace-aware (no hard-coded path; `pnpm --filter <pkg>` runs in the package's cwd) without depending on a symlink that isn't created. The `dev <cmd>` script runs via `tsx` against `src/index.ts` so file edits land without a rebuild — useful when iterating on a single command. Use the built form for end-to-end tests and snapshot assertions.

`coodra init` writes to `~/.coodra/` (or `$XDG_CONFIG_HOME/coodra/` on Linux when set, per Decision 2) and to the cwd's `<repo>/.{coodra.json,mcp.json,env}`. When iterating, run `init --dry-run` first to print what it would write without touching disk. Re-running `init` against an already-initialised project is non-destructive by default (Decision 3 — idempotent merge); use `--force` only when you want to overwrite user edits with the baseline.

When testing daemon lifecycle (`start` / `stop`), prefer a tmp project root and a non-default `~/.coodra/` location to avoid colliding with your own real install:

```bash
HOME=/tmp/coodra-dev-home \
XDG_CONFIG_HOME=/tmp/coodra-dev-xdg \
pnpm --filter @coodra/cli cli init --project-slug devtest
```

### Why I can't boot the binaries against Postgres (F11)

Closes verification finding F11 (`docs/verification/2026-04-27-module-01-02-03-verification.md`).

`apps/mcp-server` and `apps/hooks-bridge` are SQLite-only by design (`system-architecture.md §1`). Their `lib/db.ts` files unconditionally call `createDb({ kind: 'local' })` — there is no env knob, no flag, no boot path that yields a Postgres handle. The Module 02 stop-gap `COODRA_DB_OVERRIDE_MODE` was removed in M03 S4.

If you need to exercise the cloud-write path, it lives in `@coodra/db::createDb({ kind: 'cloud', postgres: { databaseUrl } })` and is tested in `packages/db/__tests__/integration/cloud-mode-write.test.ts`. Future modules (Sync Daemon, Module 05 NL Assembly's embeddings-ingest worker) will ship services that boot against Postgres directly — but those services don't exist yet, and the local mcp-server/hooks-bridge binaries never will.

### Context Pack file conventions (F13)

Closes verification finding F13 (`docs/verification/2026-04-27-module-01-02-03-verification.md`).

Two folders, two purposes:

| Path | What lives there | Tracked? |
|---|---|---|
| `~/.coodra/packs/` | Auto-saved per-pack markdown produced by every `save_context_pack` call. Filename: `{date}-{sanitised-runId}.md`. | No — gitignored via `.coodra/`. |
| `<repo>/docs/context-packs/` | Hand-curated module closeouts: the canonical, agent-readable record of "what shipped in Module N". One file per module, named like `2026-04-26-module-03-hooks-bridge.md` (no `-run-` segment). | Yes — committed. |

Override the runtime root via `COODRA_CONTEXT_PACKS_ROOT=/path/to/dir` (env) or `contextPacksRoot` on `createContextPackStore({...})` (code). The new default keeps runtime artefacts out of any repo so closeout commits don't need to add or ignore stray auto-saved files.

`docs/context-packs/*-run-*.md` is also defensively gitignored — if an agent overrides the root to point at the repo, those files still won't end up tracked.

### Running a single package

```bash
pnpm --filter @coodra/shared test:unit
pnpm --filter @coodra/db typecheck
```

### Regenerating Drizzle migrations

After changing `packages/db/src/schema/{sqlite,postgres}.ts`:

```bash
pnpm --filter @coodra/db db:generate
```

Commit both the schema change and the generated SQL in the same commit.
The schema-parity unit test
(`packages/db/__tests__/unit/schema-parity.test.ts`) will fail CI if
the two dialects drift in a way that is not explicitly allow-listed in
the test's `DIALECT_TYPE_EXEMPTIONS` map.

### Migration lock (hand-written preserve-blocks)

Some SQL that the database needs cannot be emitted by Drizzle-Kit —
today: the `sqlite-vec` virtual-table DDL (SQLite) and the pgvector
HNSW index DDL (Postgres). These live inside the Drizzle-generated
migration files, wrapped in preserve markers:

```sql
-- @preserve-begin hand-written:<marker>
<hand-written SQL>
-- @preserve-end hand-written:<marker>
```

Every marked block is sha256-locked in
`packages/db/migrations.lock.json` with `{ file, blockMarker, sha256,
lineRange, generatedAt }`. CI (`.github/workflows/ci.yml` → `verify`
job) and the `.githooks/pre-commit` hook both run the checker:

```bash
pnpm --filter @coodra/db run check:migration-lock
```

The checker surfaces three failure modes, each with a diffable
message naming the file, the marker, the expected sha256, and the
remediation command:

- `MISSING_IN_FILE` — the block is gone (Drizzle-Kit regenerated and
  wiped it). Restore from git: `git log -p <migration>`.
- `MISSING_IN_LOCK` — a new hand-written block was added without
  running `--write`. Run it and commit.
- `SHA256_MISMATCH` — the body drifted. If the edit was intentional,
  regenerate the lock:

  ```bash
  pnpm --filter @coodra/db run check:migration-lock -- --write
  git diff packages/db/migrations.lock.json   # sanity check
  git add packages/db/migrations.lock.json
  ```

Pre-commit only runs the check when files under `packages/db/` are
staged; CI always runs it. The hook is wired automatically by `pnpm
install` (root `prepare` script sets `core.hooksPath` to `.githooks`).

## Branching, commits, and the session protocol

Per the standing context (`CLAUDE.md`, `system-architecture.md` §24),
each module is delivered on a feature branch named `feat/<NN>-<slug>`
(e.g. `feat/01-foundation`). Inside that branch, commits are split by
logical slice, each self-contained and runnable.

At the end of every session, regardless of whether the module is
complete:

1. Update `context_memory/current-session.md` with a terse timeline.
2. Update `context_memory/decisions-log.md` if any non-trivial
   decision was made in this session.
3. Write a Context Pack to
   `docs/context-packs/YYYY-MM-DD-module-NN-<title>.md` using
   `docs/context-packs/template.md`.
4. Call `coodra__save_context_pack` with the Pack's markdown body
   so future sessions can retrieve it via semantic search.

Never close a session on a broken `pnpm lint` / `typecheck` /
`test:unit`. If you must stop mid-slice, `git stash` or leave the work
on a scratch branch — `main` and active feature branches stay green.

## Module workflow — at a glance

The full sequence for shipping a module is documented in
`module-wise plan.md` (§"Module workflow") and the root-level
`CLAUDE.md`. The short version:

1. Read the standing context. Ask clarifying questions *before*
   writing code if the Feature Pack leaves anything ambiguous.
2. Produce `docs/feature-packs/<NN>-<slug>/{spec,implementation,techstack}.md`
   and get explicit approval before implementing.
3. Implement slice-by-slice with tests landing in the same commit as
   the code they cover.
4. Keep `External api and library reference.md` updated in the **same
   commit** where a pin changes (amendment B of the bootstrap plan).
5. End with a Context Pack. Merge the feature branch to `main` only
   after CI is green.

## Troubleshooting

- **`Cannot find module '@coodra/shared'`** — rebuild the workspace
  package: `pnpm --filter @coodra/shared build`. Turbo's
  `typecheck` task depends on `^build`, so `pnpm typecheck` from the
  root handles it automatically.
- **`better-sqlite3` native build failure** — ensure your Node matches
  `.nvmrc` (native ABI); run `pnpm rebuild better-sqlite3`.
- **Integration tests hang or fail to connect** — check
  `docker compose ps` and make sure the Postgres container is
  `healthy`. The port `5432` must be free on the host.
- **Drizzle-kit can't find the schema file** — you probably ran it
  from the repo root; every `db:*` script is defined in
  `packages/db/package.json` and must be invoked via
  `pnpm --filter @coodra/db ...`.

## Known platform-specific behaviour

Behaviour that's correct by design but surprises operators on first
contact. Don't chase these as bugs.

### macOS launchd: `~/.coodra/pids/` stays empty

`coodra start` selects `selectDaemonManager()` per platform. On macOS
that's the **launchd** manager (`packages/cli/src/lib/daemon/launchd.ts`),
which sources the PID from `launchctl print` rather than writing
`<name>.pid` files into `~/.coodra/pids/`. So:

- A healthy macOS install has the daemons running but `~/.coodra/pids/`
  is **empty**. That's not a missed write — that's launchd's design.
- `coodra doctor` check 11 (Hooks Bridge healthz) is **PID-aware via
  the active manager**: on macOS it asks `launchctl` for liveness; on
  Linux/Docker the **fallback manager** writes `<name>.pid` and check 11
  reads it directly. Same green/yellow/red surface, different sources.
- The fallback PID-file path (`~/.coodra/pids/<name>.pid`) is the
  contract for the fallback manager only — don't `cat` it on macOS.

If you genuinely want to crash a daemon on macOS to verify recovery,
remember launchd's `KeepAlive` will respawn it within ~1s. Use
`coodra stop` (which deregisters the unit) to observe doctor moving
from green to yellow on checks 10/11 with `ECONNREFUSED — service not
running`.

### Pure-MCP runs don't generate `run_events`

Running an agent that calls **only** the MCP server (no Claude Code or
Cursor hooks firing at the bridge) populates `runs`, `policy_decisions`,
`decisions`, and `context_packs` — but **not** `run_events`. The
`run_events` table is written by `apps/hooks-bridge/src/handlers/post-tool-use.ts`
on `PostToolUse` hook ingress; the MCP server itself never inserts there.

Practical consequence: doctor check 7 (the F8 invariant — `run_events.run_id
NOT NULL when session has runs row`) is **vacuously green** when no hooks
have fired. To exercise it non-vacuously, drive the audit chain through
the bridge — either run an interactive Claude Code session or POST hook
payloads to `http://127.0.0.1:<HOOKS_BRIDGE_PORT>/v1/hooks/claude-code`
and watch `run_events` populate.

## Pointers

- Canonical architecture — `system-architecture.md`
- Discipline and style — `essentialsforclaude/01-development-discipline.md`
  and `essentialsforclaude/07-style-and-conventions.md`
- Per-module workflow — `module-wise plan.md`
- Dep pins + gotchas — `External api and library reference.md`
- Session notes — `context_memory/current-session.md`
- Feature Pack for this module — `docs/feature-packs/01-foundation/`
