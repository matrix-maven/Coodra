/**
 * `src/ui/theme.ts` — Coodra terminal design system tokens.
 *
 * The single source of truth for the look specified in
 * `Terminal Redesign Preview.html`, made **terminal-adaptive** so it
 * reads correctly on a light background, a dark background, or any
 * custom theme — not just the dark mock the design was drawn against.
 *
 * The adaptivity strategy (per the prevailing CLI guidance — use the
 * terminal's own colours, fall back to colours readable on any
 * background, detect only what you must):
 *
 *   - **`ink`** (primary text) → the terminal's *own* foreground. We
 *     emit no colour for it, so it is light on a dark terminal and dark
 *     on a light one, always at full contrast. Bulletproof, no detection.
 *   - **`inkDim`** (secondary text) → the ANSI `dim` attribute, which
 *     blends toward the background on light *and* dark terminals.
 *   - **`inkFar`** (rules, the faint axis — structural, not body text)
 *     → a fixed mid-grey that stays legible on white and black alike.
 *   - **accents** (`phosphor`, `crimson`, `amber`, `blue`, `purple`,
 *     `pink`) → three tuned 24-bit sets. The background is detected
 *     (`COODRA_THEME` override → `COLORFGBG` → unknown); a confident
 *     `dark`/`light` reading gets the vivid/deep set, and `unknown`
 *     (the common case — most terminals expose no hint) gets a
 *     mid-luminance set that clears ~3:1 contrast on both extremes.
 *
 * Net effect: the text that *must* be readable needs no detection at
 * all, and the worst a missed accent detection can do is make a colour
 * slightly less vivid — never invisible. `COODRA_THEME=light|dark`
 * forces the accent set; `NO_COLOR` drops colour entirely.
 *
 * Two consumers pull from here so they never drift: one-shot command
 * output via the `paint.*` string-wrappers, and the interactive Ink TUI
 * via `palette.*` hex values + the `dimColor` prop.
 */

import pc from 'picocolors';

export type ColorScheme = 'dark' | 'light' | 'unknown';

/**
 * Whether the active stdout stream supports colour. Computed once at
 * import (picocolors checks NO_COLOR, FORCE_COLOR, CI, TTY, TERM).
 */
export const colorEnabled: boolean = pc.isColorSupported;

/**
 * Synchronous background detection, run once at module load.
 *
 *   1. `COODRA_THEME=light|dark` — explicit override, always wins.
 *   2. `COLORFGBG` — the de-facto env hint (`fg;bg` or `fg;def;bg`);
 *      the trailing index is the background colour (`0-6,8` → dark,
 *      `7,9-15` → light).
 *   3. otherwise `unknown` — handled by the mid-luminance accent set.
 */
function detectColorScheme(): ColorScheme {
  const override = process.env.COODRA_THEME?.trim().toLowerCase();
  if (override === 'dark' || override === 'light') return override;

  const colorFgBg = process.env.COLORFGBG;
  if (typeof colorFgBg === 'string' && colorFgBg.length > 0) {
    const parts = colorFgBg.split(';');
    const bgRaw = parts[parts.length - 1];
    const bg = bgRaw !== undefined ? Number.parseInt(bgRaw, 10) : Number.NaN;
    if (Number.isInteger(bg)) {
      if (bg === 7 || (bg >= 9 && bg <= 15)) return 'light';
      if ((bg >= 0 && bg <= 6) || bg === 8) return 'dark';
    }
  }
  return 'unknown';
}

/**
 * 24-bit accent sets, one per scheme. Names mirror the design
 * reference's CSS custom properties (`--accent`, `--warn`, …).
 *
 *   - `dark`    — the vivid mock palette; bright on a dark terminal.
 *   - `light`   — deepened for crisp contrast on a white terminal.
 *   - `unknown` — mid-luminance (relative luminance ≈ 0.12–0.28), so
 *     every hue clears ~3:1 against both pure white and pure black.
 */
interface AccentSet {
  readonly phosphor: string;
  readonly phosphorSoft: string;
  readonly crimson: string;
  readonly amber: string;
  readonly blue: string;
  readonly purple: string;
  readonly pink: string;
}

const ACCENT_SETS: Record<ColorScheme, AccentSet> = {
  dark: {
    phosphor: '#7dd87d',
    phosphorSoft: '#4a9d4a',
    crimson: '#d97a7a',
    amber: '#c08a3e',
    blue: '#6ba5c8',
    purple: '#9b87d4',
    pink: '#d47fa8',
  },
  light: {
    phosphor: '#2e7d32',
    phosphorSoft: '#43853f',
    crimson: '#c62828',
    amber: '#8a5a00',
    blue: '#1565a0',
    purple: '#5e35b1',
    pink: '#ad1457',
  },
  unknown: {
    phosphor: '#3d9140',
    phosphorSoft: '#4a9d4a',
    crimson: '#cc4436',
    amber: '#a8741f',
    blue: '#3f7fa0',
    purple: '#7a5fc0',
    pink: '#c05080',
  },
};

/**
 * `inkFar` — a fixed mid-grey. It only ever carries structural marks
 * (rules, the faint axis arms, dividers, meta) — never body text — so a
 * single mid-luminance grey reads acceptably on every background and
 * needs no scheme.
 */
const INK_FAR = '#7d7d7d';

/**
 * The active scheme. Resolved synchronously at load; the TUI may refine
 * it via {@link setColorScheme} before its first render.
 */
export let activeColorScheme: ColorScheme = detectColorScheme();

/**
 * Hex values consumed directly by the Ink TUI (`<Text color={…}>`).
 * `ink` and `inkDim` are deliberately absent — Ink renders primary text
 * with a bare `<Text>` (terminal foreground) and secondary text with
 * the `dimColor` prop. Only `inkFar` + the accents are real hexes.
 *
 * Mutated in place by {@link setColorScheme} so importers (the Ink
 * components) always read the current scheme without re-importing.
 */
export const palette = {
  inkFar: INK_FAR,
  ...ACCENT_SETS[activeColorScheme],
};

/** Build a 24-bit foreground escape for `hex`, or pass `text` through when colour is off. */
function hexToRgb(hex: string): readonly [number, number, number] {
  const v = hex.replace('#', '');
  return [Number.parseInt(v.slice(0, 2), 16), Number.parseInt(v.slice(2, 4), 16), Number.parseInt(v.slice(4, 6), 16)];
}

function truecolor(hex: string, text: string): string {
  if (!colorEnabled) return text;
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/**
 * Wrap `text` in a 24-bit foreground escape for an arbitrary hex —
 * for one-shot output that needs a colour outside the named palette
 * (e.g. the per-line wordmark gradient). No-ops when colour is off.
 */
export function paintHex(hex: string, text: string): string {
  return truecolor(hex, text);
}

/**
 * Text-style modifiers, re-exported from picocolors so the whole design
 * system styles from one module. `dim` is the load-bearing one — it is
 * how `inkDim` adapts to any background.
 */
export const style = {
  bold: pc.bold,
  italic: pc.italic,
  dim: pc.dim,
  underline: pc.underline,
} as const;

/**
 * String-wrapping colourisers for the non-Ink (one-shot output) path.
 * Each reads the *current* `palette` per call, so {@link setColorScheme}
 * is reflected without rebuilding anything.
 *
 *   - `ink`     — identity: primary text rides the terminal's own fg.
 *   - `inkDim`  — the ANSI `dim` attribute (background-adaptive).
 *   - `inkFar`  — the fixed structural mid-grey.
 *   - accents   — the resolved 24-bit accent for the active scheme.
 *
 * IMPORTANT: never `.padEnd()` / `.padStart()` a painted string — the
 * ANSI escape bytes inflate `.length`. Pad the raw text, then paint.
 */
export const paint = {
  ink: (text: string): string => text,
  inkDim: (text: string): string => style.dim(text),
  inkFar: (text: string): string => truecolor(palette.inkFar, text),
  phosphor: (text: string): string => truecolor(palette.phosphor, text),
  phosphorSoft: (text: string): string => truecolor(palette.phosphorSoft, text),
  crimson: (text: string): string => truecolor(palette.crimson, text),
  amber: (text: string): string => truecolor(palette.amber, text),
  blue: (text: string): string => truecolor(palette.blue, text),
  purple: (text: string): string => truecolor(palette.purple, text),
  pink: (text: string): string => truecolor(palette.pink, text),
} as const;

/** A `paint.*` channel name — the tone vocabulary for one-shot formatters. */
export type PaintColor = keyof typeof paint;

/**
 * Tone applied to check / status rows. Decoupled from the doctor's own
 * `CheckStatus` so `src/ui/` never imports from `src/doctor/`.
 */
export type CheckTone = 'ok' | 'warn' | 'fail' | 'timeout' | 'skip';

/**
 * Verdict applied to an axis node — the brand mark used literally. A
 * run, a service, a policy decision: each is a node observed on the
 * context axis, and the dot's colour encodes the outcome.
 */
export type Verdict = 'ok' | 'fail' | 'idle' | 'warn';

/**
 * Glyph vocabulary. Two families, deliberately distinct:
 *   - `check.*` — prefix icons for diagnostic rows (design frames /02, /03)
 *   - `node.*`  — verdict dots on the context axis (the brand mark, literal)
 */
export const glyph = {
  check: {
    ok: '✓',
    warn: '⚠',
    fail: '✗',
    timeout: '⏱',
    skip: '·',
  },
  node: {
    ok: '●',
    fail: '✕',
    idle: '○',
    warn: '!',
  },
  cursor: '▸',
  promptSep: '›',
  branch: '↳',
  rule: '─',
} as const;

/** Maps a {@link CheckTone} to its prefix glyph. */
export const TONE_GLYPH: Record<CheckTone, string> = {
  ok: glyph.check.ok,
  warn: glyph.check.warn,
  fail: glyph.check.fail,
  timeout: glyph.check.timeout,
  skip: glyph.check.skip,
};

/** Maps a {@link CheckTone} to its `paint.*` coloriser (one-shot path). */
export const TONE_PAINT: Record<CheckTone, (text: string) => string> = {
  ok: paint.phosphor,
  warn: paint.amber,
  fail: paint.crimson,
  timeout: paint.crimson,
  skip: paint.inkFar,
};

/** Maps a {@link Verdict} to its axis-node glyph. */
export const VERDICT_GLYPH: Record<Verdict, string> = {
  ok: glyph.node.ok,
  fail: glyph.node.fail,
  idle: glyph.node.idle,
  warn: glyph.node.warn,
};

/** Maps a {@link Verdict} to its `paint.*` coloriser (one-shot path). */
export const VERDICT_PAINT: Record<Verdict, (text: string) => string> = {
  ok: paint.phosphor,
  fail: paint.crimson,
  idle: paint.inkDim,
  warn: paint.amber,
};

/**
 * Hex colour maps for the Ink TUI. Mutated in place by
 * {@link setColorScheme} so a scheme change reflows the live tree.
 * `skip` / `idle` resolve to the structural mid-grey (`inkFar`) rather
 * than `inkDim`, because Ink wants a concrete `color` hex there.
 */
export const TONE_COLOR: Record<CheckTone, string> = {
  ok: palette.phosphor,
  warn: palette.amber,
  fail: palette.crimson,
  timeout: palette.crimson,
  skip: palette.inkFar,
};

/** Hex colour map for {@link Verdict}, for the Ink TUI. */
export const VERDICT_COLOR: Record<Verdict, string> = {
  ok: palette.phosphor,
  fail: palette.crimson,
  idle: palette.inkFar,
  warn: palette.amber,
};

/**
 * Switch the active accent scheme. Mutates `palette`, `TONE_COLOR`, and
 * `VERDICT_COLOR` in place so every consumer — including an
 * already-imported Ink component — picks up the change on its next
 * render. The TUI calls this before `render()` if it can refine the
 * detected scheme; one-shot commands never need to.
 */
export function setColorScheme(scheme: ColorScheme): void {
  activeColorScheme = scheme;
  const accents = ACCENT_SETS[scheme];
  Object.assign(palette, accents);
  TONE_COLOR.ok = accents.phosphor;
  TONE_COLOR.warn = accents.amber;
  TONE_COLOR.fail = accents.crimson;
  TONE_COLOR.timeout = accents.crimson;
  VERDICT_COLOR.ok = accents.phosphor;
  VERDICT_COLOR.fail = accents.crimson;
  VERDICT_COLOR.warn = accents.amber;
}

/**
 * Resolved render width for one-shot output. Reads `stdout.columns`,
 * clamps to a legible band so section rules don't run off a narrow pane
 * or sprawl across an ultrawide one.
 */
export function terminalWidth(): number {
  const cols = process.stdout.columns;
  if (typeof cols !== 'number' || !Number.isFinite(cols)) return 80;
  return Math.max(48, Math.min(100, cols));
}
