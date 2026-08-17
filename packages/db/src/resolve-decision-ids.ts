import { and, eq, inArray, like } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/resolve-decision-ids` — COOD-91.
 *
 * `save_context_pack` accepted `meta.decisionIds` verbatim and never
 * checked that the ids resolved. A pack could be saved referencing
 * nothing, the write succeeded, and the only symptom appeared much
 * later on the pack detail page as:
 *
 *   "No decisions link to this pack (legacy row, or the agent didn't
 *    set meta.decisionIds on save)."
 *
 * That message had to hedge across two very different states — nothing
 * set, versus something set that resolves to nothing — because the data
 * could not tell them apart. Only the second is a bug, and it was the
 * invisible one.
 *
 * Found when three packs saved during COOD-77 all stored 8-hex-char id
 * PREFIXES (`dec_367d21cf`) instead of the full UUID-suffixed ids
 * (`dec_367d21cf-df81-4ee7-b482-ab2e2666b4fa`). Every link was broken
 * and nothing anywhere reported a problem.
 *
 * ## Expand prefixes rather than rejecting them
 *
 * Abbreviating an id is a natural thing to do — the short form is what
 * appears in prose, commit messages and conversation. Making it work is
 * friendlier than making it an error, and it costs one indexed LIKE.
 *
 * Ambiguity is NOT resolved by guessing. A prefix matching two
 * decisions comes back as `ambiguous`, because silently binding a pack
 * to whichever row sorted first is exactly the class of quiet wrongness
 * this function exists to end.
 */

export interface DecisionIdResolution {
  /** Input id → full id. Includes exact matches (mapped to themselves). */
  readonly resolved: ReadonlyMap<string, string>;
  /** Inputs matching no decision in this project. */
  readonly unresolved: ReadonlyArray<string>;
  /** Inputs whose prefix matched more than one decision. */
  readonly ambiguous: ReadonlyArray<string>;
}

/** Prefix expansion is only attempted for plausible id shapes. */
const ID_PREFIX = /^dec_[0-9a-f-]{4,}$/;

/**
 * Resolve `meta.decisionIds` against the project's decisions.
 *
 * Scoped to `projectId` deliberately: a pack must not link to another
 * project's decision, and an id that exists elsewhere is — from this
 * pack's point of view — unresolved rather than valid.
 */
export async function resolveDecisionIds(
  db: DbHandle,
  projectId: string,
  ids: ReadonlyArray<string>,
): Promise<DecisionIdResolution> {
  const resolved = new Map<string, string>();
  const unresolved: string[] = [];
  const ambiguous: string[] = [];
  const unique = [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
  if (unique.length === 0) return { resolved, unresolved, ambiguous };

  // Fully branched per dialect. A `db.kind === 'sqlite' ? a : b` table
  // reference produces a UNION column type that drizzle's `.select()`
  // cannot accept — narrowing has to happen at the statement, not in a
  // local. (Same trap as apps/web-v2/lib/queries/memory-utilization.ts.)
  const exact = new Set<string>(
    db.kind === 'sqlite'
      ? (
          await db.db
            .select({ id: sqliteSchema.decisions.id })
            .from(sqliteSchema.decisions)
            .where(and(eq(sqliteSchema.decisions.projectId, projectId), inArray(sqliteSchema.decisions.id, unique)))
        ).map((row) => row.id)
      : (
          await db.db
            .select({ id: postgresSchema.decisions.id })
            .from(postgresSchema.decisions)
            .where(and(eq(postgresSchema.decisions.projectId, projectId), inArray(postgresSchema.decisions.id, unique)))
        ).map((row) => row.id),
  );
  for (const id of unique) if (exact.has(id)) resolved.set(id, id);

  for (const id of unique) {
    if (resolved.has(id)) continue;
    if (!ID_PREFIX.test(id)) {
      unresolved.push(id);
      continue;
    }
    // `%` is not escaped because ID_PREFIX already restricts the input
    // to `dec_` plus hex and dashes — no LIKE metacharacter can survive.
    const pattern = `${id}%`;
    const matches: string[] =
      db.kind === 'sqlite'
        ? (
            await db.db
              .select({ id: sqliteSchema.decisions.id })
              .from(sqliteSchema.decisions)
              .where(and(eq(sqliteSchema.decisions.projectId, projectId), like(sqliteSchema.decisions.id, pattern)))
              .limit(2)
          ).map((row) => row.id)
        : (
            await db.db
              .select({ id: postgresSchema.decisions.id })
              .from(postgresSchema.decisions)
              .where(and(eq(postgresSchema.decisions.projectId, projectId), like(postgresSchema.decisions.id, pattern)))
              .limit(2)
          ).map((row) => row.id);

    const only = matches[0];
    if (matches.length === 1 && only !== undefined) resolved.set(id, only);
    else if (matches.length > 1) ambiguous.push(id);
    else unresolved.push(id);
  }

  return { resolved, unresolved, ambiguous };
}

/**
 * Human-readable warnings for the tool response.
 *
 * Returns [] when everything resolved, so a caller can spread the
 * result without deciding whether the field is worth including.
 */
export function decisionIdWarnings(resolution: DecisionIdResolution): string[] {
  const warnings: string[] = [];
  if (resolution.unresolved.length > 0) {
    warnings.push(
      `meta.decisionIds: ${resolution.unresolved.length} id(s) match no decision in this project and were stored as given — ${resolution.unresolved.join(', ')}. The pack saved; the link did not.`,
    );
  }
  if (resolution.ambiguous.length > 0) {
    warnings.push(
      `meta.decisionIds: ${resolution.ambiguous.join(', ')} match more than one decision. Pass the full id — an ambiguous prefix is not expanded.`,
    );
  }
  return warnings;
}
