/**
 * `apps/web/lib/feature-pack-markers.ts` — pure helpers for the M04
 * Phase 2 S6 feature-pack editor.
 *
 * Builds on the auto-marker library promoted out of M08b S14 (see
 * `packages/cli/src/lib/auto-marker/`). The CLI library is the single
 * source of truth for the `<!-- @auto:NAME -->` ... `<!-- /@auto -->`
 * grammar; this module re-exports it and adds two web-specific
 * concerns:
 *
 *   1. `compareMarkerSets(before, after)` — compute the set delta
 *      between two parses. The editor refuses to save when the user
 *      has added, removed, or renamed a marker — only the inner
 *      content of an existing marker is editable from the web. Adding
 *      or removing markers is a `contextos pack regenerate` (or
 *      template install) responsibility.
 *
 *   2. `summarizeParseErrors(errors)` — render the parser's structured
 *      errors as a single user-friendly string for the inline banner.
 *
 * Why a separate module rather than inlining: it keeps the editor
 * page slim (Server Component) and lets us unit-test the validation
 * rules without a Next.js render harness.
 */

import {
  type AutoSection,
  type ParseError,
  type ParseResult,
  parseAutoSections,
} from '@coodra/contextos-cli/lib/auto-marker';

export type { AutoSection, ParseError, ParseResult };
export { parseAutoSections };

export interface MarkerSetDelta {
  /** Section names present in `after` but not `before`. */
  readonly added: ReadonlyArray<string>;
  /** Section names present in `before` but not `after`. */
  readonly removed: ReadonlyArray<string>;
  /**
   * Section names whose order or position changed (kept in `before`
   * and `after`, but at a different index). Renaming counts as
   * removed+added; reordering counts here.
   */
  readonly reordered: ReadonlyArray<string>;
}

export function compareMarkerSets(before: ParseResult, after: ParseResult): MarkerSetDelta {
  const beforeNames = before.sections.map((s) => s.name);
  const afterNames = after.sections.map((s) => s.name);
  const beforeSet = new Set(beforeNames);
  const afterSet = new Set(afterNames);
  const added = afterNames.filter((n) => !beforeSet.has(n));
  const removed = beforeNames.filter((n) => !afterSet.has(n));

  // Reorder detection: walk the intersection in `before`'s order and
  // verify the same indices match `after`'s order. Any index mismatch
  // is a reorder — surfaced separately so the user sees the precise
  // class of violation.
  const intersection = beforeNames.filter((n) => afterSet.has(n));
  const afterFiltered = afterNames.filter((n) => beforeSet.has(n));
  const reordered: string[] = [];
  for (let i = 0; i < intersection.length; i++) {
    if (intersection[i] !== afterFiltered[i]) {
      const name = intersection[i];
      if (typeof name === 'string') reordered.push(name);
    }
  }
  return { added, removed, reordered };
}

export function deltaIsEmpty(delta: MarkerSetDelta): boolean {
  return delta.added.length === 0 && delta.removed.length === 0 && delta.reordered.length === 0;
}

export function describeDelta(delta: MarkerSetDelta): string {
  const parts: string[] = [];
  if (delta.removed.length > 0) parts.push(`removed: ${delta.removed.join(', ')}`);
  if (delta.added.length > 0) parts.push(`added: ${delta.added.join(', ')}`);
  if (delta.reordered.length > 0) parts.push(`reordered: ${delta.reordered.join(', ')}`);
  return parts.length === 0 ? 'no changes' : parts.join(' / ');
}

export function summarizeParseErrors(errors: ReadonlyArray<ParseError>): string {
  if (errors.length === 0) return '';
  const head = errors.slice(0, 3).map((e) => `line ${e.line}: ${e.code} — ${e.message}`);
  const more = errors.length > 3 ? ` (+${errors.length - 3} more)` : '';
  return head.join(' | ') + more;
}
