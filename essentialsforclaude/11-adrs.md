# 11 — Architectural Decision Records (ADRs)

These are the 12 load-bearing technology/design decisions that future sessions must not silently overturn. New decisions are recorded via `coodra__record_decision` (see `05-agent-trigger-contract.md` §5.4) and appended to `context_memory/decisions-log.md` — the latter accumulates; this file only lists the foundational set.

## ADR-001 — TypeScript MCP SDK over Python

The MCP Server uses the TypeScript SDK (`@modelcontextprotocol/sdk`) with Streamable HTTP transport. TypeScript SDK receives protocol updates first. Monorepo coherence (shared types, shared Zod schemas) outweighs Python's ML advantages at the protocol layer.

## ADR-002 — Python for NL Assembly and Semantic Diff only

Python is used exclusively for services requiring ML inference (sentence-transformers) or AST parsing (tree-sitter). Everything else is TypeScript. Do not introduce Python in other services.

## ADR-003 — Drizzle ORM over Prisma

Drizzle has native pgvector support (vector column types, HNSW indexes, cosine distance functions). Prisma requires raw SQL for pgvector. Since pgvector is central to NL Assembly search, Drizzle is the correct choice.

## ADR-004 — Hono over Express/Fastify for the Hooks Bridge

Hono is TypeScript-native, has `app.request()` for testing without a running server, and produces minimal bundles. The Hooks Bridge is latency-sensitive (`PreToolUse` must respond in <200ms) — Hono's low overhead matters.

## ADR-005 — Vitest over Jest

Vitest is 5.6x faster cold start in monorepo benchmarks. Native TypeScript/ESM support eliminates Babel/ts-jest config. Jest-compatible API means near-zero learning curve.

## ADR-006 — BullMQ for job queues

Embedding generation and semantic diff are async, CPU-bound tasks. BullMQ provides rate limiting (critical for LLM API calls), job flows, retries with backoff, and a dashboard. Redis is already in the stack.

## ADR-007 — Append-only event store for Context Packs

Context Packs and Run Events are immutable — they are historical records. The append-only constraint prevents accidental data loss and enables event sourcing. Implemented via PostgreSQL with no UPDATE/DELETE permissions on these tables.

## ADR-008 — Local-first SQLite as primary store

The VS Code extension uses SQLite (`better-sqlite3` + `sqlite-vec`) as the **primary store**, not a cache. Runs, run events, and context packs are written locally first. Cloud PostgreSQL is the team-sync layer — optional for individual developer use. This eliminates the #1 enterprise blocker (data leaving dev machines) and guarantees sub-millisecond reads with zero network dependency.

## ADR-009 — Cursor hook adapter

Cursor hooks are command-based (stdin/stdout JSON) while Claude Code supports HTTP hooks. Coodra uses a single adapter script (`.cursor/hooks/coodra.sh`) that reads Cursor's JSON from stdin, normalizes field names (e.g., `conversation_id` → `session_id`), POSTs to the hooks-bridge, and translates the response back to Cursor's stdout format. Same semantics, different transport. See `system-architecture.md` §15 for full adapter specification.

## ADR-010 — Graphify import for cold-start

Graphify (`safishamsi/graphify`, MIT license) produces a `graph.json` with tree-sitter AST nodes clustered by Leiden community detection. Coodra imports this output to seed initial Feature Pack content — each community becomes a Feature Pack section. Solves the cold-start problem (first session runs without context) without requiring manual Feature Pack authoring.

**Status (2026-05-03 audit §13 — Slice 11 option b):**
- **Reader: implemented in M02.** `apps/mcp-server/src/lib/graphify.ts` reads `~/.coodra/graphify/<projectSlug>/graph.json` and the MCP tool `query_codebase_graph` exposes the result with a fail-open soft-failure shape (`codebase_graph_not_indexed` when the file is absent).
- **Producer: deferred — depends on external `graphify` CLI** (https://github.com/safishamsi/graphify) until an in-repo producer ships. No current owning module.
- **Seeding flow (the original ADR-010 promise — "import to seed initial Feature Pack content"): not yet implemented.** `createFeaturePackStore.upsert()` accepts pre-authored markdown; it does not generate structure from a `graph.json`. A future module will own the import-to-Feature-Pack pipeline.
- **What this means in practice:** users who want `query_codebase_graph` to return real data must `npm i -g graphify` (or equivalent) and run `graphify scan` at the repo root before opening a Coodra session. The audit observed that the demo had no graphify index and the tool was permanently in soft-failure; that's by design until the producer story is resolved. Slice 10 (manifest description polish) adds an inline recovery hint so agents surface the install step to users.

## ADR-011 — Policy Engine as Non-Human Identity (NHI) infrastructure

The policy engine treats AI coding agents as distinct non-human identities. Policy rules include an `agent_type` field (`claude_code`, `cursor`, `copilot`, `*`) enabling per-agent permission scoping. Combined with the `policy_decisions` audit table, this positions Coodra as enterprise access governance for AI agents — not just a context injection tool.

## ADR-012 — Bridge-mediated autonomous coordination defaults (2026-05-02, decision `dec_83ba10c1`)

The two coordination acts that must happen on every Claude Code session — Feature Pack injection at session start and Context Pack save at session end — fire from the **hooks-bridge** by default, not from the agent's MCP tool calls. The bridge resolves the Feature Pack and returns it via Claude Code's `additionalContext` field on the SessionStart hook response, and writes a structured auto-summary Context Pack on the Stop / SessionEnd hook. The MCP tools `get_feature_pack` and `save_context_pack` remain in the §24 manifest as on-demand surfaces (mid-session module switches, narrative recaps), but the autonomous defaults no longer depend on the agent's planner choosing to call them. Phase 1 audit (2026-05-02) established that the agent-driven path is a *convention* layer that fails under token pressure and is invisible to non-Claude clients; the bridge-side path is *protocol* — it fires whenever the hook fires, no agent cooperation required. See `system-architecture.md` §16 Pattern 20 for the full pattern.

## ADR-014 — Team-mode RBAC is Tier 2.5; bridge stays local-only in team mode (2026-05-09)

Module 04 Phase 4 locks two cross-cutting team-mode design decisions.

**1. Tier 2.5 RBAC — three Clerk roles enforced at the server-action boundary.**

Roles:
- `org:admin` → all writes (policies, kill switches, feature packs, project lifecycle, member management).
- `org:basic_member` → reads everything; writes own context packs / decisions / runs; resumes own kill-switch pauses.
- `org:viewer` → read-only. Custom Clerk role; viewers cannot save context packs, record decisions, or resume kill switches even on resources they "own". Read-only means read-only.

Mapping happens in `packages/shared/src/auth/roles.ts::parseClerkRole`. Helpers `requireRole(actor, min)` and `assertCanEdit(actor, resource, { allowOwner? })` are the canonical guards. `assertCanResumeKillSwitch` is a specialization for the member-can-resume-own-pause case.

Why not custom roles (Tier 3): most teams are served by admin / member / viewer. A `permissions` table + role-policy mapping would add operational complexity for a use case we don't have evidence for yet. Add later if a real team needs it; the Tier 2.5 surface doesn't preclude a future Tier 3 expansion.

Why not "member can edit own resources, viewer can't, allowOwner relaxes both" (Tier 2): viewers must never write. Period. The role's intent is auditor / PM / stakeholder visibility — they should not be able to author state. An "allow owner override" semantics that lets viewers write would defeat the role's purpose.

**2. Hooks Bridge runs locally in both modes; no cloud bridge ships.**

The original architecture (§19 pre-Phase-4) anticipated a cloud-deployed Hooks Bridge that local agents would call via HTTPS with `LOCAL_HOOK_SECRET`. That bridge does not ship and will not ship.

Why local-only:
1. **Latency.** Cloud bridge added 50–200ms per hook event in the §6 hot path. Local-bridge + async-push (sync-daemon to cloud) has zero hot-path penalty.
2. **Failure mode.** Cloud bridge unreachable → hook events drop or block agent sessions. Local-bridge + outbox is durable across cloud outages — events queue locally and drain on recovery.
3. **Auth surface.** Cloud bridge needed HTTPS, certs, DNS, signed-request handling. Local bridge has none.

`LOCAL_HOOK_SECRET`'s scope narrows: it's now solely the credential the sync-daemon uses to authenticate against the cloud Postgres-fronted REST endpoints (push of pending_jobs, pull of decisions/context_packs/run_events). The bridge itself binds to `127.0.0.1:3101` in both modes and accepts no remote traffic.

**3. Pull-sync is mandatory in team mode (Caveat 1 fix).**

Pre-Phase-4 the sync daemon was push-only. M05's recent-decisions injection assumed cross-team-member visibility, but local MCP servers couldn't see other members' decisions because they read local SQLite and there was no pull. Phase 4 adds `apps/sync-daemon/src/lib/team-rows-puller.ts` that ticks every 10s pulling cloud→local for `runs`, `decisions`, `context_packs`, `run_events`. ON CONFLICT (id) DO NOTHING per ADR-007 — append-only makes the pull conflict-free.

Without pull-sync team mode would silently break recent-decisions injection. The fix is non-optional and ships with the team-migration tooling, not after.

## ADR-013 — Module 06 ships TypeScript-in-process + `git diff`, no external LLM (2026-05-09)

The original M06 "Semantic Diff" plan called for a Python FastAPI service on :3201, tree-sitter AST parsing, and an Anthropic LLM enrichment pass. ADR-013 replaces that plan with a TypeScript-in-process runner inside the hooks-bridge that uses `git diff` and no LLM.

**What changes:**
- M06 is renamed from "Semantic Diff" to "Run Diff". The directory and feature-pack slug are `06-run-diff`.
- No `services/semantic-diff/` Python directory ships. The bridge directly spawns `git` subprocesses via `node:child_process::execFile`.
- No `web-tree-sitter`, no `.wasm` grammars, no AST diff layer. `git diff` is the diff engine.
- No `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` reads anywhere in the new code. The agent does all narrative interpretation when it calls `save_context_pack`; the server hands the agent structured records (the unified diff + per-file metadata) and lets the agent's own model decide what's meaningful.

**Why git diff over AST:**
1. **Universal** — works on every language and file type (markdown, configs, tests, shell scripts). AST diff would need per-language grammars and would only meaningfully interpret a subset.
2. **Battle-tested** — most-tested diff implementation in software. A custom AST diff layer would have its own bug surface to grow over time.
3. **Native + free** — already on the user's machine. No `.wasm` to ship, no parser versioning, no native-module compatibility risk.
4. **Format every consumer already speaks** — every code review, every PR, every IDE renders unified diffs. Agents have read millions of them in training; AST trees are not a natural reasoning substrate.
5. **Lossless** — captures whitespace, comment changes, import reordering. The agent decides what's noise — better than a hardcoded AST walker doing the filtering.

**Why no external LLM:**
1. M05 already established the "ship intelligence as records, not as a separate service" pattern (Pattern 20 + ADR-012). M06 applies the same thesis: the server records, the agent narrates.
2. Removing the LLM eliminates an external dependency, recurring cost, and a runtime failure mode — and enables truly air-gapped operation.
3. The agent reads the structured diff via the new `query_run_diff` MCP tool and writes prose into its own `save_context_pack` call. The auto-pack (bridge-side, Pattern 20) embeds the literal unified diff as a safety-net record.

**This is a narrow supersede of ADR-002.** ADR-002's general claim ("Python exclusively for ML inference / AST parsing services") still holds for any future module that legitimately needs Python (none exist post-M05). For M06 specifically, ADR-013 wins. The `system-architecture.md` §2 service inventory is updated in the same change to remove the `:3201 Python FastAPI` line.

**What it does not change:**
- `runs.base_sha` is still captured at SessionStart (the diff baseline).
- The §7 three-tier degradation still applies — a `git diff` failure lands a soft-failure row with `error = 'git_diff_failed'`; tier-1 (events) and tier-3 (auto-pack) still succeed.
- Append-only semantics stay (ADR-007) for `context_packs`. The new `run_diffs` table uses DELETE-then-INSERT idempotency for the same reason context_packs allow the M05 single-relaxation: a re-fired SessionEnd legitimately supersedes a prior incomplete attempt.
