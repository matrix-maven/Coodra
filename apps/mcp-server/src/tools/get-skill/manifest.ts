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

export function createGetSkillToolRegistration(
  deps: GetFeatureHandlerDeps,
): ToolRegistration<typeof getFeatureInputSchema, typeof getFeatureOutputSchema> {
  return {
    name: 'get_skill',
    title: 'Coodra: get_skill',
    description:
      "Call when the user's prompt matches a skill's trigger description from `list_skills` — never blindly " +
      'pre-load. Skills are pull-based recipes (single markdown + frontmatter + optional supporting files), ' +
      'distinct from Work Packs, which are issue-bound implementation records. Returns { ok: true, ' +
      'slug, frontmatter, body, files: [{path, bytes, modifiedAt}] } where `body` is the full skill markdown ' +
      '(expect 1-30 KB). Supporting file CONTENTS are NOT inlined — call `get_skill_file(slug, path)` ' +
      'per file. Soft-failures: project_not_found / project_cwd_unknown / feature_not_found, each with howToFix. ' +
      'Re-call when switching to a different skill mid-session. (Former name `get_feature` still works as an alias.)',
    inputSchema: getFeatureInputSchema,
    outputSchema: getFeatureOutputSchema,
    idempotencyKey: getFeatureIdempotencyKey,
    handler: createGetFeatureHandler(deps),
  };
}
