import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { featuresRoot, generateFeaturesIndex, renderFeatureMd } from '@coodra/shared/features';
import type { WriteAction, WriteOutcome } from './types.js';

/**
 * `graphify-feature.ts` — the bundled `graphify-seed-packs` Feature
 * recipe (Module 09, Track 9B / phase G3).
 *
 * A Feature is a skill-style knowledge unit
 * (`docs/features/<slug>/feature.md`) the agent loads on demand. This
 * one is the skill that drives the Graphify→Coodra fusion: it tells the
 * agent how to turn Graphify's Leiden community breakdown into draft
 * Feature Packs via `coodra__seed_feature_packs_from_graph`.
 *
 * The recipe is bundled as an embedded string (no separate asset file,
 * no build-script copy step — it compiles straight into `dist/`).
 * `coodra graphify enable` and `coodra init`'s Graphify step both seed
 * it into the project's `docs/features/` directory.
 */

/** The slug + directory name of the bundled feature. */
export const GRAPHIFY_SEED_FEATURE_SLUG = 'graphify-seed-packs';

const FRONTMATTER = {
  name: GRAPHIFY_SEED_FEATURE_SLUG,
  description:
    'Use this when the user wants to bootstrap Feature Packs from the codebase structure — ' +
    '"seed feature packs from the graph", "turn our Graphify communities into feature packs", ' +
    '"cold-start the knowledge layer". Pulls the Leiden community breakdown from the Graphify MCP ' +
    'server (or `graphify-out/graph.json`) and hands it to `coodra__seed_feature_packs_from_graph`, ' +
    'which writes one draft Feature Pack per community.',
  whenNotToUse:
    'Skip when the Graphify MCP server is not wired (`coodra graphify status` shows it absent) or ' +
    '`graphify-out/graph.json` has not been generated. Not for editing or activating existing ' +
    'Feature Packs — pack activation is a tech-lead review action in the Coodra web app.',
  maturity: 'beta',
  tags: ['graphify', 'feature-packs', 'cold-start'],
} as const;

const BODY = `# graphify-seed-packs

> Loaded on demand via \`coodra__get_feature({slug:"graphify-seed-packs"})\`.
> This skill turns Graphify's codebase-structure analysis into a first
> set of draft Feature Packs — the Module 09 cold-start path.

## What this does

Graphify (\`safishamsi/graphify\`) builds a knowledge graph of the
repository and runs Leiden community detection — it clusters the
codebase into cohesive groups of files and symbols. Each cluster is a
natural candidate for one Feature Pack.

This skill bridges the two MCP servers the agent holds: it pulls the
community breakdown from Graphify and hands it to Coodra's
\`coodra__seed_feature_packs_from_graph\` tool, which writes one **draft**
Feature Pack per community. Drafts are hidden from agents until a tech
lead reviews and activates them — seeding never pushes unreviewed
knowledge into a live session.

## Prerequisites

1. The Graphify MCP server is wired — \`coodra graphify status\` shows the
   \`graphify\` entry present. If not, run \`coodra graphify enable\`.
2. Graphify has analysed the repo, so \`graphify-out/graph.json\` exists.
   If not, run \`/graphify .\` in the assistant (install with
   \`uv tool install graphifyy\`).
3. The project is registered with Coodra (\`coodra init\` has run) — the
   \`projectSlug\` you pass must match a row in \`projects\`.

If any prerequisite is missing, tell the user exactly which one and stop.
Do not fabricate community data.

## Procedure

1. Confirm \`graphify-out/graph.json\` exists at the repo root.

2. Get the community breakdown. Two ways — prefer the first:

   **(a) Read the graph file directly.** \`graphify-out/graph.json\` is
   NetworkX node-link JSON: \`{ "nodes": [...], "links": [...] }\`. Each
   node carries a \`community\` attribute (its Leiden cluster id) and a
   \`file\` / \`path\` attribute. Group nodes by \`community\`; for each
   community collect the distinct member files, the highest-degree
   "god node" symbols, and a one-line summary of what the cluster does.

   **(b) Ask the Graphify MCP server.** If it exposes structural query
   tools (\`query_graph\` and friends), ask it for the community
   breakdown instead of parsing the file yourself.

3. Build the \`communities\` array. Each entry:
   - \`communityId\` — the Leiden community id (string).
   - \`label\` — a short, human cluster name. It becomes the draft pack's
     title and slug suffix, so keep it readable ("auth & sessions", not
     "community 7").
   - \`godNodes\` — optional: high-degree symbols in the cluster.
   - \`memberFiles\` — optional: the cluster's source files.
   - \`summary\` — optional: one paragraph on what the cluster does.

4. Call the Coodra tool:

   \`\`\`
   coodra__seed_feature_packs_from_graph({
     projectSlug: "<the project slug>",
     communities: [ ...the array from step 3... ]
   })
   \`\`\`

   It creates or updates one draft Feature Pack per community —
   idempotent, so re-running updates packs in place. Cap: 100
   communities per call.

5. Report what landed. Each \`seeded\` entry is \`{slug, communityId,
   created}\`. Tell the user the packs are **drafts** and must be
   activated by a tech lead in the Coodra web app before any agent will
   see them.

## Things to watch out for

- Never invent communities. If \`graph.json\` is missing or empty, stop
  and tell the user to run \`/graphify .\` first.
- This is a cold-start tool. On a repo that already has curated Feature
  Packs, re-seeding is rarely what the user wants — confirm intent first.
- Seeded packs are drafts on purpose. Never describe the seeded
  knowledge as "live" — it is not, until a tech lead activates it.
`;

/**
 * Render the canonical `graphify-seed-packs` feature.md content. Pure
 * and deterministic — two calls produce byte-identical output, so the
 * seeder can compare against disk for idempotency.
 */
export function renderGraphifySeedPacksFeature(): string {
  return renderFeatureMd({
    frontmatter: {
      name: FRONTMATTER.name,
      description: FRONTMATTER.description,
      whenNotToUse: FRONTMATTER.whenNotToUse,
      maturity: FRONTMATTER.maturity,
      tags: [...FRONTMATTER.tags],
    },
    body: BODY,
  });
}

export interface SeedGraphifyFeatureOptions {
  /** Project root — `docs/features/` is resolved under this. */
  readonly cwd: string;
  /** Project slug, written into the regenerated `INDEX.json`. */
  readonly projectSlug: string;
  /** Overwrite a drifted (user-edited) `graphify-seed-packs` feature.md. */
  readonly force: boolean;
  /** Report what would change without touching disk. */
  readonly dryRun: boolean;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotently seed `docs/features/graphify-seed-packs/feature.md` and
 * regenerate the features index. A re-run that finds an identical
 * feature.md is a no-op; a drifted (user-edited) one is preserved
 * unless `force`. Mirrors the 9·Core merge-don't-clobber discipline.
 */
export async function seedGraphifySeedPacksFeature(options: SeedGraphifyFeatureOptions): Promise<WriteOutcome> {
  const dir = join(featuresRoot(options.cwd), GRAPHIFY_SEED_FEATURE_SLUG);
  const featureMdPath = join(dir, 'feature.md');
  const rendered = renderGraphifySeedPacksFeature();

  let action: WriteAction;
  let notes: string;
  let write = false;

  if (!(await pathExists(featureMdPath))) {
    action = 'wrote';
    notes = 'seeded the graphify-seed-packs feature';
    write = true;
  } else {
    const current = await readFile(featureMdPath, 'utf8');
    if (current === rendered) {
      action = 'unchanged';
      notes = 'graphify-seed-packs feature already up to date';
    } else if (options.force) {
      action = 'forced';
      notes = 'overwrote the graphify-seed-packs feature';
      write = true;
    } else {
      action = 'unchanged';
      notes = 'graphify-seed-packs feature exists with custom edits; pass --force to overwrite';
    }
  }

  if (!options.dryRun) {
    if (write) {
      await mkdir(dir, { recursive: true });
      await writeFile(featureMdPath, rendered, 'utf8');
    }
    // Regenerate the index on every real run — idempotent, and it
    // repairs a missing INDEX.json even when the feature.md itself was
    // already up to date.
    generateFeaturesIndex({ projectCwd: options.cwd, projectSlug: options.projectSlug });
  }

  return { path: featureMdPath, action, notes };
}
