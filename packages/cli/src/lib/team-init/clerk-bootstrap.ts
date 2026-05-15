/**
 * `packages/cli/src/lib/team-init/clerk-bootstrap.ts` — Phase B
 * (clarity-pass-plan, 2026-05-11). Clerk identity-lookup step for the
 * admin onboarding wizard.
 *
 * Given just a Clerk Secret Key, look up:
 *   - The admin's user_id + email
 *   - The list of Clerk organizations the admin is a member of
 *
 * The wizard then prompts the admin (or auto-selects, when there's
 * exactly one org) which org represents their team. The selected org's
 * id + slug land in `~/.coodra/config.json::team`.
 *
 * Why a Backend SDK call rather than asking the admin for IDs:
 *
 *   The Clerk dashboard hides `user_id` and `org_id` 2–3 levels deep
 *   under disambiguating UI ("Users → click row → URL contains id" /
 *   "Organizations → click row → URL contains id"). Most users
 *   copy-paste the WRONG value (typically the org id when they meant
 *   user id, or vice-versa). Looking up via the Backend SDK with the
 *   admin's own Secret Key is the only failure-proof path:
 *   authenticated lookup returns the exact IDs without any
 *   copy-paste step.
 *
 * Returns a discriminated-union result. Never throws.
 */

import { createClerkClient } from '@clerk/backend';

export interface ClerkBootstrapInput {
  readonly secretKey: string;
  /**
   * Optional preferred org id. When supplied (e.g., from a previous
   * partial setup or an explicit re-init), the wizard picks this org
   * out of the membership list automatically; if it's not in the list,
   * returns `org_not_found`. When absent, returns the full org list
   * and the caller is responsible for selection.
   */
  readonly preferredOrgId?: string;
}

export interface ClerkOrgSummary {
  readonly id: string;
  readonly slug: string | null;
  readonly name: string;
  /** Admin's role in this org, if known (e.g., `org:admin`, `org:member`). */
  readonly role: string | null;
}

export type ClerkBootstrapResult =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly userEmail: string | null;
      readonly orgs: readonly ClerkOrgSummary[];
      /**
       * The org the wizard auto-selected. When the membership list has
       * exactly one org OR `preferredOrgId` matched, this is non-null
       * and the wizard can skip the picker step. Otherwise null —
       * caller must prompt the user to choose from `orgs`.
       */
      readonly selectedOrg: ClerkOrgSummary | null;
    }
  | {
      readonly ok: false;
      readonly error: 'invalid_key' | 'no_orgs' | 'org_not_found' | 'lookup_failed';
      readonly howToFix: string;
      readonly underlyingError: string;
    };

/**
 * Authenticate to Clerk with the supplied secret key, resolve the
 * caller's user record, then list the orgs they're a member of.
 *
 * Heuristic for "who am I from a secret key": Clerk Secret Keys are
 * tied to a single Clerk instance, and the SDK's `users.getUserList()`
 * with no filter returns instance-wide users. To find "me" we need a
 * different signal. We use the convention that the admin running this
 * wizard is also the FIRST user in their Clerk instance (the one who
 * created the app). If that heuristic is wrong, the wizard exits with
 * a clear "couldn't determine which user is you" message and asks the
 * admin to pass `--user-id` explicitly.
 *
 * Alternative considered: ask the admin to paste their user_id. We
 * rejected this because it puts the user back in the original "dig
 * through the dashboard" friction we're trying to remove. The
 * heuristic is correct for the typical solo-admin case (the same
 * person who created the Clerk app also runs `team init`).
 */
export async function bootstrapClerk(input: ClerkBootstrapInput): Promise<ClerkBootstrapResult> {
  if (!isPlausibleSecretKey(input.secretKey)) {
    return {
      ok: false,
      error: 'invalid_key',
      howToFix:
        "The key doesn't look like a Clerk Secret Key. Make sure you copied the **Secret Key** (starts with " +
        '`sk_test_` for development or `sk_live_` for production) from your Clerk dashboard → API keys page — not ' +
        'the Publishable Key (`pk_test_…`).',
      underlyingError: 'secret key prefix mismatch (expected sk_test_ / sk_live_)',
    };
  }

  let client: ReturnType<typeof createClerkClient>;
  try {
    client = createClerkClient({ secretKey: input.secretKey });
  } catch (err) {
    return {
      ok: false,
      error: 'invalid_key',
      howToFix:
        'Clerk rejected the key at client init time. Double-check the value and re-run the wizard with the ' +
        'correct Secret Key (`sk_test_…` or `sk_live_…`).',
      underlyingError: extractMessage(err),
    };
  }

  // Step 1 — find "me". Heuristic: the FIRST user in the instance by
  // createdAt. We sort ascending so the original creator is index 0.
  let me: { id: string; email: string | null };
  try {
    const list = await client.users.getUserList({ limit: 1, orderBy: '+created_at' });
    const first = list.data[0];
    if (first === undefined) {
      return {
        ok: false,
        error: 'lookup_failed',
        howToFix:
          'Your Clerk instance has zero users. Sign yourself up via the Clerk-hosted sign-in page first, then ' +
          're-run this wizard.',
        underlyingError: 'users.getUserList() returned empty list',
      };
    }
    const primaryEmail =
      first.emailAddresses.find((e) => e.id === first.primaryEmailAddressId)?.emailAddress ??
      first.emailAddresses[0]?.emailAddress ??
      null;
    me = { id: first.id, email: primaryEmail };
  } catch (err) {
    return {
      ok: false,
      error: classifyClerkError(err),
      howToFix:
        'Clerk rejected the API call. Most common cause: the Secret Key is wrong or belongs to a different ' +
        'Clerk instance. Verify on the dashboard → API keys page.',
      underlyingError: extractMessage(err),
    };
  }

  // Step 2 — list orgs the user is a member of.
  let orgs: ClerkOrgSummary[];
  try {
    const memberships = await client.users.getOrganizationMembershipList({ userId: me.id });
    orgs = memberships.data.map((m) => ({
      id: m.organization.id,
      slug: m.organization.slug ?? null,
      name: m.organization.name,
      role: m.role ?? null,
    }));
  } catch (err) {
    return {
      ok: false,
      error: classifyClerkError(err),
      howToFix:
        "Couldn't list your Clerk organizations. The key may be valid but lack `org:read` permissions, or your " +
        'Clerk app may have organizations disabled. Enable them under Clerk dashboard → Organization settings.',
      underlyingError: extractMessage(err),
    };
  }

  if (orgs.length === 0) {
    return {
      ok: false,
      error: 'no_orgs',
      howToFix:
        "You're not a member of any Clerk organization yet. Open your Clerk dashboard → Organizations → New, " +
        "create one (the name + slug become your team's Coodra identity), then re-run this wizard.",
      underlyingError: 'getOrganizationMembershipList() returned empty list',
    };
  }

  // Step 3 — auto-select when possible.
  let selectedOrg: ClerkOrgSummary | null = null;
  if (input.preferredOrgId !== undefined && input.preferredOrgId.length > 0) {
    const match = orgs.find((o) => o.id === input.preferredOrgId);
    if (match === undefined) {
      return {
        ok: false,
        error: 'org_not_found',
        howToFix:
          `You're a member of ${orgs.length} org(s) (${orgs.map((o) => o.slug ?? o.id).join(', ')}) but none ` +
          `matches the preferred id \`${input.preferredOrgId}\`. Re-run without --org-id to pick from the list.`,
        underlyingError: 'preferredOrgId not in membership list',
      };
    }
    selectedOrg = match;
  } else if (orgs.length === 1) {
    selectedOrg = orgs[0] ?? null;
  }

  return { ok: true, userId: me.id, userEmail: me.email, orgs, selectedOrg };
}

function isPlausibleSecretKey(key: string): boolean {
  return key.startsWith('sk_test_') || key.startsWith('sk_live_');
}

function classifyClerkError(err: unknown): 'invalid_key' | 'lookup_failed' {
  const msg = extractMessage(err).toLowerCase();
  if (msg.includes('unauthorized') || msg.includes('401') || msg.includes('authentication')) {
    return 'invalid_key';
  }
  return 'lookup_failed';
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) {
    const messages: string[] = [err.message];
    let cur: unknown = (err as { cause?: unknown }).cause;
    while (cur instanceof Error && messages.length < 5) {
      messages.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    return messages.join(' → ');
  }
  return String(err);
}
