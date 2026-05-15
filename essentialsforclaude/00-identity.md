# 00 — Project Identity & Canonical Documents

> **This is NOT a prototype.** Coodra v2 is built linearly, start to finish, as a production-grade system. There are no placeholder surfaces, no mocked endpoints to make the UI render, no "we'll come back to this later." Every module ships complete or is not merged.

## What Coodra is

Coodra is an MCP (Model Context Protocol) server platform that provides **Feature Packs**, **Context Packs**, and **policy enforcement** for AI coding agents. It is the coordination layer between human architects and AI agents — ensuring agents receive project context before coding, follow policies during coding, and produce traceable records after coding.

The system has five layers:

```
Layer 0: Agent Entry Points     → Claude Code, Cursor, VS Code + Copilot
Layer 1: Integration Protocol   → MCP Server (universal), Hooks Bridge (Claude Code + Cursor), Context Files (fallback)
Layer 2: Core Services          → Pack Service, Context Pack Service, Policy Engine, NL Assembly, Run Recorder, Semantic Diff
Layer 3: Storage                → Local SQLite Primary Store (sqlite-vec), PostgreSQL + pgvector (cloud sync), Redis
Layer 4: Clients                → VS Code Extension, Web App, CLI (future)
```

Detailed per-module specs live in `docs/feature-packs/01-07/`. Read `spec.md` and `implementation.md` for the module you are working on before writing any code.

## Repository structure

```
apps/
  mcp-server/         # MCP Server — TypeScript, @modelcontextprotocol/sdk, Streamable HTTP
  hooks-bridge/       # Claude Code + Cursor HTTP Hooks Bridge — TypeScript, Hono
  web/                # Web App — Next.js 15, React 19
  vscode/             # VS Code Extension
packages/
  db/                 # Database schema + migrations — Drizzle ORM, PostgreSQL + pgvector
  shared/             # Shared types, Zod schemas, utilities
services/
  nl-assembly/        # NL Assembly — Python, FastAPI, sentence-transformers, pgvector
  semantic-diff/      # Semantic Diff — Python, FastAPI, tree-sitter, Anthropic Claude
docs/
  DEVELOPMENT.md      # Local dev setup, service commands, testing, troubleshooting
  feature-packs/      # Feature Pack specs (spec.md, implementation.md, techstack.md per module)
  context-packs/      # Context Pack records from completed work
  research/           # Research questions and verified answers
context_memory/       # Session-level working memory (see 03-context-memory.md)
essentialsforclaude/  # THIS folder — standing agent rules
```

## The two canonical documents

There are exactly **two** source-of-truth documents in this repo. Learn the difference and use them correctly.

### `system-architecture.md` — *HOW the system is built*

**Contains:** the complete architectural specification of Coodra v2 — the two-mode model (solo vs team), data-in-motion wire formats, data-at-rest schemas, CAP analysis, design patterns (currently 19), Graphify, NL Assembly, Policy Engine, JIRA (§22), GitHub (§23), and the MCP tool manifest + agent discovery contract (§24).

**Use it when:** touching a service boundary, data flow, wire format, cross-cutting concern, adding/changing an integration, introducing a new policy condition or hook event, or deciding whether something belongs in solo mode, team mode, or both.

**Authority:** source of truth for every architectural question. If code contradicts it, either the code is wrong or the doc is wrong — and in the latter case record a decision and update the doc in the same change.

**Section map:** see `references/architecture-map.md` for a section-by-section guide to what lives where in that file.

### `External api and library reference.md` — *WHICH tools to use and HOW to call them*

**Contains:** concrete API, library, and wire-format references for every third-party dependency — SQLite, Postgres, Drizzle, BullMQ, Redis, Express/Hono/Next.js/FastAPI, MCP/JSON-RPC/SSE, Ollama/Anthropic/Gemini, Clerk/Zod, cockatiel/Pino, Vitest/Biome/Turborepo, Atlassian/jira.js, Octokit (all 6 plugins)/GitHub App/CODEOWNERS/rulesets, Railway/Fly.io. Each library has a "Gotchas" subsection.

**Use it when:** adding a new external dependency, calling any external API, wiring auth/retries/rate limits/signature verification, needing the canonical code snippet for a library in Coodra, or checking known gotchas.

**Authority:** use the versions and patterns pinned here. If a version looks stale, verify online per `04-when-in-doubt.md` and update the reference in the same change. Never silently upgrade or downgrade.

**Section map:** see `references/library-map.md`.

### Precedence when the two disagree

- On **architecture, policy, data flow, mode boundaries** → `system-architecture.md` wins.
- On **specific library/API mechanics** → `External api and library reference.md` wins.
- On a **genuine contradiction** → STOP, raise it as an open question in `context_memory/open-questions.md`, and ask the user. Do not pick a side silently.
