import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createGetFeatureFileHandler, type GetFeatureFileHandlerDeps } from './handler.js';
import {
  type GetFeatureFileInput,
  getFeatureFileInputSchema,
  getFeatureFileOutputSchema,
} from './schema.js';

const getFeatureFileIdempotencyKey: IdempotencyKeyBuilder<GetFeatureFileInput> = (input, ctx) => {
  const proj = typeof input?.projectSlug === 'string' && input.projectSlug.length > 0 ? input.projectSlug : 'unknown';
  const slug = typeof input?.slug === 'string' && input.slug.length > 0 ? input.slug : 'unknown';
  const path = typeof input?.path === 'string' && input.path.length > 0 ? input.path : 'unknown';
  return {
    kind: 'readonly',
    key: `get_feature_file:${proj}:${slug}:${path}:${ctx.sessionId}`.slice(0, 200),
  };
};

export function createGetFeatureFileToolRegistration(
  deps: GetFeatureFileHandlerDeps,
): ToolRegistration<typeof getFeatureFileInputSchema, typeof getFeatureFileOutputSchema> {
  return {
    name: 'get_feature_file',
    title: 'Coodra: get_feature_file',
    description:
      'Call this AFTER get_feature surfaces a supporting file path that the body of feature.md references — never blindly load every file. ' +
      'Returns { ok: true, path, bytes, mediaType, content } where `content` is UTF-8 text. ' +
      'Soft-failure: project_not_found / project_cwd_unknown / feature_not_found / file_not_found / extension_blocked / file_too_large / path_escape, each with howToFix. ' +
      'Allowed extensions: .md, .txt, .json, .yaml/.yml, .toml, .csv, .tsv, .sql, .ts/.tsx/.js/.jsx/.mjs/.cjs, .py, .rs, .go, .java, .rb, .sh/.bash/.zsh, .html, .css, .xml. ' +
      'Hard cap: 256 KB per file. PDFs / images return extension_blocked; use the pdf-viewer skill or summarise the file via the user.',
    inputSchema: getFeatureFileInputSchema,
    outputSchema: getFeatureFileOutputSchema,
    idempotencyKey: getFeatureFileIdempotencyKey,
    handler: createGetFeatureFileHandler(deps),
  };
}
