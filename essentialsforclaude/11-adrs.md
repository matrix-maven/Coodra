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

## ADR-010 — Graphify consumed via its own MCP server (Option C, rewritten 2026-05-21)

> **PARTIALLY SUPERSEDED by ADR-015 (2026-05-23).** The "wire Graphify's own
> MCP server" decision stands — that's how Graphify is consumed, and
> `coodra graphify enable` still does exactly this. But the "What is added"
> section below (the `seed_feature_packs_from_graph` + `build_codebase_graph`
> tools and the `structure` block) is **retired**: minting one Feature Pack per
> Leiden community produced hundreds of un-injectable shells. See ADR-015.

> **Supersedes the original ADR-010** ("Graphify import for cold-start" — a
> Coodra-owned `graph.json` reader plus a never-built community-to-Feature-Pack
> importer). That design was never completed and its assumptions are stale: the
> reader pointed at `~/.coodra/graphify/<slug>/graph.json`, a path nothing ever
> writes, so `query_codebase_graph` was permanently soft-failing.

Graphify (`safishamsi/graphify`, MIT, PyPI package `graphifyy`) is a mature,
actively-developed codebase-knowledge-graph tool — tree-sitter extraction +
Leiden community detection, 50k+ GitHub stars, ~daily releases. It ships **its
own MCP stdio server** — `python -m graphify.serve graphify-out/graph.json` —
exposing `query_graph`, `get_node`, `get_neighbors`, `shortest_path`.

**Decision.** Coodra consumes Graphify by **wiring Graphify's own MCP server
into the agent's config** (next to the `coodra` server) — the same "wire the
external MCP, don't rebuild it" pattern used for Jira and consistent with
Pattern 20 / ADR-012 / ADR-013 (ship intelligence as records and recipes, not
as services). Coodra builds **no** `graph.json` reader, **no** producer, **no**
parser.

**What is retired.** The `query_codebase_graph` MCP tool and
`apps/mcp-server/src/lib/graphify.ts` are removed (Module 09, phase G1).
Graphify's own MCP answers structural queries — blast radius, "where is X
defined?", dependency paths — and does so better.

**What is added (Coodra's leverage).** Coodra's knowledge layer becomes
graph-aware:
- A new `coodra__seed_feature_packs_from_graph` MCP tool — the agent (holding
  both MCP servers) fetches the Leiden community breakdown from Graphify and
  hands it to Coodra, which creates one **draft** Feature Pack per community.
  This is the original ADR-010 cold-start promise, done the Option-C way.
- `get_feature_pack` gains an optional `structure` block (community id, god
  nodes, member files), populated at seed time.
- No schema migration: the `structure` block lives in `feature_packs.content_json`.

**Why not the alternatives.** Having Coodra subprocess-manage the `graphify`
Python CLI (the old producer plan) is brittle against a ~daily release cadence.
Reimplementing graph queries inside Coodra duplicates a 50k-star tool, worse.
Full design: `system-architecture.md §17` and `docs/feature-packs/09-integrations/`.

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

## ADR-015 — Graphify is query-only; Coodra mints no Feature Packs from the graph (2026-05-23)

Partially supersedes ADR-010. The "wire Graphify's own MCP server" half of
ADR-010 stands; the "turn Leiden communities into draft Feature Packs" half is
retired.

**What is retired.**
- The `coodra__seed_feature_packs_from_graph` MCP tool (one draft Feature Pack
  per Leiden community).
- The `coodra__build_codebase_graph` MCP tool (a `graphify update` subprocess
  wrapper that existed only to feed the seed). MCP tool count 17 → **15**.
- The `graphify-seed-packs` bundled Feature recipe (`graphify-feature.ts`) and
  its seeding from `coodra graphify enable`, `coodra init`, and the web
  `/settings/integrations` enable action.
- The optional `structure` block on `get_feature_pack` (`featurePackStructureSchema`)
  — it had no producer once seeding was gone.

**What stays.**
- `coodra graphify enable / disable / status` — wiring Graphify's **own** stdio
  MCP server into the agent config. This is the ADR-010 Option-C decision and is
  unchanged. The agent calls Graphify's `query_graph` / `get_node` /
  `get_neighbors` / `shortest_path` directly.
- The web `/settings/integrations` Graphify card (wiring only).
- The 9·Core wiring substrate (`graphify-wire.ts`, `external-mcp-merge.ts`,
  `external-codex-merge.ts`).

**Why.** Evidence from two real codebases. On a 9,659-node repo Graphify
produced 588 Leiden communities; the seed would mint 588 Feature Packs, of which
**73.5% were single-file communities** — config files (`.mcp.json`,
`.coodra.json`), READMEs, `__init__.py`. Only 2.4% were module-sized. Two
independent defects compounded:

1. **Wrong granularity (authoring).** A Leiden community ("files that reference
   each other densely") is not a module. 1-community-1-pack is a mechanical
   transform that produces noise, not the ~10–15 module blueprints a human
   architect would write. The seed also wrote only a file-list `spec.md`;
   `implementation.md` / `techstack.md` were stubs.
2. **Un-injectable (resolution).** Seeded packs carried `parentSlug=null` and
   their own slug, so neither injection path reached them: SessionStart injects
   by **project** slug only, and `get_feature_pack`'s `filePath` param — the one
   bridge from "editing file X" to "its pack" — was **destructured and discarded**
   (`filePath: _filePath`). Even a perfectly authored seeded pack fell into a
   hole.

Fixing both would have meant: roll communities up into ~12 real modules, have
the agent author genuine specs, AND implement `filePath`→`sourceFiles`
resolution. That's a large build for a feature whose premise (the graph is the
pack source) was wrong. The graph is a **navigation map**, not a pack source.

**The standing position.** Graphify's value to Coodra is its **live structural
query layer**, consumed through its own MCP. Feature Packs remain
human/agent-authored at module granularity (the core Coodra flow, which works:
a pack at the project slug is injected at SessionStart). If agent-assisted
cold-start authoring is revisited later, it must (a) target module granularity,
not communities, and (b) ship `filePath` resolution so the packs are reachable —
both are explicit preconditions recorded here so a future session doesn't
re-attempt the 1-community-1-pack dump.

## ADR-016 — Jira is consumed via Atlassian's Remote MCP (Rovo); Coodra builds no Jira client (2026-05-31)

Supersedes the `system-architecture.md` §22 "Build" design — the 8 `jira_*` MCP
tools, the OAuth 2.0 3LO flow, hand-rolled ADF↔markdown conversion, inbound Jira
webhooks, the `integration_tokens` / `integration_events` tables, and the
`IntegrationClient` wrapper. Same decision shape as ADR-010 / ADR-015 for
Graphify: **wire the external MCP, don't rebuild it.** This is the Jira (track
9A) sibling of the Graphify (track 9B) decision under Module 09.

**Context.** Atlassian ships an official, maintained **Remote MCP server**
("Rovo") at `https://mcp.atlassian.com/v1/mcp` (IDE-auth variant
`/v1/mcp/authv2`) — Streamable HTTP transport, OAuth 2.1 with RFC 7591 Dynamic
Client Registration, exposing first-class Jira tools (`getJiraIssue`,
`searchJiraIssuesUsingJql`, `createJiraIssue`, `editJiraIssue`,
`addCommentToJiraIssue`, `transitionJiraIssue`, `getTransitionsForJiraIssue`,
`getVisibleJiraProjects`, …) plus Confluence, Jira Service Management,
Bitbucket, and Compass. The original §22 plan predated this — it specified
Coodra building a `jira.js` REST client, owning a Coodra-side OAuth 2.0 3LO app,
converting ADF by hand, registering webhooks, and shipping 8 `jira_*` tools
mirroring the `jira_test/` prototype.

**Decision.** Coodra consumes Jira by **wiring Atlassian's Rovo MCP into the
agent's config** (next to the `coodra` server), exactly like `coodra graphify
enable`. `coodra jira enable` writes the remote-MCP entry per IDE; the agent
calls Atlassian's own Jira tools directly. Coodra builds **no** Jira REST
client, **no** OAuth flow, **no** ADF converter, **no** webhook ingress, **no**
`jira_*` tools.

**What Rovo provides — Coodra builds NONE of it.** The Jira / Confluence tools,
OAuth 2.1 + token refresh, the REST client, ADF↔markdown. Endpoint, transport,
exact tool names, and per-IDE wiring shapes are recorded in `External api and
library reference.md → Atlassian Remote MCP (Rovo)`.

**What Coodra builds (its leverage).**
- `coodra jira enable / disable / status` — wires Rovo's **remote** MCP server
  into Claude Code / Cursor / Windsurf / Codex configs over the `9·Core` wiring
  substrate (`graphify-wire.ts` → a sibling `jira-wire.ts`), extended for the
  remote `url` entry shape. Graphify was stdio `{command,args}`; Rovo is remote
  Streamable HTTP, so the writers gain a `url`-style entry (or, for stdio-only
  clients, the `npx mcp-remote` shim — see the reference doc).
- **Run ↔ issue linkage** — the existing `runs.issueRef` /
  `context_packs.issueRef` columns bind a session to a ticket, so Coodra history
  becomes Jira-aware ("what work touched PROJ-412?") with **zero schema
  migration**.
- **On-request write-back** — at session end, if the user asks, the agent posts
  the Context Pack summary to the linked issue via Rovo's `addCommentToJiraIssue`.
  Opt-in only; Jira is shared state and unprompted writes have a cost.
- Onboarding placement (`coodra init` step + web `/settings/integrations` card)
  + trigger-contract guidance (`05-agent-trigger-contract.md` §5.7).

**What is retired from the §22 Build design.**
- The 8 `jira_*` MCP tools (`jira_search_issues`, `jira_get_issue`,
  `jira_create_issue`, `jira_update_issue`, `jira_list_transitions`,
  `jira_transition_issue`, `jira_add_comment`, `jira_list_projects`, plus the
  manifest-listed `jira_list_my_issues` / `jira_link_issues`). Direct adds
  exactly **two** Coodra tools — `link_run_to_issue` (the Run↔issue link, J2)
  and `prepare_jira_comment` (the on-request write-back helper, J3) — so the
  manifest is **17**, not the Build design's +8. The agent-facing Jira
  tools are Rovo's and are not counted.
- The OAuth 2.0 3LO flow + the `integration_tokens` table. Rovo owns auth; **no
  Jira token ever touches Coodra's DB or a developer's laptop.**
- ADF↔markdown conversion (Rovo handles it).
- Inbound Jira webhooks (`POST /v1/webhooks/atlassian`) + the
  `integration_events` table + the `atlassian-webhook-event` worker + the
  webhook-renewal cron. Rovo is **pull-only**; Coodra receives no Jira push.
- The `IntegrationClient` circuit-breaker/rate-limiter wrapper *for Jira* (Jira
  was its only consumer; GitHub §23 is a separate, still-Build track and keeps
  its own pattern).
- The server-side `get_feature_pack` Jira enrichment
  (`jira.currentIssue` / `jira.openIssues`) and the NL-Assembly Jira injection —
  the agent pulls live issue context via Rovo instead.

**Why — the same lesson as ADR-015.** Reimplementing a mature, vendor-maintained
tool is the error we just undid for Graphify. Atlassian maintains Rovo (OAuth'd,
current, free, spec-aligned); a hand-rolled `jira.js` client + 3LO app + ADF
converter + webhook fleet is a large, perpetually-drifting surface for a
capability Atlassian already ships better. The ADR-015 anti-pattern is avoided
structurally: **no Epic → Feature Pack auto-transform.** An Epic is not a module
blueprint any more than a Leiden community is; if an epic's scope warrants a
Feature Pack, a human/agent authors it. The fusion stays small and
**reachable** — linkage you can query, write-back you can see on the ticket.

**Caveats (known at decision time, 2026-05-31).**
- Rovo is **per-user interactive OAuth** (browser flow via the IDE's `/mcp`
  auth). Each developer authorizes their own Atlassian account. A **headless**
  path exists (API-token auth for long-running / CI setups) but requires an
  **Atlassian org-admin to enable API-token authentication** first — so it is
  neither the default nor assumed. This is fine for interactive dev sessions
  (the use case).
- The HTTP+SSE endpoint (`/v1/sse`) is **deprecated and unsupported after
  2026-06-30**. Coodra wires the Streamable HTTP endpoint (`/v1/mcp` /
  `/v1/mcp/authv2`) only.
- The single reason to revisit a "Build" approach later: a genuine need for
  **server-side / headless** Jira access, or Jira→Coodra **webhook (push)**
  events. Neither is in scope; record the need before re-opening.

**The standing position.** Jira's value to Coodra is Atlassian's **live issue
surface**, consumed through Rovo's MCP. Coodra's contribution is the **wiring**,
the **Run↔issue link** (so history is Jira-aware), and **on-request write-back**
(so the ticket reflects what the agent did). Feature Packs remain human/agent-
authored at module granularity — never minted from epics.

## ADR-017 — Deep Wiki is agent-authored; Coodra ships the schema + persistence + render, runs no LLM (2026-06-06)

Module 10. A **Deep Wiki** is a DeepWiki-style (Cognition's DeepWiki /
`AsyncFuncAI/deepwiki-open`) hierarchical, mind-map explanation of a codebase,
produced by a **two-pass, schema-first** flow: a *structure pass* plans a
`WikiStructure` (sections + pages, each with importance, relevant files, a
parent for the hierarchy, and a diagram flag); a *content pass* authors each
page's Markdown with Mermaid diagrams + code citations.

**Decision.** The user's coding agent (Claude Code / Codex / Cursor) **is the
model.** Coodra runs **no** LLM, embeddings, or vector store — it ships:

- the **schema** — `@coodra/shared/wiki` (`WikiStructure` / `WikiSection` /
  `WikiPage` / `WikiPageContent`, Zod, with a referential-integrity
  `superRefine` so a malformed plan is rejected at the MCP boundary);
- the **persistence** MCP tools — `wiki_save_structure` (pass 1; writes a
  pending page skeleton), `wiki_save_page` (pass 2; authors one page),
  `wiki_status` (progress / resume). Manifest **17 → 20**;
- the **CLI** — `coodra wiki generate|status|list|open|clean`. `generate`
  writes a bounded grounding snapshot (`.coodra/wiki-grounding.md`) + an
  authoring recipe (`.coodra/wiki-job.md`) and scaffolds a `deep-wiki-author`
  Feature (pulled on trigger);
- the **web render** — `/wiki` + `/wiki/[id]`: hierarchical mind-map nav +
  Markdown (react-markdown + remark-gfm) + Mermaid (client component);
- optional **Graphify grounding** — communities → candidate sections,
  high-degree nodes → high-importance pages (degrades to file-tree-only when
  Graphify isn't wired).

This is the same thesis as ADR-012/013/015/016: **ship intelligence as records
and recipes, not as a service.** No new secrets, no embeddings infra,
air-gap-friendly.

**Storage.** `wikis` (the structure envelope) + `wiki_pages` (per-page
content/state), dual-dialect (SQLite + Postgres, schema-parity-tested),
team-synced (push dispatch + team-rows-puller + handler enqueues) so a wiki
authored on the admin's machine renders cross-machine. DB-primary (local SQLite
solo; cloud Postgres team) — the web reads the DB, like decisions/runs. A
re-plan (`wiki_save_structure` with the same slug) replaces the wiki
(DELETE-then-INSERT of the page skeleton), mirroring `run_diffs` idempotency.

**Deferred.** DeepWiki's signature **"Ask the wiki" RAG chat** is a later phase
— it needs the wiki to exist first and is a separate retrieval surface.

**Why not run an LLM in Coodra (the deepwiki-open shape).** `deepwiki-open` runs
its own Gemini/OpenAI pipeline + embeddings + RAG. For Coodra that would mean
API keys, a vector store, recurring cost, and a runtime failure mode — and it
contradicts the platform thesis. The agent the user already has, wired to the
Coodra MCP, is a better-positioned model: it can read the actual files, follow
imports, and query Graphify. Coodra's leverage is the schema, the durable record,
and the render — not a second inference engine.
