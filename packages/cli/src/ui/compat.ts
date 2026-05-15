/**
 * `src/ui/compat.ts` — a drop-in replacement for the slice of
 * `picocolors` the CLI's one-shot commands used before the terminal
 * design-system migration.
 *
 * Every method maps the old ANSI-16 colour onto the Coodra design
 * palette, so a command file adopts the design system with a one-line
 * import swap and zero call-site churn:
 *
 *   - import pc from 'picocolors';
 *   + import { pc } from '../ui/index.js';
 *
 * The mapping (`green → phosphor`, `red → crimson`, `cyan → blue`,
 * `yellow → amber`, `gray → ink-dim`) keeps every command's existing
 * semantics — success is still "green", errors still "red" — while
 * pulling the actual hues onto the brand's 24-bit palette.
 *
 * New code, and any command worth a deeper restyle, should prefer the
 * semantic formatters in `format.ts` (`sectionHead`, `kvRow`,
 * `timelineRow`, `summaryBar`, `errorLine`, …). This shim exists so the
 * long tail of commands themes consistently without a hand-rewrite
 * each — not as the destination.
 */

import { paint, style } from './theme.js';

export interface PicoCompat {
  readonly red: (text: string) => string;
  readonly green: (text: string) => string;
  readonly yellow: (text: string) => string;
  readonly cyan: (text: string) => string;
  readonly blue: (text: string) => string;
  readonly magenta: (text: string) => string;
  readonly gray: (text: string) => string;
  readonly grey: (text: string) => string;
  readonly white: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly bold: (text: string) => string;
  readonly italic: (text: string) => string;
  readonly underline: (text: string) => string;
}

export const pc: PicoCompat = {
  // success · ok · live → phosphor (the one load-bearing colour)
  green: paint.phosphor,
  // errors · deny · failure → crimson
  red: paint.crimson,
  // warn · degraded → amber
  yellow: paint.amber,
  // info · paths · accents → blue
  cyan: paint.blue,
  blue: paint.blue,
  // data → purple
  magenta: paint.purple,
  // secondary text · labels · captions → ink-dim
  gray: paint.inkDim,
  grey: paint.inkDim,
  // primary text → ink
  white: paint.ink,
  // style modifiers carry through unchanged (picocolors' own).
  dim: style.dim,
  bold: style.bold,
  italic: style.italic,
  underline: style.underline,
};
