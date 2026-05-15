import { existsSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join, posix, sep } from 'node:path';

import { parseFeatureMd } from './parse.js';
import { FEATURE_SLUG_RE } from './schema.js';
import type { FeatureFile, FeatureRow } from './types.js';

/**
 * @coodra/shared/features — filesystem walker.
 *
 * Pure read-side: walks `<projectRoot>/docs/features/` and yields one
 * `FeatureRow` per direct child directory that contains a parseable
 * `feature.md`. Sync because the rest of Coodra's read-side helpers
 * are sync (matches the meta.json + spec.md scanners in the web app);
 * keeps the bridge's SessionStart hot-path simple.
 *
 * What's INCLUDED in `FeatureRow.files`:
 *   - any file under the feature dir, recursive, depth-capped at 4
 *   - except `feature.md` itself (it's metadata, not a supporting file)
 *
 * What's EXCLUDED:
 *   - dotfiles (`.gitkeep`, `.DS_Store`)
 *   - anything under a `node_modules`, `.git`, or `dist` subfolder
 *     (defensive — features are docs, not code; nested deps are noise)
 *
 * What's NEVER thrown: malformed feature.md, unreadable supporting
 * files, deep recursion, oversized files. The walker collects errors
 * onto `FeatureRow.warnings` and keeps going. Callers decide what to
 * do with broken features.
 */

/** Cap on recursive depth when walking a feature's supporting files. */
const MAX_FILE_DEPTH = 4;

/** Names skipped when walking supporting files. */
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', '.next', '.turbo']);

/**
 * Resolve `<projectRoot>/docs/features/`. Returns the path even if the
 * directory doesn't exist — the caller checks `existsSync`. Centralised
 * so the CLI, the bridge, the web app, and the MCP server all agree on
 * one location.
 */
export function featuresRoot(projectCwd: string): string {
  return join(projectCwd, 'docs', 'features');
}

/**
 * Walk every feature in `<projectRoot>/docs/features/` and return their
 * `FeatureRow` views. Sorted by slug, ascending. Folders without a
 * readable `feature.md` are skipped silently (the indexer flags them as
 * "incomplete features" via a separate diagnostics path).
 */
export function walkFeatures(projectCwd: string): FeatureRow[] {
  const root = featuresRoot(projectCwd);
  if (!existsSync(root)) return [];

  const rows: FeatureRow[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  for (const entry of entries) {
    // Skip the index files (we generate these; they aren't features).
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
 * Read one feature directory into a `FeatureRow`. Exported so the CLI's
 * `feature show <slug>` and the web detail page can avoid walking the
 * whole tree when they already know which slug they want.
 *
 * Returns `null` only when `feature.md` is missing — that's the one
 * case where the directory isn't a feature at all. Frontmatter parse
 * errors don't return null; they surface on `row.warnings` so the UI
 * can display "this feature has invalid frontmatter, fix it here".
 */
export function readFeatureRow(slug: string, dir: string): FeatureRow | null {
  const featureMdPath = join(dir, 'feature.md');
  if (!existsSync(featureMdPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(featureMdPath, 'utf8');
  } catch (err) {
    // Unreadable feature.md — surface as a warning row so the UI doesn't
    // silently hide the directory. The frontmatter is null; the UI will
    // render an error state.
    return {
      slug,
      dir,
      frontmatter: { name: slug, description: '(feature.md unreadable)' },
      body: '',
      files: [],
      totalBytes: 0,
      lastUpdatedAt: new Date(0).toISOString(),
      warnings: [`feature_md_read_failed: ${(err as Error).message}`],
    };
  }

  const parsed = parseFeatureMd(raw);
  const files = walkFeatureFiles(dir);
  const featureMdStat = safeStat(featureMdPath);
  const featureMdBytes = featureMdStat?.size ?? Buffer.byteLength(raw, 'utf8');
  const featureMdMtime = featureMdStat?.mtime?.toISOString() ?? new Date().toISOString();
  const totalBytes = featureMdBytes + files.reduce((s, f) => s + f.bytes, 0);
  // Last-updated is the max mtime across feature.md + every supporting file.
  const lastUpdatedAt = files
    .map((f) => f.modifiedAt)
    .reduce((max, t) => (t > max ? t : max), featureMdMtime);

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
  // `feature add` always emits a matching `name`, but if a user
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
 * Walk every supporting file under a feature dir. Recursive,
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
    if (name === 'feature.md' && relDir === '') continue;
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
