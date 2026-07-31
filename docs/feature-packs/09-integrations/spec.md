# Module 09 — External MCP Integrations (spec)

> **Current as of 2026-05-31** — reflects ADR-015 (Graphify retirement) and
> ADR-016 (Jira = Direct). Earlier drafts described a Graphify→Feature-Pack
> seeder and an Epic→Feature-Pack Jira transform; **both are retired.** See
> `essentialsforclaude/11-adrs.md` ADR-015 + ADR-016, the
> `context_memory/decisions-log.md` entries (2026-05-23, 2026-05-31), and the
> live Jira plan `Coodra/jira-integration-plan.md`.

## 1. What this module is

Module 09 integrates two external systems into Coodra — **Jira** and
**Graphify** — with one shared pattern: **wire the external system's own MCP
server into the agent's config; let the agent call it; have Coodra add only the
thin fusion that ties the external system to Coodra's own records.** Coodra does
**not** rebuild Jira or Graphify, and does **not** mint Feature Packs from
either. Feature Packs stay human/agent-authored at module granularity.

This supersedes two stale designs: `system-architecture.md §22` (build-our-own
Jira REST client + OAuth app + webhooks — never built; retired by ADR-016) and
the original ADR-010 / §17 (a Coodra-owned Graphify `graph.json` reader +
importer — never completed; retired by the ADR-010 rewrite and ADR-015).

## 2. Structure — one substrate, two tracks

- **9·Core** — shared substrate, built during the Graphify track, reused by Jira:
  - the **MCP-config writers** — `lib/init/external-mcp-merge.ts` (JSON:
    Claude Code / Cursor / Windsurf) + `lib/init/external-codex-merge.ts` (TOML:
    Codex), idempotent add/remove of an external MCP server entry, preserving the
    `coodra` entry and user edits.
  - the per-IDE dispatch core (`lib/init/graphify-wire.ts` → a sibling
    `jira-wire.ts`).
  - the **`/settings/integrations`** web page — a card per integration.
  - the **`coodra <integration> enable | disable | status`** CLI shape.
  - an optional, skippable integrations step in the team onboarding wizard.
- **9A — Jira** — wire the `atlassian` Rovo MCP (remote Streamable HTTP, per-user OAuth). **Starting at J0.**
- **9B — Graphify** — wire the `graphify` MCP (local stdio). **DONE (G0–G4), trimmed by ADR-015.**

The agent ends with up to three MCP servers — `coodra`, `atlassian`, `graphify`
— all wired by Coodra onboarding.

## 3. Track 9A — Jira (Direct; ADR-016)

Locked decisions (2026-05-31):

1. **Approach = Direct.** `coodra jira enable` writes Atlassian's official Rovo
   MCP server (`https://mcp.atlassian.com/v1/mcp/authv2`, Streamable HTTP, per-
   user OAuth 2.1 + RFC 7591 DCR) into the agent config. Coodra builds **no**
   Jira REST client, OAuth app, ADF converter, webhooks, or `jira_*` tools. The
   agent calls Rovo's own tools (`getJiraIssue`, `searchJiraIssuesUsingJql`,
   `addCommentToJiraIssue`, …).
2. **Fusion = Link + on-request write-back.** Two thin pieces of leverage, and
   nothing more:
   - **Link:** bind a Run to its issue via the existing `runs.issueRef` column
     (zero schema migration), so Coodra history is Jira-aware.
   - **Write-back (on request only):** at session end, if the user asks, the
     agent posts the Context Pack summary to the issue via Rovo's
     `addCommentToJiraIssue`. Never automatic.
3. **NO Epic → Feature Pack transform.** Dropped (the ADR-015 lesson — an Epic is
   not a module blueprint any more than a Leiden community is). No
   `import_jira_epic`. If an epic warrants a Feature Pack, a human/agent authors
   it.
4. **Onboarding = both** — optional skippable wizard step + `/settings/integrations`.

**Schema: zero new tables.** Reuse `runs.issueRef` (already in the schema).
Enablement presence is read from the agent **config file** (like Graphify's
`readGraphifyPresence`), not a DB table — so no `integrations` / `external_links`
tables.

**MCP tool surface delta: +2 tools.** `link_run_to_issue` (J2) — the agent calls
it to bind `runs.issue_ref` — and `prepare_jira_comment` (J3) — assembles the
session summary the agent posts via Rovo. The query side reuses
`query_run_history` / `query_decisions`, each given an optional `issueRef` filter
(J2). The actual Jira write is Rovo's tool, not a Coodra tool. So the Coodra
manifest is **17** (the post-ADR-015 15 + `link_run_to_issue` + `prepare_jira_comment`)
— never the "+4" of the old draft.

**Key caveat.** Rovo is per-user interactive OAuth; it does not run headless
(CI / cron) without an org-admin enabling API-token auth. Fine for interactive
dev sessions (the use case). The one reason to revisit "Build" later:
server-side/headless Jira access or Jira→Coodra webhook (push) events.

## 4. Track 9B — Graphify (Option C, query-only; ADR-010 / ADR-015) — DONE

Graphify is consumed via its own stdio MCP server. **Query-only** — Coodra mints
no Feature Packs from the graph.

- **Wiring (DONE, G3; packaged by COOD-10).** `coodra graphify enable` writes a
  `graphify` stdio MCP entry into legacy/project agent config files. Native
  Coodra plugins for Codex and Claude now include the same capability by
  default, using the shared Coodra-home runtime installed under
  `~/.coodra/graphify-mcp/.venv` and pointed at the Coodra-managed graph path
  `.coodra/graphify/out/graph.json`. The agent queries `query_graph` /
  `get_node` / `get_neighbors` / `shortest_path` directly.
- **Retired (G1, ADR-010 rewrite).** `query_codebase_graph` +
  `apps/mcp-server/src/lib/graphify.ts` — a dead reader of a path nothing wrote.
- **Retired (ADR-015).** `seed_feature_packs_from_graph`, `build_codebase_graph`,
  the `graphify-seed-packs` recipe, and the `get_feature_pack` `structure` block
  — minting one Feature Pack per Leiden community produced hundreds of
  un-injectable shells (73.5% single-file on a real repo). The graph is a
  **navigation map**, not a pack source.
- **Coodra's leverage:** the live structural-query layer itself (blast radius,
  "where is X?", dependency paths), consumed through Graphify's MCP — plus the
  9·Core wiring substrate, which the Jira track reuses.

## 5. Goals / non-goals

**Goals.** A team already using Jira / Graphify adopts Coodra without changing
those tools. Coodra wires their MCP servers and adds only thin, reachable fusion
(Run↔issue link; on-request write-back). Both integrations are opt-in and
fail-open — absent config simply means the agent lacks those tools.

**Non-goals.** Coodra builds no Jira REST client, no Graphify graph reader, no
OAuth app, no webhooks. No automatic Jira write-back. **No minting of Feature
Packs from either system** (no Epic→Pack, no community→Pack). No policy gating of
the external MCP servers' calls (per user directive). Confluence / Bitbucket /
JSM and Graphify's PR-dashboard surface are out of scope.

## 6. Tool surface delta

| Tool | Change |
|---|---|
| `query_codebase_graph` | **Retired** (G1) — superseded by Graphify's own MCP |
| `seed_feature_packs_from_graph`, `build_codebase_graph` | **Retired** (ADR-015) — never the pack source |
| `get_feature_pack` `structure` block | **Retired** (ADR-015) — no producer |
| `link_run_to_issue` | **New** (J2) — binds `runs.issue_ref` so history is Jira-aware |
| `query_run_history`, `query_decisions` | **Expanded** (J2) — optional `issueRef` filter ("what touched PROJ-412?") |
| `prepare_jira_comment` | **New** (J3) — assembles the session summary from the Context Pack + decisions; the agent posts it via Rovo's `addCommentToJiraIssue`, on request |

Net Coodra MCP tool count: **17** — the post-ADR-015 15 + `link_run_to_issue`
(J2) + `prepare_jira_comment` (J3). The agent-facing Jira tools come from the
wired **Rovo** MCP and are not counted in Coodra's manifest.

## 7. References

- Decisions: `context_memory/decisions-log.md` (2026-05-21 lock, 2026-05-23
  ADR-015, 2026-05-31 ADR-016). Live plan: `Coodra/jira-integration-plan.md`.
- Architecture: `system-architecture.md` §17 (Graphify), §22 (Jira — Direct,
  rewritten at J0), §24 (manifest — 17 as of Module 09; 20 after Module 10).
- ADRs: `essentialsforclaude/11-adrs.md` ADR-010 + ADR-015 (Graphify); **ADR-016**
  (Jira = Direct).
- Reference: `External api and library reference.md → Atlassian Remote MCP (Rovo)`.
- Implementation plan: `./implementation.md`. Tech detail: `./techstack.md`.
