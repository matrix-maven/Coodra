# Module 08a — CLI — Tech Stack

> Read `spec.md` and `implementation.md` first. Pinned versions here MUST match `External api and library reference.md`. Any version bump is amendment-B (same-commit doc edit).

> **OQs 1–5 locked 2026-04-27** (see `spec.md` §11). The two questions that fed this file are resolved: Decision 3 (idempotent merge by default) means `prompts` stays declined; Decision 5 (standalone npm package `@coodra/cli`) means `package.json` ships with `bin` + `files` + `engines` + `repository` + `publishConfig` from S1. The deps tables below are now final.

> **`External api and library reference.md` updates land in S1, not here.** The deps below are spec'd, not yet installed. S1 (the package scaffold commit) installs them via `pnpm --filter @coodra/cli add <dep>@<pin>`, which lands the pin into `package.json` and `pnpm-lock.yaml` simultaneously. The library reference's entry-style — multi-paragraph treatment with verified code snippets and gotchas — only earns its place once the dep has been used in practice. So S1 commits the install + the reference entries together; the entries are stubs until then. None of the M08a deps are currently in the library reference (`commander`, `picocolors`, `execa`, `glob`, `env-paths`, `tmp-promise` for tests). `prompts` is excluded per Decision 3.

## Runtime

| Choice | Pin | Rationale |
|---|---|---|
| Node.js | ≥22.16.0 (per repo `.nvmrc`) | Already pinned at the repo root; the CLI shares the engine constraint with every other TypeScript package. |
| Module system | ESM (`"type": "module"`) | Matches the rest of the monorepo; no CommonJS-only deps in 08a. |
| TypeScript | `^6.0.3` (matches root pin) | Repo standard. |

## Direct dependencies (production)

| Library | Pin | Why this one |
|---|---|---|
| `commander` | `^13.1.0` | The de facto Node CLI framework. Stable subcommand + flag + help-text API. Smaller than `yargs`, more ergonomic than `meow` for nested commands. Used by `npm`, `eslint`, `vite`. **Considered alternative: `node:util` parseArgs** — built-in, zero-dep, but no nested-subcommand support, no auto-help-text generation, no exit-code enforcement. Acceptable for a 1-command CLI; insufficient for 8+ subcommands with `--help` per command. **Considered alternative: `yargs`** — feature-equivalent but ~2× the install size and a heavier learning curve. Commander wins on size + ecosystem familiarity. |
| `picocolors` | `^1.1.1` | Tiny ANSI-color helper. Already used downstream (Vitest depends on it). Zero-dep, faster than `chalk`. |
| `zod` | `^4.3.6` (workspace pin) | Validating `.mcp.json`, `meta.json`, the `team join` token shape, env vars. Same pin as `@coodra/shared`. |
| `execa` | `^9.6.0` | Spawning `launchctl`, `systemctl`, `schtasks`, `graphify` with ergonomic stdio + timeouts + cancellation. Avoids hand-rolling `child_process.spawn` boilerplate. |
| `glob` | `^11.0.4` | Project-root file scans (language detection, source-file enumeration for `meta.json` `sourceFiles`). |
| `prompts` | (excluded per spec §11 Decision 3) | Spec §5 requires zero questions on the happy path; spec §11 Decision 3 locks `init` re-run behavior to idempotent merge by default + `--force` destructive override, so the prompt-and-skip-per-file shape that would have needed `prompts` is off the table. Re-evaluate only when team-mode lands and a confirm-overwrite prompt becomes necessary. Pin if ever added: `^2.4.2`. |
| `env-paths` | `^3.0.0` | Cross-platform path resolution per spec §11 Decision 2 (XDG on Linux when `$XDG_CONFIG_HOME` is set, `$HOME/.coodra/` default elsewhere). Configured with `{ suffix: '' }` to drop the default `-nodejs` suffix so the path is exactly `~/.coodra/` (or `$XDG_CONFIG_HOME/coodra/` when XDG is set). Does NOT resolve `%APPDATA%\coodra\` on Windows by default, which matches Decision 2's "$HOME default elsewhere including Windows" line. **Considered alternative: hand-rolled `path.join(homedir(), '.coodra')`** — would work for non-XDG platforms but loses the XDG-on-Linux check. Locked decision: ship `env-paths`. |
| `@coodra/shared` | workspace | Logger, errors, env validation. The CLI MUST use the same pino logger and the same error hierarchy as every other package. |
| `@coodra/db` | workspace | The `doctor` check that probes `~/.coodra/data.db` reuses the existing SQLite open path so behavior matches what the MCP server expects. |

## Direct dependencies (dev)

| Library | Pin | Why |
|---|---|---|
| `vitest` | `^4.1.5` (workspace pin) | Repo-standard test runner. |
| `@types/node` | `^22.15.0` | Repo-standard. |
| `@vitest/coverage-v8` | matches workspace | Coverage reporting (80% gate per spec §2 AC-9). |
| `tmp-promise` | `^3.0.3` | Tmpdir setup for integration tests against fake project roots. |

## Process management — daemon manager strategy

| OS | Strategy | Why |
|---|---|---|
| macOS | `launchd` via `launchctl` (writes a `~/Library/LaunchAgents/com.coodra.<unit>.plist`) | macOS native, runs on user login, restart-on-crash supported, no root needed for user agents. |
| Linux | `systemd --user` (writes `~/.config/systemd/user/coodra-<unit>.service`) | Native, no root needed, `Restart=on-failure` baked in, journal logs. Falls back to `fallback.ts` on Linux distros where user systemd isn't enabled (rare on modern desktop distros, common on minimal containers). |
| Windows | `fallback.ts` in 08a (detached child process + PID file). Task Scheduler integration deferred to 08a follow-up per spec §3 non-goals. | Task Scheduler XML schema + `schtasks /Create` are well-documented but adding their integration is a 200+ LOC slice; not worth blocking 08a's macOS+Linux launch. |
| All | `fallback.ts` (detached child + PID file under `~/.coodra/pids/`) | Universal fallback when the platform's native manager is unreachable. |

## Process exit codes — the contract

| Code | Meaning |
|---|---|
| 0 | Success (or "nothing to do" in idempotent commands) |
| 1 | User-recoverable failure (missing file, invalid input, detection failure) |
| 2 | User-action required (e.g., team mode not yet GA, port in use, missing IDE) |
| 3 | Environment problem (daemon manager unreachable, Node too old, file collision) |
| 4 | Service-startup failure (daemon installed but `/health` never returned ok) |
| 99 | Unimplemented (used only by S1 stubs during development; no command may exit 99 after S9) |

These codes MUST be stable across versions — shell scripts on user machines depend on them. Adding a new code is non-breaking; reusing or removing a code is a major version bump.

## Distribution

| Channel | Status in 08a |
|---|---|
| `npm` (scope: `@coodra`, package: `cli`) | Package builds and runs locally. **Not published in 08a.** Publish-flag-day is a separate ops task tracked in `pending-user-actions.md`. |
| Anthropic MCP marketplace | Listing depends on the marketplace launch + a published CLI. Tracked as a follow-up in the Module 08a Context Pack. |
| Homebrew tap / Scoop bucket / `apt` | Not in scope. Users install via npm; OS-package distribution is a future module if there's demand. |

## Out-of-scope libraries

These are deliberately NOT in 08a's deps:

- `axios` / `node-fetch` — the CLI makes ZERO outbound HTTP calls in 08a (Graphify is a local subprocess, daemon managers are local subprocesses, MCP server `/health` checks use Node's built-in `fetch`). No HTTP client needed; no outbound surface to audit.
- `inquirer` / `enquirer` / `prompts` — see above; zero questions on the happy path.
- `chalk` — `picocolors` is strictly smaller and faster.
- `figlet` / `boxen` / `ora` / any decorative output library — the CLI prints structured, scriptable output. Spinners and ASCII art break `--json` mode and add weight without value.
- `dotenv` — the CLI does not read `.env` files. It reads `process.env` directly and `~/.coodra/config.json` for team-mode secrets (when team mode opens). Project-level `.env` is the application's concern, not the installer's.

## Gotchas

- **`npm pack --dry-run` file list is part of the contract.** S9 locks the file list with a unit test. Adding a top-level file (e.g., a stray `.DS_Store`) silently bloats the tarball; the test catches it.
- **`launchctl` and `systemctl --user` exit codes are not consistent across versions.** Treat any non-zero exit as failure but parse stderr for the actual reason; surface the underlying message in `doctor` output.
- **`npx @coodra/cli init` resolves the bin via `process.execPath` for the `.mcp.json` `command` field.** This means the `.mcp.json` written by an `npx` invocation embeds a path under the npx cache, which can be garbage-collected by npm. The `init` command MUST detect this case and warn YELLOW in `doctor`'s "MCP config validity" check, recommending a global install (`npm i -g @coodra/cli`) for stability. (Tracked as a follow-up: rewrite the `.mcp.json` `command` to `npx @coodra/cli mcp-stdio` so the path is resolved at IDE-startup time, not at `init` time. Out of 08a scope.)
- **systemd user units do not survive a reboot unless `loginctl enable-linger <user>` is run.** `doctor` warns YELLOW when `loginctl show-user $USER --property=Linger` returns `Linger=no` and the user opted into auto-start.
- **macOS Gatekeeper will quarantine the CLI binary the first time it runs from npm.** This is invisible because Node binaries aren't notarized — but if a future slice ever ships a native binary (e.g., via `pkg`), Gatekeeper UX becomes a real concern. Out of 08a scope; flagged here for the npm-publish slice.
