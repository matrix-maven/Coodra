import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { getFeaturePackHandler } from './handler.js';
import { type GetFeaturePackInput, getFeaturePackInputSchema, getFeaturePackOutputSchema } from './schema.js';

/**
 * Registration for `coodra__get_feature_pack`.
 *
 * Static const (not a factory) per §9.1.1 common-patterns: the
 * handler consumes `ctx.featurePack` which is already wired into
 * `ContextDeps` at boot — no process-level config (db, mode, env)
 * needs to be closed over here.
 *
 * Description is verbatim from `system-architecture.md §24.4`. §24.3
 * anatomy is enforced by `@coodra/shared/test-utils::
 * assertManifestDescriptionValid` in the unit tests.
 */

const getFeaturePackIdempotencyKey: IdempotencyKeyBuilder<GetFeaturePackInput> = (input, _ctx) => {
  // Read-only: the registry skips DB-backed dedupe for readonly keys
  // but still logs the key for correlation. Caller-supplied
  // projectSlug + filePath (or '*' sentinel) differentiate the
  // path-scoped call from the whole-pack call. `_ctx` is part of the
  // `IdempotencyKeyBuilder` contract but unused here — the readonly
  // key is input-derived only.
  const slug = typeof input?.projectSlug === 'string' && input.projectSlug.length > 0 ? input.projectSlug : 'probe';
  const path = typeof input?.filePath === 'string' && input.filePath.length > 0 ? input.filePath : '*';
  return {
    kind: 'readonly',
    key: `readonly:get_feature_pack:${slug}:${path}`.slice(0, 200),
  };
};

export const getFeaturePackToolRegistration: ToolRegistration<
  typeof getFeaturePackInputSchema,
  typeof getFeaturePackOutputSchema
> = {
  name: 'get_feature_pack',
  title: 'Coodra: get_feature_pack',
  description:
    'Call this at SessionStart (or when switching to a different module mid-session) for the project\'s ' +
    'architectural blueprint — the MODULE-level spec, conventions, permitted files, and gotchas the tech lead has ' +
    'recorded for the area you\'re working in. Returns one Feature Pack scoped to the project (or to the module ' +
    'that owns `filePath` if provided): spec.md + implementation.md + techstack.md + meta.json. This is the ' +
    'long-lived architectural reference — NOT a callable skill. For on-demand skills (per-task recipes triggered ' +
    'by user prompts) use `list_features` + `get_feature` instead.',
  inputSchema: getFeaturePackInputSchema,
  outputSchema: getFeaturePackOutputSchema,
  idempotencyKey: getFeaturePackIdempotencyKey,
  handler: getFeaturePackHandler,
};
