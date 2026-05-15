import 'server-only';

import { existsSync, statSync } from 'node:fs';

import {
  type FeatureRow,
  featuresRoot as featuresRootShared,
  generateFeaturesIndex,
  readFeatureRow,
  walkFeatures,
} from '@coodra/shared/features';
import { join } from 'node:path';

/**
 * `apps/web-v2/lib/queries/features.ts` — server-only thin wrappers over
 * `@coodra/shared/features`. The web app reads from disk
 * directly (no DB layer in v1 — Phase F adds a server action that
 * mutates the same files; the index DB cache is deferred to Phase H).
 *
 * Two responsibilities:
 *
 *   1. Anchor every read on `<projectCwd>/docs/features/` rather than
 *      web-v2's process.cwd(). The CWD comes from `projects.cwd`
 *      (added 2026-05-08 schema bump) and falls back to web-v2's cwd
 *      for legacy null-cwd rows. Same fallback the packs queries use,
 *      so a project with neither feature-packs nor features
 *      consistently shows the warning banner.
 *
 *   2. Always run the indexer on read (idempotent regen-on-read).
 *      This means the web list page never shows stale data even if
 *      a hook-bridge SessionStart hasn't fired since the user edited
 *      a feature.md by hand. Cost: one walk per render — bounded by
 *      Phase A unit-test idempotency guarantees.
 */

export interface ProjectFeaturesSnapshot {
  /** Absolute path to <projectCwd>/docs/features/. */
  readonly featuresRoot: string;
  /** True when docs/features/ exists on disk. */
  readonly rootExists: boolean;
  /** Lightweight per-feature views, sorted by slug. */
  readonly features: ReadonlyArray<FeatureSummary>;
  /** Slugs whose feature.md has validation warnings — surfaced in the UI as a "fix me" badge. */
  readonly slugsWithWarnings: ReadonlyArray<string>;
}

export interface FeatureSummary {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly whenNotToUse: string | null;
  readonly maturity: 'draft' | 'beta' | 'stable' | 'deprecated';
  readonly tags: ReadonlyArray<string>;
  readonly owners: ReadonlyArray<string>;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly lastUpdatedAt: string;
  readonly hasWarnings: boolean;
}

/**
 * Project-home features panel data. Returns the rendered index +
 * filesystem location. Every render runs the indexer (idempotent; no
 * cost when nothing changed).
 */
export function fetchProjectFeaturesSnapshot(args: {
  readonly projectSlug: string;
  readonly projectCwd: string;
}): ProjectFeaturesSnapshot {
  const root = featuresRootShared(args.projectCwd);
  const rootExists = existsSync(root) && statSync(root).isDirectory();
  if (!rootExists) {
    return { featuresRoot: root, rootExists: false, features: [], slugsWithWarnings: [] };
  }
  // Idempotent — no disk write when content unchanged. Surfaces a
  // canonical INDEX.json so other readers (the bridge, the MCP tools)
  // see the same view as the web.
  const result = generateFeaturesIndex({ projectCwd: args.projectCwd, projectSlug: args.projectSlug });
  return {
    featuresRoot: root,
    rootExists: true,
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
    slugsWithWarnings: [...result.slugsWithWarnings],
  };
}

/**
 * Detail-page data: full FeatureRow (frontmatter + body + supporting
 * files + warnings). Returns null when the directory doesn't exist OR
 * when feature.md is missing.
 *
 * Re-exposes the shared `FeatureRow` shape directly — the detail page
 * needs everything the parser produced, no projection.
 */
export function fetchFeatureDetail(args: {
  readonly projectCwd: string;
  readonly slug: string;
}): FeatureRow | null {
  const root = featuresRootShared(args.projectCwd);
  if (!existsSync(root)) return null;
  const dir = join(root, args.slug);
  if (!existsSync(dir)) return null;
  return readFeatureRow(args.slug, dir);
}

/**
 * Re-export for the detail-page header which prints the resolved root.
 */
export function featuresRootForProject(projectCwd: string): string {
  return featuresRootShared(projectCwd);
}

/**
 * Re-export the walk for callers that want every row (no INDEX
 * generation cost). Used by the file-render route which needs to
 * confirm a feature exists before reading one of its files.
 */
export function walkProjectFeatures(projectCwd: string): ReadonlyArray<FeatureRow> {
  return walkFeatures(projectCwd);
}
