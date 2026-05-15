# essentialsforclaude/

> Everything Claude Code (or any AI coding agent) needs loaded as standing context on every session for this repo.

## How this folder loads

Claude Code's [memory system](https://code.claude.com/docs/en/memory) auto-loads `CLAUDE.md` at the project root on every session. The root `CLAUDE.md` in this repo is a thin orchestrator — it uses the `@path/to/file` import syntax to pull every file in this folder into the agent's system prompt, in the order listed below.

The files are numbered so the reading order matches the order Claude sees them:

```
essentialsforclaude/
├── 00-identity.md                    — What Coodra is + the two canonical docs + not-a-prototype framing
├── 01-development-discipline.md      — No shallow proxies + 9 dev rules (type safety, errors, logging, idempotency, migrations, ask-don't-assume, testing)
├── 02-agent-human-boundary.md        — What the agent does vs what the user does, with hard rules against faking user actions
├── 03-context-memory.md              — The context_memory/ folder, what to write after every PostToolUse hook, session recovery
├── 04-when-in-doubt.md               — Research online vs ask the user — a decision tree
├── 05-agent-trigger-contract.md      — When to call which MCP tool (the directive version of system-architecture.md §24)
├── 06-testing.md                     — Unit, integration, E2E requirements and how to run them
├── 07-style-and-conventions.md       — Code style (TS + Python), Git, env vars, CI/CD
├── 08-implementation-order.md        — Module order (01 Foundation → 07 VSCode) + the Context Pack protocol
├── 09-common-patterns.md             — Code templates for new MCP tools, hook handlers, tests
├── 10-troubleshooting.md             — Local dev error → fix table
├── 11-adrs.md                        — The 11 architectural decision records
└── references/
    ├── architecture-map.md           — Section-by-section guide to ../system-architecture.md
    └── library-map.md                — Category-by-category guide to ../External api and library reference.md
```

## When to edit which file

The rule for where new standing context goes:

| New content is about... | Put it in |
|---|---|
| What the project IS or where to read more | `00-identity.md` |
| How code must be written (don't-fake-it, types, errors, logging, tests) | `01-development-discipline.md` |
| Something the USER has to do (API keys, deploys, infra) | `02-agent-human-boundary.md` §2.2 |
| Something the agent writes to `context_memory/` | `03-context-memory.md` |
| A research-vs-ask protocol | `04-when-in-doubt.md` |
| A new MCP tool or a change to when tools are called | `05-agent-trigger-contract.md` AND `../system-architecture.md` §24 |
| A testing rule | `06-testing.md` |
| Style/lint/env/CI rule | `07-style-and-conventions.md` |
| Module build order / "complete" criteria | `08-implementation-order.md` |
| A code template the agent should follow | `09-common-patterns.md` |
| A local dev error with a known fix | `10-troubleshooting.md` |
| A decision (library, pattern, tech) | `11-adrs.md` AND call `coodra__record_decision` |
| A pointer into the big architecture doc | `references/architecture-map.md` |
| A pointer into the library reference doc | `references/library-map.md` |

## Effective-instruction style (applies to every file here)

Per the Claude Code docs, rules here follow these principles:

- **Specific over vague.** *"Use 2-space indentation"* beats *"Format code properly"*.
- **Commands over goals.** *"Run `pnpm test` before committing"* beats *"Test your changes"*.
- **Paths over principles.** *"API handlers live in `apps/mcp-server/src/tools/`"* beats *"Keep files organized"*.
- **Trigger phrases.** Rules that say when to act start with "Call this BEFORE...", "When the user asks...", "If X, then Y".
- **Short files.** Each file targets 40–150 lines. Big rules get split, not stuffed.

## Relationship to the two canonical docs

This folder does NOT duplicate `../system-architecture.md` or `../External api and library reference.md`. Those stay as the deep references. The files here are the agent's standing rules and pointers; they tell the agent **when** to open which section of the big docs.

## Upgrade path to `.claude/rules/` (optional)

Claude Code's native auto-load + path-scoping only fires for files inside `.claude/rules/`. Today the root `CLAUDE.md` loads every file in this folder via `@` imports — simple and universal, but every file always loads in full.

If in the future you want path-scoped loading (e.g., `apps/mcp-server/**`-specific rules that only load when editing that subtree), move those specific files into `.claude/rules/` and add a `paths:` frontmatter block per the [Claude Code docs](https://code.claude.com/docs/en/memory#organize-rules-with-claude/rules/). This folder can remain as the source-of-truth directory; `.claude/rules/` entries can be symlinks or thin `@`-imports back here.
