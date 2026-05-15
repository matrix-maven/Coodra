# Coodra — CLAUDE.md (Standing System Prompt for AI Agents)

> **Read every imported file below on every session.** These rules apply to Claude Code, Cursor, Copilot, and any AI coding agent operating on this repository. They are non-negotiable.

> **This is NOT a prototype.** Coodra v2 is built linearly, start to finish, as a production-grade system. There is no "we'll come back to this later," no placeholder surfaces, no mocked endpoints to make the UI render. Every module ships complete or is not merged.

---

## How this file works

The actual rules live as split files in [`essentialsforclaude/`](./essentialsforclaude/README.md), following the Claude Code memory convention ([docs](https://code.claude.com/docs/en/memory#organize-rules-with-claude/rules/)). Each `@`-import below is loaded by Claude Code into the agent's system prompt at session start.

Edit the imported files, not this one. This file's only job is to be the stable entry point.

---

## Standing rules (always loaded, in order)

**Project identity + the two canonical reference docs + not-a-prototype framing:**
@essentialsforclaude/00-identity.md

**Development discipline — no shallow proxies, no faked results, type safety, error handling, logging, idempotency, migrations, ask-don't-assume:**
@essentialsforclaude/01-development-discipline.md

**Agent / human boundary — what the agent does vs what the user does (API keys, infra, deploys, destructive ops). Never fake a user action:**
@essentialsforclaude/02-agent-human-boundary.md

**Context memory protocol — the `context_memory/` folder, what to write after every PostToolUse hook, how to recover on resume:**
@essentialsforclaude/03-context-memory.md

**When in doubt — research online vs ask the user, decision tree:**
@essentialsforclaude/04-when-in-doubt.md

**Agent trigger contract — when to call which Coodra MCP tool (directive version of `system-architecture.md` §24):**
@essentialsforclaude/05-agent-trigger-contract.md

**Testing requirements — unit, integration, E2E, coverage, MCP manifest test:**
@essentialsforclaude/06-testing.md

**Style and conventions — TypeScript, Python, Git, env vars, CI/CD:**
@essentialsforclaude/07-style-and-conventions.md

**Implementation order — the 7 modules, "complete" criteria, Context Pack protocol:**
@essentialsforclaude/08-implementation-order.md

**Common code patterns — new MCP tool, hook handler, test templates:**
@essentialsforclaude/09-common-patterns.md

**Troubleshooting — known local-dev errors with fixes:**
@essentialsforclaude/10-troubleshooting.md

**ADRs — the 12 foundational technology/design decisions:**
@essentialsforclaude/11-adrs.md

---

## Deep references (consult on demand, not auto-loaded)

Two source-of-truth documents live at the root. Use the maps to jump to the right section without scanning them whole.

- `system-architecture.md` — the 25-section architectural spec. Navigation map: @essentialsforclaude/references/architecture-map.md
- `External api and library reference.md` — every library / API / wire format, with gotchas. Navigation map: @essentialsforclaude/references/library-map.md

---

## Related folders

- `context_memory/` — session working memory (see `03-context-memory.md` above)
- `docs/context-packs/` — archive of completed work, queryable via `coodra__search_packs_nl`
- `docs/feature-packs/` — per-module specs (spec.md / implementation.md / techstack.md)
- `docs/DEVELOPMENT.md` — local dev setup, service commands, testing
- `.mcp.json` — Coodra MCP server configuration
- `.claude/rules/` — NOT used currently. `essentialsforclaude/` serves the same role via `@`-imports from this file. See `essentialsforclaude/README.md` for the upgrade path if path-scoped rules are needed later.
