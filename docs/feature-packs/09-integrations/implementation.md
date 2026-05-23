# Module 09 — External MCP Integrations (implementation plan)

Two tracks (9A Jira, 9B Graphify) over a shared substrate (9·Core). The substrate
is built once, by whichever track ships first. **Recommended order: 9B Graphify
first** — it is the lighter track (no schema migration, no OAuth) and proves the
substrate cheaply; 9A Jira then reuses it.

## 9·Core — shared substrate

- The MCP-config writer (`packages/cli/src/lib/mcp-integrations/`) — idempotent
  add/remove of an external MCP server entry across Claude Code / Cursor / VS
  Code configs, preserving the `coodra` entry and any user edits.
- `/settings/integrations` web page (`apps/web-v2/app/settings/integrations/`) — a
  card per integration; local web writes the config directly, team-hosted web
  shows the CLI command instead.
- The `coodra <integration> enable | disable | status` CLI command shape.
- An optional, skippable integrations step in the team onboarding wizard.

## Track 9B — Graphify

- **G0 — Spec.** ✅ DONE 2026-05-21. Rewrote ADR-010 and `system-architecture.md`
  §17; corrected the §24 `query_codebase_graph` entry, the External-api-ref
  Graphify section, and `essentialsforclaude/05-agent-trigger-contract.md` §5.6;
  created this module folder.
- **G1 — Retire the dead path.** ✅ DONE 2026-05-21. Deleted the
  `query-codebase-graph` tool, `apps/mcp-server/src/lib/graphify.ts`, the
  `GraphifyClient` type/field, and the related tests. Tool count 16 → 15.
- **G2 — Fusion tool.** ✅ DONE 2026-05-21. Built `coodra__seed_feature_packs_from_graph`
  (handler / schema / manifest / tests) + the `get_feature_pack` `structure` block
  (G2.1 — also writes the on-disk pack files). Tool count 15 → 16.
- **G3 — Wiring + CLI.** ✅ DONE 2026-05-23. The 9·Core MCP-config writers —
  `lib/init/external-mcp-merge.ts` (JSON: Claude/Cursor/Windsurf) and
  `lib/init/external-codex-merge.ts` (TOML: Codex) — plus `lib/init/graphify-wire.ts`
  (the shared per-IDE dispatch). `coodra graphify enable | disable | status` wires
  all four agents. `coodra init` gained an optional, opt-in Graphify step
  (`--graphify` / `--no-graphify` / interactive prompt). The bundled
  `graphify-seed-packs` Feature recipe (`lib/init/graphify-feature.ts`) is seeded
  on `graphify enable` and on `init`'s Graphify step.
- **G4 — Web UX.** ✅ DONE 2026-05-23. `apps/web-v2/app/settings/integrations/page.tsx` —
  a Graphify card: local web does per-project enable/disable via server actions
  (`lib/actions/integrations.ts` + `lib/queries/integrations.ts`, reusing the 9·Core
  writers exported from `@coodra/cli`); team-hosted web shows the `coodra graphify
  enable` CLI command. The team onboarding wizard gained an optional, skippable
  Step 6 "Integrations". **Graphify track G0–G4 complete.**

## Track 9A — Jira

- **J0 — Spec.** Rewrite `system-architecture.md` §22; add ADR-015; write the
  Jira detail into this module folder.
- **J1 — Schema + mapping core.** `integrations` + `external_links` tables (both
  dialects, parity test, migrations); `link_jira` + `get_jira_link` tools.
- **J2 — Config wiring + CLI.** Reuse the 9·Core writer; `coodra jira
  enable | disable | status`; `coodra init` prompt.
- **J3 — Web UX.** `/settings/integrations` Jira card; wizard step.
- **J4 — Fusion tools + Features.** `import_jira_epic`, `prepare_jira_comment`;
  the Jira skill recipes; end-to-end verification.

## Open items

- User mentioned prior Jira-MCP research, never shared — reconcile if it surfaces.
- Atlassian Rovo MCP paid-plan requirement — unconfirmed.
- Graphify MCP exact invocation (`python -m graphify.serve` vs a `graphify serve`
  subcommand; `python` vs `uvx`) — confirm at G3.
- Whether Graphify's MCP exposes a communities/clusters tool, or the
  `graphify-seed-packs` recipe has the agent read `graphify-out/graph.json`
  directly — confirm at G2.
