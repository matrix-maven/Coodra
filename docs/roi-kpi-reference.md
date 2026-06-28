# Coodra ROI Dashboard — KPI Reference

> A complete, self-explanatory specification of **every KPI** on the `/roi` web dashboard
> (and the `coodra roi` CLI): **what it is**, **how it is calculated** (exact formula + data
> source), and **its value** — why it matters in the Coodra system.
>
> **Surfaces:** web `/roi` (Workspace → ROI in the sidebar) · CLI `coodra roi` / `coodra metrics`.
> **Code of record:** measured counts → `apps/web-v2/lib/queries/roi.ts` (web) and
> `packages/cli/src/commands/metrics.ts` (CLI); the modeled math → `@coodra/shared/roi`
> (`packages/shared/src/roi/{model,constants}.ts`). Web and CLI feed identical inputs into the
> **same** model, so their numbers always agree.

---

## 0. The one principle that governs the whole dashboard: Measured vs. Modeled

Coodra stores **no token, cost, or cache telemetry** anywhere, and AI-agent hooks (Claude Code,
Cursor) do **not** expose token usage. So the dashboard draws a hard line:

| Class | Symbol | What it is | Trust level |
|---|---|---|---|
| **Measured** | `● measured` | A real count or sum read directly from Coodra's database tables. | Fact. |
| **Modeled** | `◐ modeled` | A dollar/token figure **derived** from measured counts × transparent, configurable, *cited* assumptions. Shown as a conservative–base–optimistic **band**. | Estimate — interrogate it. |

Every modeled number is badged, sits next to the raw counts it came from (the **Evidence** section),
and every assumption is listed with its source (the **Assumptions & Methodology** section). You can
change an assumption and watch the number move — the opposite of fabrication.

**How to read each KPI below:** every entry states its **class** (`measured`/`modeled`), a plain
definition, the **exact formula** with its data source, and **why it matters**.

---

## 1. Dimension A — Adoption & Activity `● measured`

*"You can't bank value nobody is using."* These are leading indicators: are agents actually running,
and how much work is flowing through Coodra.

### A1. Runs recorded (Total runs)
- **What:** Total number of agent sessions Coodra has recorded (each `runs` row = one agent session).
- **Formula:** `COUNT(*) FROM runs`.
- **Value:** The base unit of usage. Coodra injects a Feature Pack at the start of every run
  (Pattern 20), so every run is also a unit over which the context-compression saving applies.

### A2. Completed runs
- **What:** Runs that reached a clean end (`status = 'completed'`).
- **Formula:** `COUNT(*) FROM runs WHERE status = 'completed'`.
- **Value:** The denominator for quality/continuity rates (e.g. Link Rate). A healthy ratio of
  completed-to-total signals sessions are finishing, not being abandoned/cancelled.

### A3. In-progress runs · A4. Cancelled runs
- **What:** Live sessions (`status = 'in_progress'`) and stopped/stuck sessions (`status = 'cancelled'`).
- **Formula:** `COUNT(*) FROM runs WHERE status = '<status>'`.
- **Value:** Operational health. A growing cancelled count points at sessions being killed or left
  hanging — worth investigating.

### A5. Active projects
- **What:** Distinct projects that have at least one run.
- **Formula:** `COUNT(DISTINCT project_id) FROM runs`.
- **Value:** Breadth of adoption — how many codebases Coodra is actually being used on.

### A6. Tool calls
- **What:** Total agent tool invocations traced (every `run_events` row — Bash, Edit, Write, and the
  agent's MCP calls).
- **Formula:** `COUNT(*) FROM run_events`.
- **Value:** A proxy for total agent effort/turns. It is also the input to the prompt-cache lever:
  each tool call is roughly one "turn" that re-sends the cached context prefix.

### A7. Agent mix
- **What:** Runs broken down by agent type (`claude_code`, `cursor`, `windsurf`, …).
- **Formula:** `SELECT agent_type, COUNT(*) FROM runs GROUP BY agent_type`.
- **Value:** Shows which AI clients your team actually uses — Coodra is agent-agnostic, this proves it.

### A8. Runs per week (12-week sparkline)
- **What:** Run volume bucketed into the trailing 12 weekly bins.
- **Formula:** fetch `runs.started_at` for all runs; bucket each into one of `TREND_WEEKS = 12`
  trailing 7-day windows in code (`bucketWeekly`). No DB date math (keeps it dialect-portable).
- **Value:** Trend, not just total — is adoption growing, flat, or decaying? (Tufte sparkline.)

---

## 2. Dimension B — Governance & Safety `● measured`

*"Risk avoided is value too."* Coodra's policy engine evaluates every agent action; this dimension
shows the coverage and the catches.

### B1. Actions governed (Governed actions)
- **What:** Total agent actions that passed through the policy engine (one `policy_decisions` row per
  `PreToolUse` evaluation).
- **Formula:** `COUNT(*) FROM policy_decisions`.
- **Value:** **Governance coverage** — the headline safety number even when nothing is blocked. It
  proves every agent action was policy-checked (the enforcement layer is armed and watching), which
  is the enterprise "AI as a governed non-human identity" story (ADR-011).

### B2. Unsafe actions blocked (Blocked)
- **What:** Actions the policy engine **denied** before they ran.
- **Formula:** `COUNT(*) FROM policy_decisions WHERE permission_decision = 'deny'`.
- **Value:** Each block is a prevented runaway loop, destructive command, or unauthorized write —
  i.e. a prevented credit spike or manual cleanup. Feeds the modeled "runaway-loop tokens prevented"
  lever (D-tokens-4). Reads `0` honestly when nothing has been blocked ("none yet · deny path armed").

### B3. Ask-first prompts
- **What:** Actions held for explicit human confirmation (`permission_decision = 'ask'`).
- **Formula:** `COUNT(*) FROM policy_decisions WHERE permission_decision = 'ask'`.
- **Value:** Human-in-the-loop friction the policy engine inserted on sensitive operations.

### B4. Active kill switches
- **What:** Currently-active pauses on agents/tools/projects (a kill switch with no `resumed_at` and
  not expired).
- **Formula:** `listAllActiveKillSwitches(handle).length` (active = `resumed_at IS NULL AND
  (expires_at IS NULL OR expires_at > now)`).
- **Value:** Are any agents paused right now? A non-zero value means something is deliberately halted.

> **Derived (computed, not currently displayed):** `coverageRatio = governedActions / (governedActions
> + toolCalls)` is produced by the query as a coverage signal; it is available to consumers but not
> rendered on the page today.

---

## 3. Dimension C — Knowledge Capitalization `● measured`

*"The compounding asset."* This is the heart of Coodra's value: the institutional memory it captures
and how often it is reused. Grounded in KCS (Knowledge-Centered Service) and ADR-value literature.

### C1. Context packs (+ agent vs. auto split)
- **What:** Total Context Packs (narrative recaps of a session), split by provenance: `agent`
  (the agent explicitly called `save_context_pack`) vs. `bridge_auto` (the hooks-bridge's
  Pattern-20 fallback auto-summary).
- **Formula:** `COUNT(*) FROM context_packs`; `agent` = `WHERE source = 'agent'`;
  `bridge_auto` = `WHERE source = 'bridge_auto'`.
- **Value:** The durable cross-session memory. Agent-authored packs are richer than auto-summaries;
  the split is a compliance signal (is the agent doing the narrative work, or only the bridge?). Only
  agent-authored packs count toward the **authoring investment** (cost) — auto-summaries are free.

### C2. Decisions
- **What:** Total architectural Decision Records captured via `record_decision`.
- **Formula:** `COUNT(*) FROM decisions`.
- **Value:** The ADR ledger — what was decided and why. Prevents re-litigation and architectural
  drift; the second pillar of institutional memory.

### C3. Feature packs · C4. Features
- **What:** Module blueprints (`feature_packs`, injected at session start) and on-demand skills
  (`features`, pulled on trigger).
- **Formula:** `COUNT(*) FROM feature_packs`; `COUNT(*) FROM features`.
- **Value:** The pushed (modules) and pulled (skills) knowledge surfaces an agent consumes.

### C5. Wiki pages (authored / total)
- **What:** Deep-Wiki pages authored vs. planned.
- **Formula:** authored = `COUNT(*) FROM wiki_pages WHERE state = 'authored'`; total = `COUNT(*) FROM
  wiki_pages`; wikis = `COUNT(*) FROM wikis`.
- **Value:** Coverage of the agent-authored codebase wiki (Module 10).

### C6. Assets per week (12-week sparkline)
- **What:** Knowledge-asset creation rate (context packs + decisions) over the trailing 12 weeks.
- **Formula:** bucket the `created_at` of all context packs + decisions into 12 weekly bins
  (`bucketWeekly`).
- **Value:** **Decision Velocity / production rate** — is institutional memory compounding, or has
  capture stalled?

### C7. Reuse reads
- **What:** The number of times an agent **consciously consulted prior knowledge** — recorded as
  `mcp_call` `run_events` for the reuse-read tools when the agent passes its `runId`.
- **Formula:** `COUNT(*) FROM run_events WHERE phase = 'mcp_call' AND tool_name IN
  (coodra__search_packs_nl, coodra__get_feature_pack, coodra__list_context_packs, coodra__get_feature,
  coodra__query_run_history)`. (That tool set is `REUSE_READ_TOOL_NAMES`, shared by web + CLI.)
- **Value:** The flagship "knowledge is being reused, not re-derived" signal — the whole point of
  capturing packs/decisions. **This counter starts when an agent first follows the updated trigger
  contract (passing its `runId` on reuse reads); it has no retroactive history**, so it honestly reads
  `0` ("capture armed") until then. Feeds the modeled "re-derivation tokens saved" (D-tokens-2) and
  "time reclaimed" (D3) levers.
- **Note on correctness:** `read_context_pack` and `query_decisions` are *excluded* from the reuse
  set on purpose — their `runId` is a filter/lookup (the run being read *about*), not the consulting
  run, so counting them would mis-attribute the reuse to the wrong run.

### C8. Reuse by tool
- **What:** Reuse reads broken down per tool (which consultation surface the agent leans on).
- **Formula:** `…GROUP BY tool_name` over the C7 filter.
- **Value:** Shows whether agents recall via semantic pack search, feature-pack injection, prior-run
  history, etc. A "most-reused" view.

### C9. Pack/Decision Link Rate (KCS Link Rate analogue)
- **What:** The share of completed runs that consulted ≥1 prior knowledge asset.
- **Formula:** `linkRatePct = runsWithReuse / completedRuns × 100`, where
  `runsWithReuse = COUNT(DISTINCT run_id)` over the C7 reuse filter.
- **Value:** The single most defensible "Coodra is actually being used as memory" KPI. KCS targets
  **60–80%**. Low = agents keep starting from zero; high = institutional memory is load-bearing.

### C10. Packs → decisions (knowledge-graph density)
- **What:** Count of Context Packs that explicitly link ≥1 Decision via their `meta.decisionIds`.
- **Formula:** for each `context_packs.meta` (JSON), parse and count rows where
  `decisionIds` is a non-empty array.
- **Value:** Cross-linked records form a navigable knowledge graph (a pack that cites the decisions
  behind it). Density of linkage = richer, more traceable memory.

### C11. Decision completeness (DIQ / AQI)
- **What:** The share of decisions that are *fully* recorded — rationale **and** ≥1 alternative
  **and** a confidence level.
- **Formula:** `decisionCompletenessPct = decisionsComplete / totalDecisions × 100`, where a decision
  is "complete" iff `rationale` is non-empty **and** `alternatives` parses to a non-empty array
  **and** `confidence` is set.
- **Value:** A Decision-IQ / Article-Quality-Index style quality score (target ≥90%). A decision with
  no alternatives or rationale is a weak record; this measures whether agents capture *good* decisions,
  not just *some*.

### C12. Knowledge captured (tokens)
- **What:** The size of the durable knowledge corpus, expressed in tokens.
- **Formula:** `assetContentChars / charsPerToken`, where `assetContentChars = SUM(LENGTH(content))`
  over context packs `+ SUM(LENGTH(description) + LENGTH(rationale))` over decisions, and
  `charsPerToken = 4`.
- **Class nuance:** the underlying chars are **measured**; the ÷4 conversion uses a model constant, so
  it is a light **estimate** (disclosed as "chars ÷ 4" in the web, "· est · chars ÷ 4" in the CLI).
- **Value:** How much reusable institutional knowledge has been banked — the corpus that future
  sessions can draw on instead of re-deriving.

### C13. Average asset age · Staleness
- **What:** Mean age (days) of all knowledge assets, and the % older than the review cadence.
- **Formula:** `avgAssetAgeDays = mean(now − created_at)` over packs+decisions;
  `stalePct = (count where age > STALE_AFTER_DAYS=90) / total × 100`.
- **Value:** Content-freshness guard (KCS staleness). Old, never-revisited decisions/packs may have
  drifted from reality; a rising stale% flags knowledge that needs review.

### C14. Author concentration (bus-factor)
- **What:** The share of attributed knowledge assets authored by the single most-prolific contributor.
- **Formula:** group packs+decisions by `created_by_user_id` (non-null); `topAuthorShare =
  max(per-author count) / sum(attributed counts) × 100`. Solo mode (no human author ids) → "solo".
- **Value:** Quantified "bus factor" — if 90% of knowledge comes from one person, the institutional
  memory is fragile. A team signal (needs the team-mode `created_by_user_id` attribution).

---

## 4. Dimension D — Efficiency & ROI `◐ modeled`

The financial layer. **Every number here is modeled** from the measured counts above × the
assumptions in §5, priced with the Anthropic rate card, and shown as a conservative–base–optimistic
band. The web shows the lever breakdown + the scenario band; the **Evidence** section prints the
literal `value = count × constant` derivation for each.

### The four token levers (modeled)

Let `runs = totalRuns`, `reuse = reuseReads`, `calls = toolCalls`, `blocks = blockedActions`, and the
constants from §5 (base case: `discovery=12,000`, `prefix=4,000`, `rederiv=6,000`, `runaway=40,000`).

#### D-tokens-1. Context-compression tokens saved
- **What:** Tokens *not* spent re-discovering project context, because Coodra injects a focused pack
  at session start instead of the agent re-reading the codebase.
- **Formula:** `runs × max(0, discovery − prefix)` = `runs × (12,000 − 4,000)` = `runs × 8,000`.
- **Value:** The biggest structural saving — a focused pack vs. naive whole-repo re-reading, per run.

#### D-tokens-2. Re-derivation tokens saved (reuse)
- **What:** Tokens *not* spent re-deriving prior knowledge, because the agent recalled it.
- **Formula:** `reuse × rederiv` = `reuseReads × 6,000`.
- **Value:** The direct payoff of reuse reads (C7) — recalling a decision/pack instead of re-figuring
  it out.

#### D-tokens-3. Prompt-cache tokens saved (net)
- **What:** Input-token-equivalent saved because the stable injected prefix is re-read from the
  provider's prompt cache (billed at 0.1× input) instead of full price each turn — net of the one-time
  cache-write premium (1.25×) per session.
- **Formula:**
  `cachedTurns = max(0, calls − runs)`
  `gross = cachedTurns × prefix × (1 − cacheRead/input)` = `cachedTurns × 4,000 × 0.9`
  `writePenalty = runs × prefix × (cacheWrite/input − 1)` = `runs × 4,000 × 0.25`
  `cacheTokens = max(0, gross − writePenalty)`.
- **Value:** Coodra puts a stable prefix (pack + history) at the front of the prompt, which is exactly
  what makes prompt caching pay off across a multi-turn session. Uses the real Anthropic cache
  multipliers (read 0.1×, 5-min write 1.25×).

#### D-tokens-4. Runaway-loop tokens prevented
- **What:** Tokens a blocked runaway/unsafe action would have burned before a human noticed.
- **Formula:** `blocks × runaway` = `blockedActions × 40,000`.
- **Value:** Turns governance (B2) into a token saving — aborting a loop after 1 block instead of 50
  iterations.

**Tokens saved (total)** = sum of the four levers above.

### D-credits. Credits saved (USD)
- **What:** The four token levers priced in dollars.
- **Formula:** each lever's tokens `÷ 1,000,000 × input_rate`; for Opus the input rate is **$5.00/MTok**.
  `creditsSaved = (compression + reuse + cache + loop tokens) / 1e6 × $5`.
- **Value:** The direct API-spend Coodra avoided.

### D2. Developer time reclaimed
- **What:** Developer focus-hours saved by avoiding re-derivation and manual cleanup, in hours and dollars.
- **Formula:**
  `minutes = reuse × minPerReuse + blocks × minPerBlock` = `reuse × 12 + blocks × 15`
  `hours = minutes / 60`; `usd = hours × hourlyRate` = `hours × $78`.
- **Value:** The human-time half of ROI. Anchored on the *programmer-specific* Parnin & Rugaber
  interruption research (10–15 min to resume a task), **not** the popular-but-unsourced "23 minutes"
  figure; dollarized at the DX (getDX) fully-loaded default of $78/hr. Reads `0h / $0` honestly when
  there are no reuse reads or blocks yet.

### D3. Authoring investment (the cost denominator)
- **What:** The human/agent effort spent *creating* the knowledge — the cost side of ROI (TVO honesty:
  count the investment, not just the savings).
- **Formula:** `assetsAuthored × minPerAsset / 60 × hourlyRate`, where
  `assetsAuthored = agentAuthoredPacks + decisions`, `minPerAsset = 6`, `hourlyRate = $78`.
- **Value:** Without a cost denominator, "savings" are meaningless. Only agent-authored packs +
  decisions count (auto-summaries are free).

### The four ROI primitives (the headline math)

Let `benefit = creditsSaved + timeReclaimedUsd` and `cost = authoringUsd`.

| KPI | Formula | Meaning |
|---|---|---|
| **D-roi-1. Net value** (north star) | `benefit − cost` | Total dollars Coodra delivered, net of what it cost to author the knowledge. |
| **D-roi-2. Benefit-cost ratio (BCR)** | `benefit / cost` (null if cost=0) | Every $1 of authoring effort returned $X. >1 = net positive. |
| **D-roi-3. ROI %** | `(net value / cost) × 100` (null if cost=0) | Standard return percentage. |
| **D-roi-4. Scenario band** | net value computed under the conservative (×0.5), base (×1.0), and optimistic (×1.5) constant sets | The honest range — never a lone point estimate (Forrester-TEI posture). |

- **Value:** Net Value is the dashboard's **north-star** — one number that maps to realized value and
  moves when you change assumptions or do more work. BCR/ROI%/band make it credible to a skeptical
  reader: the cost denominator is shown, and the answer is a range, not a single hero number.

---

## 5. The model constants (assumptions) — every one, with its source

These live in `packages/shared/src/roi/constants.ts` as `DEFAULT_ROI_CONSTANTS`, are deliberately
**conservative**, and are overridable. The web **Assumptions & Methodology** panel and the CLI footer
print them; the **Evidence** section shows each one inside its formula.

| Constant | Default | What it drives | Source / basis |
|---|---|---|---|
| `modelKey` | `opus` | Which rate card prices the credits | Anthropic published pricing |
| Model rate card (Opus) | in $5.00 / out $25.00 / cache-read $0.50 / cache-write-5m $6.25 per MTok | All credit figures | Anthropic pricing, verified 2026-06-21 |
| Cache multipliers | read **0.1×**, 5-min write **1.25×** | Prompt-cache lever | Anthropic prompt-caching docs |
| `charsPerToken` | `4` | Knowledge-captured tokens | ~4 chars/token English/code heuristic |
| `baselineDiscoveryTokensPerSession` | `12,000` | Compression lever | Estimate (Cursor smart-context ~10–15k/turn); tune per repo |
| `injectedPrefixTokens` | `4,000` | Compression + cache levers | Estimate of a focused pack's size |
| `rederivationTokensPerReuse` | `6,000` | Reuse lever | Estimate; tune per repo |
| `runawayTokensPerBlock` | `40,000` | Loop-prevention lever | Estimate of a runaway's burn before a human notices |
| `minutesReclaimedPerReuse` | `12` | Time reclaimed | Parnin & Rugaber (10–15 min to resume) |
| `minutesReclaimedPerBlock` | `15` | Time reclaimed | van Solingen (~15 min interruption recovery) |
| `blendedHourlyUsd` | `78` | Time reclaimed + authoring cost | DX (getDX): $150k/yr ≈ $78/hr fully-loaded |
| `minutesPerAssetAuthored` | `6` | Authoring investment | Estimate of effort per pack/decision |
| Scenario factors | conservative `0.5` · base `1.0` · optimistic `1.5` | The band (applied to the **benefit** constants only; cost-side stays fixed) | Forrester-TEI scenario practice |

**Other Claude rate cards** (selectable via `modelKey`): Sonnet (in $3 / out $15 / cache-read $0.30),
Haiku (in $1 / out $5 / cache-read $0.10), Fable (in $10 / out $50 / cache-read $1.00).

**Sources** (also linked in the dashboard's Assumptions panel):
Anthropic pricing & prompt-caching · Parnin & Rugaber (ICPC'09) · DX/getDX AI-ROI methodology ·
Forrester Total Economic Impact · KCS Glossary of Measurements.

---

## 6. Worked example (end-to-end, using a real snapshot)

Snapshot inputs (measured): `runs = 36`, `completed = 17`, `toolCalls = 3,801`, `reuse = 0`,
`blocks = 0`, `agentPacks = 3`, `decisions = 2`, base constants (Opus).

**Token levers**
- Compression = `36 × (12,000 − 4,000)` = **288,000**
- Reuse = `0 × 6,000` = **0**
- Cache: `cachedTurns = 3,801 − 36 = 3,765`; `gross = 3,765 × 4,000 × 0.9 = 13,554,000`;
  `writePenalty = 36 × 4,000 × 0.25 = 36,000`; cache = **13,518,000**
- Loop = `0 × 40,000` = **0**
- **Tokens saved (total) = 13,806,000 ≈ 13.81M**

**Credits** (at $5/MTok): `288,000/1e6×5 = $1.44` + `13,518,000/1e6×5 = $67.59` = **$69.03**

**Time reclaimed**: `0 reuse × 12 + 0 blocks × 15 = 0 min` → **0 h → $0** (honest: no reuse/blocks yet)

**Authoring investment**: `(3 + 2) assets × 6 min / 60 × $78 = 0.5 h × $78` = **$39.00**

**ROI primitives**
- Benefit = `$69.03 + $0` = **$69.03**
- **Net value = $69.03 − $39.00 = $30.03**
- **BCR = 69.03 / 39.00 = 1.77×**
- **ROI % = 30.03 / 39.00 × 100 = 77%**
- Scenario band (×0.5 / ×1.5 on benefit constants): **$28.95 (conservative) – $31.11 (optimistic)**

Every one of these appears on the dashboard exactly as derived here — and the **Evidence** section
prints the `count × constant` line next to each.

---

## 7. Data sources — measured vs. modeled at a glance

| KPI(s) | Class | Source table(s) / column(s) |
|---|---|---|
| Runs, completed/in-progress/cancelled, active projects, agent mix, runs trend | measured | `runs` (status, agent_type, project_id, started_at) |
| Tool calls | measured | `run_events` |
| Reuse reads, reuse-by-tool, runs-with-reuse, link rate | measured | `run_events` (phase='mcp_call', tool_name ∈ reuse set), `runs` |
| Governed / blocked / ask | measured | `policy_decisions` (permission_decision) |
| Active kill switches | measured | `kill_switches` (resumed_at, expires_at) |
| Context packs (+ source split), packs→decisions, knowledge-captured chars | measured | `context_packs` (source, meta, content) |
| Decisions, completeness | measured | `decisions` (rationale, alternatives, confidence) |
| Feature packs / features / wikis / wiki pages | measured | `feature_packs`, `features`, `wikis`, `wiki_pages` |
| Asset freshness, author concentration | measured | `context_packs` + `decisions` (created_at, created_by_user_id) |
| Tokens saved, credits saved, time reclaimed, authoring cost, net value, BCR, ROI %, band | **modeled** | the measured counts above × `@coodra/shared/roi` constants |

All queries are **dual-dialect** (local SQLite in solo / local-team; cloud Postgres in team-hosted)
and branch on `handle.kind`. Web and CLI compute the modeled layer from the **same** `@coodra/shared/roi`
functions, so the numbers always match.

---

## 8. Honest limitations (read before quoting a number)

- **Modeled ≠ measured.** Token/credit/time/$ figures are estimates with a stated band, not invoices.
  They are only as good as the constants in §5 — tune them to your team and re-state.
- **Counters that start "now."** Reuse reads (C7–C9) accrue only as agents follow the updated trigger
  contract (passing `runId` on reuse reads); there is no retroactive reuse history. On a fresh setup
  these read `0` ("capture armed") — that is honest, not a bug.
- **Capabilities that may read zero.** Blocked actions (B2) and any line-change output are real
  capabilities that show `0`/empty until they occur on your machine — shown plainly, never faked.
- **Scope.** The dashboard aggregates the store it reads: solo/local-team read this machine's local
  SQLite (single org); a true cross-teammate org rollup requires the team-hosted web (cloud Postgres)
  with an `org_id` scope. `run_diffs` and `policy_decisions` do not fully team-sync, so a cross-team
  view can under-count those.
- **Counterfactual honesty.** "Time reclaimed" and "tokens saved" are *vs. what would have happened
  without Coodra* — a counterfactual the run data can't observe directly. Treat them as a transparent
  model (assumptions shown), not a measurement, until validated against a before/after or A/B baseline.

---

*Generated 2026-06-21. KPI definitions track the shipped code; if a formula here disagrees with
`@coodra/shared/roi` or `apps/web-v2/lib/queries/roi.ts`, the code is the source of truth — update
this doc in the same change.*
