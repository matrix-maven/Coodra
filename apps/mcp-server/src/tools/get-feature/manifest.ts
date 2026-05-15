import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createGetFeatureHandler, type GetFeatureHandlerDeps } from './handler.js';
import { type GetFeatureInput, getFeatureInputSchema, getFeatureOutputSchema } from './schema.js';

const getFeatureIdempotencyKey: IdempotencyKeyBuilder<GetFeatureInput> = (input, ctx) => {
  const slug = typeof input?.slug === 'string' && input.slug.length > 0 ? input.slug : 'unknown';
  const proj = typeof input?.projectSlug === 'string' && input.projectSlug.length > 0 ? input.projectSlug : 'unknown';
  return {
    kind: 'readonly',
    key: `get_feature:${proj}:${slug}:${ctx.sessionId}`.slice(0, 200),
  };
};

export function createGetFeatureToolRegistration(
  deps: GetFeatureHandlerDeps,
): ToolRegistration<typeof getFeatureInputSchema, typeof getFeatureOutputSchema> {
  return {
    name: 'get_feature',
    title: 'Coodra: get_feature',
    description:
      'Call when the user\'s prompt matches a skill\'s trigger description from `list_features` — never blindly ' +
      'pre-load. Features are pull-based SKILLS (single markdown + frontmatter + optional supporting files), ' +
      'distinct from Feature Packs which are MODULE blueprints (push, via `get_feature_pack`). Returns { ok: true, ' +
      'slug, frontmatter, body, files: [{path, bytes, modifiedAt}] } where `body` is the full feature.md content ' +
      '(markdown, expect 1-30 KB). Supporting file CONTENTS are NOT inlined — call `get_feature_file(slug, path)` ' +
      'per file. Soft-failures: project_not_found / project_cwd_unknown / feature_not_found, each with howToFix. ' +
      'Re-call when switching to a different skill mid-session.',
    inputSchema: getFeatureInputSchema,
    outputSchema: getFeatureOutputSchema,
    idempotencyKey: getFeatureIdempotencyKey,
    handler: createGetFeatureHandler(deps),
  };
}
