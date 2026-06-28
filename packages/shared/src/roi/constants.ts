/**
 * @coodra/shared/roi — model constants for the ROI / value dashboard.
 *
 * Every number here is a MODEL ASSUMPTION, not a measured fact. The
 * dashboard (`/roi`) and CLI (`coodra roi`) feed Coodra's REAL counts
 * (runs, decisions, context packs, reuse-read events, policy decisions)
 * into the pure functions in `./model.ts`, which multiply those counts
 * by the constants below to produce MODELED dollar/token estimates. The
 * UI badges every modeled number and links to a methodology panel that
 * surfaces these constants, their sources, and the formulas — so a
 * skeptical reader can change an assumption and watch the number move
 * (the structural answer to "is this fabricated?": no, it's a live
 * model you can interrogate).
 *
 * Sources are cited inline and aggregated in `ROI_SOURCES`. Pricing was
 * verified against Anthropic's published rate card on 2026-06-21; the
 * interruption-cost and developer-hourly defaults come from the
 * programmer-specific Parnin & Rugaber interruption study and the DX
 * (getDX) ROI methodology respectively (NOT the popular-but-unsourced
 * "23 minutes" figure). Re-verify pricing before relying on dollar
 * figures — model lineup and prices drift.
 */

/**
 * The `coodra__<tool>` names that count as a KNOWLEDGE-REUSE READ in
 * `run_events` (phase='mcp_call'). When the agent passes its `runId` to one
 * of these read tools (per the trigger contract), the MCP registry records
 * the call here — this is the durable signal that a run consciously consulted
 * prior knowledge instead of re-deriving it. The `/roi` dashboard and
 * `coodra roi` count `run_events WHERE phase='mcp_call' AND tool_name IN`
 * this set. Web + CLI MUST share this list so their reuse counts agree.
 *
 * This is EXACTLY the set of tools whose `runId` is *attribution of the
 * consulting run* — the run that did the reading. `read_context_pack` and
 * `query_decisions` are deliberately EXCLUDED: their `runId` is a
 * filter/lookup (the run being read ABOUT), so an mcp_call row from them
 * carries the read-about run's id, not the consulting run's — counting them
 * would mis-attribute reuse to the wrong run (adversarial-review finding,
 * 2026-06-21).
 */
export const REUSE_READ_TOOL_NAMES = [
  'coodra__search_packs_nl',
  'coodra__get_feature_pack',
  'coodra__list_context_packs',
  'coodra__get_feature',
  'coodra__query_run_history',
] as const;

/** Per-model API rate card, USD per million tokens (Claude API, standard tier, verified 2026-06-21). */
export interface ModelPricing {
  /** Base (uncached) input tokens. */
  readonly inputPerMTok: number;
  /** Output tokens. */
  readonly outputPerMTok: number;
  /** Cache READ / refresh — the discounted re-read of a cached prefix (0.1× base input). */
  readonly cacheReadPerMTok: number;
  /** 5-minute cache WRITE — the one-time premium to establish a cached prefix (1.25× base input). */
  readonly cacheWrite5mPerMTok: number;
}

/**
 * Anthropic Claude API rate card (USD / MTok), verified 2026-06-21 against
 * https://platform.claude.com/docs/en/about-claude/pricing.
 * Cache multipliers are provider-stable: 5-min write = 1.25× input,
 * read = 0.1× input.
 */
export const MODEL_PRICING = {
  opus: { inputPerMTok: 5.0, outputPerMTok: 25.0, cacheReadPerMTok: 0.5, cacheWrite5mPerMTok: 6.25 },
  sonnet: { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheReadPerMTok: 0.3, cacheWrite5mPerMTok: 3.75 },
  haiku: { inputPerMTok: 1.0, outputPerMTok: 5.0, cacheReadPerMTok: 0.1, cacheWrite5mPerMTok: 1.25 },
  fable: { inputPerMTok: 10.0, outputPerMTok: 50.0, cacheReadPerMTok: 1.0, cacheWrite5mPerMTok: 12.5 },
} as const satisfies Record<string, ModelPricing>;

export type ModelKey = keyof typeof MODEL_PRICING;

/** Provider-stable cache multipliers relative to base input price (Anthropic). */
export const CACHE_READ_MULTIPLIER = 0.1 as const;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25 as const;

/**
 * The tunable assumptions behind every modeled number. All are overridable
 * (the web reads overrides from env / a future config table; the CLI accepts
 * flags). Defaults are intentionally CONSERVATIVE so the headline ROI is
 * defensible rather than impressive.
 */
export interface RoiConstants {
  /** Which model's rate card to price against. Default 'opus' (the tier Coodra's reference agent runs). */
  readonly modelKey: ModelKey;
  /** Characters per token for the cheap chars/N estimator (≈4 for English/code; widen for dense JSON). */
  readonly charsPerToken: number;

  // --- Context-compression lever (modeled) ---
  /**
   * Tokens a naive agent WITHOUT Coodra burns re-discovering project
   * context per session (scanning files, re-reading the tree). Coodra
   * replaces this with a focused injected pack. Cursor's "smart context"
   * truncates to ~10–15k tokens; naive whole-repo reads run higher. Default
   * is deliberately conservative.
   */
  readonly baselineDiscoveryTokensPerSession: number;
  /** Size of the stable injected Feature/Context-Pack prefix the agent reads instead (and that gets cached). */
  readonly injectedPrefixTokens: number;

  // --- Reuse / re-derivation lever (modeled) ---
  /**
   * Tokens avoided each time the agent consciously recalls a prior
   * decision / context pack (a reuse-read mcp_call) instead of
   * re-deriving the knowledge from scratch.
   */
  readonly rederivationTokensPerReuse: number;

  // --- Governance / runaway-loop lever (modeled) ---
  /** Tokens a single blocked runaway action (deny) would have burned before a human noticed. */
  readonly runawayTokensPerBlock: number;

  // --- Time-reclaimed lever (modeled; Parnin/van Solingen anchor) ---
  /** Minutes of developer focus reclaimed per reuse-read (avoided re-derivation + context rebuild). Parnin: 10–15 min to resume. */
  readonly minutesReclaimedPerReuse: number;
  /** Minutes reclaimed per blocked unsafe action (avoided manual git-reset / cleanup). */
  readonly minutesReclaimedPerBlock: number;
  /** Blended fully-loaded developer cost, USD/hour. DX (getDX) default: $150k/yr ≈ $78/hr. */
  readonly blendedHourlyUsd: number;

  // --- Cost denominator (TVO honesty: count the investment, not just the savings) ---
  /** Minutes of human/agent effort to author one knowledge asset (a context pack or decision). */
  readonly minutesPerAssetAuthored: number;
}

/**
 * Conservative-by-design defaults. Tuned low so the modeled ROI under-
 * promises. Editing any of these (web methodology panel / CLI flags)
 * recomputes every dependent figure.
 */
export const DEFAULT_ROI_CONSTANTS: RoiConstants = {
  modelKey: 'opus',
  charsPerToken: 4,
  baselineDiscoveryTokensPerSession: 12_000,
  injectedPrefixTokens: 4_000,
  rederivationTokensPerReuse: 6_000,
  runawayTokensPerBlock: 40_000,
  minutesReclaimedPerReuse: 12,
  minutesReclaimedPerBlock: 15,
  blendedHourlyUsd: 78,
  minutesPerAssetAuthored: 6,
};

/**
 * Scenario factors applied to the BENEFIT-side assumptions (the uncertain
 * levers) to produce the conservative / base / optimistic band. Cost-side
 * assumptions stay fixed so a worse scenario can never look cheaper to run.
 * Presenting a band (never a lone point estimate) is the Forrester-TEI /
 * AI-ROI best practice.
 */
export const SCENARIO_FACTORS = {
  conservative: 0.5,
  base: 1.0,
  optimistic: 1.5,
} as const;

export type ScenarioKey = keyof typeof SCENARIO_FACTORS;

/** Human-facing provenance for the methodology panel. */
export const ROI_SOURCES: ReadonlyArray<{ readonly label: string; readonly url: string }> = [
  {
    label: 'Anthropic API pricing (rate card, cache multipliers)',
    url: 'https://platform.claude.com/docs/en/about-claude/pricing',
  },
  {
    label: 'Anthropic — Prompt caching (0.1× read, 1.25× 5-min write)',
    url: 'https://www.anthropic.com/news/prompt-caching',
  },
  {
    label: 'Parnin & Rugaber — Resumption of interrupted programming tasks (10–15 min anchor)',
    url: 'https://chrisparnin.me/pdf/parnin-icpc09.pdf',
  },
  {
    label: 'DX (getDX) AI ROI methodology ($150k/yr ≈ $78/hr; hours×rate)',
    url: 'https://getdx.com/blog/ai-roi-calculator/',
  },
  {
    label: 'Forrester Total Economic Impact — risk-adjusted, scenario-banded ROI',
    url: 'https://www.forrester.com/policies/tei/',
  },
  {
    label: 'KCS (Consortium for Service Innovation) — Link Rate / Reuse Rate',
    url: 'https://library.serviceinnovation.org/KCS/KCS_v6/Measurement_Matters_v6/99_Glossary_of_Measurements',
  },
];
