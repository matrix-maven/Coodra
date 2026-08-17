/**
 * `@coodra/shared/decision-targets` — COOD-90.
 *
 * One definition of "does this `impact` entry name a file?", shared by
 * the writer that classifies it and every reader that consumes the
 * resulting `decision_edges` row.
 *
 * ## Why this moved out of the gardening worker
 *
 * `record_decision`'s `impact` is a free-text array, and the original
 * `impactTarget()` stored ANY entry without a `graph_node:` /
 * `work_pack:` prefix as `target_type = 'file'`. Agents supplied
 * perfectly reasonable prose — real rows in this repo carry targets
 * like `identity` and `licensing` — and it was all filed as if it named
 * a path.
 *
 * Two consumers then had to defend themselves against the writer:
 * COOD-86's gardening worker (which computes freshness by checking
 * whether a decision's files changed) and COOD-88's JIT teaching (which
 * looks decisions up by the path a gated tool call touched). Gardening
 * grew a `looksLikePath` heuristic to filter the noise, and that
 * filtering was a significant part of what brought its false-stale rate
 * down from ~60%.
 *
 * Fixing the reader was the wrong layer. The writer now classifies, so
 * `target_type` means what it says and readers can simply filter on it.
 *
 * ## Classify, do not reject
 *
 * Rejecting non-paths would have been cleaner data and worse
 * ergonomics: agents would hit a validation error mid-task for
 * describing impact in the way the field's own name invites. Prose
 * entries are still recorded — as `concept` — so nothing an agent
 * volunteered is discarded, and the decision→area association stays
 * queryable. Only the CLAIM that it is a file goes away.
 */

/** What an `impact` entry turned out to name. */
export type DecisionTargetType = 'file' | 'work_pack' | 'graph_node' | 'concept';

/**
 * Elisions like `apps/.../handler.ts` are prose about a path, not a
 * path. They can never resolve on disk, so treating them as files
 * guarantees a false "this file is gone" verdict.
 */
export function isElidedPath(value: string): boolean {
  return value.includes('...') || value.includes('…');
}

/**
 * Conservative path shape: contains a separator, ends in a short
 * extension, and is not an elision.
 *
 * Deliberately strict rather than clever. A false negative files a real
 * path as `concept` and loses one freshness check; a false positive
 * files prose as `file` and produces a confident wrong answer about
 * code that never existed. The second is the failure this exists to
 * prevent, so ambiguity resolves toward `concept`.
 *
 * Note this accepts package-relative paths like `src/foo.ts`, which the
 * gardening worker's own prose-scanning pattern deliberately does not.
 * The two answer different questions: this classifies a target an agent
 * stated explicitly, where `src/...` is a genuine (if ambiguous) path;
 * that one mines running prose, where a bare `src/...` is far more
 * likely to be incidental. Resolution ambiguity is the reader's
 * problem, not a reason to misfile the row.
 */
export function looksLikeFilePath(value: string): boolean {
  return value.includes('/') && /\.[A-Za-z0-9]{1,6}$/.test(value) && !isElidedPath(value);
}

/**
 * Classify one raw `impact` entry.
 *
 * Returns null for entries that carry no target at all (empty, or a
 * bare `graph_node:` / `work_pack:` prefix with nothing after it) so
 * the caller can skip them rather than write an edge pointing nowhere.
 */
export function classifyImpactTarget(
  raw: string,
): { readonly targetType: DecisionTargetType; readonly targetId: string } | null {
  const value = raw.trim();
  if (value.length === 0) return null;

  for (const [prefix, targetType] of [
    ['graph_node:', 'graph_node'],
    ['work_pack:', 'work_pack'],
  ] as const) {
    if (value.startsWith(prefix)) {
      const targetId = value.slice(prefix.length).trim();
      return targetId.length > 0 ? { targetType, targetId } : null;
    }
  }

  return { targetType: looksLikeFilePath(value) ? 'file' : 'concept', targetId: value };
}
