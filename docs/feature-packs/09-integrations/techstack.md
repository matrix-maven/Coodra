# Module 09 — External MCP Integrations (techstack)

## The two external MCP servers

### Graphify MCP (track 9B)

- **Package:** `graphifyy` on PyPI — `uv tool install graphifyy` plus
  `pip install "graphifyy[mcp]"` for the server. Python 3.10+. Not an npm package.
- **Server:** `python -m graphify.serve graphify-out/graph.json` — a stdio MCP
  server; hot-reloads when `graph.json` changes on disk.
- **Tools:** `query_graph` (IDF-weighted natural-language query → scoped
  subgraph), `get_node`, `get_neighbors`, `shortest_path`.
- **Input artifact:** `graphify-out/graph.json` — NetworkX node-link format;
  nodes carry a `community` integer; the edge array is keyed `links`. Built by
  `graphify .` / the `/graphify` skill; meant to be committed to git.
- **Agent-config entry (stdio):**
  `"graphify": { "command": "python", "args": ["-m", "graphify.serve", "graphify-out/graph.json"] }`
  — exact interpreter / `uvx` form confirmed at G3.

### Atlassian Rovo MCP (track 9A)

- **Server:** `https://mcp.atlassian.com/v1/mcp/authv2` — remote, HTTP transport,
  Atlassian-hosted. GA since February 2026.
- **Auth:** OAuth 2.1, per-user, browser-based. No Coodra OAuth app — each
  developer authorizes on first use.
- **Agent-config entry (remote HTTP):**
  `"atlassian": { "type": "http", "url": "https://mcp.atlassian.com/v1/mcp/authv2" }`
  — stdio-only clients use the `npx mcp-remote` shim.
- **Tools used:** JQL search, get issue, add comment (plus create / update).

## New Coodra MCP tools

| Tool | Track | Purpose |
|---|---|---|
| `coodra__seed_feature_packs_from_graph` | 9B | Communities (agent-fetched from Graphify) → one draft Feature Pack each |
| `coodra__link_jira` / `coodra__get_jira_link` | 9A | Read/write the `external_links` map |
| `coodra__import_jira_epic` | 9A | Epic content (agent-fetched) → draft Feature Pack + link |
| `coodra__prepare_jira_comment` | 9A | Assemble a decision / context-pack into a Jira comment body |

`get_feature_pack` is expanded (9B) with an optional `structure` block.

## Schema

- **Graphify (9B): zero migrations.** The `structure` block and `communityHash`
  live inside the existing `feature_packs.content_json` JSON column.
- **Jira (9A): two new tables** — `integrations` (per-org enablement, light) and
  `external_links` (Coodra-entity ⇄ external-key map). Both dialects + the
  schema-parity test. `runs.issue_ref` (already in the schema) covers Run ⇄ Story.

## Coodra Features (skill recipes)

- `graphify-seed-packs` (9B) — recipe: obtain communities from the `graphify`
  MCP, then call `coodra__seed_feature_packs_from_graph`.
- Jira recipes (9A): `jira-import-epic`, `jira-writeback`, `jira-promote-to-feature`.

## Wiring components

- `packages/cli/src/lib/mcp-integrations/` — the shared MCP-config writer (9·Core).
- `packages/cli/src/commands/` — the `graphify` and `jira` subcommands.
- `apps/web-v2/app/settings/integrations/` — the integrations page (9·Core).
