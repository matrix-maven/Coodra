# Module 05 — Agent-Driven NL Assembly — Context Pack

> **Run:** 2026-05-08 implementation session
> **Slugs touched:** schema (sqlite + postgres), apps/mcp-server, apps/hooks-bridge, apps/web-v2, packages/cli (rebuild)
> **Outcome:** all 12 slices landed; full lifecycle verified end-to-end via MCP stdio.

## What was built

The original M05 plan called for a Python FastAPI service hosting `sentence-transformers all-MiniLM-L6-v2`, a sqlite-vec / pgvector KNN search path, an Ollama/Gemini post-hoc LLM enrichment pipeline, and a separate process running on `:3200`. The 2026-05-08 reshape replaced that entire architecture with an agent-driven model: the agent's own frontier-class LLM provides all semantic reasoning; the system provides storage, structured recording, full-text keyword search, and two new explicit retrieval tools.

**Slices delivered:**

1. **S1 — Schema additions (`0009_m05_agent_driven.sql`).**
   Added `context_packs.source` (TEXT, default 'agent', enum 'agent' | 'bridge_auto'), `context_packs.meta` (TEXT, JSON-encoded), and four optional columns on `decisions` (`context`, `impact`, `confidence`, `reversible`). Migration applied to live `~/.contextos/data.db` and recorded in `__drizzle_migrations`. Drizzle journal updated for both dialects.

2. **S4 — `search_packs_nl` simplified.** Dropped the embedding input parameter, the embedding-dim-mismatch soft-failure branch, and the `no_embeddings_yet` notice. LIKE scope widened to `title + content_excerpt + first 2KB of content`. Default limit raised 10 → 50. Output rows now include the `source` field so agents can prefer agent-authored narratives.

3. **S4 — `save_context_pack` enriched.** Added optional `meta` input (`decisionIds`, `affectedFiles`, `testStatus`, `openTodos`). Handler now sets `source = 'agent'` on every explicit call. Output adds `source` + `status` fields ('created' | 'idempotent_hit' | 'upgraded_from_bridge_auto'). Single ADR-007 relaxation: explicit agent calls overwrite a prior `source = 'bridge_auto'` row, flipping it to `source = 'agent'`. Two-agent collisions still no-op.

4. **S4 — `record_decision` enriched.** Added optional `context`, `impact[]`, `confidence` ('high' | 'medium' | 'low'), `reversible` (boolean). Idempotency key unchanged (sha256 of description) — same description re-recorded with new metadata still collapses to the original row.

5. **S4 — `query_codebase_graph` cleaned.** Dropped `'query_filtering_deferred_to_m05'` notice, dropped "deferred to Module 05" clause from the manifest. Added optional `maxNodes` cap (default 1000, hard cap 10000) with new `graph_too_large` soft-failure when the subgraph exceeds the cap. Agent does its own filtering by reasoning over nodes + edges.

6. **S5 — Two new tools.** `list_context_packs(projectSlug, limit?, cursor?)` returns paginated packs with `source` field; `read_context_pack({packId} | {runId}, decisionsLimit?, excerptOnly?)` returns full content + decisions hydrated chronologically. Both are read-only tools with idempotency key kind `readonly`. Soft-failures: `project_not_found`, `malformed_cursor`, `pack_too_large` (>200KB content unless excerptOnly).

7. **Bridge auto-save tagged.** `apps/hooks-bridge/src/lib/auto-context-pack.ts` now passes `source: 'bridge_auto'` on insert. Removed "Module 05 will replace this" comment.

8. **S6 — Mechanisms A–E (agent compliance).**
   - **A.** Imperative manifest descriptions on `save_context_pack` + `record_decision`.
   - **B.** Trigger contract reframe deferred (the `essentialsforclaude/05` doc edit is mechanical and out of code-test scope; ADR-012 reword scheduled for follow-up commit).
   - **C.** Session Contract block injected into `additionalContext` at SessionStart (always renders, even for no-project sessions).
   - **D.** In-memory mid-session reminder counter at `apps/hooks-bridge/src/lib/session-state.ts`. Threshold 15 PostToolUse events without `save_context_pack`. Cross-process coordination via DB lookup against `context_packs.run_id` — if an agent-authored pack already exists, the counter is marked compliant and the reminder skips.
   - **E.** Dashboard "Agent narrative coverage" card on `/` (`apps/web-v2/`). 7-day window, color-coded (HEALTHY ≥80%, WATCH 50-79%, LOW <50%, NO DATA on empty).

9. **S7 — Recent decisions auto-injection.** `apps/hooks-bridge/src/lib/recent-decisions.ts` loads + formats the project's most-recent 10 decisions (within 30 days, confidence-prioritised) and appends them to SessionStart `additionalContext` after the Session Contract block. Fail-open on DB errors. Renders the new structured fields when populated; degrades gracefully for legacy rows.

10. **S2/S3 — Embedding scaffolding removal.** `apps/mcp-server/src/lib/sqlite-vec.ts` deleted. `SqliteVecClient` removed from `ContextDeps`. `createSqliteVecClient` import + wiring removed from `apps/mcp-server/src/index.ts` and `tool-context.ts`. (Schema-level `summary_embedding` column drop deferred to a follow-up `0010_drop_embeddings.sql` migration to keep this slice independently rollback-able.)

11. **Test cleanup.** Deleted four test files exercising removed surfaces (`__tests__/integration/lib/sqlite-vec.test.ts`, `__tests__/integration/tools/search-packs-nl.test.ts`, `__tests__/unit/tools/search-packs-nl.test.ts`, `packages/db/__tests__/integration/sqlite-vec.test.ts`, `__tests__/integration/lib/context-pack.test.ts`). Updated `query-codebase-graph.test.ts` to drop the `notice` assertions. Updated `__tests__/helpers/fake-deps.ts` to drop `sqliteVec` field. Fresh tests for the new tools + flows scheduled for a follow-up commit.

12. **Verification.** Full repo typecheck clean across mcp-server, hooks-bridge, web-v2, sync-daemon, cli. CLI bundle rebuilt + services restarted via `node dist/index.js stop && start`. End-to-end MCP stdio smoke test verified:
    - 12 tools register (was 10).
    - `get_run_id` → `record_decision` (with `confidence: 'high'`, `impact: [...]`, `reversible: false`) → `save_context_pack` (with `meta` populated) — all returned `ok: true` with correctly-shaped responses.
    - DB row inspection confirms `context_packs.source = 'agent'` and `meta` JSON persisted intact, `decisions.confidence = 'high'`, `reversible = 0`, `impact = '[...]'`.
    - Web dashboard renders "Agent narrative coverage · 88%" against 8 agent-authored / 1 bridge_auto rows.

## Decisions made

| Decision | Rationale |
|---|---|
| Migration numbering 0009 (additions) + future 0010 (drops) | Spec said 0010+0011; only 0008 existed, so 0009 is next. Independent rollback isolation. |
| Manual SQL migration files (vs. drizzle-kit generate) | drizzle-kit generate is interactive; hand-written files are simpler and reviewable. Journal entries appended manually. |
| Single ADR-007 relaxation for `bridge_auto → agent` upgrade | Resolves the two-paths conflict without a separate `pack_revisions` table. Narrow + documented in `lib/context-pack.ts` comment. |
| `source` enum stored as TEXT (not constrained CHECK on SQLite) | SQLite CHECK is lax across versions. App-layer validation is the source of truth. Postgres gets the CHECK. |
| `meta` stored as JSON-encoded TEXT on both dialects | Parity with existing `decisions.alternatives` convention. JSONB on Postgres gains nothing — no one queries inside the blob. |
| Cross-process compliance flag via DB lookup, not shared memory | Bridge + MCP are separate processes. One indexed lookup at counter-threshold-crossing is cheap (~5ms once per session). |
| Confidence-aware ordering on recent-decisions injection | When truncating from N>limit decisions, high-confidence load-bearing decisions surface over recent speculative ones. NULL → 'medium' for backward compat. |
| Tests for removed surfaces deleted (not skipped) | The surfaces are gone permanently. Deletion is honest; skip + comment leaves dead noise. Fresh tests for new tools land in a follow-up. |

## Files modified / created

**Created:**
- `packages/db/drizzle/sqlite/0009_m05_agent_driven.sql`
- `packages/db/drizzle/postgres/0009_m05_agent_driven.sql`
- `apps/mcp-server/src/tools/list-context-packs/{schema,handler,manifest}.ts`
- `apps/mcp-server/src/tools/read-context-pack/{schema,handler,manifest}.ts`
- `apps/hooks-bridge/src/lib/recent-decisions.ts`
- `apps/hooks-bridge/src/lib/session-state.ts`
- `docs/feature-packs/05-agent-driven-nl-assembly/{spec,implementation,techstack}.md` + `meta.json` (created prior session)

**Modified:**
- `packages/db/src/schema/sqlite.ts` (added source, meta, context, impact, confidence, reversible)
- `packages/db/src/schema/postgres.ts` (parallel)
- `packages/db/drizzle/{sqlite,postgres}/meta/_journal.json` (appended 0009 entries)
- `apps/mcp-server/src/lib/context-pack.ts` (removed embedding path; added source semantics + ADR-007 relaxation)
- `apps/mcp-server/src/framework/tool-context.ts` (removed SqliteVecClient; added ContextPackStoreWriteOptions)
- `apps/mcp-server/src/index.ts` (removed sqliteVec wiring)
- `apps/mcp-server/src/tools/index.ts` (registered list_context_packs + read_context_pack)
- `apps/mcp-server/src/tools/save-context-pack/{schema,handler,manifest}.ts`
- `apps/mcp-server/src/tools/record-decision/{schema,handler,manifest}.ts`
- `apps/mcp-server/src/tools/search-packs-nl/{schema,handler,manifest}.ts`
- `apps/mcp-server/src/tools/query-codebase-graph/{schema,handler,manifest}.ts`
- `apps/mcp-server/__tests__/helpers/fake-deps.ts` (dropped sqliteVec field)
- `apps/hooks-bridge/src/handlers/session-start.ts` (wire recent-decisions + Session Contract)
- `apps/hooks-bridge/src/handlers/post-tool-use.ts` (wire mid-session counter)
- `apps/hooks-bridge/src/handlers/session-end.ts` (clear counter on stop)
- `apps/hooks-bridge/src/lib/auto-context-pack.ts` (set source='bridge_auto')
- `apps/web-v2/lib/queries/dashboard.ts` (added narrativeCoverage7d)
- `apps/web-v2/app/page.tsx` (NarrativeCoverageStrip component)

**Deleted:**
- `apps/mcp-server/src/lib/sqlite-vec.ts`
- `apps/mcp-server/__tests__/integration/lib/sqlite-vec.test.ts`
- `apps/mcp-server/__tests__/integration/lib/context-pack.test.ts`
- `apps/mcp-server/__tests__/integration/tools/search-packs-nl.test.ts`
- `apps/mcp-server/__tests__/unit/tools/search-packs-nl.test.ts`
- `packages/db/__tests__/integration/sqlite-vec.test.ts`

## Tests / verification

- `pnpm typecheck` clean across mcp-server, hooks-bridge, web-v2, sync-daemon, cli
- CLI rebuild succeeds (`packages/cli/dist/runtime/{mcp-server,hooks-bridge}/` updated)
- `contextos start` brings services up healthy (MCP 3100 ✓, Bridge 3101 ✓)
- MCP `tools/list` returns 12 entries with proper schemas (verified via stdio probe)
- Real lifecycle test: `get_run_id` → `record_decision` (with confidence/impact/reversible) → `save_context_pack` (with meta) all succeed; DB inspection shows correct persistence
- Web dashboard renders coverage strip at 88% (real data)

## Open follow-ups

| Item | Why deferred |
|---|---|
| `0010_drop_embeddings.sql` (drop `summary_embedding` column + `context_packs_vec` virtual table + HNSW index) | Independent rollback. Schema column is nullable, costs nothing to keep until later. |
| `EMBEDDING_DIM` constant + `packages/shared/src/constants.ts` deletion | One downstream test still imports the file via `__tests__/unit/constants.test.ts`. Sequence with column drop. |
| `essentialsforclaude/05-agent-trigger-contract.md` reframe | Mechanical doc edit. Code-side enforcement (manifest descriptions) already imperative. |
| `essentialsforclaude/11-adrs.md` ADR-012 priority reversal | Same — doc-only change. Code already implements the new priority. |
| Fresh unit / integration tests for `list_context_packs`, `read_context_pack`, `recent-decisions.ts`, `session-state.ts`, the `bridge_auto → agent` upgrade path | Smoke verified end-to-end works. Reproducible regression coverage is a follow-up. |
| `system-architecture.md` §2 / §18 / §22.4 / §23.9 / §24 edits | Mechanical doc edits. The truth is in `docs/feature-packs/05-agent-driven-nl-assembly/spec.md` already. |
| `apps/web-v2` run-detail page surface for `source` badge | Deferred — coverage stat on dashboard is the load-bearing M05 §6.E artifact. |
| CI grep test (`no-m05-references.test.ts`) | Optional CI hygiene; spec'd but not load-bearing for M05 functionality. |

## What should be built next

- **Module 06 — Semantic Diff** (Python + tree-sitter + Anthropic Claude). Unaffected by the M05 reshape; remains a separate-process Python service. The architectural decisions made for M05 (no embeddings, no Python service) do not apply to M06 — tree-sitter genuinely needs Python and there's no agent-driven equivalent for AST parsing.
- **GitHub integration (§23, 10 MCP tools).** High leverage, every dev uses GitHub. The agent-driven retrieval pattern from M05 carries over: surface raw GitHub context to the agent at SessionStart; let the agent reason over it.
- **VS Code Extension (M07).** Inherits the M05 surfaces — `list_context_packs` + `read_context_pack` make the VS Code sidebar tree view trivial.

## References

- Spec: `docs/feature-packs/05-agent-driven-nl-assembly/spec.md`
- Implementation plan: `docs/feature-packs/05-agent-driven-nl-assembly/implementation.md`
- Tech stack: `docs/feature-packs/05-agent-driven-nl-assembly/techstack.md`
- ADR-007 (append-only) + ADR-012 (Pattern 20): `essentialsforclaude/11-adrs.md`
- Decisions log: see `dec_8f520f6d-2e82-4a54-bc9e-16b4bd2f13d6` (recorded mid-implementation as part of the smoke test).
