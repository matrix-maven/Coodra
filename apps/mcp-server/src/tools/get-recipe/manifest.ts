import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createGetFeatureHandler, type GetFeatureHandlerDeps } from './handler.js';
import { type GetFeatureInput, getFeatureInputSchema, getFeatureOutputSchema } from './schema.js';

const getFeatureIdempotencyKey: IdempotencyKeyBuilder<GetFeatureInput> = (input, ctx) => {
  const slug = typeof input?.slug === 'string' && input.slug.length > 0 ? input.slug : 'unknown';
  const proj = typeof input?.projectSlug === 'string' && input.projectSlug.length > 0 ? input.projectSlug : 'unknown';
  return {
    kind: 'readonly',
    key: `get_recipe:${proj}:${slug}:${ctx.sessionId}`.slice(0, 200),
  };
};

export function createGetRecipeToolRegistration(
  deps: GetFeatureHandlerDeps,
): ToolRegistration<typeof getFeatureInputSchema, typeof getFeatureOutputSchema> {
  return {
    name: 'get_recipe',
    title: 'Coodra: get_recipe',
    description:
      "Call when the user's prompt matches a recipe's trigger description from `list_recipes` — never blindly " +
      'pre-load. Agent Recipes are pull-based instructions (single markdown + frontmatter + optional supporting files), ' +
      'distinct from Work Packs, which are issue-bound implementation records. Returns { ok: true, ' +
      'slug, frontmatter, body, files: [{path, bytes, modifiedAt}] } where `body` is the full recipe markdown ' +
      '(expect 1-30 KB). Supporting file CONTENTS are NOT inlined — call `get_recipe_file(slug, path)` ' +
      'per file. Soft-failures: project_not_found / project_cwd_unknown / feature_not_found, each with howToFix. ' +
      'Re-call when switching to a different recipe mid-session.',
    inputSchema: getFeatureInputSchema,
    outputSchema: getFeatureOutputSchema,
    idempotencyKey: getFeatureIdempotencyKey,
    handler: createGetFeatureHandler(deps),
  };
}
