# Module 09 — External MCP Integrations (implementation plan)

Two tracks (9A Jira, 9B Graphify) over a shared substrate (9·Core). 9B Graphify
shipped first and built the substrate; 9A Jira reuses it. Reflects ADR-015
(Graphify query-only) + ADR-016 (Jira Direct). Live Jira plan:
`Coodra/jira-integration-plan.md`.

## 9·Core — shared substrate (DONE in 9B)

- The MCP-config writers — `packages/cli/src/lib/init/external-mcp-merge.ts`
  (JSON: Claude Code / Cursor / Windsurf) + `external-codex-merge.ts` (TOML:
  Codex) — idempotent add/remove of an external MCP server entry, preserving the
  `coodra` entry and any user edits. Per-IDE dispatch in `graphify-wire.ts`
  (→ a sibling `jira-wire.ts` for Jira).
- `/settings/integrations` web page (`apps/web-v2/app/settings/integrations/`) — a
  card per integration; local web writes the config directly, team-hosted web
  shows the CLI command.
- The `coodra <integration> enable | disable | status` CLI shape.
- An optional, skippable integrations step in the team onboarding wizard.

## Track 9B — Graphify — DONE (G0–G4), then trimmed by ADR-015

- **G0 — Spec.** ✅ 2026-05-21.
- **G1 — Retire the dead reader.** ✅ Deleted `query-codebase-graph` +
  `lib/graphify.ts`. Tool count 16 → 15.
- **G2 — Seeder.** Built, then **retired by ADR-015 (2026-05-23)**:
  `seed_feature_packs_from_graph`, `build_codebase_graph`, and the
  `get_feature_pack` `structure` block produced un-injectable noise. Graphify is
  query-only. Tool count back to **15**.
- **G3 — Wiring + CLI.** ✅ The 9·Core writers + `coodra graphify
  enable | disable | status` + the `coodra init` Graphify step. (The
  `graphify-seed-packs` recipe was also retired by ADR-015.)
- **COOD-10 — Native plugin packaging.** ✅ Codex and Claude native Coodra
  plugins bundle a default `graphify` MCP entry alongside `coodra`, using a
  shared Coodra-home Graphify MCP runtime (`~/.coodra/graphify-mcp/.venv`) and
  the project-local `.coodra/graphify/out/graph.json` path. `coodra install`
  ensures `graphifyy[mcp]` exists there via `uv` or Python venv + pip; `coodra
  graphify enable` remains the explicit repair/customization path for
  non-plugin agents and pinned interpreter/path setups.
- **G4 — Web UX.** ✅ The `/settings/integrations` Graphify card + wizard step.

## Track 9A — Jira (Direct; ADR-016)

- **J0 — Spec.** ✅ 2026-05-31. Wrote ADR-016; rewrote `system-architecture.md`
  §22 (Direct) + §24 (Jira tools come from Rovo; manifest 15 at J0, 16 after J2) + the §3 /
  §16 / §17 / §18 / §21 cross-refs; added the **Atlassian Remote MCP (Rovo)**
  subsection to `External api and library reference.md`; updated
  `05-agent-trigger-contract.md` §5.7 to Rovo tool names; aligned this folder.
- **J1 — Wiring CLI.** ✅ 2026-05-31. `packages/cli/src/lib/init/jira-wire.ts`
  (parallels `graphify-wire.ts`; widened the 9·Core JSON/TOML writers for native
  remote entries). `coodra jira enable | disable | status` + the `coodra init`
  Jira step + doctor-check-14 tolerance for remote sibling entries. Per-IDE
  **native remote entry only** — Claude Code `{type:"http",url}`, Cursor `{url}`,
  Windsurf `{serverUrl}`, Codex `url` + `experimental_use_rmcp_client`; **no
  `mcp-remote` shim** (decision 2026-05-31). CLI 496 unit + 53 integration green.
- **J2 — Run ↔ issue linkage.** ✅ 2026-05-31. Built `link_run_to_issue` (binds
  `runs.issue_ref`; idempotent, uppercase-normalised, team-mode `sync_to_cloud`
  push, `run_not_found` soft-failure) — Coodra's one Jira MCP tool, manifest
  **15 → 16**. Made `query_run_history` / `query_decisions` `issueRef`-aware
  (optional case-insensitive filter — "what touched / was decided for PROJ-412?").
  Unit + integration tests; e2e manifest set + boot-count assertions updated.
- **J3 — On-request write-back.** ✅ 2026-05-31. Built `prepare_jira_comment`
  (read-only) — assembles the session summary `{ issueRef, body }` from the run's
  Context Pack (title + excerpt) + top decisions; soft-fails `run_not_found` /
  `not_linked`. The agent posts the `body` via Rovo's `addCommentToJiraIssue`, on
  user request only (no auto-post). Manifest **16 → 17**; §5.7 trigger + §22.6
  firmed. Unit + integration tests; e2e set + boot count → 17.
- **J4 — Web + onboarding + e2e.** `/settings/integrations` Jira card (parallels
  the Graphify card; `refuseInTeamHosted` gate); wizard Jira step; e2e
  walkthrough + closeout Context Pack.

## What this track explicitly does NOT build (ADR-016)

- No `jira_*` MCP tools, no Jira REST client, no OAuth app, no ADF converter, no
  webhooks — all are Rovo's.
- No `integrations` / `external_links` tables — presence is read from the agent
  config file; linkage uses `runs.issueRef`.
- No `import_jira_epic` / Epic→Feature-Pack transform (ADR-015 lesson).

## Open items (confirm at J1)

- Per-client native-remote vs `mcp-remote`-shim choice — verify each client's
  current remote-MCP support live (Cursor `url`, Windsurf `serverUrl`, Codex
  `experimental_use_rmcp_client`).
- Atlassian Rovo paid-plan / Standard-plan requirement for the remote MCP —
  unconfirmed; verify before J1 ships.
- Exact `addCommentToJiraIssue` input shape (markdown vs ADF acceptance) — confirm
  live at J3.
