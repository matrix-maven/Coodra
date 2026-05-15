/**
 * `packages/cli/src/lib/team-init/clerk-jwt-template.ts` — Phase H.12.
 *
 * Auto-create the `coodra_cli` JWT template in the admin's Clerk
 * instance via the Backend API. Replaces the previous manual step where
 * the admin had to go into the Clerk dashboard → JWT Templates → "New
 * template" → fill in claims by hand (and got it wrong roughly every
 * other time, producing tokens that the verifier rejected with
 * `org_id missing`).
 *
 * The template the CLI needs:
 *   - name: `coodra_cli`
 *   - claims: `org_id`, `org_role`, `email` (the three fields
 *     `verify-clerk-jwt.ts::extractClaims` reads)
 *   - lifetime: 86400s (24h) — long-lived for a CLI session token
 *
 * Idempotency: the API allows GET listing; we list templates and skip
 * the POST when the name already exists. The body of an existing
 * template isn't reconciled (a previous admin may have intentionally
 * adjusted the claims). Future audit work could surface drift.
 *
 * Failure modes:
 *   - 401 → bad secret key. Caller handles via the existing
 *     `bootstrapClerk` error classification.
 *   - 403 → secret key lacks `jwt_templates:create`. Most often this is
 *     a fine-grained API key with the wrong scopes; the admin must
 *     promote to a regular Secret Key.
 *   - 422 → claim template syntax error. Should not happen in this
 *     code (claims are static strings) but reported defensively.
 *   - Other → returned as `transient_error` so the wizard surfaces the
 *     message verbatim.
 *
 * **Not throwing.** Like the rest of the wizard helpers, returns a
 * discriminated-union result so the CLI can branch on the error code
 * and pick the right remediation copy.
 */

export const COODRA_CLI_TEMPLATE_NAME = 'coodra_cli';

export interface EnsureJwtTemplateInput {
  readonly secretKey: string;
  /**
   * Override the Clerk Backend API base. Defaults to
   * `https://api.clerk.com/v1`. Used in tests to point at a mock server.
   */
  readonly apiBase?: string;
  /**
   * 24h default. Override only for testing.
   */
  readonly lifetimeSeconds?: number;
}

export type EnsureJwtTemplateResult =
  | { readonly ok: true; readonly status: 'created' | 'already_exists'; readonly templateId: string | null }
  | {
      readonly ok: false;
      readonly error: 'unauthorized' | 'forbidden' | 'rejected' | 'transient_error';
      readonly howToFix: string;
      readonly underlyingError: string;
    };

interface ListJwtTemplatesResponse {
  readonly data?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

interface CreateJwtTemplateResponse {
  readonly id?: string;
  readonly errors?: ReadonlyArray<{ readonly message?: string; readonly code?: string }>;
}

const DEFAULT_LIFETIME_SECONDS = 86400;
const DEFAULT_API_BASE = 'https://api.clerk.com/v1';

/**
 * Idempotently ensure the `coodra_cli` JWT template exists in the
 * Clerk instance the secret key authenticates to.
 */
export async function ensureCoodraCliJwtTemplate(input: EnsureJwtTemplateInput): Promise<EnsureJwtTemplateResult> {
  const apiBase = (input.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '');
  const lifetime = input.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS;

  // Step 1 — list existing templates. Look for `name === 'coodra_cli'`.
  let listResponse: Response;
  try {
    listResponse = await fetch(`${apiBase}/jwt_templates`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.secretKey}`,
        accept: 'application/json',
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: 'transient_error',
      howToFix:
        'Could not reach Clerk Backend API (network error). Check your internet connection and re-run the wizard.',
      underlyingError: err instanceof Error ? err.message : String(err),
    };
  }
  if (listResponse.status === 401) {
    return {
      ok: false,
      error: 'unauthorized',
      howToFix:
        'Clerk Backend API rejected the Secret Key. Re-check the key value (must start with `sk_test_` or `sk_live_`) ' +
        'and that it belongs to the same Clerk instance you intend to use for Coodra.',
      underlyingError: `HTTP 401 from GET ${apiBase}/jwt_templates`,
    };
  }
  if (listResponse.status === 403) {
    return {
      ok: false,
      error: 'forbidden',
      howToFix:
        'Your Clerk Secret Key lacks `jwt_templates:read` permission. If you minted a fine-grained API key, replace it ' +
        'with a standard Secret Key from Clerk dashboard → API Keys → Secret Keys.',
      underlyingError: `HTTP 403 from GET ${apiBase}/jwt_templates`,
    };
  }
  if (!listResponse.ok) {
    return {
      ok: false,
      error: 'transient_error',
      howToFix:
        `Unexpected HTTP ${listResponse.status} from Clerk Backend API when listing JWT templates. ` +
        "Re-run the wizard; if the error persists, check Clerk's status page.",
      underlyingError: `HTTP ${listResponse.status} from GET ${apiBase}/jwt_templates`,
    };
  }

  let listJson: ListJwtTemplatesResponse;
  try {
    listJson = (await listResponse.json()) as ListJwtTemplatesResponse;
  } catch (err) {
    return {
      ok: false,
      error: 'transient_error',
      howToFix:
        "Clerk returned a non-JSON list response. Re-run the wizard; if it persists, check Clerk's status page.",
      underlyingError: err instanceof Error ? err.message : String(err),
    };
  }

  const existing = (listJson.data ?? []).find((t) => t.name === COODRA_CLI_TEMPLATE_NAME);
  if (existing !== undefined) {
    return { ok: true, status: 'already_exists', templateId: existing.id };
  }

  // Step 2 — create. POST body uses Clerk's template-substitution
  // syntax (`{{org.id}}` etc.) so the signed claim reflects the
  // requesting session at sign time.
  const body = {
    name: COODRA_CLI_TEMPLATE_NAME,
    claims: {
      org_id: '{{org.id}}',
      org_role: '{{org.role}}',
      email: '{{user.primary_email_address}}',
    },
    lifetime,
    allowed_clock_skew: 5,
  };

  let createResponse: Response;
  try {
    createResponse = await fetch(`${apiBase}/jwt_templates`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.secretKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      error: 'transient_error',
      howToFix: 'Could not reach Clerk Backend API (network error). Re-run the wizard.',
      underlyingError: err instanceof Error ? err.message : String(err),
    };
  }

  if (createResponse.status === 401) {
    return {
      ok: false,
      error: 'unauthorized',
      howToFix: 'Clerk Backend API rejected the Secret Key during template creation. Re-check the key value.',
      underlyingError: `HTTP 401 from POST ${apiBase}/jwt_templates`,
    };
  }
  if (createResponse.status === 403) {
    return {
      ok: false,
      error: 'forbidden',
      howToFix:
        'Your Clerk Secret Key lacks `jwt_templates:create` permission. Use a standard Secret Key (not a fine-grained one) from Clerk dashboard → API Keys.',
      underlyingError: `HTTP 403 from POST ${apiBase}/jwt_templates`,
    };
  }

  // Some Clerk instances return 422 with a structured error body when a
  // claim shape fails validation. Surface the message verbatim.
  if (!createResponse.ok) {
    let detail = '';
    try {
      const parsed = (await createResponse.json()) as CreateJwtTemplateResponse;
      if (parsed.errors !== undefined && parsed.errors.length > 0) {
        detail = parsed.errors.map((e) => `${e.code ?? 'unknown_code'}: ${e.message ?? '(no message)'}`).join('; ');
      }
    } catch {
      // ignore — fall through to the generic shape below.
    }
    return {
      ok: false,
      error: createResponse.status === 422 ? 'rejected' : 'transient_error',
      howToFix:
        `Clerk rejected the JWT template POST with HTTP ${createResponse.status}. ` +
        (detail.length > 0 ? `Detail: ${detail}. ` : '') +
        'You can create the template manually via Clerk dashboard → JWT Templates → New template, with name ' +
        `"${COODRA_CLI_TEMPLATE_NAME}" and claims org_id={{org.id}}, org_role={{org.role}}, email={{user.primary_email_address}}.`,
      underlyingError: `HTTP ${createResponse.status} from POST ${apiBase}/jwt_templates${detail.length > 0 ? ` — ${detail}` : ''}`,
    };
  }

  let createJson: CreateJwtTemplateResponse;
  try {
    createJson = (await createResponse.json()) as CreateJwtTemplateResponse;
  } catch {
    // Shouldn't happen on 2xx, but the wizard's success path doesn't
    // strictly need the template id. Treat as created.
    return { ok: true, status: 'created', templateId: null };
  }

  return { ok: true, status: 'created', templateId: typeof createJson.id === 'string' ? createJson.id : null };
}
