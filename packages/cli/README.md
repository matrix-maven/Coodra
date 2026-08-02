# @coodra/cli

> **Status:** stable native-agent release. Install with `npm i -g @coodra/cli`. pnpm users should allow the native SQLite build: `pnpm add -g @coodra/cli --allow-build=better-sqlite3`. The command reference below is partial; run `coodra` (no args) for the full interactive catalog, or `coodra --help`.

The single-binary install / configure / run / diagnose surface for Coodra, the MCP server platform that gives AI coding agents (Claude Code, Codex) Feature Packs, Context Packs, and policy enforcement.

## Install

```bash
# Global install (recommended for repeat use)
npm i -g @coodra/cli

# Prepare the machine runtime
coodra install

# Start services, then verify / open the interactive terminal
coodra start
coodra doctor
coodra

# Install the global agent plugin before project init
coodra agent add codex     # or: coodra agent add claude

# Then, from a repo, register the project
coodra init
# or ask the installed agent to use /coodra init

# pnpm global install (pnpm 10 blocks native build scripts unless approved)
pnpm add -g @coodra/cli --allow-build=better-sqlite3

# One-shot use without installing
npx @coodra/cli init
```

Coodra supports Node.js `>=22.16.0`, npm `>=10.0.0`, and pnpm `>=10.33.0`.
The CLI uses `better-sqlite3` for the local SQLite store, so pnpm installs must
approve that native build script.

## Commands

| Command | Purpose |
|---|---|
| `coodra install [--dry-run] [--json]` | Install or repair machine-level Coodra runtime state: creates `~/.coodra/`, `logs/`, `pids/`, `data.db`, runtime env keys plus commented Graphify LLM backend placeholders in `~/.coodra/.env`, the shared Graphify MCP runtime under `~/.coodra/graphify-mcp/.venv`, and the machine ledger `~/.coodra/manifest.json`. Native per-agent plugin installers live on the `coodra agent add <agent>` path. |
| `coodra init [--project-slug] [--dry-run] [--force]` | Register the current project with Coodra: writes `<repo>/.coodra/config.json`, records `<repo>/.coodra/manifest.json`, and creates `<repo>/.coodra/{recipes,graphify,wiki,work-packs}/`. It does not create or modify the project's application `.env`, `.mcp.json`, `.codex/config.toml`, or per-agent instruction files. Install agent plugins first with `coodra agent add <agent>`, then run this command directly or through the installed agent's `/coodra init` skill. |
| `coodra agent add codex [--dry-run] [--force]` | Install or repair the native global Coodra Codex plugin through the local personal plugin marketplace. The plugin bundles Coodra skills, the Deep Wiki authoring recipe, generated Coodra + managed Graphify MCP entries, and plugin hooks without writing project `.mcp.json`, `.codex/config.toml`, or `AGENTS.md`. |
| `coodra wiki build [--slug] [--mode] [--json]` | Create/update the Coodra Wiki grounding/job files, scaffold the repo-local Markdown mirror under `.coodra/wiki/<slug>/`, record generated wiki artifacts in `.coodra/manifest.json`, and hand off to the bundled native-agent `coodra-wiki` skill. The agent saves canonical content through MCP first, then mirrors successful saves to disk. `generate` remains as a deprecated alias. |
| `coodra graphify status [--json]` | Read-only check of whether Graphify's own codebase-graph MCP server is wired for Claude Code / Codex, plus the graph artifact state. Wiring itself is Coodra-owned end to end — `coodra agent add <agent>` installs the native plugin, which bundles a managed `graphify` MCP entry pointed at the shared machine runtime and `.coodra/graphify/out/graph.json` alongside `coodra`. There is no separate enable/disable step. |
| `coodra graphify build [--slug] [--no-llm] [--no-viz] [--python] [--json]` | (Re)build the codebase graph into this project's resolved output dir via the installed `graphify` CLI. |
| `coodra graphify open` | Open the interactive `graph.html` for the current project's graph. |
| `coodra graphify clean [--force] [--json]` | Remove the generated graph artifacts. |
| `coodra start [--no-mcp] [--no-hooks] [--foreground]` | Launch MCP Server + Hooks Bridge as background daemons via the platform's native manager (launchd / systemd) or detached fallback. Polls `/healthz` until ready. |
| `coodra stop [--service <name>] [--uninstall]` | Stop running daemons. Idempotent. `--uninstall` also removes the daemon-manager unit. |
| `coodra status [--json]` | Print unified project + service state for the current cwd: project slug + registration, mode, service health probes (MCP `/healthz` + bridge `/healthz`), recent run + last decision + open blockers. |
| `coodra doctor [--json] [--timeout-ms <ms>]` | 20-check read-only health report covering Node / `~/.coodra/` / data.db / migrations / F7 sentinel / F8 + F14 + F15 invariants / `/healthz` / IDE detection / daemon manager / port availability / `LOCAL_HOOK_SECRET` / Module 03.1 placeholder. |
| `coodra team login [token] [--server <url>]` | **Stub in 08a.** Surface lives; body lands when team mode reaches GA. Exits 2. |
| `coodra team logout` | **Stub in 08a.** Same status. |
| `coodra --version` / `--help` | Standard CLI metadata. Per-subcommand `--help` available. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success / idempotent no-op |
| 1 | User-recoverable failure (missing file, wrong dir, project unregistered) |
| 2 | User action required (team mode not GA, port in use, all services down) |
| 3 | Environment problem (daemon manager unreachable, Node too old, file collision) |
| 4 | Service startup failed (daemon installed but `/healthz` never returned ok) |

These codes are stable across versions — shell scripts can rely on them.

## Where files live

`coodra install` resolves `~/.coodra/` per Decision 2 (signed off 2026-04-27):

| Platform | Path |
|---|---|
| Linux + `$XDG_CONFIG_HOME` set | `$XDG_CONFIG_HOME/coodra/` |
| Linux without XDG | `$HOME/.coodra/` |
| macOS / Windows | `$HOME/.coodra/` |

Override with `COODRA_HOME=/path/to/dir` in the environment.

## Publishing from source

`dist/` is git-ignored and the tarball is fully bundled, so publish from a clean
clone of the monorepo:

```bash
corepack enable      # pinned pnpm@10.33.0
pnpm install         # from the repo root
cd packages/cli
npm publish          # prepublishOnly builds the workspace + verifies the bundle
```

`npm publish` triggers `pnpm -w run build` (turbo, dependency-ordered) and a
bundle-integrity assert before upload — no separate build step needed. Use
`npm publish --dry-run` to rehearse. To publish under a different npm account,
change `name` in `package.json` to a scope you own (the build is name-agnostic),
then `npm login && npm publish`.

## Documentation

- Full architecture — [`system-architecture.md`](../../system-architecture.md)
- Contributor dev-loop — [`docs/DEVELOPMENT.md` § Iterating on the CLI](../../docs/DEVELOPMENT.md)
- The 11 ADRs — [`essentialsforclaude/11-adrs.md`](../../essentialsforclaude/11-adrs.md)

## License

MIT
