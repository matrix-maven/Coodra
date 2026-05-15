/**
 * `src/ui/index.ts` — barrel for the Coodra terminal design system.
 *
 * The non-Ink surface (tokens + brand + string formatters) is the part
 * one-shot command handlers import. The Ink component library lives
 * under `src/ui/ink/` and is imported directly by the TUI — it is NOT
 * re-exported here so that a one-shot command bundle never pulls React
 * into its dependency graph.
 */

export * from './brand.js';
// `pc` — picocolors-compatible shim, mapped onto the design palette.
// Migration aid for the long tail of one-shot commands; new code should
// prefer the semantic formatters above.
export { type PicoCompat, pc } from './compat.js';
export * from './format.js';
export * from './logo.js';
export * from './theme.js';
export * from './wordmark.js';
