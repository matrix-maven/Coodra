# Module 05 — Agent-Driven NL Assembly — Tech Stack

> **Status:** kickoff (2026-05-08). The shape captured here is final after the 2026-05-08 reshape — no Python, no embeddings, no LLM service. M05 reuses existing ContextOS technology and adds nothing new to the dependency graph.

## In scope

| Layer | Technology | Where it's used in M05 |
|---|---|---|
| Storage | **SQLite** (better-sqlite3 + WAL) in solo, **PostgreSQL** in team | Existing — `context_packs`, `decisions` tables grow new columns; no new tables |
| ORM + migrations | **Drizzle ORM** | Existing — schema additions in `0010_m05_agent_driven.sql`, removals in `0011_drop_embeddings.sql` |
| Runtime | **Node.js ≥ 22**, TypeScript, ESM | Existing — every M05 surface lives in TS, no Python anywhere |
| MCP server | **`@modelcontextprotocol/sdk`** with Streamable HTTP transport | Existing — two new tools registered, four modified |
| Hooks bridge | **Hono** on Node.js | Existing — SessionStart augmentation + mid-session counter live here |
| Validation | **Zod 4** | Existing — schemas for new tools, new optional fields, new soft-failure branches |
| Web | **Next.js 15 + React 19** (`apps/web-v2`) | Existing — coverage dashboard stat is one query + one card |
| Logging | **pino** (TS), structured | Existing — fail-open paths log warnings on DB miss |
| Testing | **Vitest** unit + integration, **testcontainers** for Postgres | Existing — six legacy test files revised, new tests for the two new tools |
| Linting | **Biome** | Existing — no config change |
| Build | **Turborepo** | Existing — no pipeline change |

## Removed (compared to the abandoned plan)

| Layer | Technology | Why gone |
|---|---|---|
| Embedding model | `sentence-transformers/all-MiniLM-L6-v2` (or any other) | No semantic KNN anywhere; agent does the synthesis |
| ML runtime | Python 3.11 + `uv` + sentence-transformers + transformers | No Python service exists in M05 |
| Service framework | FastAPI + Uvicorn | No `:3200` service; nothing to host |
| Local LLM | Ollama (`llama3.1:8b`) | No tier-2 enrichment on the system side; agent's own model is the LLM |
| Managed LLM | Google Gemini 2.5 Flash via `@google/generative-ai` | Same — agent's provider relationship handles all LLM cost |
| Vector storage (SQLite) | `sqlite-vec` virtual table `context_packs_vec` | Dropped in `0011_drop_embeddings.sql` |
| Vector storage (Postgres) | `pgvector` `vector(384)` column + HNSW index | Dropped in `0011_drop_embeddings.sql` |
| Background queue | BullMQ embedding-generation worker | No work to enqueue; agent writes content directly |
| Cross-package constant | `EMBEDDING_DIM = 384` (`packages/shared/src/constants.ts`) | No consumer remains |
| Embedding-aware MCP tool input | `embedding: number[]` on `search_packs_nl` | Removed from schema |

## Reused with extension

| Existing tech | What M05 adds |
|---|---|
| `decisions` table | Four new optional columns: `context`, `impact`, `confidence`, `reversible` |
| `context_packs` table | Two new columns: `source` (enum: 'agent' \| 'bridge_auto'), `meta` (JSON blob) |
| `save_context_pack` MCP tool | New optional `meta` field; new `source` semantics in handler; one narrow ADR-007 relaxation (agent overwrites bridge-auto) |
| `record_decision` MCP tool | New optional fields in the input schema; idempotency key unchanged |
| `search_packs_nl` MCP tool | LIKE scope widened to include first 2KB of content; default limit 50; `embedding` input removed |
| `query_codebase_graph` MCP tool | New optional `maxNodes` cap; `graph_too_large` soft-failure; M05 deferral notice removed |
| Hooks bridge SessionStart handler | Auto-injects recent decisions + Session Contract block alongside Feature Pack |
| Hooks bridge PostToolUse handler | Mid-session reminder counter (in-memory, per-runId) |
| `apps/web-v2` dashboard | Agent narrative coverage stat card |

## New (M05-internal)

| Component | Why it's new |
|---|---|
| `apps/hooks-bridge/src/lib/recent-decisions.ts` | Loads + formats recent decisions for SessionStart injection |
| `apps/hooks-bridge/src/lib/session-state.ts` | In-memory counter map for the mid-session reminder mechanism |
| `apps/mcp-server/src/tools/list-context-packs/` | New tool — paginated list of Context Packs |
| `apps/mcp-server/src/tools/read-context-pack/` | New tool — full pack content + hydrated decisions |
| `apps/mcp-server/__tests__/integration/no-m05-references.test.ts` | CI grep test that prevents accidental re-introduction of the abandoned design |
| `.contextos.json:sessionStart` config object | Per-project knobs for the four bridge mechanisms |

## Dependencies — `package.json` changes

**Removed from `apps/mcp-server/package.json`:**
- `sqlite-vec` (or `@coodra/sqlite-vec`) — no longer used in production paths

**Added:** none.

**Net effect on the dependency graph:** strictly fewer dependencies. M05 is the first ContextOS module to ship as a net-deletion of third-party libraries.

## What's NOT in M05

These were considered during spec authoring and explicitly out:

- **No FTS5 (SQLite) / `tsvector` (Postgres)** ranked full-text search. Future module if pack count exceeds ~500/project.
- **No `@xenova/transformers`** ONNX-in-Node embeddings. The agent is the LLM; we're not bringing in a different one.
- **No vector DB** (Pinecone, Weaviate, Qdrant). System-architecture §15 rules these out for solo+team scale; M05 confirms.
- **No streaming SSE for long LLM calls.** No long LLM calls in M05 — agent calls happen in the agent's own runtime.
- **No background workers** (BullMQ, in-process queue) for any pack-related processing. Pack writes are synchronous filesystem + DB operations.
- **No new HTTP endpoints** on either MCP server or hooks bridge. M05's surface is entirely via the existing `/mcp` JSON-RPC and the existing hook handlers.

## Justifications

### Why no Python

The original M05 needed Python for `sentence-transformers` and `tree-sitter` (the latter for M06's semantic diff, which is a separate module and unaffected). M05 ships zero ML inference; Python's strengths are not needed. ContextOS already reserved Python for M06 + the planned services directory; M05 simply doesn't add a row.

### Why no FastAPI

No HTTP service to host. M05 lives entirely inside the existing TS processes (MCP server, hooks bridge, web).

### Why no Ollama / Gemini / Anthropic SDK in M05

The agent's own model — whatever it is, configured by the user in their Claude Code or Cursor or other client — does the LLM work. ContextOS doesn't run a parallel LLM. The user pays for one provider relationship; we use it.

### Why drop `sqlite-vec` and `pgvector`

No producer ever wrote a vector. The infrastructure was scaffolding for the abandoned plan. Carrying it forward as nullable columns + empty virtual tables would be technical debt without offsetting benefit. The optionality argument (resurrect the column later) loses to the simplicity argument (one fewer concept in the schema).

### Why TS for the recent-decisions formatter

It runs inside the hooks bridge process (already TS). A separate language would force a new IPC boundary for ~50 lines of formatting code. The formatter is pure functions over Drizzle rows — minimal mechanical work.

## Versioning posture

M05 lands inside the existing TypeScript + Drizzle + Vitest tooling. No version bumps required for any external dependency. The internal `@coodra/contextos-shared` package gets a minor bump when `EMBEDDING_DIM` is removed (a public symbol drop). No other workspace package changes its public API.
