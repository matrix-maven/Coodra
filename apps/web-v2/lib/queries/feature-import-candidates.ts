import 'server-only';

import { existsSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

import { FEATURE_SLUG_RE, walkFeatures } from '@coodra/shared/features';

/**
 * `apps/web-v2/lib/queries/feature-import-candidates.ts` — scan a
 * project's filesystem for markdown documents that look like good
 * candidates for promotion to a skill-style feature.
 *
 * Path B of the onboarding plan: when a user lands in Coodra with
 * an existing project that already has scattered docs (`docs/auth.md`,
 * `specs/payments-spec.md`, `architecture/csv-import.md`), we don't
 * want them to start over from a blank wizard. We scan the project,
 * propose draft features, and let them check off which ones to promote.
 *
 * Heuristics — what counts as a "candidate":
 *
 *   1. The file lives under one of the well-known doc directories
 *      (`docs/`, `specs/`, `architecture/`, `arch/`, `design/`).
 *   2. Extension is `.md`.
 *   3. Size between MIN_BYTES and MAX_BYTES (skips empty stubs and
 *      runaway dumps).
 *   4. NOT under `docs/feature-packs/` or `docs/features/` — those
 *      are the pre-existing pack layer + the features layer itself.
 *   5. NOT a `README.md` at the project root (too generic to be a
 *      feature trigger; will hit the agent's "default conventions"
 *      noise floor).
 *
 * Each candidate gets a *suggested slug* derived from its filename
 * (kebab-case, sanitized through `FEATURE_SLUG_RE`) AND a *suggested
 * description* — the first non-heading line of the document, capped at
 * 200 chars. Both are advisory; the user edits them in the wizard
 * before accepting.
 *
 * The walker is depth-capped (4) and breadth-capped (50 candidates
 * total) so a sprawling monorepo doesn't blow the page render budget.
 */

const SCAN_DIRECTORIES = ['docs', 'specs', 'architecture', 'arch', 'design'] as const;

/** Skip if any path segment matches one of these names. */
const SKIP_SEGMENT_NAMES = new Set([
  'feature-packs',
  'features',
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.turbo',
  'coverage',
  '__tests__',
  'context-packs',
]);

const MAX_DEPTH = 4;
const MAX_CANDIDATES = 50;
/**
 * Minimum file size to count as a "real" doc. Filters obvious empty
 * stubs (`echo "TODO" > docs/x.md`) without blocking small but
 * substantive specs. 100 bytes ≈ a heading line + one short sentence,
 * which is the realistic floor for something worth promoting.
 */
const MIN_BYTES = 100;
const MAX_BYTES = 256 * 1024;

export interface FeatureImportCandidate {
  /** POSIX-style path relative to the project root. */
  readonly relPath: string;
  /** Absolute path on disk — used by the import action. */
  readonly absPath: string;
  /** Bytes on disk. */
  readonly bytes: number;
  /** ISO-8601 last-modified. */
  readonly modifiedAt: string;
  /** Suggested feature slug (sanitized, kebab-case). May collide with existing slugs. */
  readonly suggestedSlug: string;
  /** True if `suggestedSlug` already exists under `docs/features/`. The form disables import for these by default. */
  readonly slugCollides: boolean;
  /**
   * Suggested trigger description — the first non-heading paragraph,
   * cleaned and capped. Starts with a heuristic-selected verb so the
   * user has something useful to refine rather than an empty box.
   */
  readonly suggestedDescription: string;
  /** True if this file already lives inside a feature directory. Excluded from the candidate list to avoid double-import. */
  readonly insideFeatures: boolean;
}

export interface ImportCandidatesResult {
  readonly candidates: ReadonlyArray<FeatureImportCandidate>;
  /** Slugs that already exist under `docs/features/` — used by the wizard to flag collisions. */
  readonly existingSlugs: ReadonlyArray<string>;
  /** True when we hit `MAX_CANDIDATES` and stopped scanning early. */
  readonly truncated: boolean;
  /** Where we looked. Surfaced in the UI so users know what was scanned. */
  readonly scannedDirs: ReadonlyArray<string>;
}

/**
 * Scan `<projectCwd>` for markdown files that look like candidates for
 * import as features. Sync — same shape as the rest of the read paths
 * in this module.
 */
export function scanFeatureImportCandidates(projectCwd: string): ImportCandidatesResult {
  const existingSlugs = walkFeatures(projectCwd).map((r) => r.slug);
  const existingSet = new Set(existingSlugs);

  const candidates: FeatureImportCandidate[] = [];
  const scannedDirs: string[] = [];
  let truncated = false;

  for (const top of SCAN_DIRECTORIES) {
    const root = join(projectCwd, top);
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    scannedDirs.push(root);
    walkFiles(projectCwd, root, 0, (absPath, stat, relPath) => {
      if (candidates.length >= MAX_CANDIDATES) {
        truncated = true;
        return false; // signal walker to stop
      }
      if (extname(absPath).toLowerCase() !== '.md') return true;
      if (stat.size < MIN_BYTES || stat.size > MAX_BYTES) return true;

      // Skip files INSIDE an existing feature dir or pack dir.
      const segments = relPath.split('/');
      const insideFeatures = segments.some((s) => SKIP_SEGMENT_NAMES.has(s));
      if (insideFeatures) return true;

      // Skip the project-root README — too generic.
      if (relPath === 'docs/README.md' || relPath === 'README.md') return true;

      const suggestedSlug = deriveSlug(absPath);
      const slugCollides = existingSet.has(suggestedSlug);
      const suggestedDescription = deriveDescription(absPath, relPath);
      candidates.push({
        relPath,
        absPath,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        suggestedSlug,
        slugCollides,
        suggestedDescription,
        insideFeatures: false,
      });
      return true;
    });
  }
  // Sort: newest first, capped to MAX_CANDIDATES.
  candidates.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0));
  return {
    candidates: candidates.slice(0, MAX_CANDIDATES),
    existingSlugs,
    truncated,
    scannedDirs,
  };
}

/**
 * Recursive walker. The visitor returns `false` to abort the walk
 * entirely (we use this for the MAX_CANDIDATES early-exit).
 */
function walkFiles(
  projectCwd: string,
  dir: string,
  depth: number,
  visit: (absPath: string, stat: Stats, relPath: string) => boolean,
): boolean {
  if (depth > MAX_DEPTH) return true;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return true;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if (SKIP_SEGMENT_NAMES.has(name)) continue;
    const abs = join(dir, name);
    let stat: Stats;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const continueWalk = walkFiles(projectCwd, abs, depth + 1, visit);
      if (!continueWalk) return false;
      continue;
    }
    if (!stat.isFile()) continue;
    const relPath = toPosix(relative(projectCwd, abs));
    const continueWalk = visit(abs, stat, relPath);
    if (!continueWalk) return false;
  }
  return true;
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/**
 * Derive a slug from a file path. Uses the basename (without extension),
 * lowercases, replaces non-slug chars with hyphens, trims edges. Falls
 * back to `imported-N` if sanitization produces an empty string.
 */
function deriveSlug(absPath: string): string {
  const base = absPath.split('/').pop() ?? 'imported';
  const noExt = base.replace(/\.[^.]+$/, '');
  const slug = noExt
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0 || !FEATURE_SLUG_RE.test(slug)) return `imported-${Math.floor(Math.random() * 1e6)}`;
  return slug;
}

/**
 * Pull a short trigger-shaped description out of the markdown body.
 * Strategy:
 *   1. Read up to the first 4 KB (description doesn't need more).
 *   2. Strip leading frontmatter if present (`---\n...\n---\n`).
 *   3. Find the first non-heading non-blank line.
 *   4. Cap at 200 chars; collapse whitespace.
 *   5. If nothing usable found, return a generic placeholder so the
 *      wizard's quality-hint will fail-loudly and the user fills it in.
 */
function deriveDescription(absPath: string, relPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8').slice(0, 4096);
  } catch {
    return `Imported from ${relPath}. TODO: replace with a "Use this when..." trigger sentence.`;
  }
  // Strip leading YAML frontmatter.
  const fmMatch = raw.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
  const body = fmMatch !== null ? raw.slice(fmMatch[0].length) : raw;
  // Find the first non-heading, non-blank line.
  const lines = body.split(/\r?\n/);
  let firstUseful = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('>') && trimmed.length < 50) continue; // skip tiny pull-quotes
    firstUseful = trimmed;
    break;
  }
  if (firstUseful.length === 0) {
    return `Imported from ${relPath}. TODO: replace with a "Use this when..." trigger sentence.`;
  }
  const cleaned = firstUseful.replace(/\s+/g, ' ').slice(0, 200);
  return cleaned;
}
