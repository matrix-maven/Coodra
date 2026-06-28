# Coodra ROI and Metrics Architecture: Measuring Agent Value

This document outlines the strategy, KPIs, metrics, and technical architecture for measuring the Return on Investment (ROI) and overall business value of Coodra.

> [!IMPORTANT]
> **Status (2026-06-21): SHIPPED — with one load-bearing correction.** The ROI/value dashboard
> was built and is live at `/roi` (web) and `coodra roi` (CLI). The **§3 "Telemetry & Collection
> Architecture" proposal below (the `run_telemetry` table + `input_tokens`/`cost` columns on `runs`)
> was deliberately NOT built.** No token/cost/cache telemetry exists anywhere in Coodra, and Claude
> Code's hooks do not expose token usage to the bridge — so that table would have stored *estimates
> dressed up as measured facts*, which `essentialsforclaude/01-development-discipline.md §1.1`
> forbids. Instead the shipped design draws a hard **measured-vs-modeled** line: real counts
> (runs, decisions, packs, reuse-read `mcp_call` events, policy decisions) are measured and stated
> plainly; token/credit/time dollars are **MODELED** from those counts × transparent, *cited*,
> configurable constants and badged "◐ modeled". The flagship "knowledge reuse" KPI was made real by
> instrumenting the reuse-read MCP tools to accept an optional `runId` (so the registry's existing
> `mcp_call` audit hook records the consultation). **Do NOT build the §3 telemetry table.** Treat
> §3/§5 below as the original *aspiration*; the authoritative record of what shipped (and the honest
> KPI catalogue + the `@coodra/shared/roi` model) is `docs/context-packs/2026-06-21-roi-value-dashboard.md`.

---

## 1. Executive Summary & The ROI Challenge

AI coding assistants and autonomous agents (like Claude Code, Cursor, and Windsurf) represent a massive shift in engineering velocity. However, their cost structure is volatile, and measuring their business value is notoriously difficult.

### The Agent Cost Dilemma

```
[ Short Term: Investment Phase ]                     [ Long Term: Payoff Phase ]
• Writing Feature Packs                              • Instant onboarding of agents to modules
• Writing Context Packs (Narratives)                 • Fast, context-aware bug fixes
• Recording architectural decisions                  • Near-100% prompt cache hit rates
• Evaluating policy rules (high latency overhead)    • 90% reduction in token cost per turn
───────────────────────────────────────────────────► ──────────────────────────────────────────────────►
                   Credit Consumption                                   Value & Credit Savings
                   (Sucks up credits)                                   (Saves credits & time)
```

In the **short term**, Coodra consumes credits and human effort:
1. It prompts the agent to write **Feature Packs** and **Context Packs**.
2. It logs **Decision Records**, adding context overhead to the current session.
3. It intercepts tool uses to evaluate **Policies**, adding minimal latency and write logs.

In the **long term**, this upfront investment yields massive savings:
1. **Reduced Context Bloat**: Instead of an agent re-reading the entire codebase or scanning hundreds of files to understand a module (which burns thousands of tokens every single turn), the agent gets a focused **Feature Pack** (~2-5k tokens) at session start.
2. **Context Caching (Prompt Caching)**: Because Coodra injects the stable Feature Pack and historical Context Packs at the *very beginning* of the session, subsequent turns achieve **up to 90% prompt cache hit rates**.
3. **Fewer Iteration Turns**: Accurate cross-session memory means the agent doesn't spend 5-10 turns "re-discovering" how the codebase works or why a decision was made. It solves tasks in 2-3 turns.
4. **Policy Guardrails**: Blocking unauthorized or destructive commands prevents runaway loops (which can cost $100+ in API credits in minutes) and avoids manual rollbacks or code refactoring.

This report establishes the **CORE Framework (Coodra ROI & Efficiency)** to quantify these dynamics and prove Coodra's value.

---

## 2. The CORE Framework: 4-Dimensional Metrics & KPIs

We propose a four-dimensional metrics framework to measure Coodra's ROI.

### CORE Dimensions at a Glance

| Dimension | Core Question | Primary KPIs |
|---|---|---|
| **1. Token & Credit Optimization** | How much direct API spend did Coodra save? | • Prompt Cache Hit Rate<br>• Input Token Compression Ratio<br>• Credit Savings ($) |
| **2. Engineering Velocity** | How much developer time was reclaimed? | • Mean Turns to Complete (MTTC)<br>• Success-on-First-Attempt (SOFA) Rate<br>• Cognitive Interruptions Avoided |
| **3. Knowledge Capitalization** | How much institutional memory was retained? | • Decision Re-use Count (DRC)<br>• Cross-Session Memory Hit Rate<br>• Knowledge Density Index |
| **4. Risk & Safety Guardrails** | What disasters and cost spikes were prevented? | • Unsafe Actions Blocked<br>• Infinite Loop Aborts<br>• Engineering Hours saved from Rollbacks |

---

### Dimension 1: Token & Credit Optimization (Credits Saved)

This dimension measures direct dollar savings on LLM API tokens.

#### A. Prompt Cache Hit Rate (PCHR)
*   **Definition**: The percentage of prompt tokens read from the LLM provider's cache.
*   **Mechanism**: Coodra injects Feature Packs and Context Packs as static prefixes at session start. Since this prefix remains identical across a multi-turn conversation, subsequent turns result in near-100% cache hits.
*   **Formula**:
    $$\text{PCHR} = \left( \frac{\text{Cached Input Tokens}}{\text{Total Input Tokens}} \right) \times 100$$
*   **Target**: $> 85\%$ for sessions with $> 3$ turns.

#### B. Input Token Compression Ratio (ITCR)
*   **Definition**: The reduction in context size from using targeted Feature/Context Packs versus a naive agent scanning the codebase.
*   **Formula**:
    $$\text{ITCR} = \frac{\text{Est. Codebase/Module Tokens Search Size}}{\text{Coodra Injected Pack Size (Tokens)}}$$
*   **Target**: $> 10\text{x}$ compression (e.g., loading a $3,000$ token Feature Pack instead of an agent traversing $30,000$ tokens of raw file structure).

#### C. Monthly Credit Savings ($)
*   **Definition**: Direct financial savings from Prompt Caching discounts (typically 90% off for cache hits on Anthropic) and context compression.
*   **Formula**:
    $$\text{Savings} = \sum \left( \text{Uncached Cost Baseline} - \text{Coodra Cost} \right)$$
    *Where Uncached Cost Baseline assumes all tokens are read uncached, and Coodra Cost accounts for cache-write premiums and cache-read discounts.*

---

### Dimension 2: Engineering Velocity (Time Saved)

This dimension measures the efficiency of the human-agent pair.

#### A. Mean Turns to Complete (MTTC)
*   **Definition**: The average number of model calls (turns) needed to resolve an issue or implement a feature.
*   **Value**: Without memory, agents waste turns exploring, failing tests, and adjusting. With Coodra, they proceed directly to the correct implementation.
*   **Formula**:
    $$\text{MTTC} = \frac{\sum \text{Total Turns in Session}}{\text{Total Completed Sessions}}$$
*   **Target**: Reduction of $30\%$ in MTTC compared to baseline agents without Coodra.

#### B. Success-on-First-Attempt (SOFA) Rate
*   **Definition**: The percentage of agent runs that successfully complete their goal (tests passing, PR opened) without requiring the user to reset the git tree, roll back files, or restart the session.
*   **Target**: $> 80\%$ of runs.

#### C. Cognitive Interruptions Reclaimed
*   **Definition**: The estimated number of times the human did *not* have to type a correction to guide the agent back to project conventions or explain architectural decisions.
*   **Value**: Evaluated as developer focus hours saved.
*   **Formula**:
    $$\text{Hours Reclaimed} = \text{Interruptions Avoided} \times 5 \text{ mins (Context Switch Penalty)}$$

---

### Dimension 3: Knowledge Capitalization (Memory Worth)

This dimension measures the growth and utility of the codebase's "agent memory."

#### A. Decision Re-use Count (DRC)
*   **Definition**: The number of times the agent queried the `decisions` table via `query_decisions` and successfully cited a recorded decision in its plan or source code comments.
*   **Value**: Proves that documenting architecture decisions (ADRs) automatically prevents duplicate debates and architecture drift.

#### B. Cross-Session Memory Hit Rate
*   **Definition**: The percentage of sessions where the agent successfully retrieved and used a Context Pack from a previous run (via `search_packs_nl` or `read_context_pack`).
*   **Formula**:
    $$\text{Memory Hit Rate} = \left( \frac{\text{Sessions referencing prior packs}}{\text{Total Sessions}} \right) \times 100$$

#### C. Codebase Knowledge Density (CKD)
*   **Definition**: The ratio of structured agent-friendly files to raw codebase size.
*   **Formula**:
    $$\text{CKD} = \frac{\text{Number of Active Feature Packs} + \text{Number of Context Packs}}{\text{Total Files in Codebase}}$$

---

### Dimension 4: Risk & Safety Guardrails (Risk Avoided)

This dimension measures the value of policies protecting the filesystem and API budget.

#### A. Policy Violations Blocked (PVB)
*   **Definition**: The number of times the Hooks Bridge blocked a tool use (e.g., write file, execute bash) because it violated a policy rule.
*   **Value**: Prevents security leaks, overwriting critical files (like `.github/workflows`), and running destructive bash commands.

#### B. Runaway Loop Aborts (RLA)
*   **Definition**: The number of times Coodra detected and terminated an infinite loop (e.g., the agent repeatedly attempting to write the same failing code or retrying a build command).
*   **Value**: Aborting a runaway agent after 5 loops instead of 50 saves massive API credits.
*   **Estimated Savings**:
    $$\text{Loop Savings} = (\text{Loops Prevented}) \times (\text{Average Context Size} \times \text{Token Cost})$$

#### C. Rollback Time Avoided (RTA)
*   **Definition**: Estimated engineering time saved by not having to manually repair a codebase that was corrupted or left in an inconsistent state by an agent.
*   **Value**: Assumes every blocked policy violation or loop abort would have required 15 minutes of manual cleanup/git reset.

---

## 3. Telemetry & Collection Architecture

To calculate these KPIs, Coodra needs a lightweight, privacy-respecting telemetry layer. This layer intercepts events during the agent's life cycle and records them.

### Telemetry Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                           Agent Client                           │
│                     (Claude Code / Cursor)                       │
└──────┬────────────────────────────────────────────────────▲──────┘
       │                                                    │
       │ 1. Hook Events                                     │ 4. Context Packs,
       │    (SessionStart, PreToolUse,                      │    Feature Packs,
       │     PostToolUse, SessionEnd)                       │    Decisions
       ▼                                                    │
┌──────────────────────────────┐                    ┌───────┴──────┐
│         Hooks Bridge         ├───────────────────►│  MCP Server  │
│         (Port 3101)          │ 2. Evaluate Policy│ (Port 3100)  │
└──────┬───────────────────────┘                    └──────┬───────┘
       │                                                   │
       │ 3. Log Telemetry (tokens, blocks, duration)       │ 3. Log Queries
       ▼                                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│                       Local Database (SQLite)                    │
│   • runs          • policy_decisions      • run_telemetry (NEW)  │
└──────┬───────────────────────────────────────────────────────────┘
       │
       │ 5. Asynchronous Sync (Team Mode)
       ▼
┌──────────────────────────────────────────────────────────────────┐
│                       Shared Postgres DB                         │
│                    (Team Dashboard Surface)                      │
└──────────────────────────────────────────────────────────────────┘
```

---

### Database Schema Extensions

To store telemetry data, we propose adding a new `run_telemetry` table and extending `runs` and `policy_decisions`.

```sql
-- SQLite Schema Extensions (packages/db/src/schema/sqlite.ts)

-- 1. Extend the 'runs' table to track token costs and counts
ALTER TABLE runs ADD COLUMN input_tokens INTEGER;
ALTER TABLE runs ADD COLUMN output_tokens INTEGER;
ALTER TABLE runs ADD COLUMN cached_input_tokens INTEGER;
ALTER TABLE runs ADD COLUMN est_cost_usd REAL;
ALTER TABLE runs ADD COLUMN turns_count INTEGER DEFAULT 0;

-- 2. Create a new 'run_telemetry' table for detailed step tracking
CREATE TABLE run_telemetry (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,          -- 'session_start', 'tool_use', 'session_end'
  tool_name TEXT,                    -- null if not a tool
  input_size_bytes INTEGER NOT NULL,  -- size of context/payload passed
  output_size_bytes INTEGER,         -- size of response/outcome
  cache_hit BOOLEAN DEFAULT false,   -- was prompt cache hit indicated?
  duration_ms INTEGER,               -- tool execution duration
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX run_telemetry_run_idx ON run_telemetry(run_id);

-- 3. Extend 'policy_decisions' to log estimated costs prevented
ALTER TABLE policy_decisions ADD COLUMN is_terminal_block BOOLEAN DEFAULT false;
```

> [!NOTE]
> The same schema modifications should be mirrored in Drizzle for Postgres (`packages/db/src/schema/postgres.ts`) to ensure team-mode synchronization functions correctly.

---

### Data Collection Hook Points

We hook into Coodra's existing lifecycle to populate these metrics:

1.  **SessionStart Hook (`apps/hooks-bridge/src/handlers/session-start.ts`)**:
    *   Initialize the `runs` telemetry fields.
    *   Record the token size of the injected **Feature Pack** (calculated via a fast local tokenizer like `gpt-3-encoder` or a simple character-to-token ratio of 4 chars = 1 token).
    *   Mark this initial block as **Cache Write**.

2.  **PreToolUse Hook (`apps/hooks-bridge/src/handlers/pre-tool-use.ts`)**:
    *   If a policy blocks the action, increment the policy violation counter and record the **Policy Blocked** event.
    *   Measure payload size to estimate the context size at this turn.

3.  **PostToolUse Hook (`apps/hooks-bridge/src/handlers/post-tool-use.ts`)**:
    *   Measure tool response size and execution time (`duration_ms`).
    *   Record a `run_telemetry` row for the tool execution.
    *   Estimate token consumption. Since the agent executes multi-turn conversations, every subsequent turn re-submits the history. We calculate:
        *   **Cached tokens**: Sum of Feature Pack size + preceding turns' size.
        *   **New tokens**: Size of the latest tool output + user response.

4.  **MCP Tool Calls (`apps/mcp-server/src/tools/...`)**:
    *   When the agent calls `query_decisions` or `search_packs_nl`, log a **Memory Reference** event.
    *   If the agent records a decision via `record_decision`, log a **Memory Asset Created** event.

5.  **SessionEnd Hook (`apps/hooks-bridge/src/handlers/session-end.ts`)**:
    *   Compute the final totals for `input_tokens`, `output_tokens`, `cached_input_tokens`, and `turns_count`.
    *   Calculate `est_cost_usd` based on the agent's model type (configured in `.coodra.json` or parsed from the system environment).
    *   Calculate final ROI numbers.

---

## 4. ROI Dashboard Design (Next.js 15 Admin UI)

Coodra's web interface (`apps/web-v2`) will expose these metrics in a premium, high-impact dashboard.

### Dashboard Layout Mockup

```
┌────────────────────────────────────────────────────────────────────────┐
│  COODRA  │  Projects  │  Policies  │  Context Packs  │  ROI Dashboard  │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  ROI Summary (Last 30 Days)                                            │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐      │
│  │   Credits Saved  │  │  Developer Hours │  │   Risk Avoided   │      │
│  │     $412.50      │  │      24.5 hrs    │  │    18 Actions    │      │
│  │   +15% vs last mo│  │   Saved on loops │  │  Blocked by rule │      │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘      │
│                                                                        │
│  Efficiency & Cache Analytics                                          │
│  ┌────────────────────────────────────────────────────────┐            │
│  │ Prompt Cache Hit Rate                                 │            │
│  │ [██████████████████████████████████░░░░░░] 85.2% Hit   │            │
│  │ (Saved 1,420,000 redundant context tokens this month)  │            │
│  └────────────────────────────────────────────────────────┘            │
│                                                                        │
│  Knowledge Asset Valuation                                             │
│  • Feature Packs Active: 12 (Ingesting specs at session start)         │
│  • Context Packs Saved: 84 (Avoiding "starting from scratch" loops)    │
│  • Architecture Decisions Reused: 142 times this month                 │
│                                                                        │
│  Blocked Incident Log                                                  │
│  • [Blocked] Write to .github/workflows/ci.yml (Policy: Protect CI)    │
│  • [Aborted] Write loop on src/index.ts (Reason: 5 duplicate writes)  │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### Visual Styling Guidelines (Aesthetics)
To match Coodra's sleek design guidelines:
- **Color Palette**: Dark mode primary, using deep slate background (`#0B0F19`), vibrant emerald green for savings (`#10B981`), and neon purple accents for agent activity (`#8B5CF6`).
- **Micro-Animations**: Hover transitions on the KPI cards (slight scale and box-shadow glow), and animated progress bars for prompt cache rates.
- **Dynamic Charts**: Use lightweight responsive SVG charts for monthly savings trends.

---

## 5. ROI Formulas & Financial Model

Below is the mathematical framework for calculating Coodra's financial returns.

### The Financial Model Parameters

Let:
- $T_i$ = Input token cost (per million tokens). E.g., for Claude 3.5 Sonnet, $T_i = \$3.00$.
- $T_c$ = Cached input token cost (per million tokens). E.g., for Claude 3.5 Sonnet, $T_c = \$0.30$.
- $T_o$ = Output token cost (per million tokens). E.g., for Claude 3.5 Sonnet, $T_o = \$15.00$.
- $H$ = Developer hourly rate (blended average, e.g., $\$75.00/\text{hr}$).
- $C_{base}$ = Average context size read by a naive agent without Coodra per turn (in millions of tokens).
- $C_{coodra}$ = Average context size read by Coodra per turn (in millions of tokens).
- $N$ = Number of turns in a session.
- $S$ = Number of sessions in a month.

---

### Formula 1: Context Size Savings (Token Reduction)

Without Coodra, the agent reads files recursively to find context. With Coodra, it loads a compact Feature Pack prefix.

$$\text{Context Size Savings} = S \times N \times (C_{base} - C_{coodra}) \times T_i$$

*Example*:
- $S = 500$ sessions/month.
- $N = 8$ turns/session average.
- $C_{base} = 30,000$ tokens ($0.03\text{M}$).
- $C_{coodra} = 5,000$ tokens ($0.005\text{M}$).
- $T_i = \$3.00/\text{M}$ tokens.

$$\text{Savings} = 500 \times 8 \times (0.03 - 0.005) \times \$3.00 = 4,000 \times 0.025 \times \$3.00 = \$300.00/\text{month}$$

---

### Formula 2: Prompt Caching Savings (Hit Discount)

With Coodra's static prefixing, the cached portion of the context is billed at the discounted rate ($T_c$) instead of the full rate ($T_i$). Let $P_c$ be the size of the cached context pack (in millions of tokens).

$$\text{Cache Savings} = S \times (N-1) \times P_c \times (T_i - T_c)$$

*Example*:
- $S = 500$ sessions/month.
- $N = 8$ turns/session (so $7$ turns benefit from caching).
- $P_c = 15,000$ tokens ($0.015\text{M}$ Feature/Context Pack size).
- $T_i = \$3.00/\text{M}$, $T_c = \$0.30/\text{M}$ (saving $\$2.70/\text{M}$).

$$\text{Savings} = 500 \times 7 \times 0.015 \times \$2.70 = 3,500 \times 0.015 \times \$2.70 = \$141.75/\text{month}$$

---

### Formula 3: Developer Time Reclaimed (Cognitive Value)

Let $I$ be the number of context-explanation interruptions avoided per month, and $L$ be the number of loop aborts/manual rollbacks avoided.

$$\text{Developer Time Reclaimed ($)} = \left( I \times \frac{5}{60} + L \times \frac{15}{60} \right) \times H$$

*Example*:
- $I = 150$ interruptions avoided (the agent read a Feature Pack and followed conventions automatically).
- $L = 30$ rollbacks/loops prevented.
- $H = \$75.00/\text{hr}$.

$$\text{Time Reclaimed} = \left( 150 \times 0.083 + 30 \times 0.25 \right) \times \$75.00 = (12.5 + 7.5) \times \$75.00 = \$1,500.00/\text{month}$$

---

### Total Monthly ROI Summary (10-Dev Team Example)

| Expense / Saving Category | Monthly Cost / Value | Description |
|---|---|---|
| **Upfront Context Authoring Cost** | $-\$225.00$ | 3 hours of dev time to write/verify Feature Packs ($75/hr) |
| **Token Cost Savings** | $+\$441.75$ | Combined token size reduction and prompt caching discounts |
| **Developer Focus Reclaimed** | $+\$1,500.00$ | Avoided context switches and manual git rollbacks |
| **Net Monthly Savings** | **$+\$1,716.75** | **Net positive ROI in month 1** |

---

## 6. Implementation Action Plan

To implement this telemetry and ROI framework in Coodra:

1.  **Phase 1: DB Migration (SQLite & Postgres)**
    *   Apply the migrations extending `runs`, `policy_decisions`, and creating `run_telemetry`.
2.  **Phase 2: Hooks Bridge Instrumentation**
    *   Update Hono handlers in `apps/hooks-bridge/src/handlers/` to capture payload sizes and log them to SQLite.
3.  **Phase 3: MCP Telemetry Tracking**
    *   Update `save_context_pack` and `record_decision` tools to increment the knowledge asset counts.
4.  **Phase 4: ROI Dashboard in Web UI**
    *   Add a new `/projects/[slug]/roi` route in `apps/web-v2`. Build interactive dashboard cards using the Drizzle metrics queries.
5.  **Phase 5: Sync Daemon Integration**
    *   Update `apps/sync-daemon` to sync the telemetry table to the Postgres database for team-level reports.
