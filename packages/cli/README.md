# @coodra/cli

The install, configure, run, and diagnose surface for Coodra.

Coodra supercharges coding agents with plugin-native lifecycle events, durable
memory, Work Packs, Deep Wiki, Graphify code graph context, and policy
governance. It supports native plugin wiring for Claude Code, Codex, Cursor,
Devin, and Antigravity.

## Install

```bash
npm i -g @coodra/cli
coodra install
coodra agent add codex     # or: claude, cursor, devin, antigravity, all, detected
coodra init
coodra start
coodra doctor
```

pnpm users should allow the native SQLite build:

```bash
pnpm add -g @coodra/cli --allow-build=better-sqlite3
```

Coodra supports Node.js `>=22.16.0`, npm `>=10.0.0`, and pnpm `>=10.33.0`.

## What Gets Installed

`coodra install` prepares machine-level state under `~/.coodra/`: the local
SQLite store, logs, daemon state, runtime env, Graphify MCP runtime, and machine
manifest.

`coodra agent add <agent>` installs Coodra as a native agent plugin with bundled
skills, lifecycle hooks, the Coodra MCP entry, and the managed Graphify MCP
entry.

`coodra init` registers the current repo and creates project-local state under
`.coodra/`, including recipes, Graphify artifacts, wiki files, Work Packs, and a
manifest of generated files.

`coodra start` launches:

- Coodra MCP server on port 3100.
- Web dashboard on port 3001.
- Sync daemon when the machine is in team mode.

## Common Commands

| Command | Purpose |
|---|---|
| `coodra install` | Install or repair machine-level runtime state. |
| `coodra init` | Register the current project and create `.coodra/` state. |
| `coodra start` / `coodra stop` / `coodra status` | Run and inspect local services. |
| `coodra doctor --full` | Run runtime, lifecycle, policy, outbox, and service checks. |
| `coodra agent add/status/repair/remove <agent>` | Manage native plugin wiring for coding agents. |
| `coodra agents` | Show per-agent wiring status. |
| `coodra files status` / `coodra files clean` | Inspect or clean generated project files. |
| `coodra metrics` / `coodra roi` | Show reuse, governance, and modeled value KPIs. |
| `coodra graphify build/status/open/clean` | Build and inspect code graph artifacts. |
| `coodra wiki build/status/list/open/ask/clean` | Create, inspect, open, query, or remove Deep Wiki content. |
| `coodra work import/status/show` | Prepare and inspect Work Packs. |
| `coodra policy ...` | Manage policy rules and governance catalogs. |
| `coodra project ...` / `coodra run ...` | Inspect project and run records. |
| `coodra login`, `coodra invite`, `coodra team ...` | Team identity, invites, setup, and sync flows. |

Run `coodra --help` or `coodra <command> --help` for the full command catalog.

## MCP Tools

The Coodra MCP server exposes 26 tools:

- Identity and lifecycle: `ping`, `get_run_id`, `lifecycle_event`.
- Recipes: `list_recipes`, `get_recipe`, `get_recipe_file`.
- Memory: `save_context_pack`, `search_packs_nl`, `list_context_packs`, `read_context_pack`.
- Decisions and runs: `record_decision`, `query_decisions`, `query_decisions_by_file`, `query_run_history`, `query_run_diff`.
- Policy: `check_policy`.
- Links and collaboration: `link_run_to_issue`, `link_run_to_pr`, `prepare_jira_comment`.
- Deep Wiki: `wiki_save_structure`, `wiki_save_page`, `wiki_status`, `wiki_ask`.
- Work Packs: `work_pack_upsert`, `work_pack_update`, `work_pack_status`.

Graphify is an independent open-source project. Coodra owns the plugin wiring
and points the managed Graphify MCP server at each project's
`.coodra/graphify/out/graph.json`.

## Work Packs

Work Packs hold issue-shaped execution context for agents: goal, acceptance
criteria, related issues, affected files, implementation plan, and status. For
Jira or Linear, the agent uses those systems' native MCP tools for provider
sync, then persists the Coodra-side execution context through the `work_pack_*`
MCP tools.

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success or idempotent no-op. |
| 1 | User-recoverable failure, such as missing file or unregistered project. |
| 2 | User action required, such as a port conflict or unavailable service. |
| 3 | Environment problem, such as unsupported Node or daemon-manager failure. |
| 4 | Service startup failed. |

## Publishing From Source

```bash
corepack enable
pnpm install
cd packages/cli
npm publish
```

`npm publish` runs the workspace build and verifies the bundled package before
upload. Use `npm publish --dry-run` to rehearse.

## Documentation

- Public developer docs: <https://matrix-maven.github.io/Coodra/docs/>
- Local docs source: [`docs/index.html`](../../docs/index.html)
- Development loop: [`docs/DEVELOPMENT.md`](../../docs/DEVELOPMENT.md)
- Changelog: [`CHANGELOG.md`](../../CHANGELOG.md)
- Third-party notices: [`NOTICE`](NOTICE)

## License

MIT License. Copyright (c) 2026 Matrix Maven.
