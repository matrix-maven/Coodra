import { describe, expect, it } from 'vitest';

import { actorDisplayNameProp } from '@/lib/actor-display';
import type { ClerkUserDisplay } from '@/lib/queries/clerk-users';

/**
 * Regression guard for the `/context-packs` + `/decisions` 500.
 *
 * The original inline spread inverted its condition —
 * `(id !== null && map.get(id)?.label) !== undefined` is `true` for a
 * null id (because `false !== undefined`), then dereferenced
 * `map.get(null)!.label` and threw `Cannot read properties of undefined`.
 * tsc couldn't catch it (an `as string` + `!` masked the deref), so this
 * behavioral test is the durable backstop.
 */
describe('actorDisplayNameProp', () => {
  const names = new Map<string, ClerkUserDisplay>([
    ['user_alice', { label: 'alice@acme.com', email: 'alice@acme.com' }],
  ]);

  it('returns {} for a null author (the bridge-auto / pre-Phase-4 case that crashed)', () => {
    expect(actorDisplayNameProp(null, names)).toEqual({});
  });

  it('returns {} when the id is absent from the map (Clerk down / deleted user)', () => {
    expect(actorDisplayNameProp('user_ghost', names)).toEqual({});
  });

  it('returns the resolved displayName for a known author', () => {
    expect(actorDisplayNameProp('user_alice', names)).toEqual({ displayName: 'alice@acme.com' });
  });

  it('never throws and omits the key (not displayName: undefined) so exactOptionalPropertyTypes holds', () => {
    const out = actorDisplayNameProp(null, names);
    expect('displayName' in out).toBe(false);
  });
});
