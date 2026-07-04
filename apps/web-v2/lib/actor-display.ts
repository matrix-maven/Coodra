import type { ClerkUserDisplay } from '@/lib/queries/clerk-users';

/**
 * `apps/web-v2/lib/actor-display.ts` — build the optional `displayName`
 * prop for `<ActorBadge>` from a `created_by_user_id` and the page-level
 * resolved-names map.
 *
 * Returns `{}` (no `displayName`) when the row has no author (null id —
 * e.g. a bridge-auto Context Pack, or pre-Phase-4 audit data) or when the
 * id couldn't be resolved to a display name. It NEVER dereferences an
 * undefined map entry.
 *
 * This replaces a per-page inline spread whose condition was inverted —
 * `(id !== null && map.get(id)?.label) !== undefined` evaluates to `true`
 * for a null id (because `false !== undefined`), then dereferenced
 * `map.get(null)!.label` and threw `Cannot read properties of undefined`,
 * 500-ing `/context-packs` and `/decisions` whenever the author column was
 * shown over any null-author row (i.e. always, in team mode).
 *
 * Works under `exactOptionalPropertyTypes`: the return type omits the key
 * entirely rather than passing `displayName: undefined`.
 */
export function actorDisplayNameProp(
  userId: string | null,
  names: Map<string, ClerkUserDisplay>,
): { displayName?: string } {
  if (userId === null) return {};
  const label = names.get(userId)?.label;
  return label !== undefined ? { displayName: label } : {};
}
