/**
 * `packages/cli/src/lib/team-init/index.ts` — Phase B (clarity-pass-
 * plan, 2026-05-11). Public re-exports for the team-init wizard
 * library, consumed by both the CLI command (`commands/team-init.ts`)
 * and the web server action
 * (`apps/web-v2/lib/actions/team-init.ts`).
 *
 * Centralising the export surface here keeps the cross-package import
 * paths short (`@coodra/cli/lib/team-init`) and gives a
 * single place to audit what web-v2 reaches into the CLI package for.
 */

export {
  bootstrapClerk,
  type ClerkBootstrapInput,
  type ClerkBootstrapResult,
  type ClerkOrgSummary,
} from './clerk-bootstrap.js';
export {
  type FinalizeConfigInput,
  type FinalizeConfigResult,
  finalizeConfig,
} from './finalize-config.js';
export {
  bootstrapPostgres,
  type PostgresBootstrapInput,
  type PostgresBootstrapResult,
} from './postgres-bootstrap.js';

export {
  DEFAULT_WIZARD_DEPS,
  type RunWizardOptions,
  runWizard,
  type WizardDeps,
  type WizardInput,
  type WizardResult,
  type WizardStep,
  type WizardStepResult,
} from './wizard.js';
