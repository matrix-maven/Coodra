/**
 * @coodra/shared/roi — public surface for the ROI / value model
 * (the `/roi` web dashboard + `coodra roi` CLI).
 *
 * Single import site so the web and CLI compute identical numbers from
 * identical assumptions. Consumers gather Coodra's REAL counts into a
 * `RoiMeasuredInputs` and call `computeRoiBand(...)`; everything modeled
 * (tokens, credits, time, net value, BCR, ROI%) flows from the pure
 * functions here. NEVER duplicate these constants/formulas — import them.
 */

export {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  DEFAULT_ROI_CONSTANTS,
  MODEL_PRICING,
  type ModelKey,
  type ModelPricing,
  REUSE_READ_TOOL_NAMES,
  ROI_SOURCES,
  type RoiConstants,
  SCENARIO_FACTORS,
  type ScenarioKey,
} from './constants.js';

export {
  buildMethodology,
  computeRoi,
  computeRoiBand,
  estimateTokensFromChars,
  type MethodologyRow,
  type RoiBand,
  type RoiCreditBreakdown,
  type RoiMeasuredInputs,
  type RoiResult,
  type RoiTokenBreakdown,
  scaleConstantsForScenario,
} from './model.js';
