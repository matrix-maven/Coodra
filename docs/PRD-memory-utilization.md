# PRD: Memory Utilization Telemetry and Progressive Context Delivery

Status: draft for review, 2026-08-14

Scope: make Coodra's memory layer *measurable* and *self-correcting* — record what context is surfaced and pulled, shift SessionStart from pushing bodies to pushing an index, close the post-compaction gap, and give freshness a mechanical definition. Agent-native runtime telemetry (tokens/cost) is designed into this document but deliberately not built in this phase.

## Source Inputs

- Discussion thread, 2026-08-10 to 2026-08-14, between the product owner, Claude Code, and Codex.
- OpenAI, "Harness engineering: leveraging Codex in an agent-first world" (2026-02-11) — progressive disclosure, `AGENTS.md`-as-table-of-contents, mechanical doc-freshness enforcement, doc-gardening agents, lint messages as agent context.
- Anthropic, "Effective context engineering for AI agents"; compaction research on long-running sessions (lossy compounding across repeated compactions).
- Current Coodra implementation:
  - `apps/mcp-server/src/lib/context-pack.ts` — SessionStart selection: recency-ordered, tier derived from linked Work Pack **status** via `tierForWorkPackStatuses`, `null`-tier rows dropped, then a diversification pass.
  - `apps/mcp-server/src/tools/lifecycle-event/handler.ts:827` — `isSessionStartEquivalent` covers `SessionStart` and the first `UserPromptSubmit` of a run only. **Not** `PostCompact`.
  - `apps/mcp-server/src/tools/lifecycle-event/handler.ts:1252-1261` — `sessionContext` built once; `joinAdditionalContext([sessionContext, promptRelevantContext])` concatenates, never merges or revises.
  - `apps/mcp-server/src/lib/prompt-context.ts:261` — `selectPromptRelevantContext` re-queries live per prompt (`activeOnly: true`), dedups within a single injection via `seenDecisionIds`, no cross-turn dedup.
  - `apps/mcp-server/src/tools/search-packs-nl/handler.ts` — lexical BM25 (SQLite FTS5 / Postgres `tsvector`); the embedding-supplied semantic KNN was deliberately replaced.
  - `packages/db/src/schema/sqlite.ts:444` — `policy_decisions` already carries `ask_outcome`, `ask_outcome_at`, `matched_rule_id`, `governance_verdict`, `base_decision`, `effective_decision`.
  - COOD-63 — Agent Recipes index: an index is pushed at SessionStart, bodies are pulled via `get_recipe`. Progressive disclosure already exists in the codebase, for recipes only.

## Problem

### 1. Coodra cannot tell whether its memory is used

Today's dashboard reports **inventory**: context packs created, decisions recorded, Work Packs updated. These are vanity metrics — they rise when Coodra nags effectively, and would look healthy on a project where every pack is noise nobody ever reads.

Nothing records which packs were surfaced, which were pulled, which were never retrieved again, or which had gone stale by the time they were shown. `sessionAdditionalContext(...)` selects packs, renders them, and forgets the decision a millisecond later.

The consequence: every improvement to retrieval — COOD-58's decision edges, COOD-59's decay work, the diversification pass — is judged by inspection, and no one can say whether Coodra's memory layer is working at all.

### 2. Pushed context is frozen and cannot be retracted

`sessionContext` is built exactly once per run. Everything afterward is appended, never revised. A pack injected at hour 0 describing the old approach is still verbatim in the window at hour 3 after a decision supersedes it.

`activeOnly: true` filters superseded decisions out of *new* injections, but it cannot un-inject what was already sent. OpenAI hit the same failure in a file ("it rots instantly — agents can't tell what's still true"); Coodra's version is worse in one respect, because a file can be re-read after it is fixed and a transcript block cannot.

### 3. Compaction silently destroys Coodra's grounding

`isSessionStartEquivalent` excludes `PostCompact`, so Coodra never re-injects after a compaction. Project grounding degrades to whatever the agent's own summarizer preserved, while per-prompt decision blocks keep arriving on top of it.

Long sessions compact repeatedly and each pass is lossy over the previous pass's output, so error compounds. Runs of six hours or more are now routine.

### 4. Freshness is declared, never verified

COOD-58's supersede edges only exist when an agent bothers to record them. Nothing checks whether a pack still describes how the code actually behaves. Packs referencing `apps/hooks-bridge` have been stale since COOD-67 and no mechanism knows.

Ranking a stale pack into position 1 is worse than not retrieving it at all.

## Goals

1. Record every surfacing of a Coodra artifact — push and pull — in one generalized log.
2. Shift SessionStart from pushing bodies to pushing an index, with bodies pulled on demand.
3. Re-establish grounding after compaction.
4. Make staleness computable rather than declared.
5. Reframe the dashboard from inventory to utilization.
6. Keep the design compatible with later agent-native OTel ingestion without building it now.

## Non-goals

- **Agent-native token/cost telemetry.** Claude Code and Codex expose it via OTel; Cursor, Devin, and Antigravity do not. Designed for here (§8), built later (COOD-45/46/47).
- **Policy outcomes in the access log.** `policy_decisions` already holds them with more fidelity. Duplicating creates two sources of truth. The access log records only the *teaching* channel (§7).
- **Repo-local mirror of packs/decisions as system of record.** DB + MCP stays canonical. A one-way generated export remains a deferred option (§10).
- **Semantic/embedding retrieval.** Out of scope; the current lexical ranker is the baseline being measured.
- **A composite "memory health score."** Composite scores hide the diagnostics that make the numbers actionable.

## Design principle

> Repository docs are one implementation of progressive disclosure. Coodra provides the same pattern through MCP, backed by a structured shared memory store.

Coodra is not helping one agent in one repo. Team memory, cross-agent continuity, audit trails, Work Packs, and org-level context all want a database. We borrow the *patterns* from harness engineering — progressive disclosure, mechanical freshness, gardening, just-in-time teaching — without copying the storage architecture.

The delivery model becomes:

```
SessionStart manifest  ->  MCP pull tools  ->  DB freshness/gardening  ->  prompt-time invalidation
```

---

## Workstreams

### W1 — `memory_access_events` table

The keystone. Additive; changes no existing behaviour.

**On the name.** An earlier draft called this `context_access_events`. Rejected: Coodra already has a `context_packs` table, so that name reads as "access events for context packs" — a subset of what this holds, and the opposite of the generalization it exists for. `artifact_access_events` was also rejected, because `artifact` already means Graphify build output in this codebase (`packages/cli/src/commands/graphify-artifacts.ts`), and two meanings of one word in a single schema is worse than the ambiguity being fixed. `memory_*` matches the vocabulary already used throughout this epic — memory utilization, memory gardening, dead memory — and collides with nothing. Columns follow: `memory_type`, `memory_id`.

| Column | Notes |
| --- | --- |
| `id` | |
| `org_id`, `project_id`, `run_id`, `session_id` | `org_id` mirrors `runs`, `run_events`, `context_packs`, `decisions`, `work_packs`, `policy_decisions`. Omitting it would make team-mode sync, retention and org-scoped dashboard queries depend on `project_id` joins alone |
| `actor_user_id`, `agent_type` | Who/what caused the access. Needed for per-seat and per-agent utilization in team mode |
| `run_event_id` | Nullable FK, for later outcome correlation |
| `channel` | `push` \| `pull` |
| `site` | Which door: `session_start_manifest`, `prompt_context`, `post_compact`, `search_packs_nl`, `read_context_pack`, `query_decisions`, `query_decisions_by_file`, `wiki_ask`, `get_recipe`, `policy_reason` |
| `memory_type` | `context_pack` \| `decision` \| `wiki_page` \| `recipe` \| `work_pack` \| `manifest` |
| `memory_id` | Nullable — a search that returned nothing still logs |
| `position` | Rank within the injection or result set |
| `bytes` | Cost contributed |
| `latency_ms` | Retrieval cost in time |
| `trigger_type` | `session_start` \| `user_prompt` \| `post_compact` \| `tool_call` |
| `query_hash`, `trigger_text_hash` | Hashed by default (§9) |
| `result_count` | For search-type sites |
| `freshness_status_at_access` | Point-in-time snapshot; a pack that goes stale later must not rewrite history |
| `baseline_generation` | Increments per compaction; makes deltas well-defined |
| `created_at` | |

Notes on the schema as debated:

- `site` and `memory_type` are deliberately distinct — `site` answers "through which door," `memory_type` answers "what came through it." Pull-through rate is naturally a per-site metric.
- No `action` column mixing retrieval verbs with policy verdicts. Policy outcomes stay in `policy_decisions`.
- Writes go through the outbox (`scheduleDurableWrite`) so hook latency is unaffected.

### W2 — Pull instrumentation (first)

Sequenced ahead of push because the call sites already exist — every pull passes through the MCP tool registry. It is **not** free, however, and the reason is the single most important design constraint in this workstream.

#### Three concepts that must not be conflated

Today they are partially overloaded through an optional `runId` input field. The telemetry layer must not repeat that pattern.

1. **Current-run attribution** — *which run is this call part of?* A property of the caller's session, never of the tool's arguments.
2. **Retrieval filter inputs** — *what is the caller asking for?* `query_decisions.runId` is documented as "Optional narrower filter to a single run" (`apps/mcp-server/src/tools/query-decisions/schema.ts:55`). Instructing agents to pass the current run id for attribution would **silently change retrieval semantics**, narrowing results to that run.
3. **Artifact-level access rows** — *what came back, and at what rank/cost?* Per-artifact, extracted from the result, not the input.

The registry currently records `run_events` only when the tool input carries a non-empty `runId` (`apps/mcp-server/src/framework/tool-registry.ts:499-509`). `wiki_ask` has no `runId` at all, so it would be invisible.

#### Required design

- **Resolve the run at registry level, independent of any `runId` input.** `ToolContext` (`PerCallContext`, `apps/mcp-server/src/framework/tool-context.ts:199-212`) carries `sessionId` and `agentType` only — **not** `cwd` and **not** `projectId`. So the resolution chain is explicitly:
  1. Take `projectSlug` from the tool input — legitimate, since it is a scope argument every one of these tools already requires, not an attribution field.
  2. Resolve `projectSlug` → `project_id` (and `org_id`).
  3. Call `lookupRunId(db, projectId, ctx.sessionId)` (`packages/db/src/lookup-run.ts`).

  A miss at any step writes the access row with `run_id = null` rather than guessing, and increments a counter so silent attribution loss is itself observable.
- **Per-tool adapters** extract artifact ids, positions, and `result_count` from each tool's *output*, since result shapes differ per tool.
- Tool input `runId` remains purely a retrieval filter. Its presence or absence must never affect attribution.

**Precedent for why this matters:** Coodra has already shipped an attribution bug of exactly this shape. `packages/db/src/lookup-run.ts:10-18` records that the bridge's `scheduleRunEventInsert` called its lookup with `projectSlug = undefined` — "a hardcoded short-circuit that made every `run_events` row write `run_id IS NULL`." Repeating it here would silently null out attribution and poison every metric in W6.

Instrument `read_context_pack`, `search_packs_nl`, `query_decisions`, `query_decisions_by_file`, `wiki_ask`, `get_recipe`, `list_recipes`, `list_context_packs`.

**Immediate payoff — the recipes pilot.** COOD-63 already pushes an index and lets agents pull bodies. Instrumenting pull alone yields a real click-through rate on the existing progressive-disclosure surface, *before* committing to the manifest redesign for packs. Fastest signal, and it de-risks W3.

### W3 — Manifest model: push the index, pull the body

SessionStart carries a compact manifest instead of excerpts: pack ids, titles, one-line summaries, tier, freshness state, linked Work Pack — plus explicit instruction on which tool retrieves bodies.

Rationale beyond token efficiency: **push gives no usage signal.** A manifest entry followed by a `read_context_pack` call is an observable act of selection by the agent. Stage-3 utilization ("was it used?") becomes measurable for the first time.

Known risk, recorded honestly: agents do not reliably call tools nobody told them to call — precisely the justification in COOD-63's comment that no native-plugin agent could discover recipes without calling `list_recipes` unprompted. Mitigation is push-the-index-pull-the-body (never pull-only), explicit tool guidance in the manifest, and W9 measurement of under-retrieval before this ships as the default.

### W4 — Compaction handling

1. Treat `PostCompact` (or the first `UserPromptSubmit` after one) as manifest-eligible, extending `isSessionStartEquivalent` or adding a sibling predicate.
2. Increment `baseline_generation` per compaction. Delta and invalidation injection is defined relative to a generation, so deltas are never emitted against a baseline that no longer exists in the window.
3. Prompt-time context becomes: query live state, compare against what this generation has already surfaced (via W1), emit only deltas and invalidations.

Corollary: if injected context is a disposable hint rather than durable truth, the manifest must be **periodically re-emitted**, not emitted once.

### W5 — Freshness fields and memory gardening

Add to packs and decisions: `freshness_status`, `last_verified_at`, `stale_reason`, `verified_against_commit`, `verified_against_files`.

**No `superseded_by` column.** Decision supersession is already modelled canonically in `decision_edges` (COOD-58), and packs already carry `archived_in_pack_id`. A direct column would create a second source of truth for authority. Supersession stays in edges; freshness columns are additive and describe a different property (is this still *true*?) from supersession (has this been *replaced*?). If a denormalised `superseded_by` is ever needed for query performance, it must be introduced explicitly as a computed cache with stated invalidation rules — not as a parallel authority.

`verified_against_commit` / `verified_against_files` are what make staleness **computable** — "have the files this pack was verified against changed since?" — rather than heuristic. This is the missing half of COOD-58: **staleness** becomes derivable rather than only agent-declared. Supersession is a different property and remains canonical in `decision_edges`; nothing here derives it.

Gardening runs as a Coodra background capability (the analogue of OpenAI's doc-gardening agent, in the DB rather than as PRs): detect moved/deleted files a pack depends on, decisions whose target files changed materially, obsolete paths, dead Work Pack assumptions. It **marks and proposes**; it does not silently rewrite user memory.

#### W5.1 — Graph freshness is a prerequisite

W5 wants to use Graphify relationships to *detect* stale packs. A stale graph produces wrong staleness verdicts, which is worse than none — so graph freshness must land before gardening goes live.

The graph is already stale in practice, and a manual rebuild does not fix it for long. **Example snapshot — verify live before citing.** As of 2026-08-15 the working tree's `graph.json` reports `built_at_commit: c5b7b138`, 7,214 nodes, and correctly no longer contains the `apps/hooks-bridge/` tree deleted in COOD-67 — i.e. it had been manually rebuilt. It is nonetheless already **12 commits and 116 changed files behind HEAD**.

That is the argument for automation, stated more precisely than "people forget": even a deliberately refreshed graph decays within days of normal work, and `query_decisions_by_file` will keep serving blast-radius paths from it while reporting `graphAvailable: true`.

**Provenance already exists and is unused.** `graph.json` carries `built_at_commit`; nothing reads it. `graphAvailable` is a binary meaning *present*, not *current* (`apps/mcp-server/src/tools/query-decisions-by-file/handler.ts:230`).

1. Promote `graphAvailable` to a freshness signal: `built_at_commit`, commits behind, files changed since. Consumers degrade rather than mislead — annotate blast radius with graph age, and above a drift threshold report it *unavailable* rather than *wrong*.
2. **Node identity is the harder half.** Node ids are path-derived (`.githooks/pre-commit` → `githooks_pre_commit`), so a rename or move mints a new id and any stored reference dangles silently. Refreshing more often makes this worse, not better — staleness is traded for dangling pointers, which fail quieter. Therefore:
   - Never store a graph node id as a hard FK. Audit `decision_edges.target_id` for `target_type: graph_node` usage.
   - Store the **path** alongside the id; paths survive refactors better and git can follow renames.
   - Treat node references as **resolvable pointers, not foreign keys** — resolve at read time and record the outcome (`resolved` / `moved` / `missing`) into `freshness_status_at_access`, making identity drift measurable instead of silent.
   - Authored annotations (boundary/layer markings) need identity that survives refresh by construction; losing a derived edge is cheap, losing an authored one is not.
3. **Refresh triggers, not a cadence.** Each guarded by an actual drift check rather than a fixed schedule. Same principle as `verified_against_commit`: do not schedule freshness, make staleness observable and refresh opportunistically.

##### Automatic refresh design

Humans forget to rebuild; the working tree proves it. But rebuilding at SessionStart is infeasible — and it is also the wrong end of the session.

**Split cheap detection from expensive rebuild.** Detection is `git rev-parse HEAD` against `built_at_commit` — microseconds, safe to run at SessionStart purely to *annotate* per (1) above, never to rebuild. Rebuilds are always enqueued, never inline.

**Rebuild at SessionEnd, not SessionStart.** The agent has just finished writing code — that is the moment the graph went stale, and nothing is waiting on the result. The next session then starts fresh at no cost on the critical path.

| Trigger | Catches |
| --- | --- |
| **SessionEnd** (primary) | The agent's own edits — the dominant source of drift |
| Work Pack completion | Coarser milestone boundary |
| Drift detected at SessionStart | Commits arriving from elsewhere — merge, pull, branch switch |
| Periodic backstop sweep | Abnormally-ended sessions: crash, laptop sleep, no Stop hook |

All triggers enqueue against a drift threshold plus a cooldown, so many sessions coalesce into one rebuild.

**Runs as a `GraphRefreshWorker` in `packages/lifecycle`**, started by the mcp-server daemon alongside `startStaleRunsSweeper` and **HTTP-transport only** — the stdio transport is a short-lived per-hook subprocess where a timer never fires a second tick and boot work re-runs on every hook call (`packages/lifecycle/src/stale-runs-sweeper.ts`, COOD-62).

**Cost is lower than assumed:** Graphify rebuilds incrementally by default (`--force` exists specifically to skip "the incremental manifest gate and semantic cache reads"), backed by `out/cache/stat-index.json`. This makes a per-SessionEnd rebuild plausible; still measure before committing (open question 6).

**`graphify watch` is not the default.** It is a long-lived per-project filesystem watcher: resource cost across every touched project, and it fires *during* agent edits, rebuilding repeatedly through a session when the graph only needs to be correct at boundaries. Keep as an opt-in for heavy users; lifecycle-triggered beats continuous.

**Write/read safety.** Cache invalidation is already correct: `loadGraphifyIndex` serves the cached parse only when the 60s TTL holds **and** `mtimeMs` **and** `size` are unchanged (`apps/mcp-server/src/tools/query-decisions-by-file/handler.ts:168-189`), so a rebuild is picked up on the next call. No work needed there.

The residual issue is a torn read: `stat()` → `readFile()` → `JSON.parse()` against a file being rewritten concurrently. It is caught and degrades to `query_decisions_by_file_graphify_unavailable`, so blast radius transiently disappears during a rebuild and then self-heals — a real but low-severity window. The fix belongs in Graphify (write temp + rename); **verify whether it already writes atomically before specifying work.**

**The actual gap in this handler:** `GraphifyIndex` is `{ nodes, byId, adjacency }` — `built_at_commit` is parsed and discarded, so nothing downstream *can* annotate drift. Carry it through `buildGraphifyIndex` into the index and cache entry, and widen `blastRadius` beyond `graphAvailable: boolean` to carry the commit plus computed drift. Additive, race-free, and a prerequisite for (1) above.

Two distinct staleness measures, not one:

- **Short-term** — superseded within a run. Measures churn: how often the agent's own work invalidates what it was given.
- **Long-term** — verified-against files have drifted over days or weeks. Measures rot. A background query, not a session-time one.

They have different fixes (better mid-session invalidation vs. gardening cadence) and must not be collapsed into a single "staleness %".

### W6 — Metrics and the dashboard reframe

Every artifact has four stages; the dashboard currently shows one.

**Created → Surfaced → Pulled → Stale/Contradicted**

North-star metrics, two per surface, no composite:

- **Pull-through rate** — was this memory wanted?
- **Stale share** — was this memory still trustworthy?

| Surface | Utilization | Health |
| --- | --- | --- |
| Context packs | surfaced/created, read-through, median age at retrieval | never-surfaced ("dead memory"), stale share |
| Decisions | surfaced/recorded, `query_decisions_by_file` hit rate | superseded share, time-to-supersede, **surfaced-then-contradicted** |
| Wiki | `wiki_ask` volume | empty / low-signal answer rate, pages never asked about |
| Recipes | index-shown → `get_recipe` click-through | recipes never invoked |
| Policy *(from `policy_decisions`, not the access log)* | ask precision, defer rate, rule coverage | dead rules, friction cost, fail-open rate |

*Surfaced-then-contradicted* is the most expensive failure: Coodra put the guidance in front of the agent and it went the other way. Rare and hard to detect, but it is the difference between "we failed to retrieve" and "retrieval works and nobody listens."

Dashboard change: every inventory count gains a utilization ratio beside it.

### W7 — Just-in-time teaching via `permissionDecisionReason`

Policy deny/ask reasons currently carry opaque labels. They should carry scoped remediation plus the motivating active decision — context delivered at the exact moment of the violation, never stale, never budget-consuming.

**Explicitly supplementary, not a replacement for push/pull.** Permission events fire only on policy-gated actions; a great many retrievals and reads never reach a permission check at all. This channel covers a narrow slice and cannot carry general project grounding.

Logged in `memory_access_events` as a `push` at `site: policy_reason` — the one policy-adjacent thing the access log records, because `policy_decisions` cannot see whether a decision was taught through it.

### W8 — Agent-native runtime telemetry (designed now, built later)

Three layers, three answers:

| Layer | Source | Approach |
| --- | --- | --- |
| MCP server ops — latency, error rates, DB query time, breaker trips | Coodra's process | OTel. Natural fit; hand-rolling would be wasteful. |
| Memory utilization | Coodra's tables | **Canonical in-DB.** Optional OTel *exporter* for teams that already run a collector. |
| Token / cost | Agent-native OTel | Ingest later — COOD-45/46/47. Claude Code + Codex only. |

Why utilization is not OTel-sourced: native OTel emits what the *agent* knows, and no agent knows what a context pack, a supersede edge, or a Work Pack is. Pull-through rate is not derivable from agent telemetry at any level of effort. Separately, OTel is a wire protocol, not a storage or query answer — requiring a solo user to run a collector and backend to see their own stale-pack count is a non-starter.

The coverage asymmetry cuts the other way from expectation: because the access log is Coodra instrumenting its own code path, it works identically for **all five agents**, making it the only telemetry uniform across the supported matrix.

**Design-now requirement:** carry a stable correlation key so agent-native OTel can be joined later. COOD-46 (confirm Codex's OTel metrics-export state, and whether a join key back to `run_id` exists or must be injected into resource attributes) becomes more valuable than when written, because the access log now gives it something worth joining to. Recommend promoting COOD-46 ahead of COOD-45.

### W9 — Eval Layer 1, in parallel

Layer 2 of COOD-69 (three-arm counterfactual, LLM judge, confidence intervals) is **parked**. Layer 1 is **not**, and should run alongside this work.

The reason is W3. Replacing pushed excerpts with a manifest is a substantive change to retrieval with two opposite predicted failure modes — the old model bloats and goes stale, the new one under-retrieves. Shipping that without measurement means guessing. Layer 1 is deterministic, costs nothing, runs in CI in under a second, and is precisely calibrated for this: distractor rate and injected bytes catch bloat, Recall@k catches under-retrieval.

Scope for this phase: COOD-70 (corpus) and COOD-71 (harness) only. COOD-72/73/74/75 stay parked.

---

## Sequencing

1. **W1** — `memory_access_events` table
2. **W2** — pull instrumentation → recipes pull-through pilot *(first real signal)*
3. **W9** — eval Layer 1 baseline, before changing the injection model
4. **W3** — manifest model, measured against that baseline
5. **W4** — compaction handling and delta/invalidation injection
6. **W5** — freshness fields, then gardening
7. **W6** — dashboard reframe
8. **W7** — JIT teaching channel *(independent; can land any time after W1)*
9. **W8** — OTel exporter; agent-native ingestion deferred

W7 is small and self-contained and does not need to wait its turn.

## Retention and volume

`memory_access_events` becomes the highest-volume table in the schema — roughly five push rows per prompt plus every pull, carried in a local SQLite file for solo users. This must ship **with W1**, not after W6, or the dashboard inherits an unbounded event table.

**Raw retention.** Default 30 days, configurable. Solo (SQLite) prunes locally. Team/cloud retention is a separate policy and may be longer for compliance reasons; the schema must not assume they match.

**Two rollups, because one grain cannot serve both metric families.**

*(a) `memory_access_daily` — volume and cost.*

`(org_id, project_id, day, channel, site, memory_type)` → `access_count`, `distinct_items`, `distinct_runs`, `total_bytes`, `total_latency_ms`, `max_latency_ms`, `stale_at_access_count`

**No percentiles.** p50/p95 cannot be re-aggregated from stored aggregates — averaging daily percentiles is not the percentile of the union, and it silently produces wrong numbers. Start with `total_latency_ms` + `max_latency_ms` + `access_count` (mean is exact, max is exact, and both compose across days). If real percentiles are wanted later, upgrade to fixed histogram buckets — those *do* compose — rather than trying to roll up p95.

*(b) `memory_cohorts` — identity and pull-through.*

The daily grain above loses `memory_id`, so it can count accesses but **cannot** answer the actual north-star question: *this manifest entry was shown — was this specific body then pulled?* That needs a cohort row:

`(org_id, project_id, run_id, baseline_generation, memory_type, memory_id)` → `surfaced_count`, `pulled_count`, `first_surfaced_at`, `first_pulled_at`, `time_to_first_pull_ms`, `stale_at_access`

Keyed on `baseline_generation` so a pull is attributed to the manifest generation that actually surfaced it — after a compaction re-emits the manifest, the next pull belongs to the new cohort, not the old one.

This table is small (one row per artifact per generation, not per access), so it carries a **longer retention than raw events**. Dead-memory detection needs months of history; raw access rows do not. "Never surfaced" is then an artifact table `LEFT JOIN` against this, not a scan of raw events.

**Prune and rollup trigger.** A daemon-side worker on the `startStaleRunsSweeper` pattern (`packages/lifecycle`), HTTP-transport only, for the reason documented there. Rollup is append-only per completed day; prune deletes raw rows older than the retention window and only after the covering rollup exists.

**Invariant:** a raw row is never deleted until its day is rolled up, so pruning cannot silently erase history from the dashboard.

## Privacy posture

- Store ids, counts, hashes, byte costs, and metadata. **Never raw prompt text or artifact content by default** — see the opt-in carve-out below, which is the only exception and is local-only.
- `query_hash` / `trigger_text_hash` by default.
- Known limitation: hashes count repeats but cannot diagnose. "Wiki empty-answer rate" says the wiki has holes; only the actual questions say *which* holes. Plaintext capture is therefore an **opt-in, local-only** setting — decided now rather than discovered later when the metric cannot drive the fix.
- Local-first by default. Nothing leaves the machine without explicit opt-in.

## Open questions

1. **Local-only vs. phone-home.** Everything here works local-only. Does Coodra want an aggregate product-analytics path? That is a trust conversation with self-hosting users, not just an engineering task, and it is still undecided.
2. **Manifest default.** Does the manifest replace excerpts outright, or ship behind a flag until W9 numbers justify it? Recommend flagged.
3. **Gardening cadence and autonomy.** Marks only, or opens proposals? On what schedule? Who reviews?
4. **Repo projection (deferred, not rejected).** A one-way generated export — the shape of OpenAI's own `docs/generated/` — would make memory visible to agents running without Coodra, and to humans in PR review. Cheap, reversible, no divergence risk because it is regenerated and never hand-edited. Deferred because DB + MCP is canonical and the benefit is unproven, not because the objection is invalid.
5. **Correlation key** for later OTel join — resolve via COOD-46 before W8 design locks.
6. **Graph rebuild cost.** 6,924 nodes on this repo; a 30-second rebuild justifies running on every merge, a ten-minute one is background-only. Measure before choosing triggers (W5.1).
7. **Graph drift threshold.** At what commits-behind / files-changed point does blast radius stop being annotated and start being withheld? Needs a number, ideally derived from how often stale edges actually resolve to moved-or-missing paths.

## Success criteria

This phase succeeds if, at the end of it, we can answer questions that are currently unanswerable:

- What share of context packs are never surfaced again after creation?
- When Coodra shows an agent a manifest, how often does the agent pull the body?
- What fraction of surfaced memory had already gone stale?
- Does grounding survive a compaction?
- Did the manifest model reduce injected bytes without costing recall?

Explicitly **not** a success criterion: a headline number like "Coodra saves X% of tokens." That is an eval claim requiring the parked Layer 2 counterfactual, and it must not be manufactured from telemetry.
