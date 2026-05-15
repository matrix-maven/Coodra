/**
 * `packages/cli/src/lib/team-init/wizard.ts` — Phase B (clarity-pass-
 * plan, 2026-05-11). Pure orchestrator over the three bootstrap steps.
 *
 * The wizard has no IO of its own — no prompts, no console writes, no
 * fs reads. It accepts a `Steps` object containing the three bootstrap
 * functions (production or mocked), runs them in sequence, and returns
 * the cumulative result.
 *
 * Why this layer exists: the CLI wizard (readline-driven, terminal
 * output) and the web wizard (server-action-driven, search-params
 * state) both need the same step-by-step semantics — abort on first
 * failure, accumulate success values, surface remediation strings to
 * the user. Putting the sequencing logic in one place keeps both
 * front-ends parity-checked.
 *
 * The wizard is "step-streaming" — callers receive intermediate results
 * via the `onStep` callback so they can render per-step output (CLI:
 * a "✓ pgvector installed" line; web: a status pill on the wizard
 * step indicator). Each callback fires exactly once per step.
 */

import { bootstrapClerk, type ClerkBootstrapResult } from './clerk-bootstrap.js';
import { type FinalizeConfigResult, finalizeConfig } from './finalize-config.js';
import { bootstrapPostgres, type PostgresBootstrapResult } from './postgres-bootstrap.js';

export interface WizardInput {
  readonly databaseUrl: string;
  readonly skipPgvector?: boolean;
  readonly clerkSecretKey: string;
  /** Optional pre-selected org id (skips the picker when set). */
  readonly preferredOrgId?: string;
  /** Test override — pass a pre-generated secret to make outputs deterministic. */
  readonly localHookSecret?: string;
  /** Test override — write under a tmp home instead of `~/.coodra`. */
  readonly homeOverride?: string;
}

export type WizardStep = 'postgres' | 'clerk' | 'finalize';

export type WizardStepResult =
  | { readonly step: 'postgres'; readonly result: PostgresBootstrapResult }
  | { readonly step: 'clerk'; readonly result: ClerkBootstrapResult }
  | { readonly step: 'finalize'; readonly result: FinalizeConfigResult };

export type WizardResult =
  | {
      readonly ok: true;
      readonly postgres: Extract<PostgresBootstrapResult, { ok: true }>;
      readonly clerk: Extract<ClerkBootstrapResult, { ok: true }>;
      readonly finalize: FinalizeConfigResult;
    }
  | {
      readonly ok: false;
      /** Which step failed. */
      readonly failedStep: WizardStep;
      /** The discriminated-union soft-failure from the step that failed. */
      readonly failure: Extract<PostgresBootstrapResult, { ok: false }> | Extract<ClerkBootstrapResult, { ok: false }>;
    };

export interface WizardDeps {
  readonly bootstrapPostgres: typeof bootstrapPostgres;
  readonly bootstrapClerk: typeof bootstrapClerk;
  readonly finalizeConfig: typeof finalizeConfig;
}

export const DEFAULT_WIZARD_DEPS: WizardDeps = {
  bootstrapPostgres,
  bootstrapClerk,
  finalizeConfig,
};

export interface RunWizardOptions {
  readonly input: WizardInput;
  readonly onStep?: (step: WizardStepResult) => void;
  readonly deps?: WizardDeps;
}

export async function runWizard(options: RunWizardOptions): Promise<WizardResult> {
  const deps = options.deps ?? DEFAULT_WIZARD_DEPS;
  const { input } = options;

  // Step 1 — Postgres
  const postgres = await deps.bootstrapPostgres({
    databaseUrl: input.databaseUrl,
    ...(input.skipPgvector !== undefined ? { skipPgvector: input.skipPgvector } : {}),
  });
  options.onStep?.({ step: 'postgres', result: postgres });
  if (!postgres.ok) {
    return { ok: false, failedStep: 'postgres', failure: postgres };
  }

  // Step 2 — Clerk
  const clerk = await deps.bootstrapClerk({
    secretKey: input.clerkSecretKey,
    ...(input.preferredOrgId !== undefined ? { preferredOrgId: input.preferredOrgId } : {}),
  });
  options.onStep?.({ step: 'clerk', result: clerk });
  if (!clerk.ok) {
    return { ok: false, failedStep: 'clerk', failure: clerk };
  }

  // The wizard's contract: at the point we reach step 3, an org MUST
  // be selected. The CLI prompts when `clerk.selectedOrg` is null;
  // the web wizard renders a radio picker. Both then resolve to a
  // chosen org and re-call `runWizard` with `preferredOrgId` so the
  // re-entrance hits the auto-select branch. If selectedOrg is still
  // null here, the caller is using the API wrong — surface as a
  // structured failure rather than crashing.
  if (clerk.selectedOrg === null) {
    return {
      ok: false,
      failedStep: 'clerk',
      failure: {
        ok: false,
        error: 'org_not_found',
        howToFix:
          `You are a member of ${clerk.orgs.length} Clerk org(s). The wizard needs you to choose one — re-run ` +
          'with `--org-id <id>` (CLI) or pick one in the org-picker step (web).',
        underlyingError: 'wizard.runWizard called with multi-org Clerk result but no preferredOrgId',
      },
    };
  }

  // Step 3 — Finalize. This is the only step that mutates disk.
  const finalize = deps.finalizeConfig({
    databaseUrl: input.databaseUrl,
    clerkUserId: clerk.userId,
    clerkOrgId: clerk.selectedOrg.id,
    clerkOrgSlug: clerk.selectedOrg.slug,
    ...(input.localHookSecret !== undefined ? { localHookSecret: input.localHookSecret } : {}),
    ...(input.homeOverride !== undefined ? { homeOverride: input.homeOverride } : {}),
  });
  options.onStep?.({ step: 'finalize', result: finalize });

  return { ok: true, postgres, clerk, finalize };
}
