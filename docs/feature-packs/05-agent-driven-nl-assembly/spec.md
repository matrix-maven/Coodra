# Module 05 — Agent-Driven NL Assembly — Spec

> **Status:** kickoff (2026-05-08). No implementation slice has landed yet. This spec replaces the abandoned plan to ship a Python FastAPI service with embeddings + KNN + post-hoc LLM enrichment; the new design moves intelligence to the agent and treats the system as fast storage + structured recording + full-text search.
> **Depends on:** 01 Foundation (DB schema), 02 MCP Server (tool registry — adds 2, modifies 4), 03 Hooks Bridge (auto-save path + new SessionStart context augmentation), 04 Web App (dashboard coverage metric), 03.1 Durable Outbox (audit-trail integrity for the new `source` column).
> **Blocks:** 06 Semantic Diff (which still lands as planned — tree-sitter + Anthropic — and is unaffected by this reshape); 07 VS Code Extension's session-recap surface (consumes `read_context_pack`).
> **Aware of:** 08a CLI (adds `coodra packs list / read` commands); 22 JIRA / 23 GitHub integrations (still surface third-party context to the agent at SessionStart, but no longer feed a Python LLM-enrichment service — the agent reads them inline and synthesizes).
> **Source of truth:** `system-architecture.md` §2 (service inventory — M05 row removed), §6 (latency budgets — read path stays in-process, no :3200 service), §7 (fail-open — applies to recent-decisions injection at SessionStart), §16 patterns 1–4 (idempotency carries through to enriched tool fields), §16 pattern 20 (bridge auto-save semantics revised — see §5 below), §22.4 (JIRA NL Assembly inputs — agent-side now), §23.9 (GitHub NL Assembly inputs — agent-side now), §24 (manifest grows from 10 to 12 tools). User directives 2026-04-24 (Gemini for managed LLM — moot now, no managed LLM in M05) and 2026-05-08 (this reshape).

## 1. What M05 is — and what it stopped being

### 1.1 What it stopped being

The original M05 was a Python FastAPI service running on `:3200` that owned four jobs in one process:

1. **Embedding production** — sentence-transformers `all-MiniLM-L6-v2` over Context Pack content, written to `pack_embeddings` (sqlite-vec virtual table) or `feature_packs.embedding` (pgvector + HNSW).
2. **Semantic search** — KNN over those embeddings on every `search_packs_nl` call.
3. **Post-hoc LLM enrichment** — at every SessionEnd, take the bridge's structured digest + JIRA + GitHub context and produce a narrative recap via Ollama (solo) or Gemini (team).
4. **Codebase-graph NL filtering** — a deferred surface for `query_codebase_graph` that would parse natural-language queries into structured graph traversals.

That plan is dead. We're not building it. Reasons captured in `context_memory/decisions-log.md` 2026-05-08:

- **The agent's frontier model already does semantic reasoning better than 384-dim cosine over excerpts.** A Claude/GPT/Gemini in the loop reading two full Context Packs runs circles around statistical similarity. Embeddings were the right primitive when LLMs had 8k context; they're a vestige now that the agent has 200k+ tokens and can `read_context_pack` directly.
- **Post-hoc LLM enrichment fights ADR-007.** The bridge writes a Context Pack on every SessionEnd; the planned post-hoc service would have to upsert the same row, which the append-only invariant forbids. Resolving the conflict required either a parallel `pack_revisions` table (more state to keep coherent) or a schema relaxation — both worse than not building the service.
- **Two-language, two-process service for one consumer is overhead.** Embedding lookups would have crossed Python↔TS process boundaries on every read; LLM enrichment would have run in a service nobody else talked to. The cost — Python toolchain, FastAPI deploy, model files, Ollama-vs-Gemini fallback chain — is not justified by the marginal intelligence gain.
- **Cold-start was unsolved.** Existing Context Packs (zero today) would all need backfill embeddings. The migration story was never specified.

### 1.2 What M05 IS

M05 reshapes the project's "memory layer" around the agent's own intelligence. Concretely:

- **System provides:** Context Pack storage (existing), structured decision recording (existing), full-text keyword search (LIKE-based, expanded scope), and two new read tools (`list_context_packs`, `read_context_pack`) that let the agent enumerate and load packs explicitly.
- **Agent provides:** all semantic reasoning, all narrative synthesis, all relevance ranking. The agent calls `record_decision` immediately when each design choice is made (not retrospectively); the agent calls `save_context_pack` at session end with a narrative recap synthesizing events, decisions, and outcomes.
- **Bridge provides:** a structured-digest fallback Context Pack on every SessionEnd (Pattern 20, kept) for sessions where the agent didn't call the tool. Plus a new SessionStart augmentation that auto-injects the project's most-recent decisions into `additionalContext` alongside the Feature Pack — closing the cross-developer awareness gap that embeddings would have masked.

**Agent-authored Context Packs are canonical. Bridge auto-save is the fallback floor.** Five mechanisms (Mechanisms A–E in §6 below) target ~80% canonical coverage at steady state, measured by a new dashboard stat. We frame the system honestly: the floor catches what the agent skipped; the canonical is what the agent wrote.

**There is no Python service.** No `services/nl-assembly/`, no `:3200`, no FastAPI, no sentence-transformers, no Ollama integration, no Gemini-managed-LLM path inside Coodra itself. (The agent's own model — whatever it is — does the LLM work, in its own process, on the user's own runtime, paid for via the user's own provider relationship.)

## 2. Acceptance criteria

A commit on `feat/05-agent-driven-nl-assembly` is "complete" when **every** item below holds on a clean checkout:

1. **Workspace:** `pnpm install` clean. No new dependencies added (M05 removes `sqlite-vec` from production paths). `apps/mcp-server/package.json` no longer depends on the sqlite-vec runtime client.
2. `pnpm lint` — Biome zero findings across every file M05 touched.
3. `pnpm typecheck` — `tsc --noEmit` clean across every workspace package, including the deleted-import fan-out.
4. `pnpm test:unit` — every unit test passes; ≥ 80% line coverage on touched files. Six legacy test files revised (see §10): `apps/mcp-server/__tests__/unit/tools/search-packs-nl.test.ts` (semantic-branch tests removed), `packages/shared/__tests__/unit/constants.test.ts` (removed), `packages/db/__tests__/unit/schema-parity.test.ts` (passes after both dialects drop the column in lockstep), plus three integration-test files (see §10).
5. `pnpm test:integration` — full integration pass, including the new `recent-decisions.test.ts` (bridge SessionStart with seeded decisions appends the formatted block to `additionalContext`) and the `source` column round-trip (bridge writes `source='bridge_auto'`; explicit MCP call overrides to `source='agent'` per ADR-012 revision in §6.B).
6. `pnpm test:e2e` — full lifecycle test extended to assert: (a) when the agent explicitly calls `save_context_pack`, the resulting row has `source='agent'`; (b) when the agent skips it, the bridge's auto-save lands `source='bridge_auto'`; (c) when both fire (agent first, then bridge), the agent's row sticks and the bridge call is a no-op (idempotency by `runId` is preserved; the pack is NOT overwritten).
7. **Schema delta:** ONE migration per dialect — `0010_m05_agent_driven.sql`:
   - Adds `context_packs.source TEXT NOT NULL DEFAULT 'agent'` (SQLite) / `varchar(16) NOT NULL DEFAULT 'agent'` (Postgres) with a CHECK constraint `source IN ('agent', 'bridge_auto')`.
   - Adds four optional columns to `decisions`: `context TEXT`, `impact TEXT` (JSON-encoded array), `confidence TEXT` (CHECK `IN ('high','medium','low')`), `reversible INTEGER` / `boolean` (nullable — old rows have NULL meaning "unknown").
   - Adds four optional columns to `context_packs` *not* via separate columns but in a new `context_packs_meta` JSON column (single column, agent-curated metadata: `decisionIds`, `affectedFiles`, `testStatus`, `openTodos`). Single column avoids per-field migration when fields evolve.
   - `0010_m05_agent_driven.sql` is the migration filename in both `drizzle/sqlite/` and `drizzle/postgres/`. `migrations.lock.json` does not need a new entry (no hand-edited preserve-block).
8. **Schema delta — REMOVAL** — separate migration `0011_drop_embeddings.sql` (both dialects):
   - SQLite: `DROP TABLE IF EXISTS context_packs_vec;` followed by the rebuild-and-rename pattern that Drizzle's SQLite generator produces for `summary_embedding` column removal (NOT a one-line `DROP COLUMN` — see §10.1).
   - Postgres: `DROP INDEX IF EXISTS context_packs_summary_embedding_hnsw_idx;` first, then `ALTER TABLE context_packs DROP COLUMN IF EXISTS summary_embedding;`. Order matters — index drop must precede column drop.
   - `migrations.lock.json` updated: the `sqlite-vec` blockMarker entry on `0001_chief_turbo.sql` is removed (the table created by that block no longer exists); the `pgvector-hnsw` blockMarker entry on `0001_clean_rafael_vega.sql` is removed (the index it creates has been dropped).
9. **Backwards compatibility:** every CLI command (M08a + M08b — 20 commands) keeps its surface verbatim. Two new commands added: `coodra packs list [--project <slug>]` and `coodra packs read <packId|runId>`. Existing `coodra pack show / regenerate / delete` are unaffected (those operate on Feature Packs, not Context Packs — naming is distinct). Note the pluralization split: `pack` (singular) = feature pack, `packs` (plural) = context packs. Documented in CLI help.
10. **Manifest test:** `apps/mcp-server/__tests__/integration/manifest.test.ts` asserts the tool count is **12**, not 10. New tools registered: `list_context_packs`, `read_context_pack`. All 12 manifest descriptions pass the `assertManifestDescriptionValid` recipe (40-80 words, imperative trigger, return-shape sentence).
11. **No M05-as-service references remain:**
    - `system-architecture.md` §2 service inventory has no `nl-assembly` row on `:3200`.
    - `system-architecture.md` §18 (LLM Enrichment Strategy) is rewritten in-place to describe the agent-driven model (or removed and a forward pointer to this spec inserted; preference: rewrite in place, single source of truth).
    - `essentialsforclaude/11-adrs.md` ADR-012 is revised to reverse the priority — agent-authored is canonical, bridge auto-save is fallback (current wording does the opposite).
    - `essentialsforclaude/05-agent-trigger-contract.md` §5.4 (record_decision) and §5.9 (save_context_pack) get imperative reframes per Mechanism B in §6.
    - No source file in `apps/`, `packages/`, or `docs/` contains the strings `"Module 05 will replace this"`, `"deferred to Module 05"`, `"M05 owns"`, `"NL Assembly service"`, or equivalent. CI grep test added.
12. **Web app contract:**
    - `apps/web-v2/app/page.tsx` dashboard adds the "Agent narrative coverage" stat card (Mechanism E).
    - `apps/web-v2/app/runs/[id]/page.tsx` shows the pack's `source` ('agent' or 'bridge auto-save') with a small badge.
    - `apps/web-v2/app/packs/page.tsx` (Context Packs surface — to be confirmed; today this route is Feature Packs) is left as-is. Context Pack listing surface lives at the run-detail page since packs are scoped to runs.
13. **Performance:** the bridge SessionStart hook with recent-decisions injection enabled stays inside its 3s budget (§6 system-architecture). The injection adds <10ms locally for a project with 100 decisions (single indexed query, formatted in memory).
14. **Module 05 Context Pack** saved to `docs/context-packs/YYYY-MM-DD-module-05-agent-driven-nl-assembly.md`. README module-status table flips 05 → ✅. The pack documents the decisions in §1.1 (why we abandoned the original plan) so future sessions can't accidentally re-litigate them.

## 3. Non-goals

These are deliberately excluded and are **not** stubbed:

- **No Python service of any kind.** No `services/`, no FastAPI, no Uvicorn, no `:3200`. If the directory exists from prior work, it is removed.
- **No embedding model in any process.** No sentence-transformers, no `@xenova/transformers`, no ONNX runtime, no model files in `~/.coodra/`. The agent's own model is the only one in play.
- **No vector store.** No `sqlite-vec` virtual table, no `pgvector` HNSW index, no `summary_embedding` column. Existing scaffolding is removed in `0011_drop_embeddings.sql`.
- **No post-hoc LLM enrichment.** No service, no cron job, no BullMQ worker that takes a written Context Pack and rewrites it. The bridge's structured digest is the floor; the agent's authored pack is the canonical. There is no third path.
- **No FTS5 / `tsvector` ranked full-text search yet.** `search_packs_nl` becomes a LIKE query over a wider concatenated field (title + excerpt + first 2KB of content) ordered by `created_at DESC`. We accept this scales to ~500 packs per project before relevance becomes painful (§9). Adding ranked search is a future module, not M05.
- **No cross-project pack search.** `search_packs_nl`, `list_context_packs`, `read_context_pack` are all project-scoped. Searching across projects requires a workspace-level surface that's out of scope.
- **No schema-level relaxation of ADR-007.** Append-only by `runId` is preserved. The `source` column is set on first insert and never updated. The agent's call wins by ordering — see §6.B.3 — not by upsert.
- **No agent-side metric collection.** The web dashboard's coverage stat is computed from `context_packs.source` rows; it does not require the agent to emit telemetry.
- **No third-party telemetry.** The five compliance mechanisms (§6) are all internal — manifest text, in-process counters, dashboard reads. Nothing leaves the user's machine in solo mode.
- **No automatic backfill of pack `source`.** Existing rows (zero today) get `'agent'` as the default — the column is added with `DEFAULT 'agent'` so any pre-existing row is treated as canonical. New rows after migration explicitly write `'agent'` or `'bridge_auto'`.

## 4. The agent-as-intelligence reframe

This section captures the philosophy so future sessions don't re-litigate it.

**Embeddings were the right primitive in 2022.** When LLMs had 4k–8k context windows and tool calls were expensive, you could not afford to read 50KB of pack content per query. Cosine similarity over short excerpts let you pre-filter to 3 likely candidates, then read those. Statistical retrieval was a context-budget compression strategy.

**In 2026, the agent has 200k+ context and `read_context_pack` is one tool call.** The constraint that justified the embedding model is gone. A frontier-class agent reading two full Context Packs reasons about them better than 384-dim cosine over their first 500 characters. The marginal intelligence gain from adding embeddings on top of the agent is approximately zero, while the cost — Python toolchain, embedding pipeline, vector store, model versioning, cold-start backfill, post-hoc LLM enrichment — is high and ongoing.

**The agent already runs LLM-grade reasoning. Use it.** The system's job is to make the agent's reasoning load-bearing: store rich content, expose explicit list/read/search tools, record structured intent at the moment it's formed (`record_decision` with `confidence`, `impact`, `reversible`), and inject the most-recent decisions into SessionStart so the agent's first turn already knows the team's recent moves.

**Two consequences we accept:**

1. **Retrieval is slower per query.** "What did we decide about X?" goes from 50ms cosine top-3 to 4-6 tool calls + tens of thousands of read tokens. We accept this trade. The agent does it once per question, gets a thorough answer, and the user gets reasoning the agent can defend — not a similarity score the agent pretends to understand.
2. **Vocabulary mismatch is real.** If a decision was recorded as "we picked BullMQ for queue infrastructure" and the user asks "what's our async job framework?", agent-driven LIKE search depends on the agent generating the right keywords. Mitigation: SessionStart auto-injects the most-recent decisions (§7), so common cross-cuts are visible without retrieval. Beyond that, the agent generates query expansions itself (multiple LIKE searches with different keywords) when it doesn't find what it expected.

The framing in user-facing copy is: **"agent-authored is canonical, bridge auto-save is fallback."** Not "gold standard with fallback" — that's aspirational. The honest framing is reflected in the dashboard stat (§6.E) and the manifest descriptions (§6.A).

## 5. Tool surface

The MCP manifest grows from 10 tools to 12. Two new tools, four modified, the rest unchanged.

### 5.1 NEW — `list_context_packs`

```
Input:  { projectSlug: string, limit?: number, cursor?: string }
        - limit: 1..100, default 20
        - cursor: opaque string from prior call's `nextCursor`; keyset pagination
                  on (created_at, id) descending
Output: { ok: true, packs: Array<{
            id: string,
            title: string,
            excerpt: string,        // first 500 chars of content
            savedAt: string,        // ISO
            runId: string,
            source: 'agent' | 'bridge_auto',
        }>, nextCursor: string | null }
```

**Manifest description (~70 words):**
> Call this when you need to enumerate Context Packs for a project — answering "what work has happened here recently" or "have we tackled this kind of problem before". Returns paginated list ordered by save time, newest first. Use the `source` field to distinguish agent-authored narratives from bridge auto-summaries; prefer the former when reading detail. Pair with `read_context_pack` to load full content for any candidate.

Read-only tool. Idempotency key kind `readonly`. Pagination via cursor on `(created_at DESC, id DESC)` to handle ties.

### 5.2 NEW — `read_context_pack`

```
Input:  { packId: string } | { runId: string }
        - exactly one required (Zod discriminated union)
        - decisionsLimit?: number (default 50, max 200) — cap on hydrated decisions
        - excerptOnly?: boolean (default false) — when true, returns the 500-char
          excerpt instead of full content (for budget-constrained reads)
Output: { ok: true, ... } discriminated union:
  - found:     { ok: true, found: true, title, content | excerpt, savedAt, runId,
                 source, featurePackSlug: string | null,
                 decisions: Array<{ id, description, rationale, alternatives,
                                    context, impact, confidence, reversible,
                                    createdAt }> }
  - not_found: { ok: true, found: false }       (input was well-formed but no row)
  - too_large: { ok: false, error: 'pack_too_large', howToFix: string }
                                                 (content > 200KB; ask agent to use excerptOnly)
```

**Manifest description (~75 words):**
> Call this after `list_context_packs` or `search_packs_nl` to load the full body of a single Context Pack. Returns title, content, save time, source (agent/bridge), the linked Feature Pack slug if any, and all `decisions` recorded during that run with their full structured fields. Set `excerptOnly` true when budget is tight. Returns `pack_too_large` for packs over 200KB; retry with `excerptOnly: true` to get a 500-char preview.

Hydrates decisions inline because the agent almost always wants both. Decisions are ordered chronologically (`created_at ASC`) to reflect how the session unfolded; agents typically read them in that order to follow the narrative.

### 5.3 MODIFIED — `search_packs_nl`

**Removed:**
- The `embedding: number[]` input parameter.
- The semantic KNN branch in the handler (calls to `ctx.sqliteVec.searchSimilarPacks`).
- The `notice: 'no_embeddings_yet'` and `howToFix` advisory output fields.
- The `embedding_dim_mismatch` soft-failure branch.

**Modified:**
- LIKE scope expanded from `title + content_excerpt` to `title + content_excerpt + substr(content, 1, 2000)`. Wider net for keyword hits.
- Default limit raised from 10 to 50.
- Manifest description rewritten: *"Searches Context Pack titles and the first 2KB of content by keyword. Returns up to 50 matches ordered by recency. Prefer this for keyword-precise queries; for semantic exploration, call `list_context_packs` and reason over candidate titles. Use your own judgment to rank relevance after reading candidates with `read_context_pack`."*

**Honest documentation:** the manifest explicitly says "ordered by recency, not relevance." Agents are instructed in the description to apply their own ranking. This is the LIKE-with-recency-tiebreak approach, accepted for solo and small-team scale (~500 packs per project). FTS5/tsvector ranking is a future module.

### 5.4 MODIFIED — `save_context_pack`

**Added optional input fields** (all stored in a new single JSON column `context_packs.meta` to avoid per-field migrations):

```ts
meta: {
  decisionIds?: string[];       // decisions that materially support this pack
  affectedFiles?: string[];     // files the agent considers important (curated, not exhaustive)
  testStatus?: 'pass' | 'fail' | 'skip' | 'unknown';
  openTodos?: string[];         // remaining work the next session should pick up
}
```

**Behavior:**
- When the agent calls explicitly, the handler sets `source = 'agent'`.
- When the bridge auto-saves (Pattern 20), the handler sets `source = 'bridge_auto'`.
- Idempotency by `runId` preserved (ADR-007). If both fire for the same run:
  - **Agent first → bridge second:** bridge's call returns the existing row unchanged (no-op). Agent's content + `source='agent'` stick.
  - **Bridge first → agent second:** agent's call DETECTS `source='bridge_auto'` and is allowed to overwrite content + flip `source='agent'` (this is the ONE relaxation of ADR-007 — explicit, narrow, justified). Two non-bridge agent calls still collapse to a no-op (agent never overwrites another agent's pack within the same runId).

**Manifest description rewrite (Mechanism A — see §6.A):**
> **Call this at session end before signaling exit.** Write a narrative recap synthesizing what was built, what was decided, what's still open. This is the canonical record the next session will read. The bridge's auto-save fires as a fallback for crashed sessions and produces a structured event digest, not a narrative — skipping this call means the next agent inherits the digest only. Include `decisionIds`, `affectedFiles`, `testStatus`, `openTodos` in `meta` when applicable.

### 5.5 MODIFIED — `record_decision`

**Added optional input fields:**

```ts
context?: string;              // what triggered this decision (user request, error, design review)
impact?: string[];             // affected modules / API surfaces / files
confidence?: 'high' | 'medium' | 'low';
reversible?: boolean;          // can this be undone without major cost
```

**Schema:** four new nullable columns on `decisions` (see §2.7). Old rows have NULLs (legacy decisions had no concept of confidence; we don't backfill).

**Idempotency key behavior — IMPORTANT:** the existing key is `dec:{runId}:{sha256(description).slice(0,32)}`. We **do NOT include the new fields in the key**. Rationale: identical descriptions logged twice with different metadata are still the same decision — second call collapses. If the agent wants to update the metadata after the first call, that's an explicit `update_decision` operation we don't ship in M05 (out of scope; record correctly the first time or live with the first version).

**Manifest description rewrite (Mechanism A):**
> **Record every design or implementation decision the moment you make it.** Future sessions consult this table — and SessionStart auto-injects the 10 most recent — to avoid silent contradictions. Include `context` (what prompted the decision), `impact` (modules affected), `confidence` ('high' | 'medium' | 'low'), and `reversible` (can it be undone cheaply). Calls made retrospectively after the run ends lose the implicit run context and may collide on idempotency.

### 5.6 MODIFIED — `query_codebase_graph`

**Removed:** the `'query_filtering_deferred_to_m05'` notice in the success output. Manifest description loses the "query filtering is deferred to Module 05" clause.

**Behavior unchanged otherwise.** Agent receives the full subgraph (or the soft-failure when the index is missing). Agent applies its own filtering by reasoning over `nodes` + `edges`. We accept this puts a context-budget burden on the agent for large graphs (>5,000 nodes); a `maxNodes: number` parameter (default 1000) is added to cap the result size — soft-failure `graph_too_large` when exceeded, with `howToFix: "narrow with --query or use graphify CLI to scope"`. Future work may add typed filtering server-side; not in M05.

### 5.7 UNCHANGED

The remaining 6 tools — `ping`, `get_run_id`, `get_feature_pack`, `check_policy`, `query_run_history`, `query_decisions` — are unaffected by M05.

## 6. Agent compliance discipline — Mechanisms A through E

The architecture bets that agents reliably call `save_context_pack` and `record_decision`. Today they don't (this is why Pattern 20 exists). M05 layers five mechanisms to flip the ratio. None alone is enough; together they target ~80% canonical coverage at steady state.

### 6.A — Imperative manifest descriptions

**Where:** `save_context_pack/manifest.ts`, `record_decision/manifest.ts`.

Replace permissive language ("Use this when…") with imperative language ("Call this at…"). The new wording is in §5.4 and §5.5 above. The 40-80 word recipe enforced by `assertManifestDescriptionValid` is preserved.

### 6.B — Trigger contract reframe

**Where:** `essentialsforclaude/05-agent-trigger-contract.md` §5.4 (record_decision), §5.9 (save_context_pack), `essentialsforclaude/11-adrs.md` ADR-012.

§5.9 today positions agent calls as *optional richness on top of the bridge default*. Reverse the framing:

> **Always call save_context_pack at session end.** The bridge's auto-save exists for two cases: (a) the session crashed before you got to it, (b) non-Claude/Cursor agents that don't run hooks. Treat its existence as a safety net, not a substitute. Auto-save produces a structured event digest; only your call produces a readable narrative. Late calls are still better than none — but the canonical pattern is "call this immediately when you decide the work is complete, before signaling exit."

ADR-012 is revised in the same change. New text:

> **Agent-authored Context Packs are canonical.** The bridge's autonomous auto-save (Pattern 20) is the fallback floor for sessions where the agent didn't call `save_context_pack` — it produces a structured event digest derived from `run_events` + decisions, suitable for retrospective grep but not as readable as an agent-authored narrative. The `context_packs.source` column distinguishes the two: `'agent'` rows are the canonical record, `'bridge_auto'` rows are floor-only. Mechanisms A-E (M05 spec §6) target ~80% canonical coverage; the dashboard surfaces the live ratio.

### 6.C — End-of-session reminder injected at SessionStart

**Where:** `apps/hooks-bridge/src/handlers/session-start.ts`.

The Stop hook fires after the agent has mentally exited — too late to remind. Inject the contract at SessionStart instead, as part of the same `additionalContext` block that delivers the Feature Pack:

```markdown
## Session contract

This session ends with a call to `save_context_pack` — a narrative recap of what
was built, what was decided, what's still open. Don't skip it. The bridge will
write a structured digest as a safety net only; your call is the canonical record
the next session will read. When you make a design or implementation choice mid-
session, call `record_decision` immediately (not retrospectively).
```

That sentence sits in the agent's first turn alongside Feature Pack content + recent decisions (§7). Agents condition on early system content reliably; this is one of the highest-leverage placements available. Cost: ~10 lines in the bridge. Configurable via `.coodra.json` field `sessionStart.contractReminder: boolean` (default `true`).

### 6.D — Mid-session reminder when the session goes long

**Where:** `apps/hooks-bridge/src/handlers/post-tool-use.ts` + new `apps/hooks-bridge/src/lib/session-state.ts`.

In-memory counter keyed by `runId`. When the bridge has counted **N PostToolUse events for this run without a `save_context_pack` call** (default N=15, configurable via `.coodra.json:sessionStart.midSessionReminderAfter`), inject a one-shot system reminder via the next hook response:

```
<system-reminder>
You've made 15 tool calls in this session without calling save_context_pack.
When you wrap up this work, call it with a narrative recap of what was built.
</system-reminder>
```

Fires **once per run**, not on every PostToolUse. Counter cleared on Stop. Disabled when `midSessionReminderAfter: 0`. Catches the "agent forgot" failure mode without nagging chatty sessions.

### 6.E — Coverage metric on the dashboard

**Where:** `apps/web-v2/lib/queries/dashboard.ts` + `apps/web-v2/app/page.tsx`.

New stat card on the workspace dashboard (next to "Active runs" / "Decisions · 24h" / "Active switches" / "Mode"):

```
Agent narrative coverage
73%
last 7d · 47 of 64 sessions
```

Definition:
```sql
SELECT
  COUNT(*) FILTER (WHERE source = 'agent') * 1.0 / NULLIF(COUNT(*), 0) AS coverage,
  COUNT(*) FILTER (WHERE source = 'agent') AS agent_count,
  COUNT(*) AS total
FROM context_packs cp
JOIN runs r ON r.id = cp.run_id
WHERE cp.created_at > now() - interval '7 days'
  AND r.status = 'completed';
```

(Dialect-adapted in `apps/web-v2/lib/queries/dashboard.ts`.)

This is the **measurement piece**. Without it the team can't tell whether Mechanisms A-D are working. Make the number visible and you'll iterate when it drops. Stretch goal (post-M05): an alert hook when coverage drops below threshold over a moving window.

## 7. Recent decisions auto-injection at SessionStart

Closes the cross-developer awareness gap that embedded retrieval would have masked.

### 7.1 What it does

When the bridge resolves a project's primary Feature Pack on the SessionStart hook, it ALSO loads the project's most-recent `decisions` and appends them to the `additionalContext` block. The agent's first turn sees Feature Pack content + recent decisions side-by-side; no tool call needed.

### 7.2 Configuration

Per-project, in `.coodra.json`:

```json
{
  "sessionStart": {
    "recentDecisionsLimit": 10,
    "recentDecisionsMaxAgeDays": 30,
    "contractReminder": true,
    "midSessionReminderAfter": 15
  }
}
```

All four are optional. Defaults shown above. `recentDecisionsLimit: 0` disables the feature for projects that don't want it.

### 7.3 Query

```sql
SELECT id, run_id, description, rationale, alternatives, context, impact,
       confidence, reversible, created_at
FROM decisions
WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1)
  AND created_at > now() - interval '$2 days'
ORDER BY
  CASE confidence WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 2 END,
  created_at DESC
LIMIT $3;
```

Dialect-adapted in `apps/hooks-bridge/src/lib/recent-decisions.ts`. The `confidence` clause prioritizes high-confidence decisions on truncation — at solo scale (10 decisions) it has no effect; at team scale (50 in 30 days truncated to 10) it surfaces load-bearing decisions over speculative ones. NULL confidence sorts as `'medium'` for backward compatibility with rows written before the column existed.

### 7.4 Format

Markdown block appended to `additionalContext` after the Feature Pack and Session Contract, separated by horizontal rules:

```markdown
---

## Recent decisions for `<projectSlug>` (last 10, past 30 days)

### 2026-05-08 14:22 — Picked BullMQ over pg-boss for async jobs
**Context:** Reviewing job queue options for tier-2 LLM call rate limiting.
**Rationale:** BullMQ has rate-limiting + dashboard; pg-boss is simpler but lacks the ratelimiter we need for LLM API calls.
**Alternatives:** pg-boss, Inngest
**Impact:** packages/queue, apps/mcp-server/src/tools/check-policy
**Confidence:** high · **Reversible:** yes (queue is behind a thin abstraction)

### 2026-05-07 09:15 — Dropped COODRA_DB_OVERRIDE_MODE flag
**Rationale:** apps/mcp-server and apps/hooks-bridge are SQLite-only by design. Flag was a Module 02 stop-gap.
**Alternatives:** Keep as opt-in for testing
**Confidence:** high · **Reversible:** no (binaries hardcoded to local DB)

### ... (8 more)
```

Decisions written before M05 lands (with no `context`, `impact`, `confidence`, `reversible` columns) render description + rationale + alternatives only. The format gracefully degrades — empty fields are omitted, not rendered as "**Context:** null".

### 7.5 Latency

SessionStart hook budget: 3s (system-architecture §6). Decision query: single indexed read against `decisions_run_created_idx` joined to `runs.project_id` LIMIT 10. Locally <10ms. Negligible.

### 7.6 Failure semantics

Fail-open. Any DB error → `recent-decisions.ts` logs a warn and returns `null` → bridge proceeds with Feature Pack only. SessionStart never blocks on this.

### 7.7 Caveats (documented in implementation.md)

1. **Recency is not relevance.** A load-bearing decision from 6 months ago that's still active won't surface. Same scaling argument as caveat 1 — fine at solo scale, may want ranked-by-importance later. Don't solve it now.
2. **30-day default may be wrong** for some projects. Per-project config addresses it for sophisticated users; default works for most.
3. **Team mode multiplies traffic.** A project with 5 active devs may have 50 decisions in 30 days; truncating at 10 means dev B sees the most-recent 10 which may all be dev A's. The `confidence` ordering tweak in §7.3 mitigates — high-confidence load-bearing decisions surface over recent speculative ones.

## 8. Removed scaffolding

A complete inventory of what comes out of the codebase. CI's `manifest-test` and `grep-no-m05-references` (new test) enforce the inventory.

| File / symbol | Action | Why |
|---|---|---|
| `apps/mcp-server/src/lib/sqlite-vec.ts` | **Delete** | No semantic KNN path |
| `apps/mcp-server/src/index.ts:141, :155` | **Edit** | Remove `createSqliteVecClient` instantiation; remove `sqliteVec` from `ContextDeps` wiring |
| `apps/mcp-server/src/framework/tool-context.ts:138, :234` | **Edit** | Remove `SqliteVecClient` field from `ContextDeps` interface |
| `packages/shared/src/constants.ts` | **Delete** | `EMBEDDING_DIM` constant has no consumer |
| `packages/shared/src/index.ts` | **Edit** | Remove `export * from './constants'` |
| `packages/shared/__tests__/unit/constants.test.ts` | **Delete** | The constant is gone |
| `packages/db/src/schema/sqlite.ts:97` | **Edit** | Remove `summaryEmbedding: text('summary_embedding')` from `contextPacks` definition |
| `packages/db/src/schema/postgres.ts:86` | **Edit** | Remove `summaryEmbedding: vector('summary_embedding', { dimensions: 384 })` |
| `packages/db/__tests__/integration/sqlite-vec.test.ts` | **Delete** | Tests a removed surface |
| `apps/mcp-server/__tests__/integration/lib/sqlite-vec.test.ts` | **Delete** | Tests a removed surface |
| `apps/mcp-server/__tests__/integration/lib/context-pack.test.ts` | **Edit** | Remove embedding-write assertions; keep the rest |
| `apps/mcp-server/__tests__/unit/tools/search-packs-nl.test.ts` | **Edit** | Remove semantic-branch tests; keep LIKE-fallback tests, expand coverage of new wider-LIKE scope |
| `apps/mcp-server/__tests__/integration/tools/search-packs-nl.test.ts` | **Edit** | Same |
| `apps/sync-daemon/src/lib/dispatch.ts` | **Edit** | Remove `EMBEDDING_DIM` import + any embedding-aware dispatch logic |
| `apps/hooks-bridge/src/lib/auto-context-pack.ts:93` | **Edit** | Remove the "Module 05 will replace this" comment; replace with new framing per §1.2 |
| `apps/mcp-server/src/tools/query-codebase-graph/manifest.ts:50` | **Edit** | Remove "deferred to Module 05" clause from description |
| `apps/mcp-server/src/tools/query-codebase-graph/handler.ts:46, :50` | **Edit** | Remove deferral comment + `notice: 'query_filtering_deferred_to_m05'` from success output |
| `system-architecture.md` §2 service inventory | **Edit** | Remove the `nl-assembly :3200 Python FastAPI` row |
| `system-architecture.md` §18 LLM Enrichment Strategy | **Rewrite** | New section: agent-driven, no service, points at this spec |
| `system-architecture.md` §22.4, §23.9 | **Edit** | Replace "NL Assembly receives JIRA/GitHub context" with "agent receives JIRA/GitHub context inline at SessionStart" |
| `system-architecture.md` §24 manifest | **Edit** | Update tool count 10 → 12; add `list_context_packs`, `read_context_pack` |
| `essentialsforclaude/05-agent-trigger-contract.md` §5.4, §5.9 | **Edit** | Imperative reframe (Mechanism B) |
| `essentialsforclaude/11-adrs.md` ADR-012 | **Edit** | Reverse priority — agent canonical, bridge fallback |
| `packages/db/drizzle/sqlite/0001_chief_turbo.sql` | **Leave** | Migration history is immutable. The vec table it creates is dropped in `0011_drop_embeddings.sql` |
| `packages/db/drizzle/postgres/0001_clean_rafael_vega.sql` | **Leave** | Same — HNSW index it creates is dropped in `0011` |
| `packages/db/migrations.lock.json` | **Edit** | Remove `sqlite-vec` and `pgvector-hnsw` entries |
| `packages/cli/dist/runtime/drizzle/**/*.sql` | **Regenerate** | CLI bundles migrations as runtime artifacts; rebuild after `0010` and `0011` land |
| `packages/cli/dist/runtime/mcp-server/index.js` | **Regenerate** | CLI bundles a runtime mcp-server; rebuild after the deletions |

## 9. Schema deltas

Two migrations, in order.

### 9.1 `0010_m05_agent_driven.sql` (both dialects)

Adds new columns. Runs first.

**SQLite:**
```sql
-- New: source column on context_packs (agent vs bridge_auto)
ALTER TABLE context_packs ADD COLUMN source TEXT NOT NULL DEFAULT 'agent';
-- CHECK constraint enforced at app layer (SQLite CHECK is lax across versions)

-- New: meta JSON blob on context_packs
ALTER TABLE context_packs ADD COLUMN meta TEXT;  -- JSON-encoded; NULL allowed

-- New: structured fields on decisions
ALTER TABLE decisions ADD COLUMN context TEXT;
ALTER TABLE decisions ADD COLUMN impact TEXT;       -- JSON-encoded array
ALTER TABLE decisions ADD COLUMN confidence TEXT;   -- 'high' | 'medium' | 'low' | NULL
ALTER TABLE decisions ADD COLUMN reversible INTEGER;  -- boolean, NULL = unknown
```

**Postgres:**
```sql
ALTER TABLE context_packs
  ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT 'agent'
    CHECK (source IN ('agent', 'bridge_auto')),
  ADD COLUMN meta JSONB;

ALTER TABLE decisions
  ADD COLUMN context TEXT,
  ADD COLUMN impact JSONB,
  ADD COLUMN confidence VARCHAR(8) CHECK (confidence IN ('high', 'medium', 'low')),
  ADD COLUMN reversible BOOLEAN;
```

### 9.2 `0011_drop_embeddings.sql` (both dialects)

Removes embedding scaffolding. Runs second so `0010` is in place first (independence).

**SQLite (rebuild-and-rename pattern, generated by Drizzle):**
```sql
DROP TABLE IF EXISTS context_packs_vec;

-- Drizzle generates the rebuild for column drop on SQLite:
CREATE TABLE __new_context_packs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_excerpt TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'agent',
  meta TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO __new_context_packs SELECT id, run_id, project_id, title, content,
  content_excerpt, source, meta, created_at FROM context_packs;
DROP TABLE context_packs;
ALTER TABLE __new_context_packs RENAME TO context_packs;
CREATE UNIQUE INDEX context_packs_run_idx ON context_packs(run_id);
CREATE INDEX context_packs_project_created_idx ON context_packs(project_id, created_at);
```

**Postgres:**
```sql
DROP INDEX IF EXISTS context_packs_summary_embedding_hnsw_idx;
ALTER TABLE context_packs DROP COLUMN IF EXISTS summary_embedding;
```

`migrations.lock.json` updated in the same commit: remove the two preserve-block entries (`sqlite-vec` on `0001_chief_turbo.sql`, `pgvector-hnsw` on `0001_clean_rafael_vega.sql`).

## 10. Open questions and locks

The following were considered during spec authoring (2026-05-08) and locked. Documented so future sessions don't re-litigate.

| OQ | Question | Lock |
|---|---|---|
| OQ-1 | Keep `summary_embedding` column nullable for optionality? | **No.** Full removal. Cost of resurrection (one migration) is small; cost of carrying dead schema is ongoing. |
| OQ-2 | One migration or two? | **Two.** `0010` adds; `0011` removes. Independent rollback if `0011` causes issues in dist tarball regeneration. |
| OQ-3 | `affectedFiles` curated highlights or full file list? | **Curated highlights** (agent's choice, top 5-10). Full list is derivable from `run_events.tool_input` at read time; duplicating it in the pack is waste. |
| OQ-4 | `decisionIds` redundant with implicit `runId` join? | **Keep — explicitly cross-run.** Allows packs to reference decisions from earlier sessions when synthesizing follow-up work. Implicit join still works as a default. |
| OQ-5 | Should `record_decision`'s idempotency key include new fields? | **No.** Identical descriptions twice = same decision; second collapses. Update semantics = future module. |
| OQ-6 | ADR-007 conflict resolution? | **Narrow upgrade-in-place** for `context_packs` only, ONLY when existing `source='bridge_auto'` and incoming call is agent-explicit. All other rewrites still no-op. |
| OQ-7 | `query_codebase_graph` result size cap? | **`maxNodes: 1000` default**, soft-failure `graph_too_large` when exceeded. |
| OQ-8 | Web v2 surface for Context Packs list? | **Run-detail page** (existing `/runs/[id]`). Context Packs are run-scoped; they don't need a dedicated route. Show `source` badge. |
| OQ-9 | Recent-decisions injection — solo vs team default? | **Same default both modes.** `recentDecisionsLimit: 10`, `maxAgeDays: 30`. Teams that need different values configure via `.coodra.json`. |
| OQ-10 | Coverage metric — what time window? | **Rolling 7 days** for the dashboard card. Per-run `source` is permanent in the DB; longer-window analytics are post-M05. |

## 11. Slice plan (high-level)

Detailed in `implementation.md`. Eight slices, each independently shippable:

- **S1 — Schema additions.** `0010_m05_agent_driven.sql` lands. Tests verify column existence + defaults. (~half day)
- **S2 — Schema removals.** `0011_drop_embeddings.sql` lands. Six test files deleted/edited. CLI dist regenerated. (~1 day)
- **S3 — sqlite-vec runtime removal.** `apps/mcp-server/src/lib/sqlite-vec.ts` deleted; ContextDeps cleaned; sync-daemon import removed; `EMBEDDING_DIM` deleted. (~half day)
- **S4 — Tool surface changes.** `search_packs_nl` simplified; `save_context_pack` + `record_decision` accept new fields; `query_codebase_graph` cleaned; manifest test asserts 10 tools (interim count before S5). (~1 day)
- **S5 — Two new tools.** `list_context_packs`, `read_context_pack` implemented + tested + registered. Manifest test asserts 12 tools. (~1 day)
- **S6 — Compliance mechanisms.** Manifest A reframes; trigger contract B updates; SessionStart contract reminder C; mid-session reminder D; coverage metric E (web). ADR-012 revised. (~1.5 days)
- **S7 — Recent decisions injection.** `apps/hooks-bridge/src/lib/recent-decisions.ts` + SessionStart wiring + `.coodra.json` schema extension + tests. (~1 day)
- **S8 — Documentation closeout.** `system-architecture.md` §2/§18/§22.4/§23.9/§24 edits; `essentialsforclaude` updates; CI grep test for "M05 service" / "deferred to Module 05" strings. Module 05 Context Pack saved. (~half day)

Total: ~6.5 days of focused work. Comfortably one sprint.

## 12. Why this is the right shape

Captured here so the next architect doesn't second-guess.

1. **The agent's model is the cheapest, smartest LLM in the system.** Every alternative (sentence-transformers + Ollama + Gemini service) is strictly less capable at synthesis and strictly more operational overhead. Use what's already paid for.
2. **Storage + structured tools + full-text search is a load-bearing minimum.** Don't add layers that the agent doesn't need. If FTS5 ranking becomes necessary later (>500 packs/project), it's one migration on top — not a redesign.
3. **The bridge's auto-save is genuine value.** It catches sessions where the agent failed (crash, OOM, exit without Stop). Pattern 20 stays. We just stop pretending it's the canonical artifact.
4. **Recent-decisions injection is the cheap mitigation for the cross-developer awareness gap.** ~1 day of work to close a real product hole. Nothing else in the M05 design lands as much value per line of code.
5. **The compliance mechanisms aren't enforcement — they're nudges.** A, B, C, D push agents toward calling the tools; E measures whether the push works. None of them block. Nothing breaks if the agent skips the call. The bridge floor catches it. The dashboard shows the cost.

## 13. References

- `system-architecture.md` §2 (service inventory), §6 (latency), §18 (LLM strategy — being rewritten), §24 (manifest)
- `essentialsforclaude/11-adrs.md` ADR-007 (append-only), ADR-012 (Pattern 20 — being revised)
- `essentialsforclaude/05-agent-trigger-contract.md` §5.4, §5.9
- `apps/mcp-server/src/tools/save-context-pack/`, `apps/mcp-server/src/tools/record-decision/`, `apps/mcp-server/src/tools/search-packs-nl/`
- `apps/hooks-bridge/src/handlers/session-start.ts`, `apps/hooks-bridge/src/lib/auto-context-pack.ts`
- `packages/db/src/schema/sqlite.ts`, `packages/db/src/schema/postgres.ts`, `packages/db/migrations.lock.json`
- This spec's prior conversations: 2026-05-08 brainstorm thread → original M05 plan → 23-finding audit → reshape (this spec).
