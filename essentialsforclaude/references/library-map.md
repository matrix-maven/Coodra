# references/library-map.md

Pointer guide into `../../External api and library reference.md`. Use this to jump directly to the library/API subsection you need without scanning 2,400+ lines. Every subsection in the source file has a "Gotchas" block — always read it.

## When to open which category

| You are about to... | Go to category |
|---|---|
| Pick a driver, write a migration, add a pgvector index, or choose a Postgres connection lib | **Databases, Extensions & ORM Layer** → SQLite (WAL + PRAGMAs), sqlite-vec, PostgreSQL, better-sqlite3, Postgres.js, Drizzle ORM |
| Enqueue a background job, configure Redis, build a cloud queue (BullMQ) or the solo in-process queue | **Queues, Workers & Redis** → BullMQ, Upstash Redis, solo in-process queue pattern |
| Mount an HTTP server, add middleware, serve Next.js routes, or spin up a FastAPI Python service | **Web Frameworks & HTTP Layer** → Express, Hono, Next.js, FastAPI |
| Implement an MCP tool, wire JSON-RPC, stream SSE, or decide between HTTP/1.1 and HTTP/2 | **Protocols & Transports** → Model Context Protocol + Streamable HTTP, JSON-RPC 2.0, Server-Sent Events, HTTP versions |
| Call Ollama (solo), Anthropic, or Gemini from NL Assembly — including structured JSON / function calling | **LLM Providers & Structured Output** → Ollama (JSON Schema mode), Anthropic Claude, Google Gemini (JSON mode + 2.5 Flash function calling) |
| Verify a Clerk JWT, sign a webhook, or secure a session | **Auth & Security** → Clerk (JWT templates, verification, solo bypass) |
| Write a Zod schema, convert to JSON Schema for MCP, or add retries with cockatiel | **Validation, Schemas & Resilience** → Zod, zod-to-json-schema, cockatiel (circuit breaker + retry) |
| Add structured logging anywhere in a TS service | **Logging** → Pino (levels, redaction, transports) |
| Configure Vitest, Biome, or Turborepo; set up testcontainers | **Tooling: Testing, Linting, Monorepo** → Vitest, testcontainers, Biome, Turborepo |
| Import Graphify output into Coodra for cold-start | **Graphify CLI** → usage, graph.json schema, import pipeline |
| Deploy to Railway or Fly.io | **Deployment Platforms** → Railway, Fly.io (Dockerfile + fly.toml patterns) |
| Add a JIRA MCP tool, wire OAuth, verify a webhook, convert ADF ↔ Markdown, execute JQL | **Atlassian / Jira Integration** → jira.js, REST v3 endpoints, OAuth 2.0 3LO, webhook signatures, ADF, JQL, rate limits, gotchas |
| Add a GitHub MCP tool, wire GitHub App auth, verify webhooks, parse CODEOWNERS, read branch protection or Rulesets, use Octokit plugins | **GitHub Governance & Context Layer** → REST v3, GraphQL v4, GitHub App auth (`@octokit/auth-app`), fine-grained PATs, webhook signature (`X-Hub-Signature-256`), CODEOWNERS syntax + parsers, legacy protection + Rulesets, Octokit suite (6 packages) with throttling + retry plugins, ETag conditional requests, rate-limit numbers, GFM comment format |
| Verify something before shipping | **Things that require explicit manual verification** — library versions, credential placement, config gaps |

## Using this file correctly

1. Find the category in the table above that matches your task.
2. Open `../../External api and library reference.md` and jump to that category.
3. Read the full subsection for your library, INCLUDING the "Gotchas" block.
4. If a version pinned there differs from what's currently published, run `npm view <pkg> version` (or `pip index versions`) to verify — see `04-when-in-doubt.md` §4.2.
5. If you discover a new gotcha or a version bump during implementation, update the reference in the same change you ship.

## What the last section ("Things that require explicit manual verification") covers

This final section lists items that must be checked at implementation time — e.g., library versions that may have moved, config gaps the user must fill, auth flows that need a live test account. Treat anything listed there as a potential blocker per `02-agent-human-boundary.md` §2.3 — record, ask, do not fake.
