/**
 * `src/ui/format.ts` — string formatters for one-shot CLI output.
 *
 * Every `coodra <command>` that prints human-readable text composes
 * its output from these primitives, so the whole CLI speaks the design
 * vocabulary in `Terminal Redesign Preview.html`: `/NN` section heads,
 * key-value rows aligned on a column, axis-node timelines, summary
 * bars, the splash banner.
 *
 * Padding discipline (load-bearing): these formatters pad *raw* text to
 * width and *then* colourise. Painted strings carry ANSI escape bytes
 * that inflate `.length`, so `.padEnd()` on a painted string mis-aligns.
 * Any field a caller passes pre-painted (e.g. a glyph from
 * {@link checkGlyph}) must be a fixed visible width and is placed
 * without padding.
 *
 * The interactive Ink TUI does NOT use these — it has JSX components in
 * `src/ui/ink/` — but both pull the same tokens from `theme.ts` /
 * `brand.ts`, so the two surfaces stay visually identical.
 */

import { axisNode, axisParts } from './brand.js';
import { LOGO_BLOCK, LOGO_BLOCK_WIDTH, paintLogoLine } from './logo.js';
import {
  type CheckTone,
  glyph,
  type PaintColor,
  paint,
  paintHex,
  style,
  TONE_GLYPH,
  TONE_PAINT,
  terminalWidth,
  VERDICT_PAINT,
  type Verdict,
} from './theme.js';
import { WORDMARK_LINES, WORDMARK_WIDTH, wordmarkLineColor } from './wordmark.js';

// ============================================================================
// section heads + rules
// ============================================================================

/**
 * A `/NN` section head — `/01  ENVIRONMENT  ─────────────`. The number
 * is phosphor, the title bold uppercase ink, the rule fills the rest of
 * the line in faint ink-far. Hierarchy through numbering, not chrome.
 */
export function sectionHead(
  num: string,
  title: string,
  opts: { readonly width?: number; readonly indent?: number } = {},
): string {
  const width = opts.width ?? terminalWidth();
  const indent = opts.indent ?? 0;
  const pad = ' '.repeat(indent);
  const numTok = `/${num}`;
  const titleUpper = title.toUpperCase();
  // visible columns consumed before the rule: indent + "/NN" + 2 + title + 2
  const consumed = indent + numTok.length + 2 + titleUpper.length + 2;
  const ruleLen = Math.max(3, width - consumed);
  return `${pad}${paint.phosphor(numTok)}  ${style.bold(paint.ink(titleUpper))}  ${paint.inkFar(glyph.rule.repeat(ruleLen))}`;
}

/**
 * A command-output title — `Doctor — health report` with a rule on the
 * line below. Used at the top of a one-shot command's output, above its
 * `/NN` sections.
 */
export function commandTitle(
  title: string,
  subtitle?: string,
  opts: { readonly width?: number; readonly indent?: number } = {},
): string {
  const width = opts.width ?? terminalWidth();
  const indent = opts.indent ?? 2;
  const pad = ' '.repeat(indent);
  const head =
    subtitle !== undefined
      ? `${style.bold(paint.ink(title))} ${paint.inkFar(`— ${subtitle}`)}`
      : style.bold(paint.ink(title));
  const ruleStr = paint.inkFar(glyph.rule.repeat(Math.max(8, width - indent)));
  return `${pad}${head}\n${pad}${ruleStr}`;
}

/** A plain horizontal rule in faint ink-far. */
export function rule(opts: { readonly width?: number; readonly indent?: number } = {}): string {
  const width = opts.width ?? terminalWidth();
  const indent = opts.indent ?? 0;
  return ' '.repeat(indent) + paint.inkFar(glyph.rule.repeat(Math.max(4, width - indent)));
}

/** The axis divider between major output blocks. */
export function divider(opts: { readonly width?: number; readonly indent?: number } = {}): string {
  const width = opts.width ?? terminalWidth();
  const indent = opts.indent ?? 0;
  return ' '.repeat(indent) + axisParts(Math.max(8, width - indent)).painted;
}

// ============================================================================
// key-value rows
// ============================================================================

export interface KvRow {
  /**
   * Pre-painted prefix glyph occupying exactly one visible column (e.g.
   * the output of {@link checkGlyph}). Omit for an aligned blank slot so
   * glyphed and glyph-less rows stay column-aligned.
   */
  readonly glyph?: string;
  readonly key: string;
  readonly value?: string;
  /** Trailing meta, rendered faint after the value (e.g. `· 14 migrations`). */
  readonly meta?: string;
  /** Override the value colour (default: ink). */
  readonly valueTone?: PaintColor;
}

/** A single aligned key-value row. See {@link kvBlock} for auto-sized columns. */
export function kvRow(row: KvRow, opts: { readonly keyWidth?: number; readonly indent?: number } = {}): string {
  const keyWidth = opts.keyWidth ?? 22;
  const indent = opts.indent ?? 0;
  const pad = ' '.repeat(indent);
  // glyph slot is 3 visible columns: glyph + 2 spaces, or 3 spaces blank.
  const lead = row.glyph !== undefined ? `${row.glyph}  ` : '   ';
  const key = paint.inkDim(row.key.padEnd(keyWidth));
  const valuePaint = row.valueTone !== undefined ? paint[row.valueTone] : paint.ink;
  const value = row.value !== undefined ? valuePaint(row.value) : '';
  const meta = row.meta !== undefined ? `  ${paint.inkFar(row.meta)}` : '';
  return `${pad}${lead}${key}${value}${meta}`;
}

/**
 * A block of key-value rows with the key column auto-sized to the
 * longest key (unless `keyWidth` is given). One `\n`-joined string.
 */
export function kvBlock(
  rows: readonly KvRow[],
  opts: { readonly keyWidth?: number; readonly indent?: number } = {},
): string {
  const longest = rows.reduce((max, r) => Math.max(max, r.key.length), 0);
  const keyWidth = opts.keyWidth ?? Math.min(34, Math.max(12, longest + 2));
  const rowOpts = opts.indent !== undefined ? { keyWidth, indent: opts.indent } : { keyWidth };
  return rows.map((r) => kvRow(r, rowOpts)).join('\n');
}

// ============================================================================
// timeline rows (the brand mark used literally — every run is a node)
// ============================================================================

export interface TimelineEntry {
  readonly verdict: Verdict;
  /** Relative time, e.g. `12m ago`. */
  readonly when: string;
  /** Entity id, e.g. `run_a8f3…`. */
  readonly id: string;
  /** Status word, coloured by verdict. */
  readonly status: string;
  /** Trailing meta, e.g. `47 events`. */
  readonly meta?: string;
}

/**
 * A timeline row — `·──●  12m ago    run_a8f3…   completed   47 events`.
 * The leading axis node's colour encodes the verdict; the status word
 * takes the same colour. This is the brand mark used literally: each
 * row is a node observed on the context axis.
 */
export function timelineRow(
  entry: TimelineEntry,
  opts: {
    readonly indent?: number;
    readonly whenWidth?: number;
    readonly idWidth?: number;
    readonly statusWidth?: number;
  } = {},
): string {
  const indent = opts.indent ?? 0;
  const whenWidth = opts.whenWidth ?? 12;
  const idWidth = opts.idWidth ?? 18;
  const statusWidth = opts.statusWidth ?? 11;
  const pad = ' '.repeat(indent);
  const node = axisNode(entry.verdict); // `·──●`, 4 visible columns, pre-painted
  const when = paint.inkDim(entry.when.padEnd(whenWidth));
  const id = paint.ink(entry.id.padEnd(idWidth));
  const status = VERDICT_PAINT[entry.verdict](entry.status.padEnd(statusWidth));
  const meta = entry.meta !== undefined ? paint.inkFar(entry.meta) : '';
  return `${pad}${node}  ${when}${id}${status}${meta}`;
}

// ============================================================================
// summary bar
// ============================================================================

export interface SummarySegment {
  readonly text: string;
  /** Segment colour (default: ink-dim). */
  readonly tone?: PaintColor;
  readonly bold?: boolean;
}

/**
 * A summary bar — `20 / 20 checks passed  ·  1 warning  ·  0 failures`.
 * Segments are joined by a faint `·` separator.
 */
export function summaryBar(segments: readonly SummarySegment[], opts: { readonly indent?: number } = {}): string {
  const indent = opts.indent ?? 0;
  const sep = paint.inkFar('  ·  ');
  const parts = segments.map((s) => {
    const colour = s.tone !== undefined ? paint[s.tone] : paint.inkDim;
    return s.bold === true ? style.bold(colour(s.text)) : colour(s.text);
  });
  return ' '.repeat(indent) + parts.join(sep);
}

// ============================================================================
// splash banner
// ============================================================================

export interface BannerOptions {
  readonly version: string;
  /** Italic tagline under the wordmark. */
  readonly tagline?: string;
  /** Wordmark text (default: `coodra`). */
  readonly wordmark?: string;
  /** Trailing meta segment after `Coodra · vX`. */
  readonly metaSuffix?: string;
  readonly width?: number;
}

/**
 * The splash hero — the Coodra logo mark (a circle observing a node on
 * a dotted axis), the `coodra` wordmark in figlet block art
 * (gradient-washed; falls back to the plain word on a narrow terminal),
 * an italic tagline, and a meta line. Every line is centred on the
 * resolved render width.
 */
export function banner(opts: BannerOptions): string {
  const width = opts.width ?? terminalWidth();
  const fallbackWord = opts.wordmark ?? 'coodra';
  const tagline = opts.tagline ?? 'Master the context.';
  const metaParts = ['Coodra', `v${opts.version}`, opts.metaSuffix ?? 'local-first by design'];

  const metaRaw = metaParts.join(' · ');
  const metaPainted = metaParts.map((p) => paint.inkDim(p)).join(paint.inkFar(' · '));

  const center = (rawLen: number, painted: string): string => {
    const lead = Math.max(0, Math.floor((width - rawLen) / 2));
    return ' '.repeat(lead) + painted;
  };

  // The logo mark, then the wordmark — block figlet when the terminal
  // can hold it, the plain word otherwise.
  const logoBlock = LOGO_BLOCK.map((line) => center(LOGO_BLOCK_WIDTH, paintLogoLine(line)));
  const showBlock = width >= WORDMARK_WIDTH + 4;
  const wordmarkBlock = showBlock
    ? WORDMARK_LINES.map((line, i) => center(WORDMARK_WIDTH, paintHex(wordmarkLineColor(i), line)))
    : [center(fallbackWord.length, style.bold(paint.phosphor(fallbackWord)))];

  return [
    ...logoBlock,
    '',
    ...wordmarkBlock,
    '',
    center(tagline.length, style.italic(paint.phosphor(tagline))),
    '',
    center(metaRaw.length, metaPainted),
  ].join('\n');
}

// ============================================================================
// prompt + glyphs
// ============================================================================

/**
 * The command prompt line — `·──●  you ›`. With `command`, echoes a
 * previously-run command; with `cursor`, appends a block cursor.
 */
export function promptLine(
  opts: { readonly role?: string; readonly command?: string; readonly cursor?: boolean } = {},
): string {
  const role = opts.role ?? 'you';
  const mark = axisNode('ok');
  const rolePart = style.bold(paint.phosphor(role));
  const sep = paint.inkFar(` ${glyph.promptSep} `);
  const cmd = opts.command !== undefined ? paint.ink(opts.command) : '';
  const cursor = opts.cursor === true ? paint.inkDim('█') : '';
  return `${mark}  ${rolePart}${sep}${cmd}${cursor}`;
}

/** A pre-painted diagnostic glyph for the given tone — feed into {@link KvRow.glyph}. */
export function checkGlyph(tone: CheckTone): string {
  return TONE_PAINT[tone](TONE_GLYPH[tone]);
}

// ============================================================================
// status one-liners
// ============================================================================

/** `·──✕  error  <message>` — a failed observation on the axis. */
export function errorLine(message: string): string {
  return `${axisNode('fail')}  ${paint.crimson('error')}  ${paint.inkDim(message)}`;
}

/** `⚠  <message>` — an operational warning. */
export function warnLine(message: string): string {
  return `${paint.amber(glyph.check.warn)}  ${paint.inkDim(message)}`;
}

/** `✓  <message>` — a clean result. */
export function okLine(message: string): string {
  return `${paint.phosphor(glyph.check.ok)}  ${paint.ink(message)}`;
}

/** A faint, indented sub-detail line (`↳ …`). */
export function noteLine(message: string): string {
  return `${paint.inkFar(glyph.branch)} ${paint.inkDim(message)}`;
}

/** A faint hint / caption line. */
export function hintLine(message: string): string {
  return paint.inkFar(message);
}

// ============================================================================
// footer hints
// ============================================================================

export interface FooterHint {
  /** Key chord, e.g. `tab` or `↑↓`. */
  readonly keys: string;
  readonly label: string;
}

/**
 * A footer hint strip — `tab switch views   ↑↓ history   ⏎ run   q quit`.
 * Used at the bottom of long output and (mirrored as a component) in the
 * Ink TUI.
 */
export function footerHints(hints: readonly FooterHint[], opts: { readonly indent?: number } = {}): string {
  const indent = opts.indent ?? 0;
  const parts = hints.map((h) => `${paint.inkDim(h.keys)} ${paint.inkFar(h.label)}`);
  return ' '.repeat(indent) + parts.join(paint.inkFar('   '));
}

// ============================================================================
// helpers
// ============================================================================

/** Indent every non-empty line of a (possibly multi-line) string by `n` spaces. */
export function indentLines(text: string, n: number): string {
  const pad = ' '.repeat(n);
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}
