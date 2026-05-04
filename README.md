# ContextOS (Coodra)

ContextOS is an MCP (Model Context Protocol) server platform that provides **Feature Packs**, **Context Packs**, and **policy enforcement** for AI coding agents. It is the coordination layer between human architects and AI agents — agents receive project context before coding, follow policies during coding, and produce traceable records after coding.

> **This is not a prototype.** ContextOS v2 is built linearly, module by module, as a production-grade system. Every module ships complete or is not merged.

## Repository layout

```
apps/                  # TypeScript runtime services (mcp-server, hooks-bridge, web, vscode) — added module-by-module
packages/              # Shared TypeScript libraries (shared, db)
services/              # Python services (nl-assembly, semantic-diff) — added in Modules 05/06
docs/
  feature-packs/       # Per-module specs (spec.md / implementation.md / techstack.md)
  context-packs/       # Archive of completed work
  DEVELOPMENT.md       # Local dev setup
context_memory/        # Session-level working memory for AI agents (see essentialsforclaude/03-context-memory.md)
essentialsforclaude/   # Standing rules auto-loaded by Claude Code / Cursor / Windsurf via CLAUDE.md
CLAUDE.md              # AI-agent entry point (thin orchestrator for essentialsforclaude/)
system-architecture.md # Architectural source of truth (§0–§24)
External api and library reference.md # Library / API / wire-format source of truth
.mcp.json              # ContextOS MCP server configuration (stub until Module 02 ships)
docker-compose.yml     # Local Postgres (pgvector) + Redis for team-mode integration tests
```

## Requirements

| Tool | Version |
|------|---------|
| Node.js | ≥22.16.0 (see `.nvmrc`) |
| pnpm | ≥10.33.0 |
| Python | ≥3.12 <3.14 for services (system Python is independent) |
| uv | ≥0.9.0 |
| Docker | Required from Module 02 for testcontainers and the local Postgres/Redis stack |

## Getting started (once Foundation is the only module merged)

```bash
git clone https://github.com/Abishai95141/Coodra.git
cd Coodra
nvm use                         # or: asdf install; volta install node
corepack enable && corepack prepare pnpm@10.33.0 --activate
pnpm install
pnpm lint
pnpm typecheck
pnpm test:unit
```

See `docs/DEVELOPMENT.md` for the running-services playbook (added as each module lands).

## Module status

| Module | Name | Status |
|--------|------|--------|
| 01 | Foundation | ✅ complete (`docs/context-packs/2026-04-22-module-01-foundation.md`) |
| 02 | MCP Server | ✅ complete (`docs/context-packs/2026-04-25-module-02-mcp-server.md`) |
| 03 | Hooks Bridge | ✅ complete (`docs/context-packs/2026-04-26-module-03-hooks-bridge.md`) |
| 08a | CLI (`@coodra/contextos-cli`) — install + lifecycle | ✅ complete (`docs/context-packs/2026-04-27-module-08a-cli.md`) |
| 08b | CLI Expansion — operational + admin + Feature-Pack flexibility | ✅ complete (`docs/context-packs/2026-05-03-module-08b-cli-expansion.md`) |
| 04 | Web App | ✅ complete — Phase 1 (`docs/context-packs/2026-05-04-module-04-web-app.md`) + Phase 2 (`docs/context-packs/2026-05-04-module-04-web-app-phase-2.md`) |
| 05 | NL Assembly (Python) | 🔨 next (depends on 03; unlocks `/search` semantic search in the web) |
| 06 | Semantic Diff (Python) | ⏳ blocked on 03 |
| 07 | VS Code Extension | ⏳ blocked on 04, 08a |

Build order and "complete" criteria: `essentialsforclaude/08-implementation-order.md`.

## Working with AI coding agents

Claude Code, Cursor, and Windsurf auto-load `CLAUDE.md` at session start, which in turn imports every file under `essentialsforclaude/` as standing system prompt. Those rules are non-negotiable for agents operating on this repo.

Key agent expectations:

- **No shallow proxies, no faked results.** Every feature is real or it is absent (`essentialsforclaude/01-development-discipline.md` §1.1).
- **Context memory.** Every file write gets logged to `context_memory/current-session.md`; every design decision goes to `decisions-log.md` as it's made (`03-context-memory.md`).
- **Agent / human boundary.** Agents never invent API keys, never register third-party apps, never deploy to cloud, never approve destructive ops (`02-agent-human-boundary.md`).
- **Module order is enforced.** Do not start Module N+1 until Module N has a Context Pack under `docs/context-packs/` (`08-implementation-order.md` §8.3).

## License

MIT — see `LICENSE`.
