# Module 08a — CLI (`@coodra/cli`) — Spec

> **Status:** in progress on `feat/08a-cli` (refined 2026-04-27 after M03 post-merge findings F7–F15 landed; open-question sign-off landed 2026-04-27 — see §11).
> **Depends on:** 01 Foundation, 02 MCP Server, 03 Hooks Bridge
> **Blocks:** 04 Web App (the web app's onboarding flow is tested end-to-end via the CLI), 07 VS Code Extension (the extension shells out to the CLI for daemon lifecycle)
> **Aware of:** Module 03.1 (Durable Audit Outbox) placeholder — `coodra doctor` surfaces "audit writes are still `setImmediate`-based" as a YELLOW warn until M03.1 lands. See `docs/feature-packs/03.1-durable-outbox/spec.md`.
> **Source of truth:** `system-architecture.md` §1 (two-mode), §13 (Server Setup), §19 (Auth — `LOCAL_HOOK_SECRET` config-file path), `essentialsforclaude/02-agent-human-boundary.md` §2.4 (sentinels vs real values), `essentialsforclaude/08-implementation-order.md`. M02 closeout pack §8.5 (the deferred first-run UX gap that named this module). M03 closeout pack §"Post-merge integration findings" (F7–F15 — `coodra doctor` surfaces the integration seams those findings exposed).

## 1. What `@coodra/cli` is

A single Node.js CLI installed via `npm i -g @coodra/cli` (or `npx @coodra/cli <cmd>` for one-shot use) that takes a developer from **zero** to **a working Coodra install on their machine** in under 90 seconds, without manual `.mcp.json` editing, build steps, or service-orchestration knowledge.

It is the only supported install path. After Module 08a ships, no documentation page should ever instruct a user to "clone the repo, `pnpm install`, build, then edit `.mcp.json`" — that path remains valid for Coodra contributors but is removed from the user-facing onboarding.

The CLI is **the system's UX surface for setup and lifecycle management**. The Web App (Module 04) and VS Code Extension (Module 07) are the surfaces for daily use; the CLI handles install, configure, start, stop, diagnose, and team-join.

## 2. Acceptance criteria

Module 08a is "complete" when **every** item below holds on a clean machine:

1. `npx @coodra/cli init` in any project root completes in under 90 seconds for a 50k-line codebase, with no questions asked, and produces a working Coodra install (Claude Code or Cursor sees the `coodra__*` tools after IDE restart).
2. `coodra start` launches the MCP Server (Module 02) and Hooks Bridge (Module 03) as background daemons via the platform's native daemon manager (launchd on macOS, systemd on Linux, Task Scheduler on Windows). Falls back to a detached child process when no daemon manager is reachable. Writes PIDs to `~/.coodra/pids/`.
3. `coodra stop` reliably terminates every service started by `start`. Idempotent (safe to call when nothing is running).
4. `coodra status` prints a per-service report (`MCP Server: running on :3100, PID 41234, uptime 4m20s`) in under 200 ms. No state is implied — every line is a live probe.
5. `coodra doctor` runs ≥10 health checks (Node version, pnpm presence if needed, port availability, `~/.coodra/data.db` writability, `.mcp.json` validity, IDE detection, daemon-manager reachability, etc.) and prints a numbered report with **green/yellow/red** status per check + a one-line remediation when red.
6. `coodra team join <token>` (stub in 08a — full flow lands when team mode is reachable) fails cleanly with a clear "team mode not yet generally available" message and exit code 2. The command, flag set, and help text exist in 08a so the surface is stable; the OAuth round-trip is wired in the team-mode-launch slice.
7. `coodra --version` prints the published version. `coodra --help` prints a compact command list. Every subcommand supports `--help` with its own help block.
8. The CLI **never** writes secrets to logs (the `LOCAL_HOOK_SECRET` lifecycle in particular). The CLI **never** asks the user to paste a secret into the terminal — secrets land via `~/.coodra/config.json` (file-mode `0600`) or env var only.
9. `pnpm --filter @coodra/cli test:unit` passes with ≥ 80% line coverage on `src/`. Integration tests cover at minimum: `init` against a tmp project, `start`/`stop` lifecycle on macOS+Linux runners (Windows runner deferred to 08a follow-up), `doctor` against three known-broken states.
10. Module 08a Context Pack saved to `docs/context-packs/YYYY-MM-DD-module-08a-cli.md` per `essentialsforclaude/08-implementation-order.md` §8.4.

## 3. Non-goals

These are deliberately excluded from Module 08a and are **not** stubbed:

- **No marketing site, no landing page, no `coodra.dev` HTML.** The user explicitly removed marketing/distribution-site work from the project scope (decisions-log 2026-04-24 — "we are not making the landing page here, only the system"). The CLI is published to npm; discovery happens via README + word of mouth + (later) the Anthropic MCP marketplace listing. None of that lives in this repo.
- **No billing, no Stripe, no seat management, no usage metering.** Decisions-log 2026-04-24 locked "forget about monetary setup, only focus on building the working product." Subscription/usage tables stay out of every module spec including this one.
- **No npm-publish automation in 08a.** The package builds and runs locally; the publish-flag-day decision (npm scope, semver gating, release notes) is a separate ops task tracked in `pending-user-actions.md`.
- **No `team join` OAuth round-trip in 08a.** The command, help text, and exit codes exist for surface stability, but the actual Clerk-mediated browser OAuth dance lands when team mode is reachable end-to-end. Until then, the command exits with `code 2` and a clear message.
- **No Windows daemon-manager (Task Scheduler) parity in 08a's CI matrix.** macOS (launchd) and Linux (systemd) are required. Windows ships best-effort with detached-child fallback; full Task Scheduler integration is an 08a follow-up, tracked in the Module 08a Context Pack's "what should be built next" section.
- **No installer GUI, no `.dmg`, no `.exe`.** Pure CLI via npm.
- **No telemetry / phone-home.** Zero outbound network calls during `init` / `start` / `stop` / `status` / `doctor` other than (a) optional Graphify scan of the local repo, (b) optional version-check against `npm view @coodra/cli version` gated behind a `--check-updates` flag (default off).
- **No automatic updates.** Users run `npm i -g @coodra/cli@latest` to update. Update detection is opt-in.

## 4. Commands — the surface

| Command | Purpose | Exit codes |
|---|---|---|
| `coodra init [--project-slug <slug>] [--ide <claude\|cursor\|both>] [--no-graphify] [--dry-run] [--force]` | Creates `~/.coodra/{data.db,config.json,logs/,pids/}` (config.json absent until `team login`); writes a starter `.env` with solo-mode sentinels per `essentialsforclaude/02-agent-human-boundary.md` §2.4; runs auto-migrate against the local SQLite (and `ensureGlobalProject` per F7); writes/merges `.mcp.json` + writes the project's `.coodra.json`; creates `docs/feature-packs/<slug>/` with seeded `meta.json` + `spec.md` skeleton; optionally invokes Graphify. Re-run is **idempotent merge by default** — each file is inspected, left alone if already correct, merged if drift is detected, never destroying user edits. `--force` overrides to baseline (destructive). See §11 Decision 3. | 0 ok / 1 detection-failed / 2 user-input-needed / 3 file-collision-needs-`--force` |
| `coodra start [--no-mcp] [--no-hooks] [--foreground]` | Launches background daemons via the platform's native manager. `--foreground` runs attached for debugging. | 0 ok / 1 already-running / 2 port-in-use / 3 daemon-manager-unreachable / 4 service-startup-failed |
| `coodra stop [--service <name>]` | Stops every (or named) running service. Idempotent. | 0 ok-or-nothing-was-running |
| `coodra doctor [--json]` | Strictly **read-only** health check in 08a — no `--fix` mode (see §11 Decision 4). Walks the integration seams M03's post-merge findings exposed (F7–F15 invariants) plus generic environment checks. Output severity-tagged `green ✓ / yellow ⚠ / red ✗` like the M03 F-fix register. See §4.5. | 0 all-green / 1 yellows-only / 2 reds-present |
| `coodra status [--json]` | Unified state probe — both project-state (registered project for cwd, recent runs, last decision, pending blockers from `context_memory/blockers.md`) AND service-state (live probe of MCP server + hooks bridge). One command, structured output. The user-facing answer to "where am I?". | 0 all-running-and-registered / 1 some-down-or-unregistered / 2 nothing-running |
| `coodra team login <token> [--server <url>]` | **Stub in 08a** per §11 Decision 1 — full flag set + help text + exit-code 2 message ("team mode not yet generally available"). Naming locked to `team login` (matches M02 §8.6 carryover; "login" reads more naturally than "join" in the auth context). Body — invite-token exchange + `~/.coodra/config.json` write (mode `0600`) per §19 — lands when team mode is reachable end-to-end. | 0 (when implemented) / 2 (08a stub) |
| `coodra team logout` | **Stub in 08a** per §11 Decision 1 — same surface, same exit-2 stub. Body (rotate local secret + clear `~/.coodra/config.json`) lands alongside `team login`. | 0 (when implemented) / 2 (08a stub) |
| `coodra --version` | Prints the npm version. | 0 |
| `coodra --help` / `coodra <cmd> --help` | Help text. | 0 |

Every command must:
- Be idempotent where the operation has a single intended end-state (`start`, `stop`, `init` per §11 Decision 3).
- Print human output by default and JSON output behind `--json` (where applicable) for shell-script consumers.
- Exit with a non-zero code on any failure that requires user action; never `process.exit(1)` silently.
- Log to `~/.coodra/logs/<command>-YYYY-MM-DD.log` in addition to stderr.
- **Never write secrets to logs** — the `LOCAL_HOOK_SECRET` lifecycle in particular. Log lines that touch it must redact via the shared `@coodra/shared` logger's redaction config.

## 4.1 What `coodra init` writes — sentinels vs real values per §2.4

Per `essentialsforclaude/02-agent-human-boundary.md` §2.4, the CLI writes **dev/dummy sentinels only** to the starter `.env`. Production values are the user's to provide via `team login` (when implemented) or by hand-editing `.env`. Specifically:

| File | Purpose | What `init` writes |
|---|---|---|
| `~/.coodra/data.db` | Local SQLite primary store | empty file with all migrations applied + `__global__` sentinel project seeded (F7) |
| `~/.coodra/config.json` | Team-mode `LOCAL_HOOK_SECRET` (mode `0600` per §19) | **absent after `init`** — only `team login` writes this file |
| `<repo>/.env` (or merge) | Solo-mode env vars | `COODRA_MODE=solo`, `CLERK_SECRET_KEY=sk_test_replace_me` (sentinel from §19), `CLERK_PUBLISHABLE_KEY=pk_test_replace_me`, `LOCAL_HOOK_SECRET=<random hex generated at init time, solo-only>`, `MCP_SERVER_PORT=3100`, `HOOKS_BRIDGE_PORT=3101`. **Not written:** `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `GITHUB_APP_*`, `ATLASSIAN_*`, `SUPABASE_*`, `UPSTASH_*` — all are user-action items per §2.2 and the existing `pending-user-actions.md` entries. |
| `<repo>/.coodra.json` | Bridge's `projectSlugResolver` config | `{ "projectSlug": "<derived or --project-slug>" }` |
| `<repo>/.mcp.json` | Claude Code / IDE MCP server registration | merges a `coodra` entry into `mcpServers`; existing servers preserved; conflicting `coodra` entry triggers idempotent merge per §11 Decision 3 (existing entry inspected and left alone if already correct, drift triggers merge, `--force` overrides to baseline) |

The `LOCAL_HOOK_SECRET` written by `init` to a project-local `.env` is **solo-mode-only** and per-project. Team mode reuses the user-level `~/.coodra/config.json` value across projects. Both are random hex generated by `crypto.randomBytes(32).toString('hex')`; neither is ever a hardcoded sentinel (per §2.4 — secrets the agent generates locally for its own dev bypass are fine; secrets that authenticate against a real service are not).

## 4.5 `coodra doctor` — what each check surfaces

Doctor's job is to make M01+M02+M03's invariants observable. Each check maps to either an environment requirement or a finding from the M03 post-merge integration walk (F7–F15).

| # | Check | Severity scale | What it surfaces |
|---|---|---|---|
| 1 | Node version ≥ 22.16.0 | red | Repo engine requirement. |
| 2 | `~/.coodra/` directory exists, writable, mode `0700` | red | First-run UX gate; `init` must have run. |
| 3 | `~/.coodra/data.db` opens via `@coodra/db::createDb({kind:'local'})` | red | DB integrity; M03 F11 reminder that this binary is SQLite-only. |
| 4 | DB migrations are at head (`__drizzle_migrations` matches latest) | red | Missing `init` step or partial upgrade. |
| 5 | `__global__` sentinel project row exists in `projects` (F7 invariant) | red | F7 closure live; if missing, audit-on-unregistered-cwd path is broken. |
| 6 | Recent (last 100) `policy_decisions` rows have `idempotency_key` matching `^pd:[^:]+:[^:]+:[^:]+:.+$` (F14 shape — 4 segments after `pd:`) | yellow | F14 closure live; legacy 3-segment rows surface as YELLOW with a one-liner "regenerate via `init --force`-style migration only if needed." |
| 7 | Recent (last 100) `run_events` rows have `run_id NOT NULL` when their session has a `runs` row (F8 invariant) | yellow | F8 closure live; pre-fix orphans land yellow with the count. |
| 8 | Bridge `pre_tool_use_decision` log lines from the last 24h include `runId` field (F15 spot-check via `~/.coodra/logs/`) | yellow | F15 closure live; reads the bridge's pino-rotated logs. |
| 9 | MCP server reachable on stdio (spawn `--transport stdio`, send `initialize`, await reply within 2s) | red | Module 02 wire-up. |
| 10 | MCP server HTTP `/healthz` 200 OK on `MCP_SERVER_PORT` if the daemon is supposed to be running (skipped if `start` never ran) | yellow | Module 02 HTTP transport. |
| 11 | Hooks bridge `/healthz` 200 OK on `HOOKS_BRIDGE_PORT` | yellow | Module 03 wire-up. |
| 12 | Project registered for `cwd` — `.coodra.json` parses, slug resolves to a `projects` row | yellow | Pre-condition for governance — without this, the bridge falls to `__global__` (still audited per F7 but project-specific rules don't fire). |
| 13 | Audit-write durability — **YELLOW until M03.1 (Durable Audit Outbox) lands**. Reports "Audit writes are still `setImmediate`-based; SIGTERM mid-PreToolUse can lose a row. See `docs/feature-packs/03.1-durable-outbox/`." | yellow (permanent until M03.1) | Module 03.1 awareness — keeps the M03 known-issues entry visible to operators. |
| 14 | `.mcp.json` parses as JSON if present + the `coodra` entry's `command` path resolves on disk | yellow | Catches the `npx`-cache-GC footgun named in `techstack.md` Gotchas. |
| 15 | IDE detection: `~/.claude/` OR `~/.cursor/` OR `~/.windsurf/` exists | yellow | Pre-condition for hooks to fire. |
| 16 | Daemon-manager reachability (`launchctl` macOS / `systemctl --user` Linux / fallback Windows) | yellow | Required for `start --background` survival across reboot. |
| 17 | Port 3100 (MCP) availability when nothing is registered as `start`ed | yellow | Catches a stray non-Coodra process binding the port. |
| 18 | Port 3101 (Hooks) availability — same | yellow | — |
| 19 | `pnpm` reachable on PATH | green/yellow | Yellow only when install method is `dev-monorepo`; green-or-skipped otherwise. |
| 20 | `LOCAL_HOOK_SECRET` set (env or `~/.coodra/config.json`) AND length ≥ 32 hex chars | yellow | Bridge auth chain pre-condition. The CLI does NOT print the secret — only its length and source. |

`doctor` is strictly **read-only** in 08a per §11 Decision 4 — no `--fix` flag, no auto-remediation. Every red maps to either `init` (run it) or a documented one-liner. Output format is severity-tagged `green ✓ / yellow ⚠ / red ✗`, one-line remediation per non-green. `--json` emits `{ checks: [{ id, name, status, remediation? }], summary: { ok, warn, fail }, version }`. Reds-present → exit 2; yellows-only → exit 1; all-green → exit 0.

The 20 checks above are the **floor**, not the ceiling. Each module that lands after 08a may add its own check rows in the same registry — Module 04 adds web-app-reachability, Module 05 adds NL Assembly health, Module 06 adds Semantic Diff, etc. The `Check` interface is open for extension; `doctor` is the long-term operational entry point.

## 4.6 `coodra status` — unified state in one screen

```
$ coodra status
Project   myapp                          (registered ✓ — slug 'myapp', projectId proj_a1b2…)
Cwd       /Users/you/work/myapp
Mode      solo

Services
  MCP Server     running   :3100  PID 41234   uptime 4m20s
  Hooks Bridge   running   :3101  PID 41235   uptime 4m18s

Recent
  Last run         2026-04-27 11:32  status=in_progress   agent=claude_code
  Last decision    2026-04-27 11:32  "include toolUseId in audit key"
  Pending blocker  context_memory/blockers.md is empty ✓

Run `coodra doctor` for the full diagnostic.
```

`--json` emits the same five sections as a structured object. `status` is read-only; live-probes services every call (no cache).

## 5. The "first 5 minutes" — the experience this spec is buying

```
$ npx @coodra/cli init
✓ Detected project: TypeScript monorepo at /Users/you/work/myapp
✓ Detected IDE: Claude Code (~/.claude/ exists)
✓ Detected: existing .mcp.json (merging, original backed up to .mcp.json.bak)
✓ Running Graphify scan (12s)... 47 modules, 312 symbols
✓ Seeded Feature Pack: docs/feature-packs/myapp/ (spec.md + meta.json)
✓ Wrote .mcp.json
✓ Started local services: MCP Server (3100), Hooks Bridge (3101)
✓ Registered launchd entry: com.coodra.local (auto-starts at login)

Coodra is ready.
  → Open Claude Code → run /mcp to verify.
  → Run `coodra doctor` if anything misbehaves.
  → First Context Pack saves automatically at session end.
```

A user who has never read the Coodra docs can complete this. That is the bar.

## 6. What the CLI is NOT allowed to do (agent-human boundary)

Per `essentialsforclaude/02-agent-human-boundary.md` §2.2, the CLI never:

- Generates or invents production secrets. `LOCAL_HOOK_SECRET` for team mode comes from `team join <token>` (later) or env var; the CLI never fabricates one.
- Deploys to any cloud account.
- Modifies cloud infrastructure.
- Posts to GitHub/JIRA/Slack/email on the user's behalf without an explicit `--post` flag and confirmation.
- Sends telemetry without explicit opt-in.
- Auto-updates itself.

These rules are tested: a unit test grep-scans the CLI source for `process.env.STRIPE_*`, `process.env.ANTHROPIC_*`, `axios.post`, `fetch(.*post`, etc., and fails if any unauthorized network call sneaks in.

## 7. Out-of-scope documentation stance

`system-architecture.md §13` already describes the shape of `coodra start` for solo mode. Module 08a is the implementation of that section. Where §13 says "Process management: PIDs written to `~/.coodra/pids`", Module 08a expands that into the platform-native daemon-manager integration (launchd / systemd / Task Scheduler) and amends §13 in the same commit per amendment B.

`system-architecture.md §19` says `LOCAL_HOOK_SECRET` lives in `~/.coodra/config.json`. Module 08a's `team join` command is the writer of that file (in a future slice when team mode reaches GA); the CLI's read-path for 08a remains env-var-only because the OAuth round-trip is not yet wired. The `pending-user-actions.md` entry "LOCAL_HOOK_SECRET config-file reads" updates to point at this module.

## 8. What "done" hands off to Modules 04 and 07

- A working `coodra init` that downstream module specs can refer to as "the install path" without qualification.
- A working `coodra start` / `stop` lifecycle that the VS Code Extension (Module 07) shells out to for service control.
- A `coodra doctor` checklist that the Web App (Module 04) can render in its admin panel via JSON output.
- A `team login` surface (stub in 08a per §11 Decision 1) that the team-mode-launch slice fills in without changing the command name, flags, or exit codes.
- A Module 08a Context Pack describing all of the above.

## 11. Locked design decisions (signed off 2026-04-27)

The five open questions raised at M08a kickoff are now locked. Each subsection records the question, the chosen answer, and the constraints the answer puts on later slices. These decisions become same-commit edits to this spec (S0 commit `docs(08a-cli): lock open-question answers from kickoff sign-off`).

### Decision 1 — `coodra team login` ships as a stub in 08a

- **Question (was):** Is the team-mode auth command in 08a scope, and what is its name?
- **Decision:** Land both `team login` and `team logout` as **stubs in 08a** with the full flag set + help text + exit-code 2 message ("team mode not yet generally available"). The OAuth round-trip + secret-write body land when team mode is reachable end-to-end (post-M04). **Naming locked to `team login`** (matches the M02 §8.6 carryover; "login" reads more naturally than "join" in the auth context). The placeholder draft's `team join` is renamed in the same edit.
- **Why this answer:** Locking the surface in 08a means M04 (Web App) integrates against a stable command name + flag set + exit-code contract. Surfaces don't churn when the body fills in. The OAuth body genuinely depends on team mode being reachable, so deferring the body itself is correct, not a shortcut.
- **What this constrains:** S8 ships the stub; the secret-write path is explicitly NOT in 08a's surface. `pending-user-actions.md`'s "LOCAL_HOOK_SECRET config-file reads via a future coodra team login CLI" entry updates to "command surface lives in 08a; OAuth round-trip lands when team mode opens."

### Decision 2 — XDG on Linux when set, `$HOME/.coodra/` default elsewhere

- **Question (was):** Where does `~/.coodra/` resolve cross-platform?
- **Decision:** Honor `$XDG_CONFIG_HOME` on Linux when set, default to `$HOME/.coodra/` everywhere otherwise (including Windows). Resolution lives in a single path helper using `env-paths` (configured `{ suffix: '' }` to drop the default `-nodejs` suffix).
- **Why this answer:** Linux XDG-respect costs ~5 lines and matches the platform's documented convention; Linux desktop environments increasingly enforce XDG. Windows `%APPDATA%` integration is genuinely non-trivial (paths cross drive letters, forward-slash support varies in npm-shipped Node tools) — defer to a future slice if a Windows user complains. The architecture spec's `~/.coodra/` mentions stay correct because they specify the default; the XDG override is a feature, not a contradiction. `system-architecture.md §1` gets a same-commit clarification at S5.
- **What this constrains:** S5 reads the path through `env-paths`, never hardcodes `path.join(os.homedir(), '.coodra')`. S3 doctor uses the same helper so the check that probes `~/.coodra/data.db` finds the file at the right place on Linux+XDG.

### Decision 3 — Idempotent merge by default; `--force` is the destructive override

- **Question (was):** What's the `init` re-run behavior?
- **Decision:** Re-run inspects each file (`.mcp.json`, `.coodra.json`, `<repo>/.env`, `docs/feature-packs/<slug>/`), leaves it alone if already correct, merges only if drift detected, never destroys user edits. `--force` overrides to baseline (destructive — writes the baseline, loses user edits). Re-run with no flags is always safe.
- **Why this answer:** Matches the M02 verification F13 closure mindset (`save_context_pack` defaults to `~/.coodra/packs/` so re-runs are non-destructive by default). Re-running `init` after a pack update, a Module-04-led reinstall, or a CI provisioning step must be safe. Option (b) prompt-and-skip-per-file would re-introduce the `prompts` dep that techstack.md declines — and friendly prompts don't compose with `--json` / non-TTY use. Option (c) hard-refuse-without-`--force` is harsh on first-time re-runners and makes scripted setups fragile.
- **What this constrains:** S5 implements per-file diff/merge logic for each artifact. `prompts` stays out of `techstack.md`. The `init` JSON output schema includes a per-file `action: 'wrote' | 'merged' | 'unchanged' | 'forced'` field so CI consumers can reason about what changed.

### Decision 4 — Doctor is strictly read-only in 08a

- **Question (was):** Should `doctor` ever auto-fix?
- **Decision:** Strictly **read-only** in 08a — no `--fix` flag, no auto-remediation. Every red finding maps to either `init` (re-run it) or a documented one-liner remediation in the check's `remediation` field.
- **Why this answer:** Adding `--fix` doubles the test matrix (each check needs its fix tested AND its detection tested) and introduces silent-recovery footguns: a `doctor --fix` that flips a check from red to green can mask the underlying install bug that caused the red. Read-only doctor is also predictable for CI usage (`doctor --json | jq` is safe to run in pipelines without unintended side effects). If user demand for `--fix` surfaces post-launch, add in a follow-up slice with the design-cost paid then.
- **What this constrains:** S3 implements the 20 checks per §4.5 with `remediation` strings only. No write paths in any check. The Check interface does not include a `fix()` method. `doctor --json` schema does not include a "would-fix" field.

### Decision 5 — Standalone npm package `@coodra/cli` (publish step out of 08a scope)

- **Question (was):** Is the CLI a workspace-only bin, or a published npm package?
- **Decision:** Standalone npm package, scope `@coodra`, package `@coodra/cli`. The package builds and runs locally in 08a. `package.json` ships with `bin`, `files`, `engines`, `repository`, `publishConfig`. **Publication itself is out of 08a scope** (per existing non-goals §3) — `pending-user-actions.md`'s "publish-flag-day" entry remains a separate ops task. S9 locks the `npm pack --dry-run` file list with a unit test so the published tarball shape is stable when the publish-flag-day comes.
- **Why this answer:** Matches the existing `pending-user-actions.md` npm-scope-claim entry (2026-04-24). The `init` UX (`npx @coodra/cli init` for one-shot, `npm i -g` for repeat use) matches every comparable tool (vite, eslint, npm itself). Building the package shape now means the publish-flag-day is a "log in to npm and run `pnpm publish`" event — no scrambling to add `bin` / `files` then.
- **What this constrains:** S1 `package.json` includes `bin` + `files` + `engines` + `repository` + `publishConfig` from day one. S9 locks the file list. The contributor dev-loop (DEVELOPMENT.md §"Iterating on the CLI") describes how to invoke the CLI without `npm i -g`: `pnpm --filter @coodra/cli build && pnpm --filter @coodra/cli cli init`. No new build tool — same TS pipeline as every other workspace package.
