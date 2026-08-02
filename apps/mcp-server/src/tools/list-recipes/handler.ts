import { existsSync, statSync } from 'node:fs';

import { type DbHandle, lookupProjectBySlug } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { generateFeaturesIndex, skillsRoot } from '@coodra/shared/features';

import type { ToolContext } from '../../framework/tool-context.js';
import type { ListFeaturesInput, ListFeaturesOutput } from './schema.js';

/**
 * Handler for `coodra__list_recipes`.
 *
 * Resolution order:
 *   1. `projectSlug` → `projects.cwd` via `lookupProjectBySlug`. The cwd
 *      is the absolute project root (the directory containing
 *      `.coodra.json`). Recorded by the bridge / CLI on first
 *      registration; always populated for projects created post the
 *      2026-05-08 schema bump.
 *
 *   2. `<cwd>/.coodra/recipes/` (or the legacy `docs/features/`) must exist on
 *      disk. Otherwise return `features_dir_missing` (stable error code kept
 *      for back-compat) so the agent can prompt the user to add a first skill
 *      via the web wizard or `coodra recipe add`.
 *
 *   3. Run `generateFeaturesIndex` (idempotent regen-on-read — same
 *      pattern the bridge SessionStart loader uses; the generator
 *      writes only when content changed). This means the agent always
 *      sees fresh state even if the user edited a recipe.md by hand
 *      since the last index.
 *
 *   4. Project the result down to the wire-shape `FeatureIndexEntry[]`
 *      and return.
 *
 * Soft-failure shape per `essentialsforclaude/09-common-patterns §9.1.2`
 * — every error branch carries `error` + `howToFix`.
 */

export interface ListFeaturesHandlerDeps {
  readonly db: DbHandle;
}

const handlerLogger = createLogger('mcp-server.tool.list_recipes');

export function createListFeaturesHandler(
  deps: ListFeaturesHandlerDeps,
): (input: ListFeaturesInput, ctx: ToolContext) => Promise<ListFeaturesOutput> {
  return async function handle(input, _ctx) {
    const project = await lookupProjectBySlug(deps.db, input.projectSlug);
    if (project === null) {
      handlerLogger.info(
        { event: 'list_recipes_project_not_found', projectSlug: input.projectSlug },
        'list_recipes: returning project_not_found soft-failure',
      );
      return {
        ok: false,
        error: 'project_not_found',
        howToFix:
          `No projects row for slug "${input.projectSlug}". Run \`coodra init\` from the project root to register it, ` +
          'or pass the slug exactly as it appears in `.coodra.json`.',
      };
    }
    if (project.cwd === null) {
      handlerLogger.warn(
        { event: 'list_recipes_project_cwd_unknown', projectSlug: input.projectSlug, projectId: project.id },
        'list_recipes: project row exists but cwd is null (legacy row)',
      );
      return {
        ok: false,
        error: 'project_cwd_unknown',
        howToFix:
          'This project has no recorded cwd (legacy row from before 2026-05-08). Open Claude Code inside the project root once — the bridge backfills `projects.cwd` on first SessionStart — or re-run `coodra init`.',
      };
    }
    const root = skillsRoot(project.cwd);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      handlerLogger.info(
        { event: 'list_recipes_dir_missing', projectSlug: input.projectSlug, root },
        'list_recipes: docs/features/ does not exist',
      );
      return {
        ok: false,
        error: 'features_dir_missing',
        howToFix: `No \`.coodra/recipes/\` directory in this project. Add a first skill via the web UI (Project home → Agent Recipes → + Add) or run \`coodra recipe add <slug>\` from inside the project root.`,
      };
    }

    let result: ReturnType<typeof generateFeaturesIndex>;
    try {
      result = generateFeaturesIndex({
        projectCwd: project.cwd,
        projectSlug: input.projectSlug,
      });
    } catch (err) {
      handlerLogger.warn(
        {
          event: 'list_recipes_regen_failed',
          projectSlug: input.projectSlug,
          err: err instanceof Error ? err.message : String(err),
        },
        'list_recipes: regen-on-read threw; surfacing features_dir_missing soft-failure',
      );
      return {
        ok: false,
        error: 'features_dir_missing',
        howToFix:
          'Failed to scan the recipes directory (`.coodra/recipes/` or legacy `docs/features/`). Check the directory permissions and ensure each subdirectory has a valid `recipe.md`.',
      };
    }

    return {
      ok: true,
      projectSlug: input.projectSlug,
      featuresRoot: root,
      features: result.index.features.map((f) => ({
        slug: f.slug,
        name: f.name,
        description: f.description,
        whenNotToUse: f.whenNotToUse,
        maturity: f.maturity,
        tags: [...f.tags],
        owners: [...f.owners],
        fileCount: f.fileCount,
        totalBytes: f.totalBytes,
        lastUpdatedAt: f.lastUpdatedAt,
        hasWarnings: f.hasWarnings,
      })),
    };
  };
}
