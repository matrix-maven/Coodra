/**
 * @coodra/shared/roi/model — pure ROI calculation functions.
 *
 * NOTHING here reads a clock, a DB, or env. Callers (web `lib/queries/roi.ts`,
 * CLI `commands/metrics.ts`) gather Coodra's REAL counts into a
 * `RoiMeasuredInputs`, pass it here with optional constant overrides, and
 * render the returned `RoiResult` / `RoiBand`. Keeping this pure makes it
 * exhaustively unit-testable and keeps the "measured vs modeled" boundary
 * crisp: inputs are measured; outputs are modeled.
 */

import {
  DEFAULT_ROI_CONSTANTS,
  MODEL_PRICING,
  type ModelPricing,
  type RoiConstants,
  SCENARIO_FACTORS,
  type ScenarioKey,
} from './constants.js';

/**
 * The MEASURED counts the model consumes. Every field is a real number
 * read from Coodra's tables — no estimation happens before this struct.
 */
export interface RoiMeasuredInputs {
  /** runs rows (all). Each Coodra session injects a Feature Pack at start (Pattern 20) → the compression lever applies per run. */
  readonly totalRuns: number;
  /** runs with status='completed'. */
  readonly completedRuns: number;
  /** run_events rows (tool calls) — a turn/effort proxy; used for the per-turn cache lever. */
  readonly toolCalls: number;
  /** Reuse-read mcp_call events: agent consulted a prior decision/pack/feature instead of re-deriving (the instrumented read tools). */
  readonly reuseReads: number;
  /** Knowledge assets a human/agent authored — context packs + decisions (the investment denominator). */
  readonly assetsAuthored: number;
  /** policy_decisions rows total — every agent action that passed through policy enforcement (governed actions). */
  readonly governedActions: number;
  /** policy_decisions with permission_decision='deny' — runaway/unsafe actions blocked. */
  readonly blockedActions: number;
  /** Total characters of authored knowledge-asset content (context-pack + decision bodies), for the "knowledge captured (tokens)" stat. Optional. */
  readonly assetContentChars?: number;
}

/** Per-lever token breakdown (modeled). */
export interface RoiTokenBreakdown {
  /** Tokens saved by injecting a focused pack instead of re-discovering context, across all sessions. */
  readonly compression: number;
  /** Tokens saved by recalling prior knowledge instead of re-deriving it, across all reuse reads. */
  readonly reuse: number;
  /** Net input-token-equivalent saved by the cached stable prefix (read discount minus write premium). */
  readonly cache: number;
  /** Tokens a runaway loop would have burned, prevented by policy blocks. */
  readonly loopPrevented: number;
  readonly total: number;
}

/** Per-lever credit (USD) breakdown (modeled). */
export interface RoiCreditBreakdown {
  readonly compression: number;
  readonly reuse: number;
  readonly cache: number;
  readonly loopPrevented: number;
  readonly total: number;
}

/** The full modeled result for ONE scenario / constant set. */
export interface RoiResult {
  readonly tokensSaved: RoiTokenBreakdown;
  readonly creditsSavedUsd: RoiCreditBreakdown;
  readonly timeReclaimed: {
    readonly minutes: number;
    readonly hours: number;
    readonly usd: number;
  };
  readonly investment: {
    /** Hours spent authoring knowledge assets (the cost denominator). */
    readonly authoringHours: number;
    readonly authoringUsd: number;
  };
  /** Tokens of knowledge captured into durable assets (chars/N estimate); null when content size wasn't supplied. */
  readonly knowledgeCapturedTokens: number | null;
  // --- ROI primitives ---
  /** creditsSaved.total + timeReclaimed.usd. */
  readonly totalBenefitUsd: number;
  /** totalBenefitUsd − investment.authoringUsd. */
  readonly netValueUsd: number;
  /** totalBenefitUsd / investment.authoringUsd; null when no investment. */
  readonly benefitCostRatio: number | null;
  /** (netValueUsd / investment.authoringUsd) × 100; null when no investment. */
  readonly roiPct: number | null;
}

/** The conservative/base/optimistic band plus the inputs + base constants used. */
export interface RoiBand {
  readonly conservative: RoiResult;
  readonly base: RoiResult;
  readonly optimistic: RoiResult;
  readonly inputs: RoiMeasuredInputs;
  readonly constants: RoiConstants;
}

/** Cheap token estimate from a character count (chars / N). */
export function estimateTokensFromChars(chars: number, charsPerToken: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.round(chars / Math.max(1, charsPerToken));
}

function resolvePricing(constants: RoiConstants): ModelPricing {
  return MODEL_PRICING[constants.modelKey];
}

/** USD for a token count billed at a per-MTok rate. */
function tokensToUsd(tokens: number, perMTok: number): number {
  return (Math.max(0, tokens) / 1_000_000) * perMTok;
}

/**
 * Compute the modeled ROI for a single, fully-resolved constant set.
 * Every figure traces to (measured input × constant); see the methodology
 * rows in `buildMethodology` for the literal formulas surfaced in the UI.
 */
export function computeRoi(inputs: RoiMeasuredInputs, constants: RoiConstants = DEFAULT_ROI_CONSTANTS): RoiResult {
  const pricing = resolvePricing(constants);

  // --- Token levers ---
  // Compression: every session swaps ~baselineDiscovery tokens of re-reading
  // for a ~injectedPrefix-token focused pack. Net saved per session, ≥0.
  const perSessionCompression = Math.max(
    0,
    constants.baselineDiscoveryTokensPerSession - constants.injectedPrefixTokens,
  );
  const compressionTokens = inputs.totalRuns * perSessionCompression;

  // Reuse: each reuse-read avoids re-deriving prior knowledge.
  const reuseTokens = inputs.reuseReads * constants.rederivationTokensPerReuse;

  // Cache: the stable injected prefix is paid once per session at the write
  // premium, then re-read each subsequent turn at 0.1×. We express the lever
  // as input-token-equivalent SAVINGS (priced exactly below).
  //   cached turns ≈ toolCalls − runs (turns after the session's first).
  const cachedTurns = Math.max(0, inputs.toolCalls - inputs.totalRuns);
  // input-token-equivalent saved: each cached turn would have cost full input;
  // instead costs cacheRead. Saving fraction = (1 − cacheRead/input).
  const cacheSaveFraction = pricing.inputPerMTok > 0 ? 1 - pricing.cacheReadPerMTok / pricing.inputPerMTok : 0;
  const cacheTokensGross = cachedTurns * constants.injectedPrefixTokens * cacheSaveFraction;
  // write premium paid once per session, expressed in input-token-equivalent (negative saving).
  const writePremiumFraction = pricing.inputPerMTok > 0 ? pricing.cacheWrite5mPerMTok / pricing.inputPerMTok - 1 : 0;
  const cacheTokensWritePenalty = inputs.totalRuns * constants.injectedPrefixTokens * writePremiumFraction;
  const cacheTokens = Math.max(0, cacheTokensGross - cacheTokensWritePenalty);

  // Loop prevention: blocked runaway actions.
  const loopPreventedTokens = inputs.blockedActions * constants.runawayTokensPerBlock;

  const totalTokens = compressionTokens + reuseTokens + cacheTokens + loopPreventedTokens;

  // --- Credits (USD) — compression/reuse/loop tokens would have been billed
  // at the base INPUT rate; the cache lever is already input-equivalent. ---
  const compressionCredits = tokensToUsd(compressionTokens, pricing.inputPerMTok);
  const reuseCredits = tokensToUsd(reuseTokens, pricing.inputPerMTok);
  const cacheCredits = tokensToUsd(cacheTokens, pricing.inputPerMTok);
  const loopCredits = tokensToUsd(loopPreventedTokens, pricing.inputPerMTok);
  const totalCredits = compressionCredits + reuseCredits + cacheCredits + loopCredits;

  // --- Time reclaimed (Parnin/van Solingen minutes × DX hourly) ---
  const minutes =
    inputs.reuseReads * constants.minutesReclaimedPerReuse + inputs.blockedActions * constants.minutesReclaimedPerBlock;
  const hours = minutes / 60;
  const timeUsd = hours * constants.blendedHourlyUsd;

  // --- Investment (cost denominator) ---
  const authoringHours = (inputs.assetsAuthored * constants.minutesPerAssetAuthored) / 60;
  const authoringUsd = authoringHours * constants.blendedHourlyUsd;

  // --- Knowledge captured (durable token corpus) ---
  const knowledgeCapturedTokens =
    inputs.assetContentChars !== undefined
      ? estimateTokensFromChars(inputs.assetContentChars, constants.charsPerToken)
      : null;

  // --- ROI primitives ---
  const totalBenefitUsd = totalCredits + timeUsd;
  const netValueUsd = totalBenefitUsd - authoringUsd;
  const benefitCostRatio = authoringUsd > 0 ? totalBenefitUsd / authoringUsd : null;
  const roiPct = authoringUsd > 0 ? (netValueUsd / authoringUsd) * 100 : null;

  return {
    tokensSaved: {
      compression: Math.round(compressionTokens),
      reuse: Math.round(reuseTokens),
      cache: Math.round(cacheTokens),
      loopPrevented: Math.round(loopPreventedTokens),
      total: Math.round(totalTokens),
    },
    creditsSavedUsd: {
      compression: compressionCredits,
      reuse: reuseCredits,
      cache: cacheCredits,
      loopPrevented: loopCredits,
      total: totalCredits,
    },
    timeReclaimed: { minutes: Math.round(minutes), hours, usd: timeUsd },
    investment: { authoringHours, authoringUsd },
    knowledgeCapturedTokens,
    totalBenefitUsd,
    netValueUsd,
    benefitCostRatio,
    roiPct,
  };
}

/** Apply a scenario factor to the benefit-side constants only (cost stays fixed). */
export function scaleConstantsForScenario(base: RoiConstants, scenario: ScenarioKey): RoiConstants {
  const f = SCENARIO_FACTORS[scenario];
  return {
    ...base,
    baselineDiscoveryTokensPerSession: Math.round(base.baselineDiscoveryTokensPerSession * f),
    rederivationTokensPerReuse: Math.round(base.rederivationTokensPerReuse * f),
    runawayTokensPerBlock: Math.round(base.runawayTokensPerBlock * f),
    minutesReclaimedPerReuse: base.minutesReclaimedPerReuse * f,
    minutesReclaimedPerBlock: base.minutesReclaimedPerBlock * f,
    // injectedPrefixTokens / hourly / authoring stay fixed:
    // they are sizes/costs, not benefit assumptions.
  };
}

/** Compute the conservative/base/optimistic band from one measured-input set. */
export function computeRoiBand(
  inputs: RoiMeasuredInputs,
  baseConstants: RoiConstants = DEFAULT_ROI_CONSTANTS,
): RoiBand {
  return {
    conservative: computeRoi(inputs, scaleConstantsForScenario(baseConstants, 'conservative')),
    base: computeRoi(inputs, baseConstants),
    optimistic: computeRoi(inputs, scaleConstantsForScenario(baseConstants, 'optimistic')),
    inputs,
    constants: baseConstants,
  };
}

/** One row of the "Assumptions & Methodology" panel: the constant, its value, its formula, and its source. */
export interface MethodologyRow {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly formula: string;
  readonly source: string;
  readonly confidence: 'high' | 'medium' | 'low';
}

/**
 * Build the methodology rows for the base scenario — the literal
 * "$X = N events × M × $R" derivations the UI shows next to every modeled
 * number so nothing reads as fabricated.
 */
export function buildMethodology(
  inputs: RoiMeasuredInputs,
  constants: RoiConstants,
  result: RoiResult,
): MethodologyRow[] {
  const pricing = MODEL_PRICING[constants.modelKey];
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const k = (n: number) => `${Math.round(n).toLocaleString()}`;
  return [
    {
      id: 'pricing',
      label: `Model rate card (${constants.modelKey})`,
      value: `$${pricing.inputPerMTok}/MTok in · $${pricing.cacheReadPerMTok}/MTok cache-read`,
      formula: 'Anthropic standard tier, USD per million tokens (cache read = 0.1× input)',
      source: 'platform.claude.com/docs/.../pricing (verified 2026-06-21)',
      confidence: 'high',
    },
    {
      id: 'compression',
      label: 'Context-compression tokens saved',
      value: k(result.tokensSaved.compression),
      formula: `${k(inputs.totalRuns)} runs × (${k(constants.baselineDiscoveryTokensPerSession)} discovery − ${k(constants.injectedPrefixTokens)} injected) tokens`,
      source: 'Estimate — Cursor smart-context ~10–15k/turn; tune per repo',
      confidence: 'low',
    },
    {
      id: 'reuse',
      label: 'Re-derivation tokens saved (reuse)',
      value: k(result.tokensSaved.reuse),
      formula: `${k(inputs.reuseReads)} reuse-reads × ${k(constants.rederivationTokensPerReuse)} tokens each`,
      source: 'Estimate — knowledge recall vs re-derivation; tune per repo',
      confidence: 'low',
    },
    {
      id: 'cache',
      label: 'Prompt-cache tokens saved (net)',
      value: k(result.tokensSaved.cache),
      formula: `cached turns × ${k(constants.injectedPrefixTokens)} prefix × (1 − 0.1) − per-session 1.25× write premium`,
      source: 'Anthropic prompt-caching multipliers (0.1× read, 1.25× write)',
      confidence: 'medium',
    },
    {
      id: 'loop',
      label: 'Runaway-loop tokens prevented',
      value: k(result.tokensSaved.loopPrevented),
      formula: `${k(inputs.blockedActions)} blocked actions × ${k(constants.runawayTokensPerBlock)} tokens/loop`,
      source: 'Estimate — tokens a blocked runaway would burn before a human notices',
      confidence: 'low',
    },
    {
      id: 'time',
      label: 'Developer time reclaimed',
      value: `${result.timeReclaimed.hours.toFixed(1)} h → ${usd(result.timeReclaimed.usd)}`,
      formula: `(${k(inputs.reuseReads)} reuse × ${constants.minutesReclaimedPerReuse}m + ${k(inputs.blockedActions)} blocks × ${constants.minutesReclaimedPerBlock}m) ÷ 60 × $${constants.blendedHourlyUsd}/h`,
      source: 'Parnin & Rugaber (10–15 min resume) × DX $78/h fully-loaded',
      confidence: 'medium',
    },
    {
      id: 'investment',
      label: 'Authoring investment (cost)',
      value: `${result.investment.authoringHours.toFixed(1)} h → ${usd(result.investment.authoringUsd)}`,
      formula: `${k(inputs.assetsAuthored)} assets × ${constants.minutesPerAssetAuthored}m ÷ 60 × $${constants.blendedHourlyUsd}/h`,
      source: 'Estimate — human/agent effort per pack/decision authored',
      confidence: 'medium',
    },
  ];
}
