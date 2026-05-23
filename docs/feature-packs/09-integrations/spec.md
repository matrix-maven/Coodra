# Module 09 — External MCP Integrations (spec)

> Status: G0 (Graphify spec) complete 2026-05-21. Architecture locked — see
> `context_memory/decisions-log.md` (2026-05-21) and
> `~/.claude/.../memory/module-09-mcp-integrations.md`.

## 1. What this module is

Module 09 integrates two external systems into Coodra — **Jira** and
**Graphify** — with one shared pattern: **wire the external system's own MCP
server into the agent's config, and have Coodra provide *fusion tools + skill
recipes* that compose it with the knowledge layer.** Coodra does not rebuild
Jira or Graphify; it wires them, and fuses their data into Feature Packs,
Context Packs, and Decisions.

This supersedes two stale specs: `system-architecture.md §22` (a build-our-own
Jira REST client + OAuth app + webhooks — never built) and the original ADR-010
/ §17 (a Coodra-owned Graphify `graph.json` reader + importer — never completed,
pointed at a path nothing writes).

## 2. Structure — one substrate, two tracks

- **9·Core** — shared substrate, built once by whichever track ships first:
  - the **MCP-config writer** — idempotently adds/removes an external MCP server
    entry in the agent's config (`.mcp.json` for Claude Code; `.cursor/mcp.json`;
    `.vscode/mcp.json`), preserving the `coodra` entry and user edits.
  - the **`/settings/integrations`** web page — a card per integration.
  - the **`coodra <integration> enable | disable | status`** CLI command shape.
  - an optional, skippable integrations step in the team onboarding wizard.
- **9A — Jira** — wire the `atlassian` MCP (remote HTTP, per-user OAuth).
- **9B — Graphify** — wire the `graphify` MCP (local stdio).

The agent ends with up to three MCP servers — `coodra`, `atlassian`, `graphify`
— all wired by Coodra onboarding.

## 3. Track 9A — Jira

Locked decisions (2026-05-21):
1. **Access = Direct.** Onboarding writes Atlassian's official Rovo MCP server
   (`https://mcp.atlassian.com/v1/mcp/authv2`, per-user OAuth 2.1) into the agent
   config. Coodra builds no Jira REST client, OAuth app, or webhooks.
2. **Story → Run** (its Context Pack is the write-back artifact); **Epic →
   Feature Pack**; Features stay separate, with an explicit "promote a finished
   Story to a Feature" action.
3. **Write-back = on request only** — never automatic.
4. **Onboarding = both** — optional skippable wizard step + `/settings/integrations`.

Entity map: Epic↔Feature Pack, Story/Task/Bug↔Run (`runs.issue_ref`), Context
Pack↔comment, Decision↔comment, Feature↔(promotion only). New Coodra tools:
`link_jira`, `get_jira_link`, `import_jira_epic`, `prepare_jira_comment`. New
schema: `integrations` + `external_links` tables. Full detail lands at J0.

## 4. Track 9B — Graphify

Decision: **Option C** — consume Graphify via its own MCP server.

- **Wiring.** Onboarding writes a `graphify` stdio MCP entry (`python -m
  graphify.serve graphify-out/graph.json`) into the agent config. The agent
  queries `query_graph` / `get_node` / `get_neighbors` / `shortest_path`
  directly.
- **Retired.** `query_codebase_graph` + `apps/mcp-server/src/lib/graphify.ts` — a
  dead reader of `~/.coodra/graphify/<slug>/graph.json`, a path nothing writes.
- **Coodra's leverage — fuse structure into the knowledge layer:**
  - **`coodra__seed_feature_packs_from_graph`** (new) — the agent fetches the
    Leiden community breakdown from Graphify and hands it to Coodra; Coodra
    creates one **draft** Feature Pack per community (the cold-start fix).
    Idempotent on a community hash — re-seeding updates packs; a vanished
    community flags its pack stale.
  - **`get_feature_pack`** gains an optional `structure` block (community id,
    god nodes, member files), populated at seed time — every session start can
    deliver code topology alongside human intent.
- **No schema migration** — `structure` + `communityHash` live inside the
  existing `feature_packs.content_json` JSON column.
- New Coodra Feature recipe: `graphify-seed-packs`.

## 5. Goals / non-goals

**Goals.** A team already using Jira / Graphify adopts Coodra without changing
those tools. Coodra wires their MCP servers and fuses their data into the
knowledge layer. Both integrations are opt-in and fail-open — absent config
simply means the agent lacks those tools.

**Non-goals.** Coodra builds no Jira REST client, no Graphify graph reader, no
OAuth app, no webhooks. No automatic Jira write-back. No policy gating of the
external MCP servers' calls (per user directive). Confluence / Bitbucket and
Graphify's PR-dashboard surface are out of scope.

## 6. Tool surface delta

| Tool | Change |
|---|---|
| `query_codebase_graph` | **Retired** (G1) — superseded by Graphify's own MCP |
| `coodra__seed_feature_packs_from_graph` | **New** (G2) — communities → draft Feature Packs |
| `get_feature_pack` | **Expanded** (G2) — optional `structure` block |
| `link_jira`, `get_jira_link`, `import_jira_epic`, `prepare_jira_comment` | **New** (Jira track, J1 / J4) |

Net MCP tool count: 16 → 15 (G1) → 16 (G2) → 20 (Jira track).

## 7. References

- Decisions: `context_memory/decisions-log.md` (2026-05-21).
- Architecture: `system-architecture.md` §17 (Graphify), §22 (Jira — rewritten at
  J0), §24 (manifest).
- ADRs: `essentialsforclaude/11-adrs.md` ADR-010 (Graphify); ADR-015 (Jira, added at J0).
- Implementation plan: `./implementation.md`. Tech detail: `./techstack.md`.
