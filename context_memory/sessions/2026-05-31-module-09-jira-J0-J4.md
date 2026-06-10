# Current Session — 2026-05-31 (Module 09 Track 9A — Jira: J0 spec)

## Goal

Execute **J0** of the Jira track (Direct approach, ADR-016): verify the Atlassian
Rovo Remote MCP online, then write the spec — ADR-016, a rewritten
`system-architecture.md` §22, the Rovo subsection in `External api and library
reference.md`, the §5.7 trigger-contract update, and align the
`09-integrations` feature-pack folder. **No product code in J0.**

## Context loaded

- `Coodra/jira-integration-plan.md` (the durable locked plan — Direct + Link/write-back)
- `system-architecture.md` §22 (old Build design), §24 (manifest)
- `essentialsforclaude/11-adrs.md` (ADR-015), `05-agent-trigger-contract.md` §5.7
- `External api and library reference.md` → Atlassian/Jira section
- Live online verification: Atlassian Rovo MCP (support docs + `atlassian/atlassian-mcp-server` + Claude Code / Codex / Windsurf MCP docs)
- `context_memory/decisions-log.md` (2026-05-31 lock entry)

## Last completed

**J0 COMPLETE (docs only).** Verified Rovo online (endpoint `mcp.atlassian.com/v1/mcp(/authv2)`,
Streamable HTTP, OAuth 2.1 + RFC 7591 DCR, verbatim Jira tool names, per-IDE
wiring shapes, `/v1/sse` off after 2026-06-30, headless needs org-admin
API-token enablement). Wrote: ADR-016; rewrote §22 → Direct (22.1–22.9) + all
cross-refs (§3, §16, §17, §18, §21, §24.4/24.5/24.6); added the "Atlassian Remote
MCP (Rovo)" subsection to the External-api reference; rewrote §5.7 to Rovo tool
names; aligned `docs/feature-packs/09-integrations/{spec,implementation,techstack,meta.json}`
to ADR-015 + ADR-016 (dropped Epic→Pack transform, `import_jira_epic`,
`external_links`/`integrations` tables, the 4-tool surface → net 0–1 Jira tool,
zero migration); updated the `library-map.md` Atlassian row; logged the J0
completion in `decisions-log.md`.

Net: Coodra MCP manifest stays at **15** tools. Zero new DB tables for Jira.
Agent-facing Jira tools come from the wired Rovo MCP.

## Next action

**JIRA TRACK (Module 09 Track 9A) COMPLETE — J0–J4 all done + green.** Manifest is
**17 tools** (15 + `link_run_to_issue` + `prepare_jira_comment`). Closeout pack:
`docs/context-packs/2026-05-31-jira-direct-integration.md`.

No further Jira work required. **Publish artifact is BUILT and verified** (2026-05-31):
web-v2 standalone rebuilt; `pnpm --filter @coodra/cli build` produced
`dist/runtime/{mcp-server(17 tools),hooks-bridge,sync-daemon,web}` + `dist/lib/**`;
`scripts/prepublish-assert.mjs` → ok (4 artifacts, web fresher than source);
`npm pack --dry-run` → `coodra-cli-0.2.0-beta.15.tgz` (23.4 MB / 3047 files, README +
LICENSE included); bundled-binary smoke `node dist/index.js jira --help` shows the
enable/disable/status Rovo subcommands. Pending **user actions**:
1. Publish: `cd packages/cli && npm publish --tag beta --access public --otp=<code>`.
   (`prepublishOnly` re-runs the assert only — it does NOT rebuild, so the dist just
   built is exactly what ships.)
2. Exercise live: `coodra jira enable` in a project, restart the agent, run `/mcp`
   to complete the Atlassian sign-in, then drive the loop (read a ticket → the agent
   calls `link_run_to_issue` → ask "what touched PROJ-412?" → `prepare_jira_comment`
   → post via Rovo's `addCommentToJiraIssue`).

If continuing development, Module 09 is fully complete (Graphify 9B + Jira 9A).
Next module per `08-implementation-order.md` is a judgment call with the user.

## Open / to confirm at J1

- Per-client native-remote vs `mcp-remote`-shim choice — re-verify each client's current remote-MCP support live.
- Atlassian Rovo paid-plan / Standard-plan requirement for the remote MCP — unconfirmed.
- Exact `addCommentToJiraIssue` body shape (markdown vs ADF) — confirm at J3.

## Pending user actions (carried over, unchanged by J0)

- Publish CLI `beta.14` (`npm publish --tag beta --access public --otp=<code>`) and restart the `coodra` MCP server to load the 15-tool build. (J0 is docs-only — no new user action.)

## Log (append-only per PostToolUse)
- [J0] Verified Atlassian Rovo MCP online — endpoint/transport/OAuth/tool-names/per-IDE shapes captured from Atlassian + Claude Code + Codex + Windsurf docs.
- [J0] Wrote ADR-016 (Jira = Direct) → `essentialsforclaude/11-adrs.md`.
- [J0] Rewrote `system-architecture.md` §22 to Direct (sed-deleted the 405-line Build §22, inserted the new Direct §22 before §23); updated §24.4/24.5/24.6 + §3/§16/§17/§18/§21 cross-refs.
- [J0] Added the "Atlassian Remote MCP (Rovo)" subsection to `External api and library reference.md`; marked Build-era subsections superseded.
- [J0] Rewrote `05-agent-trigger-contract.md` §5.7 to Rovo tool names + the SessionStart line + the §5.11 N/A note.
- [J0] Rewrote `docs/feature-packs/09-integrations/{spec,implementation,techstack}.md` + fixed `meta.json` (valid JSON confirmed) to ADR-015 + ADR-016.
- [J0] Updated `library-map.md`; logged J0 completion + archived the prior G0–G4 current-session to `sessions/2026-05-21-module-09-G0-to-G4-graphify.md`.
- [J1 decision] User chose **native remote entries only — no `mcp-remote` shim**. Docs updated (§22.3, External-api Rovo table, 09-integrations/implementation.md, decisions-log).
- [J1] Widened the 9·Core writers — `external-mcp-merge.ts` (`RemoteMcpEntry`/`McpEntry`) + `external-codex-merge.ts` (`url` projection + idempotent `topLevel` rmcp flag); fixed doctor check 14 to tolerate remote sibling entries.
- [J1] Built `lib/init/jira-wire.ts` + `commands/jira.ts` (enable/disable/status); wired `program.ts` (`jira` group + `init --jira/--no-jira`) + the `coodra init` Jira step.
- [J1] Tests: `jira-wire.test.ts` + `commands/jira.test.ts`; updated `program.test.ts` list + help snapshot. Added the `./lib/init/jira-wire` package export; bumped beta.14 → beta.15 (`src/version.ts` synced).
- [J1] Verified: CLI 496/496 unit + 53 integration + typecheck + Biome green; real-binary smoke (`jira enable --ide claude,codex`) writes correct native shapes incl. Codex `experimental_use_rmcp_client = true`. **J1 COMPLETE. Next: J2.**
- [J2 decision] User chose a **dedicated `link_run_to_issue` MCP tool** (manifest 15→16) over a `get_run_id` param.
- [J2] Built `apps/mcp-server/src/tools/link-run-to-issue/` (schema/handler/manifest) — Coodra's one Jira tool; binds `runs.issue_ref`, idempotent, uppercase-normalised, team-mode sync push, `run_not_found` soft-failure. Registered in the barrel.
- [J2] Added optional `issueRef` filter to `query_run_history` + `query_decisions` (the "what touched/was decided for PROJ-412?" read path).
- [J2] Updated tool-count to 16: boot.test.ts + boot-team-mode + e2e `manifest-e2e` EXPECTED_TOOLS/PROBE_INPUTS (also fixed a pre-existing ADR-015 staleness — the retired seed tool was still listed). Docs 15→16: §22.4/22.5/22.9, §24.4/24.5, ADR-016, README, 09-integrations spec/impl/techstack, §5.7 trigger.
- [J2] Rebuilt mcp-server dist (boot tests boot from dist). Verified: mcp-server 260 unit + 154 integration + 20 e2e manifest green; typecheck + Biome clean. **J2 COMPLETE. Next: J3 (write-back).**
- [J3 decision] User chose the **helper tool** (`prepare_jira_comment`) over pure guidance — manifest 16→17.
- [J3] Built `apps/mcp-server/src/tools/prepare-jira-comment/` — read-only; assembles `{issueRef, body}` from the run's Context Pack + top decisions; soft-fails `run_not_found`/`not_linked`; no Jira call (agent posts via Rovo). Output schema is `z.union` (two ok:false branches can't use discriminatedUnion). Registered in barrel.
- [J3] Tool-count 16→17: boot/boot-team/e2e EXPECTED_TOOLS+PROBE_INPUTS. Docs: ADR-016 (TWO Coodra Jira tools), §22.4/22.6/22.9, §24.4/24.5, README (3 spots), 09-integrations spec/impl/techstack, §5.7 write-back trigger.
- [J3] Verified: typecheck + Biome clean; mcp-server 267 unit + 159 integration + 21 e2e manifest green; dist rebuilt (17 tools live). **J3 COMPLETE. Jira track J0–J3 DONE; J4 (web) optional.**
- [J4] Built the web Jira surface (mirror of Graphify G4): `lib/queries/integrations.ts` (readJiraIntegrationStatus), `lib/actions/integrations.ts` (enable/disableJiraAction), `app/settings/integrations/page.tsx` (Jira card), onboarding Step 6 Jira section. De-staled the Graphify `graphify-seed-packs` refs (ADR-015). Fixed: emitted CLI `dist/lib/init/jira-wire.d.ts` (build:tsc-only) so web typecheck resolves the export.
- [J4] Verified: web-v2 typecheck + Biome clean; 43 unit; `next build` compiles both routes. Closeout pack `docs/context-packs/2026-05-31-jira-direct-integration.md` written. **J4 COMPLETE. JIRA TRACK (J0–J4) DONE — manifest 17 tools.**
