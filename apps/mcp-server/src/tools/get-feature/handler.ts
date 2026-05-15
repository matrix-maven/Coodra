import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { lookupProjectBySlug, type DbHandle } from '@coodra/db';
import { featuresRoot, readFeatureRow } from '@coodra/shared/features';
import { createLogger } from '@coodra/shared';

import type { ToolContext } from '../../framework/tool-context.js';
import type { GetFeatureInput, GetFeatureOutput } from './schema.js';

/**
 * Handler for `coodra__get_feature`.
 *
 * Loads the body of one feature on demand, after the agent has decided
 * (via `list_features`) that the feature is relevant to the current
 * task. The skill-pattern split is exactly this: index → fetch.
 *
 * Returns frontmatter + body + supporting-file metadata. Supporting
 * files' contents are NOT included; the agent fetches them
 * individually via `get_feature_file` so the registry can apply
 * extension / size gates per file.
 */

export interface GetFeatureHandlerDeps {
  readonly db: DbHandle;
}

const handlerLogger = createLogger('mcp-server.tool.get_feature');

export function createGetFeatureHandler(
  deps: GetFeatureHandlerDeps,
): (input: GetFeatureInput, ctx: ToolContext) => Promise<GetFeatureOutput> {
  return async function handle(input, _ctx) {
    const project = await lookupProjectBySlug(deps.db, input.projectSlug);
    if (project === null) {
      return {
        ok: false,
        error: 'project_not_found',
        howToFix:
          `No projects row for slug "${input.projectSlug}". Run \`coodra init\` from the project root, or check the slug.`,
      };
    }
    if (project.cwd === null) {
      return {
        ok: false,
        error: 'project_cwd_unknown',
        howToFix:
          'This project has no recorded cwd. Open Claude Code inside the project root once so the bridge can backfill `projects.cwd`.',
      };
    }
    const dir = join(featuresRoot(project.cwd), input.slug);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      handlerLogger.info(
        { event: 'get_feature_not_found', projectSlug: input.projectSlug, slug: input.slug, dir },
        'get_feature: feature directory missing',
      );
      return {
        ok: false,
        error: 'feature_not_found',
        howToFix:
          `No feature at \`${dir}\`. Call \`coodra__list_features\` to see what's available, or \`coodra feature add ${input.slug}\` to create it.`,
      };
    }
    const row = readFeatureRow(input.slug, dir);
    if (row === null) {
      // Directory exists but has no feature.md — the walker would have
      // also skipped this in list_features, so the agent shouldn't have
      // seen this slug. Treat as feature_not_found to keep the
      // soft-failure surface tight.
      return {
        ok: false,
        error: 'feature_not_found',
        howToFix:
          `\`${dir}\` exists but has no \`feature.md\`. Either remove the empty directory or run \`coodra feature add ${input.slug} --force\` to scaffold one.`,
      };
    }

    return {
      ok: true,
      slug: row.slug,
      frontmatter: {
        name: row.frontmatter.name,
        description: row.frontmatter.description,
        whenNotToUse: row.frontmatter.whenNotToUse ?? null,
        maturity: row.frontmatter.maturity ?? 'draft',
        tags: [...(row.frontmatter.tags ?? [])],
        owners: [...(row.frontmatter.owners ?? [])],
      },
      body: row.body,
      files: row.files.map((f) => ({
        path: f.path,
        bytes: f.bytes,
        modifiedAt: f.modifiedAt,
      })),
      warnings: [...row.warnings],
    };
  };
}
