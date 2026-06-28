# Context Pack — ROI / Value Dashboard (2026-06-21)

**Author:** agent session (solo)
**Status:** shipped, all tests green, live-verified (web `/roi` + `coodra roi`)

## What was built

A comprehensive **ROI / value dashboard** that proves Coodra's operational value across four
research-backed dimensions (Adoption → Governance → Knowledge Capitalization → Efficiency/ROI),
plus a parity CLI command, plus the instrumentation that makes the flagship "knowledge reuse"
KPI genuinely measurable. The whole design is built on a hard **measured-vs-modeled** split
(no faked data, per `essentialsforclaude/01-development-discipline.md §1.1`):

- **MEASURED** (real counts from Coodra's tables): runs/completed/agent-mix, tool calls,
  governed actions / blocks / asks, context packs (agent vs bridge_auto), decisions,
  feature packs, features, wiki pages, **reuse reads**, pack→decision linkage (`meta.decisionIds`),
  decision completeness (DIQ/AQI), asset freshness/staleness, author concentration (bus-factor),
  knowledge-captured chars.
- **MODELED** (derived from those counts × transparent, configurable, *cited* constants, badged
  "◐ modeled"): token/credit savings (compression + reuse + prompt-cache + runaway-loop),
  developer time reclaimed, **Net Value / Benefit-Cost Ratio / ROI%**, as a conservative–base–
  optimistic band, with an Assumptions & Methodology panel exposing every constant + source + formula.

### Why this split (the central decision)
The prior strategy doc (`docs/coodra-roi-and-metrics-architecture.md`) proposed a `run_telemetry`
table + token columns on `runs`. **No token/cost/cache telemetry exists anywhere**, and Claude
Code's hooks don't expose token usage — so even that table would store *estimates*, not measured
facts. Modeling-from-real-counts (clearly labeled) is the honest path; building a "measured tokens"
table would have faked the headline numbers. Decision recorded in `decisions-log.md`.

## Files

### New
- `packages/shared/src/roi/{constants,model,index}.ts` — the shared ROI model (pure, configurable,
  cited). Constants: Anthropic rate card (Opus $5/$25, cache-read 0.1×, write 1.25×; Sonnet/Haiku/Fable),
  `DEFAULT_ROI_CONSTANTS`, `SCENARIO_FACTORS`, `REUSE_READ_TOOL_NAMES`, `ROI_SOURCES`. Functions:
  `computeRoi`, `computeRoiBand`, `scaleConstantsForScenario`, `estimateTokensFromChars`,
  `buildMethodology`. Exported as `@coodra/shared/roi` (added to package.json exports).
- `packages/shared/__tests__/unit/roi/model.test.ts` — 21 tests, exact hand-derived math.
- `apps/web-v2/lib/queries/roi.ts` — dual-dialect (sqlite+postgres) MEASURED aggregation →
  `RoiSnapshot` incl. `modeledInputs: RoiMeasuredInputs` (the only bridge to the modeled layer).
- `apps/web-v2/app/roi/page.tsx` — server component: hero north-star, 4 dimension sections,
  evidence/methodology, assumptions panel. Dependency-free inline SVG sparklines + CSS meters
  (no chart lib added). Measured/modeled chips throughout.
- `packages/cli/src/commands/metrics.ts` — `coodra metrics` (alias `coodra roi`), `--json`,
  `--project`. Reads local SQLite, computes the SAME band via `@coodra/shared/roi` (web↔CLI parity).
- `packages/cli/__tests__/unit/commands/metrics.test.ts` — 4 tests (seeds real `mcp_call` reuse rows).
- `apps/mcp-server/__tests__/integration/tools/reuse-runid-instrumentation.test.ts` — 9 tests:
  5 schemas retain `runId` + registry records `mcp_call` with runId / nothing without.

### Modified
- `apps/mcp-server/src/tools/{search-packs-nl,get-feature-pack,query-run-history,list-context-packs,
  get-feature}/schema.ts` — added optional attribution `runId` (so the registry's existing
  `mcp_call` audit hook records reuse reads). NOT added to query_decisions/read_context_pack
  (their `runId` is a filter/lookup, not attribution).
- `essentialsforclaude/05-agent-trigger-contract.md` §5.5 — instruct the agent to pass `runId` on
  reuse reads; clarified the filter-vs-attribution distinction.
- `apps/web-v2/components/Sidebar.tsx` — `/roi` nav link in both solo+team Workspace groups + IconChart.
- `packages/cli/src/program.ts` — wired `metrics`/`roi` command + DI fields.
- Test fixups exposed by rebuilding the stale mcp-server dist:
  `program.test.ts` (+metrics), `help-output.test.ts` (snapshot), `boot-team-mode-local-sqlite.test.ts`
  (stale tool count 17→20; only passed before against a pre-wiki dist).

## How reuse is now measured (the instrumentation)
`ToolRegistry.handleCall` (`tool-registry.ts:469-498`) already writes a `phase:'mcp_call'`
`run_events` row whenever the validated input contains a non-empty `runId`. The reuse-read tools
were `.strict()` *without* `runId`, so the agent couldn't pass it and reuse was invisible. Adding
optional `runId` to 5 read schemas + telling the agent (trigger contract) to pass it makes reuse a
**real measured signal going forward** — zero new write code. The `/roi` + CLI count
`run_events WHERE phase='mcp_call' AND tool_name IN REUSE_READ_TOOL_NAMES`. Counter starts now
(no retroactive history) — surfaced honestly as "capture armed" when 0.

## Tests / verification
- Unit: shared 297, mcp-server 284; Integration: mcp-server 175 (incl. new reuse test);
  CLI 537 (incl. new metrics test); web-v2 47. Workspace `pnpm -r typecheck` clean; Biome clean.
- **Live web**: dev server → `GET /roi` HTTP 200, real data (36 runs, 17 packs, 3,778 governed),
  modeled net **$30.03** (band $28.95–$31.11), BCR 1.8×, ROI 77%, credits $69.03, tokens 13.81M,
  time $0 (honest: reuse=0/blocks=0). No render errors.
- **Live CLI**: `coodra metrics` / `roi` / `--json` — **identical numbers to the web** (shared model).
- Reuse pipeline proven by the integration test (registry records `mcp_call` with runId, nothing without).

## Adversarial review (2026-06-21) — 3 findings confirmed (2/2 votes) + fixed
A 5-dimension adversarial review workflow (math / dual-dialect / honesty / instrumentation /
regression, each finding refuted by 2 independent skeptics) ran. Math, dual-dialect, and
regression returned **zero** findings. Three confirmed + fixed:
1. **HIGH (reuse undercount).** The MCP run-recorder built `run_events.id = re_<idempotencyKey.key>_<phase>`
   with `ON CONFLICT (id) DO NOTHING`; the reuse-read tools' readonly keys are pure functions of the
   request args (no runId), so an identical parameterized reuse-read from a *second* run collided and
   was silently dropped — undercounting reuse + `runsWithReuse`. **Fix:** the mcp_call event id now
   includes the runId (`re_<runId>_<key>_<phase>`, `apps/mcp-server/src/lib/run-recorder.ts`). Write
   tools already embed runId in their key, so it's redundant-but-harmless there.
2. **MEDIUM (mis-attribution).** `read_context_pack` / `query_decisions` use `runId` as a
   filter/lookup (the run read ABOUT), so their mcp_call rows carry the wrong run_id. **Fix:** removed
   both from `REUSE_READ_TOOL_NAMES` — the reuse set is now exactly the 5 tools whose `runId` is
   consulting-run attribution.
3. **LOW (CLI honesty).** `coodra roi` printed "knowledge captured" (a chars÷4 modeled estimate) under
   a "· measured" section with no transform disclosure (the web shows "chars ÷ 4"). **Fix:** the CLI
   row now reads "· est · chars ÷ 4".
Post-fix: shared 297, mcp 284+175, cli 537 green; web typecheck clean; Biome clean; CLI re-verified live.

## Known limitations / next
- **Reuse + line-output + blocks read 0 on this machine today** (capabilities armed; reuse accrues as
  agents follow the updated contract; `run_diffs` are all `no_base_sha`; 0 policy denies). Shown honestly.
- **Team-hosted org-scoping**: `roi.ts` is unscoped, mirroring `dashboard.ts` (local SQLite is single-org).
  A true cross-teammate org rollup needs the `projects.org_id` JOIN in the postgres branch (tracked).
  `run_diffs` never sync (local-only) and `policy_decisions` is push-only — a team dashboard would
  under-count those until added to `SYNC_TABLES`.
- Assumptions are configurable-in-code (+ a read-only methodology panel); a future admin-editable
  config-table UI (live what-if) is the natural follow-up.
- The mcp-server `dist/` was stale (pre-wiki, 22 May); rebuilt this session — running services should
  be restarted (`coodra start`) to pick up the wiki tools + the new reuse-read `runId` schemas.
