import { existsSync, readdirSync, readFileSync, type Stats, statSync } from 'node:fs';
import { join, posix, sep } from 'node:path';

import { parseFeatureMd } from './parse.js';
import { FEATURE_SLUG_RE } from './schema.js';
import type { FeatureFile, FeatureRow } from './types.js';

/**
 * @coodra/shared/features — filesystem walker.
 *
 * Pure read-side: walks `<projectRoot>/.coodra/recipes/` and yields one
 * `FeatureRow` per direct child directory that contains a parseable
 * `recipe.md` (or legacy `feature.md`). Sync because the rest of Coodra's read-side helpers
 * are sync (matches the meta.json + spec.md scanners in the web app);
 * keeps the bridge's SessionStart hot-path simple.
 *
 * What's INCLUDED in `FeatureRow.files`:
 *   - any file under the feature dir, recursive, depth-capped at 4
 *   - except `recipe.md` / legacy `feature.md` itself (it's metadata, not a supporting file)
 *
 * What's EXCLUDED:
 *   - dotfiles (`.gitkeep`, `.DS_Store`)
 *   - anything under a `node_modules`, `.git`, or `dist` subfolder
 *     (defensive — features are docs, not code; nested deps are noise)
 *
 * What's NEVER thrown: malformed recipe.md, unreadable supporting
 * files, deep recursion, oversized files. The walker collects errors
 * onto `FeatureRow.warnings` and keeps going. Callers decide what to
 * do with broken features.
 */

/** Cap on recursive depth when walking a feature's supporting files. */
const MAX_FILE_DEPTH = 4;

/** Names skipped when walking supporting files. */
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', '.next', '.turbo']);

/**
 * The current directory name for agent recipes, plus legacy names used before
 * the 2026-07 Skills→Agent Recipes rename.
 */
export const RECIPES_DIR_NAME = 'recipes' as const;
export const SKILLS_DIR_NAME = 'skills' as const;
export const LEGACY_FEATURES_DIR_NAME = 'features' as const;
export const RECIPE_MD_NAME = 'recipe.md' as const;
export const LEGACY_FEATURE_MD_NAME = 'feature.md' as const;

/**
 * Resolve the effective on-disk home for this project's Agent Recipes. Returns
 * the path even if the directory doesn't exist — the caller checks
 * `existsSync`. Centralised so the CLI, the bridge, the web app, the
 * sync-daemon, and the MCP server all agree on one location.
 *
 * Precedence (mirrors the Graphify managed/legacy layout — NEVER relocate
 * a project's files silently):
 *   1. `.coodra/recipes/` exists → use it (the current home);
 *   2. else `docs/skills/` exists → use it (legacy Skills home);
 *   3. else `docs/features/` exists → use it (legacy Features home);
 *   4. else (greenfield) → `.coodra/recipes/` (the new default).
 *
 * This is a pure path resolution — it does not create anything. The one
 * writer that mkdir's is `generateFeaturesIndex`, which uses whatever this
 * returns, so a fresh project lands on `.coodra/recipes/` and legacy projects
 * stay where their existing recipes live.
 */
export function skillsRoot(projectCwd: string): string {
  const recipes = join(projectCwd, '.coodra', RECIPES_DIR_NAME);
  if (existsSync(recipes)) return recipes;
  const skills = join(projectCwd, 'docs', SKILLS_DIR_NAME);
  if (existsSync(skills)) return skills;
  const legacy = join(projectCwd, 'docs', LEGACY_FEATURES_DIR_NAME);
  if (existsSync(legacy)) return legacy;
  return recipes;
}

/** Current name for the project-local Agent Recipes root. */
export function recipesRoot(projectCwd: string): string {
  return skillsRoot(projectCwd);
}

/**
 * Candidate directories for `coodra recipe migrate` and diagnostics. None are
 * guaranteed to exist.
 */
export function skillsDirCandidates(projectCwd: string): {
  readonly recipes: string;
  readonly skills: string;
  readonly legacy: string;
} {
  return {
    recipes: join(projectCwd, '.coodra', RECIPES_DIR_NAME),
    skills: join(projectCwd, 'docs', SKILLS_DIR_NAME),
    legacy: join(projectCwd, 'docs', LEGACY_FEATURES_DIR_NAME),
  };
}

/** Current name for Agent Recipe directory candidates. */
export function recipesDirCandidates(projectCwd: string): ReturnType<typeof skillsDirCandidates> {
  return skillsDirCandidates(projectCwd);
}

/**
 * @deprecated Coodra "Features" / "Skills" were renamed to Agent Recipes
 * (2026-07). Use `skillsRoot`. Kept so external importers don't break.
 */
export function featuresRoot(projectCwd: string): string {
  return skillsRoot(projectCwd);
}

/**
 * Walk every recipe in the resolved recipes root and return their
 * `FeatureRow` views. Sorted by slug, ascending. Folders without a
 * readable `recipe.md` / legacy `feature.md` are skipped silently.
 */
export function walkFeatures(projectCwd: string): FeatureRow[] {
  const root = skillsRoot(projectCwd);
  if (!existsSync(root)) return [];

  const rows: FeatureRow[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  for (const entry of entries) {
    // Skip the index files (we generate these; they aren't recipes).
    if (entry === 'INDEX.md' || entry === 'INDEX.json') continue;
    // Skip dotfiles.
    if (entry.startsWith('.')) continue;
    // Slug regex must match — avoids picking up "README.md" or other
    // accidental siblings.
    if (!FEATURE_SLUG_RE.test(entry)) continue;
    const dir = join(root, entry);
    let stat: Stats;
    try {
      stat = statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const row = readFeatureRow(entry, dir);
    if (row !== null) rows.push(row);
  }

  rows.sort((a, b) => a.slug.localeCompare(b.slug));
  return rows;
}

/**
 * Read one recipe directory into a `FeatureRow`. Exported so the CLI's
 * `recipe show <slug>` and the web detail page can avoid walking the
 * whole tree when they already know which slug they want.
 *
 * Returns `null` only when neither `recipe.md` nor legacy `feature.md` exists
 * — that's the one case where the directory isn't a recipe at all. Frontmatter parse
 * errors don't return null; they surface on `row.warnings` so the UI
 * can display "this feature has invalid frontmatter, fix it here".
 */
export function readFeatureRow(slug: string, dir: string): FeatureRow | null {
  const recipeMdPath = join(dir, RECIPE_MD_NAME);
  const legacyMdPath = join(dir, LEGACY_FEATURE_MD_NAME);
  const recipePath = existsSync(recipeMdPath) ? recipeMdPath : existsSync(legacyMdPath) ? legacyMdPath : null;
  if (recipePath === null) return null;

  let raw: string;
  try {
    raw = readFileSync(recipePath, 'utf8');
  } catch (err) {
    // Unreadable feature.md — surface as a warning row so the UI doesn't
    // silently hide the directory. The frontmatter is null; the UI will
    // render an error state.
    return {
      slug,
      dir,
      frontmatter: { name: slug, description: '(recipe.md unreadable)' },
      body: '',
      files: [],
      totalBytes: 0,
      lastUpdatedAt: new Date(0).toISOString(),
      warnings: [`recipe_md_read_failed: ${(err as Error).message}`],
    };
  }

  const parsed = parseFeatureMd(raw);
  const files = walkFeatureFiles(dir);
  const featureMdStat = safeStat(recipePath);
  const featureMdBytes = featureMdStat?.size ?? Buffer.byteLength(raw, 'utf8');
  const featureMdMtime = featureMdStat?.mtime?.toISOString() ?? new Date().toISOString();
  const totalBytes = featureMdBytes + files.reduce((s, f) => s + f.bytes, 0);
  // Last-updated is the max mtime across feature.md + every supporting file.
  const lastUpdatedAt = files.map((f) => f.modifiedAt).reduce((max, t) => (t > max ? t : max), featureMdMtime);

  if (parsed.frontmatter === null) {
    // Frontmatter parsing failed — surface the errors as warnings so
    // the UI can render a fix-me state, but still give the row the
    // slug + body so the user can see what's there.
    return {
      slug,
      dir,
      frontmatter: { name: slug, description: '(invalid frontmatter)' },
      body: parsed.body,
      files,
      totalBytes,
      lastUpdatedAt,
      warnings: [...parsed.errors, ...parsed.warnings],
    };
  }

  // Slug-name mismatch is a warning, not a fatal error. The CLI's
  // `recipe add` always emits a matching `name`, but if a user
  // hand-edits frontmatter and forgets, we tell them politely.
  const warnings = [...parsed.warnings];
  if (parsed.frontmatter.name !== slug) {
    warnings.push(
      `frontmatter_name_mismatch: directory is "${slug}" but frontmatter says name="${parsed.frontmatter.name}". The directory name wins; fix the frontmatter to match.`,
    );
  }

  return {
    slug,
    dir,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    files,
    totalBytes,
    lastUpdatedAt,
    warnings,
  };
}

/**
 * Walk every supporting file under a recipe dir. Recursive,
 * depth-capped. Returns POSIX-style relative paths sorted ascending.
 */
function walkFeatureFiles(featureDir: string): FeatureFile[] {
  const out: FeatureFile[] = [];
  walkRecursive(featureDir, '', 0, out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function walkRecursive(absDir: string, relDir: string, depth: number, out: FeatureFile[]): void {
  if (depth > MAX_FILE_DEPTH) return;
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if ((name === RECIPE_MD_NAME || name === LEGACY_FEATURE_MD_NAME) && relDir === '') continue;
    if (name.startsWith('.')) continue;
    if (SKIP_DIR_NAMES.has(name)) continue;
    const abs = join(absDir, name);
    const rel = relDir === '' ? name : posix.join(relDir, name);
    const stat = safeStat(abs);
    if (stat === null) continue;
    if (stat.isDirectory()) {
      walkRecursive(abs, rel, depth + 1, out);
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({
      path: toPosix(rel),
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
}

function safeStat(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
