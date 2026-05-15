# Module 08a — CLI — Implementation Plan

> Read `spec.md` and `techstack.md` first. This file is the step-by-step plan; spec is what + why, techstack is which-libraries-and-versions, this file is the order of operations.

> **Open-question gate — CLOSED 2026-04-27.** All five open questions in `spec.md` §11 are signed off (Decisions 1–5) and locked in this spec via S0. Slices below that previously named an OQ now reference the locked decision number.

> **Integration-harness invariant.** The M03 closeout established two manual integration harnesses under `__tests__/manual/` (`verify-f5-live.ts`, `verify-phase5-closed-loop.ts` — see `__tests__/manual/README.md`). Every CLI slice that touches the DB, the bridge config files, or the auto-migrate path must leave both harnesses green. Each slice's "Tests" section names the harness call it ran.

> **Status — 2026-05-02 reconciliation.** Every slice in the original 10-slice plan (S0–S9) landed. The bulk landed in PR #2 (squashed merge `93736f6`, 2026-04-27); five same-merge integration-walk fixes followed the user-visible S9. Standalone post-merge commits (`64e4067`, `313d6f0`, `6d16b2c`, `6bc0cad`, `0c0768a`, `d7a3238`, `907db6a`) extended the CLI surface as Module 03.1 / functest-cleanup / Module 04a landed. Every landed slice below is rewritten in "what landed" style following the convention M02 used for §S7a/§S7b/§S7c/§S8. **No remaining surface in the original M08a slice plan.** Cross-cutting work post-M08a (Phase 2 autonomy defaults `dec_83ba10c1`, Phase 3 `@coodra/*` → `@coodra/*` rename + Fixes A–E) is uncommitted at HEAD `907db6a` and lives in M02/M03/cross-cutting scope, not as new M08a slices.

The plan splits Module 08a into 10 slices (S0–S9). Each slice landed as one logical commit on `feat/08a-cli`; the branch squash-merged to `main` as PR #2 (`93736f6`).

## S0 — Open-question sign-off + spec/implementation/techstack triplet (landed 2026-04-25, commit `53be96a`)

**Scope:** Lock the five `spec.md` §11 open questions before any code lands. Refine the placeholder triplet from `5b6b13d` (2026-04-24) into a real spec/implementation/techstack set, with each "Recommendation preview" in §11 converted to Decision N.

**What landed:**

- `docs/feature-packs/08a-cli/spec.md` — 11 sections covering the 7-command surface, auto-migrate semantics, `~/.coodra/` layout, the agent-vs-human boundary callouts, and the five OQ resolutions baked in as Decisions 1–5.
- `docs/feature-packs/08a-cli/implementation.md` — the 10-slice plan (this file, pre-rewrite).
- `docs/feature-packs/08a-cli/techstack.md` — pinned libraries: `commander@13.1.0`, `env-paths@3.0.0`, `picocolors@1.1.1`, `tmp-promise@3.0.3`, `glob@11.0.4`, plus workspace deps on `@coodra/{shared,db}`.
- `docs/feature-packs/08a-cli/meta.json` — `{ slug, parentSlug: '01-foundation', sourceFiles, isActive: true }`.
- `system-architecture.md` §13 amendment — PID location + native daemon-manager registration.
- `system-architecture.md` §1 amendment — XDG resolution for `~/.coodra/`.
- `essentialsforclaude/08-implementation-order.md` — confirms M08a slot between Modules 03 and 04 and lists the four out-of-every-module scope items (no billing, no marketing site, hosted-only team, Gemini-not-Anthropic).
- `DEVELOPMENT.md` — new "Iterating on the CLI (Module 08a)" subsection for contributor dev-loop without `npm i -g`.

**Tests:** docs only — no test work.

**Gate:** none required (docs).

**Commit:** `docs(feature-pack): Module 08a CLI — spec/implementation/techstack` (`53be96a`).

## S1 — Package scaffold (landed 2026-04-27, squashed in `93736f6`)

**Scope:** Create `packages/cli/` workspace package with the commander surface and stub command bodies (each subcommand exits 99 with "not yet implemented"). Pinned deps per techstack.md, workspace deps on `@coodra/{shared,db}`.

**What landed:**

- `packages/cli/package.json` — `name: "@coodra/cli"`, `bin: { "coodra": "./dist/index.js" }`, `type: "module"`, `engines.node: ">=22.16.0 <23"`. Pinned: `commander@13.1.0`, `env-paths@3.0.0`, `picocolors@1.1.1`, `glob@11.0.4`, `tmp-promise@3.0.3`. Workspace: `@coodra/db`, `@coodra/shared`.
- `packages/cli/tsconfig.json` — extends repo base, `rootDir=src`, `outDir=dist`. `tsconfig.typecheck.json` includes `__tests__/`.
- `packages/cli/vitest.config.ts` + `packages/cli/vitest.integration.config.ts` — v8 coverage, 80% line-threshold; integration variant boots testcontainers.
- `packages/cli/src/{index,program}.ts` — `#!/usr/bin/env node` shebang, top-level commander program with the 7 subcommands wired (`init`, `start`, `stop`, `status`, `doctor`, `cloud-migrate`, `team {login,logout}`), each handler stubbed via the `runXxxCommand` factories in `src/commands/*.ts`.

**Tests added:**

- `__tests__/unit/program.test.ts` — asserts each subcommand registers, `--help` lists 7 commands.
- Per-command stub tests later replaced wholesale as bodies landed in S3–S8.

**Gate:** `pnpm install --frozen-lockfile` clean, `pnpm --filter @coodra/cli typecheck`, `pnpm --filter @coodra/cli build` produces `dist/index.js`, `node dist/index.js --help` enumerates the 7 commands.

**Squashed merge:** `feat(cli): scaffold @coodra/cli — workspace package + commander surface` (in `93736f6`).

## S2 — `--help` and `--version` surfaces (landed 2026-04-27, squashed in `93736f6`)

**Scope:** Wire commander metadata + version pulled from `package.json` at build time via a generated `src/version.ts`. Each subcommand registers its `--help` block.

**What landed:**

- `packages/cli/scripts/sync-version.mjs` — wired as `prebuild`. Reads `package.json#version`, rewrites `src/version.ts` with `export const VERSION = '<semver>'`. Banner comment forbids hand edits.
- `packages/cli/src/version.ts` — committed for IDE awareness; CI guards drift via the sync test.
- `packages/cli/src/program.ts` — commander `name`, `description`, `version`, `helpOption`, plus per-subcommand `description` / `option` declarations.

**Tests added:**

- `__tests__/unit/help-output.test.ts` — snapshot-locks the `--help` text.
- `__tests__/unit/version-sync.test.ts` — reads `package.json` and asserts `src/version.ts#VERSION` matches; CI fails on drift.

**Gate:** snapshots match, version test green.

**Squashed merge:** `feat(cli): --help and --version surfaces with snapshot-locked text` (in `93736f6`).

## S3 — `coodra doctor` — diagnostic engine + 20 checks (landed 2026-04-27, squashed in `93736f6`)

**Scope:** Implement `doctor` as a `Check` registry + parallel runner with per-check timeout (default 2s, `--timeout-ms` configurable). Land the 20 checks specified in `spec.md` §4.5, including six post-M03 invariant checks (5/6/7/8/12/13).

**What landed:**

- `packages/cli/src/doctor/{types,context,run,output}.ts` — `Check` / `CheckResult` / `CheckContext` / `DoctorReport` types, context builder, parallel runner with timeout, formatter (human + JSON).
- `packages/cli/src/doctor/checks/01-node-version.ts` through `20-local-hook-secret.ts` — one file per check. The six M03-invariant checks:
  - **Check 5** — `__global__` sentinel project exists (F7 closure live).
  - **Check 6** — recent `policy_decisions` rows have the F14 4-segment idempotency key shape.
  - **Check 7** — recent `run_events` rows have `run_id NOT NULL` when their session has a `runs` row (F8). Severity bumped to RED in the same-merge post-S9 fix below.
  - **Check 8** — bridge `pre_tool_use_decision` log lines from the last 24h include `runId` (F15).
  - **Check 12** — project registered for cwd (`.coodra.json` resolves) — F7 governance pre-condition.
  - **Check 13** — Audit-write durability YELLOW until M03.1 lands; permanent-yellow severity is what flips to GREEN automatically when `313d6f0` arrives.
- `packages/cli/src/doctor/registry.ts` — `ALL_CHECKS` registration. Output: numbered list with green ✓ / yellow ⚠ / red ✗ glyphs, one-line remediation per non-green. `--json` emits `{ checks, summary, version }`. Reds → exit 2; yellows-only → exit 1; all-green → exit 0.

**Tests added:**

- `__tests__/unit/doctor/checks-fixture.test.ts` plus per-check unit suites — green path + each failure path. Checks 5–8 use a real testcontainers SQLite fixture with seeded F7/F8/F14 fixtures (correct + broken).
- `__tests__/integration/doctor-binary.test.ts` — spawns `node dist/index.js doctor --json` against tmpdirs hitting multiple failure modes; asserts JSON shape + exit code.

**Gate:** `verify-phase5-closed-loop.ts` reports doctor all-green when the harness has just succeeded.

**Squashed merge:** `feat(cli): doctor — 20-check diagnostic engine surfacing F7/F8/F14/F15 invariants` (in `93736f6`).

## S4 — Project + IDE detection module (landed 2026-04-27, squashed in `93736f6`)

**Scope:** `packages/cli/src/lib/detect.ts` — pure functions for project root, language, IDE, and existing `.mcp.json` detection. No side effects beyond filesystem reads.

**What landed:**

- `detectProjectRoot(cwd)` — walks up looking for `package.json` / `pyproject.toml` / `Cargo.toml` / `.git`; returns deepest match or original cwd as fallback.
- `detectLanguages(root)` — file-extension scan via Glob; returns deduped `Language[]`.
- `detectIDE({ homeDir? })` — checks `~/.claude/`, `~/.cursor/`, `~/.windsurf/` existence; `homeDir` override for tests.
- `detectExistingMCPConfig(root)` — reads `.mcp.json`, validates with strict Zod schemas (`mcpEntrySchema` + `mcpConfigSchema`), returns parsed object or null.

**Tests added:** `__tests__/unit/detect.test.ts` against fixture directories under `__tests__/fixtures/` for each function.

**Squashed merge:** `feat(cli): detect — project root, languages, IDE, existing .mcp.json` (in `93736f6`).

## S5 — `coodra init` (landed 2026-04-27, squashed in `93736f6`)

**Scope:** First-time setup command per spec.md §11 Decision 3 (idempotent merge default; `--force` overrides to baseline). Wires S4 detection into a 13-step flow that lays down `~/.coodra/`, `.coodra.json`, `.mcp.json`, `.env`, `~/.claude/settings.json`, the seeded Feature Pack folder, and (unless `--dry-run`) calls `start` internally.

**What landed:**

- `packages/cli/src/commands/init.ts` — full flow.
- `packages/cli/src/lib/init/{coodra-json,mcp-merge,env-merge,claude-settings-merge,feature-pack-seed,types}.ts` — one writer per file; each returns a `WriteOutcome` of `'wrote' | 'merged' | 'unchanged' | 'forced'` so CI consumers can read progress from `--json` output.
- `packages/cli/src/lib/coodra-home.ts` + `runtime-paths.ts` — XDG-aware `~/.coodra/` resolver (Linux uses `$XDG_CONFIG_HOME` when set), bundled-mcp-server runtime path resolution.
- `packages/cli/src/lib/open-local-db.ts` — opens `data.db` with the sqlite-vec extension loaded.
- Auto-migrate via `@coodra/db::migrateSqlite`. Calls `ensureGlobalProject(handle)` for the F7 sentinel + `ensureProject(handle, { slug })` for the user's slug (the latter wired by the in-PR cleanup commit `fix(cli,db): seed projects row in init` inside the squashed merge — see §Post-S9 below).
- Generates a fresh `LOCAL_HOOK_SECRET` via `crypto.randomBytes(32).toString('hex')` per `essentialsforclaude/02-agent-human-boundary.md` §2.4 — never a literal sentinel string.
- Feature Pack seeded with `meta.json` + `spec.md` skeleton (200-line template with TODO markers).
- Optional Graphify scan (skipped if `--no-graphify` or absent on PATH); logs YELLOW on absence, never fails the run.

**Tests added:**

- Unit tests against tmp project dirs covering: greenfield (no `.mcp.json`, no `.coodra.json`), existing `.mcp.json` with another MCP server (idempotent merge keeps the other entry), existing `docs/feature-packs/` with a different slug (conflict path), Graphify-absent path, `--dry-run`, idempotent re-run (`action: 'unchanged'`), `--force` re-run (`action: 'forced'`).
- `__tests__/integration/init.test.ts` — greenfield + idempotent + `--force` + `.mcp.json` preservation + `--dry-run` + secrets-leak invariant + `EXIT_USER_RECOVERABLE` on no-marker.
- The `init`-writes-sentinels-only assertion: parses the written `.env` and fails if any of the disallowed keys (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `GITHUB_APP_*`, `ATLASSIAN_*`, `SUPABASE_*`, `UPSTASH_*`) appears with a non-empty value. Per spec §6 agent-human boundary.

**Gate:** drive `init` against a tmpdir, then immediately drive `verify-phase5-closed-loop.ts` against the resulting bridge config — must succeed with one `runs` row (F8/F9/F14 invariants live).

**Squashed merge:** `feat(cli): init — auto-migrate + ensureGlobalProject + .mcp.json merge + Feature Pack seed + Graphify enrichment` (in `93736f6`).

## S6 — Daemon manager abstraction (landed 2026-04-27, squashed in `93736f6`)

**Scope:** `packages/cli/src/lib/daemon/{launchd,systemd,taskscheduler,fallback}.ts` — one module per platform implementing a common `DaemonManager` interface, plus a `selectDaemonManager()` factory.

**What landed:**

- Common `DaemonManager` interface — `isAvailable / install / uninstall / start / stop / status / list`.
- `launchd.ts` — macOS, drives `launchctl` via execa.
- `systemd.ts` — Linux, drives `systemctl --user` via execa.
- `taskscheduler.ts` — Windows, drives `schtasks` via execa.
- `fallback.ts` — detached child process + PID file under `~/.coodra/pids/`. Used on Windows in 08a (Task Scheduler integration is a stub) and as the universal fallback.
- `selectDaemonManager()` picks the right one for `process.platform`, falling back to `fallback.ts` when the native manager is unreachable.

**Tests added:**

- Unit tests for each implementation (mocking the underlying CLI: `launchctl`, `systemctl`, `schtasks`).
- Opt-in integration test gated behind `COODRA_TEST_DAEMON=1` that runs against the actual native manager — only enabled in CI on the matching OS runner.

**Squashed merge:** `feat(cli): daemon — launchd / systemd / Task-Scheduler / fallback abstraction` (in `93736f6`).

## S7 — `coodra start` and `coodra stop` (landed 2026-04-27, squashed in `93736f6`)

**Scope:** Daemon lifecycle for MCP server + Hooks Bridge. `start` walks: select daemon manager → install both units → start both → wait for `/healthz` to return ok within 10s. `stop` lists installed Coodra units → stops each → optionally uninstalls (`--uninstall`).

**What landed:**

- `packages/cli/src/commands/{start,stop}.ts` — full flows. Health-check polling uses `@coodra/shared`'s logger and an exponential backoff capped at 1s.
- `packages/cli/src/lib/services.ts` — service registry (mcp-server / hooks-bridge / sync-daemon-when-team) + spawn env composition.
- `packages/cli/src/lib/wait-for-health.ts` — polled probe.

**Tests added:** `__tests__/integration/` suites in CI on macOS + Linux runners exercising `start → status → stop` against a small MCP server binary in fixtures. Windows runner skips with TODO.

**Squashed merge:** `feat(cli): start + stop — daemon lifecycle for MCP server and Hooks Bridge` (in `93736f6`).

## S8 — `coodra status` + `team login` / `team logout` stubs (landed 2026-04-27, squashed in `93736f6`)

**Scope:** Unified state probe per `spec.md §4.6` merging project state (read `<cwd>/.coodra.json`, latest `runs` + recent decisions + non-empty `context_memory/blockers.md`) and service state (live HTTP `/healthz` probe; no daemon-manager `list()` reliance, that path is fragile per the M02 finding around stale subprocess state). `team login` / `team logout` ship as stubs that exit 2 with a deferred-body message per spec.md §11 Decision 1.

**What landed:**

- `packages/cli/src/commands/status.ts` + `team.ts` — full implementations. `status --json` emits a Zod-validated structured object; sub-200ms target on the live probe path.
- `team {login,logout}` commands have the full flag set per `spec.md` §4 + each subcommand's `--help` text. Bodies print "team mode not yet generally available — the OAuth round-trip + `~/.coodra/config.json` write land when team mode is reachable end-to-end (post-Module 04). Track via `pending-user-actions.md`." and exit 2.

**Tests added:**

- `status` against four states: services running + project registered / services down + project registered / services running + cwd unregistered → falls to `__global__` / nothing run yet.
- `--json` output schema lock (Zod-validated test fixture).
- `team login` / `team logout` snapshot tests asserting exit 2 + the deferred-body message + `--help` text.

**Gate:** after `init` + `start`, run `verify-phase5-closed-loop.ts`, then drive `status` — must report all-green and the recent-runs entry must show the closed-loop run.

**Squashed merge:** `feat(cli): status — unified project + service probe; team login / logout per OQ 1` (in `93736f6`).

## S9 — README + npm-pack file-list lock + Module 08a Context Pack (landed 2026-04-27, squashed in `93736f6`)

**Scope:** Documentation + tarball-shape lock + Context Pack save.

**What landed:**

- `packages/cli/README.md` — install instructions, 7-command summary, link back to `docs/feature-packs/08a-cli/spec.md`.
- `packages/cli/__tests__/integration/npm-pack-lock.test.ts` — runs `pnpm pack --dry-run`, parses the file list, asserts inclusion of `dist/`, `package.json`, `README.md`, `LICENSE` and exclusion of `src/`, `__tests__/`, `node_modules/`, `.tsbuildinfo`.
- `docs/context-packs/2026-04-27-module-08a-cli.md` — Context Pack saved per `essentialsforclaude/08-implementation-order.md` §8.4.

**Squashed merge:** `docs(08a-cli): README + npm-pack file-list lock + Module 08a Context Pack` (in `93736f6`).

## Post-S9 integration-walk fixes (landed in same merge as S1–S9, `93736f6`)

Five fixes surfaced by walking the M02 + M03 + M08a integration immediately after S9 finished. Squashed into the same merge so main remained green.

- `fix(cli,db): seed projects row in init for the user's slug` — `ensureProject` was added to `init.ts` after S5 closed; pre-fix the bridge resolver fell back to `__global__` for every per-project audit. Closes the post-08a integration walk's first finding.
- `fix(cli): default COODRA_LOG_DESTINATION=stderr in the CLI binary` — without this the spawned mcp-server inherited stdout-as-protocol-channel and corrupted its own stdio output.
- `fix(cli): keep typecheck tsbuildinfo out of dist/` — `npm-pack-lock` test caught the leak; `tsconfig.typecheck.json` redirected to write `.tsbuildinfo` outside `dist/`.
- `fix(cli): doctor check 7 (F8 invariant) reports RED on orphan run_events` — original check returned YELLOW; severity bumped to RED per the post-walk register.
- `fix(cli): route daemon stdout/stderr to ~/.coodra/logs/` — `doctor check 8 (F15)` now has logs to read.

## Post-merge cleanup (separate commits)

The next seven commits extended the CLI surface as Module 03.1 / functest-cleanup / Module 04a landed. Each is named here as a doc reconciliation entry; the canonical spec for the surrounding module lives under `docs/feature-packs/<module>/`.

### Post-S9.1 — PID-aware doctor + cli helper script (landed 2026-04-27, commit `64e4067`)

**Scope:** Phase 2 negative-control "stop the bridge" returned YELLOW from doctor checks 10/11; that's no signal for ops. Bumped both checks to be PID-aware: RED on crash (PID file present, process gone), YELLOW on never-started (no PID file). Added `bin/cli` dev helper for running the CLI from source without `npm i -g`, plus a comment clarifying the executable-bit shebang requirement.

**What landed:**

- `packages/cli/src/doctor/checks/{10-mcp-healthz,11-bridge-healthz}.ts` — PID-file inspection + crash/never-started discrimination.
- `packages/cli/bin/cli` — dev helper.

**Commit:** `chore(post-08a-cleanup): PID-aware doctor + cli helper script + executable-bit comment (#3)` (`64e4067`).

### Post-S9.2 — Module 03.1 outbox extends the CLI surface (landed 2026-04-28, commit `313d6f0`)

**Scope:** Module 03.1 (durable audit outbox) is its own module per `docs/feature-packs/03.1-durable-outbox/`, but its `OutboxWorker` is consumed by the CLI's `start` flow + new doctor checks 21/22/23 lock the pending-jobs depth / oldest / dead-letter invariants. Doctor check 13's audit-write durability flips from permanent YELLOW to GREEN automatically.

**What landed in `packages/cli/`:**

- `packages/cli/src/lib/outbox/{backoff,dispatcher,index,types,worker}.ts` — full OutboxWorker landing.
- `packages/cli/src/doctor/checks/{21-pending-jobs-depth,22-pending-jobs-oldest,23-pending-jobs-dead-letter}.ts`.
- `packages/cli/src/doctor/checks/13-audit-durability.ts` — flips to GREEN once M03.1 is wired.
- `packages/cli/__tests__/unit/outbox/{backoff,worker}.test.ts` (~46 + 374 tests respectively).

**Commit:** `feat(module-03.1): durable audit outbox — pending_jobs + OutboxWorker + crash-safety AC (#4)` (`313d6f0`).

### Post-S9.3 — Layered .env loader (Finding A from 2026-04-28 functest) (landed 2026-04-28, commits `6d16b2c` + `6bc0cad` + `0c0768a`)

**Scope:** Functest 2026-04-28 surfaced Finding A: `init` writes `.env` but `resolveServices` doesn't load it before spawning daemons; the spawned bridge sees empty `LOCAL_HOOK_SECRET`. Two-layer fix landed across three commits.

**What landed in `packages/cli/`:**

- `packages/cli/src/lib/services.ts` — layered `.env` reading (`<cwd>/.env` + `<coodra-home>/.env` overlays); spawn env composition order pinned.
- `packages/cli/__tests__/unit/services.test.ts` — env-layering test suite (cwd-mocked so it doesn't read the runner's repo-root `.env`).
- Bridge solo-bypass treats `COODRA_MODE=solo` the same as the sentinel CLERK key (lands inside `apps/hooks-bridge`, mentioned here for the cwd-CLI repo-root resolution side-effect).

**Commits:**

- `chore(post-functest-cleanup): bridge solo-bypass + dotenv-load + CLI-path repo root + skip broken e2e + docs` (`6d16b2c`).
- `chore(finding-a-env-loader-path): layered .env loader — closes Finding A from 2026-04-28 functest` (`6bc0cad`).
- `test(cli): make resolveServices env-layering tests cwd-independent` (`0c0768a`).

### Post-S9.4 — Pipefail-safe doctor + biome template lit (landed 2026-04-28, commit `d7a3238`)

**Scope:** Two quality fixes from `verify-full-functionality.sh` running on a real Coodra checkout. Step 9's negative-controls used `if coodra doctor 2>&1 | grep -qE "..."` which under `set -o pipefail` masked nonzero exits behind `grep -q`'s success; switched to a temp-file capture pattern. Biome template-literal hint in a doctor output formatter cleaned up.

**Commit:** `chore(verify-full-functionality): pipefail-safe doctor checks + biome template lit` (`d7a3238`).

### Post-S9.5 — Module 04a sync daemon + cloud-migrate command (landed 2026-04-28, commit `907db6a`)

**Scope:** Module 04a (sync daemon + self-host packaging) is its own module per `docs/feature-packs/04a-sync-daemon/`, but its sync-aware doctor checks + the new `cloud-migrate` command land inside `packages/cli/`.

**What landed in `packages/cli/`:**

- `packages/cli/src/commands/cloud-migrate.ts` — applies Drizzle Postgres migrations to the cloud `DATABASE_URL` for team-mode self-host operators. Idempotent, refuses to run if unknown tables contain data (Module 04a OQ4 closure).
- `packages/cli/src/doctor/checks/{24-cloud-reachability,25-sync-queue-depth,26-sync-lag,27-sync-dead-letter}.ts` — team-mode-only invariants for the sync daemon (essential-set tagging unchanged; these stay opt-in via `--full`).
- `packages/cli/src/doctor/checks/{17-port-3100,18-port-3101}.ts` extended for the sync-daemon port surface.
- `packages/cli/src/lib/services.ts` extended with the `sync-daemon` service entry + `--no-sync` start-flag handling.
- `packages/cli/__tests__/integration/cloud-migrate.test.ts` (~181-line suite) + extensions to `unit/{help-output,outbox/worker,program,services}.test.ts`.

**Commit:** `feat(module-04a): sync daemon + self-host packaging (#5)` (`907db6a`).

## After M08a — what gets unblocked

- Module 04 (Web App) can build its onboarding flow knowing the CLI exists. The web app's "Get Started" page reduces to "run `npx @coodra/cli init` then `coodra team login <invite-token>` (when team mode opens)" — exact CLI name locked per spec §11 Decision 1.
- Module 07 (VS Code Extension) can shell out to `coodra start` / `stop` / `status` for service control without re-implementing daemon management.
- The `pending-user-actions.md` entry "LOCAL_HOOK_SECRET config-file reads via a future coodra team login CLI" updates to "command surface lives in 08a as stub; OAuth round-trip + secret-write body land when team mode opens" — fully closes when team mode launches.

## Per-slice integration-harness gate (recap)

Slices that touch DB / bridge config / auto-migrate paths must leave both manual harnesses green at slice end. Map:

| Slice | Touches | Harness must pass after slice |
|---|---|---|
| S3 (doctor) | reads DB, reads bridge logs | `verify-f5-live.ts` (no impact expected) |
| S5 (init) | writes DB, writes `.coodra.json`, writes `.mcp.json`, writes `.env` | `verify-phase5-closed-loop.ts` against the just-init'd project |
| S7 (start/stop) | starts/stops bridge + MCP | `verify-phase5-closed-loop.ts` end-to-end |
| S8 (status) | reads bridge + MCP via /healthz | both harnesses |

If a harness regresses, the slice does not commit. Fix-or-revert before proceeding.

## Doc reconciliations applied in this module's commits

- `system-architecture.md §13` "Process management: PIDs written to `~/.coodra/pids`" expanded to "PIDs written to `~/.coodra/pids/`; on macOS / Linux the daemon is also registered with the platform's native manager (launchd / systemd) so it survives reboot." Same-commit edit per amendment B at S6 / S7.
- `system-architecture.md §1` amended at S5 per spec §11 Decision 2 ("`~/.coodra/` may resolve to `$XDG_CONFIG_HOME/coodra/` on Linux when set; defaults to `$HOME/.coodra/` everywhere otherwise").
- `essentialsforclaude/08-implementation-order.md` §8.1 inserts Module 08a between 03 and 04 — confirmed during S0 that this stayed correct after the M03.1 placeholder landed.

## Remaining slice surface

**None in the original M08a plan.** S0–S9 + the same-merge integration-walk fixes + the five post-merge follow-ups are all committed at HEAD `907db6a`.

Cross-cutting work that touched `packages/cli/` after `907db6a` (uncommitted at the time of this 2026-05-02 reconciliation) is **not** new M08a slice surface — it lives in M02/M03 / cross-cutting-fix scope:

- **Phase 2 (decision `dec_83ba10c1`, 2026-05-02)** — bridge-mediated autonomous Feature Pack injection at SessionStart and Context Pack auto-save at SessionEnd. Bulk of the work is in `apps/hooks-bridge/`; `packages/cli/` touches limited to wiring `~/.claude/settings.json` writes through `init`. Saved as MCP context pack `cp_715762ac`.
- **Phase 3 (rename + Fixes A–E, 2026-05-02)** — workspace-wide `@coodra/*` → `@coodra/*` rename (252 files), `.strict()` → `.passthrough()` payload schema fix (M02/shared), `~/.claude` gate drop in `init`, `implementation.md` + `techstack.md` seeded by `seedFeaturePack` (M08a), default policy rules seeded after `ensureProject` (M08a wires `ensureDefaultPolicy` from M01-db), drop cyclic devDependencies. Saved as MCP context pack `cp_c21520f2`.

- **Phase 4 Fix F (2026-05-02 — caught during demo rehearsal)** — the Phase 3 Fix D `ensureDefaultPolicy` rule list covered only Write+Edit and root-level globs, leaving MultiEdit/NotebookEdit and nested `.git/`/`node_modules/` paths unenforced; the Phase 3 `claude-settings-merge` matcher used the literal sentinel `__coodra__` which never matched any real Claude Code tool name, making PreToolUse hooks functionally inert for that agent. Fix F:
  - Expanded `DEFAULT_RULES` to 25 entries (24 deny + 1 ask) covering the cross-product of {Write, Edit, MultiEdit, NotebookEdit} × {.env, **/.env, .git/**, **/.git/**, node_modules/**, **/node_modules/**}.
  - Made `ensureDefaultPolicy` self-healing on re-run: existing-install repair detects missing-from-baseline rules by `(priority, eventType, toolName, pathGlob)` 4-tuple and additively inserts only the missing ones; user customizations preserved.
  - Switched the Claude Code matcher to per-event values: `Write|Edit|MultiEdit|NotebookEdit|Bash` for PreToolUse/PostToolUse, omitted for SessionStart/Stop. Ownership detection moved from matcher-by-sentinel to URL-by-bridge-endpoint; legacy `__coodra__`-matcher entries with the bridge URL get migrated to the new shape on next merge.
  - Added regression test `apps/hooks-bridge/__tests__/integration/handlers/default-policy-tool-coverage.test.ts` (4 tools × 6 paths + 1 sanity = 25 cases). Pre-fix: 16 failed / 9 passed. Post-fix: 25 passed / 0 failed.
  - Extended `__tests__/manual/verify-f5-live.ts` with Edit/MultiEdit/NotebookEdit live MCP-stdio cases.
  - Decision logged in `context_memory/decisions-log.md` 2026-05-02 23:30.

When that cross-cutting work commits, it lands as `feat(workspace): rename @coodra/* → @coodra/*` + per-fix commits — not as new M08a slices.
