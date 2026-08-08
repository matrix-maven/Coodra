import type { ContextPackRow, DecisionRow } from '@coodra/db';

/**
 * `context_packs.meta` is agent-curated JSON (see `save_context_pack`'s
 * `meta.decisionIds`) — best-effort parse, never throws on a malformed or
 * legacy-shaped row. Shared by the run detail page, the decisions list
 * page, and the decision detail page — all three need the same
 * pack ↔ decision linkage (extracted 2026-08-08 from the run detail page,
 * which had it inline first).
 */
export function linkedDecisionIds(pack: ContextPackRow): ReadonlySet<string> {
  if (pack.meta === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(pack.meta);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'decisionIds' in parsed &&
      Array.isArray((parsed as { decisionIds: unknown }).decisionIds)
    ) {
      return new Set(
        (parsed as { decisionIds: unknown[] }).decisionIds.filter((x): x is string => typeof x === 'string'),
      );
    }
  } catch {
    // Malformed meta — treat as no linkage rather than failing the page.
  }
  return new Set();
}

export interface PackWithLinkedDecisions<D extends DecisionRow = DecisionRow> {
  readonly pack: ContextPackRow;
  readonly linked: ReadonlyArray<D>;
}

export interface GroupedDecisions<D extends DecisionRow = DecisionRow> {
  /** Newest pack first, each with the decisions it claims via `meta.decisionIds`. */
  readonly packsWithDecisions: ReadonlyArray<PackWithLinkedDecisions<D>>;
  /** Decisions no pack claims — legacy rows, or the agent didn't tag `meta.decisionIds`. */
  readonly otherDecisions: ReadonlyArray<D>;
}

/** Groups `decisions` under the context pack(s) that claim them — see the run detail page for the rendering this backs. */
export function groupDecisionsByPack<D extends DecisionRow>(
  packsNewestFirst: ReadonlyArray<ContextPackRow>,
  decisions: ReadonlyArray<D>,
): GroupedDecisions<D> {
  const claimed = new Set<string>();
  const packsWithDecisions = packsNewestFirst.map((pack) => {
    const ids = linkedDecisionIds(pack);
    const linked = decisions.filter((d) => ids.has(d.id));
    for (const d of linked) claimed.add(d.id);
    return { pack, linked };
  });
  const otherDecisions = decisions.filter((d) => !claimed.has(d.id));
  return { packsWithDecisions, otherDecisions };
}

/** The reverse direction: which pack(s) (out of `packs`) claim this one decision? Usually 0 or 1, but not enforced. */
export function packsLinkingDecision(
  packs: ReadonlyArray<ContextPackRow>,
  decisionId: string,
): ReadonlyArray<ContextPackRow> {
  return packs.filter((pack) => linkedDecisionIds(pack).has(decisionId));
}
