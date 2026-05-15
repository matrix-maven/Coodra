import 'server-only';

import { redirect } from 'next/navigation';

/**
 * `apps/web-v2/lib/org-guard.ts` — the single-tenant invariant for the
 * team-hosted deployment pattern.
 *
 * Each team-hosted deployment serves exactly one Clerk org. The
 * deployment's `COODRA_EXPECTED_ORG_ID` env var encodes which one.
 * Visitors whose Clerk session belongs to a *different* org must be
 * hard-rejected — not "show them empty data," not "let them write
 * cross-tenant rows," but redirected to `/forbidden`.
 *
 * Why this matters even though the Postgres is already team-scoped:
 *
 *   - Defense in depth. The team's Postgres `org_id` filter is the
 *     primary safeguard. This guard is the second line so a buggy or
 *     missing WHERE clause never leaks data across tenants.
 *
 *   - A non-member with a valid Clerk session (e.g., signed into a
 *     different org in the same Clerk app) gets a clear "you're not in
 *     this team" message instead of an empty dashboard that's confusing.
 *
 *   - It catches misconfiguration: if an admin accidentally points two
 *     deployments at the same Postgres but different Clerk orgs, the
 *     guard prevents cross-deployment writes.
 *
 * Both `requireOrgMatch` and `assertOrgMatch` redirect to /forbidden via
 * Next's `redirect()` so they're terminal. Callers don't need to branch.
 *
 * The env var is documented in `docs/team-hosted-web-and-cli-install-plan.md`
 * §4.4. Empty / unset means "no check" — useful for solo and local-team
 * modes where there's no Clerk session to match against.
 */

export interface RequireOrgMatchOptions {
  /** When true, redirect to /forbidden on mismatch. When false, throw. */
  readonly redirectOnMismatch?: boolean;
}

/**
 * Verifies the Clerk session's orgId matches `COODRA_EXPECTED_ORG_ID`.
 *
 *   - `expected === undefined`  → check is a no-op (used in dev when
 *                                  the env var hasn't been set yet).
 *   - `actual === expected`      → returns silently.
 *   - `actual === null`          → user has no org context → redirect.
 *   - `actual !== expected`      → user is in a different org → redirect.
 *
 * Call this inside server components AFTER `auth()` has resolved a session.
 */
export async function requireOrgMatch(
  actual: string | null | undefined,
  options: RequireOrgMatchOptions = {},
): Promise<void> {
  const expected = process.env.COODRA_EXPECTED_ORG_ID;
  if (typeof expected !== 'string' || expected.length === 0) {
    // No expected-org pinned for this deployment → check is intentionally
    // skipped. Operator can wire it after the first member signs in.
    return;
  }
  if (typeof actual !== 'string' || actual.length === 0) {
    if (options.redirectOnMismatch !== false) redirect('/forbidden?reason=no_org');
    throw new Error(`requireOrgMatch: no Clerk org on session (expected ${expected})`);
  }
  if (actual !== expected) {
    if (options.redirectOnMismatch !== false) {
      redirect(`/forbidden?reason=org_mismatch&expected=${encodeURIComponent(expected)}&got=${encodeURIComponent(actual)}`);
    }
    throw new Error(`requireOrgMatch: orgId mismatch (expected ${expected}, got ${actual})`);
  }
}

/** Pure predicate variant — never throws or redirects; returns boolean. */
export function isOrgMatch(actual: string | null | undefined): boolean {
  const expected = process.env.COODRA_EXPECTED_ORG_ID;
  if (typeof expected !== 'string' || expected.length === 0) return true;
  return typeof actual === 'string' && actual === expected;
}
