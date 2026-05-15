import { z } from 'zod';

import type { FeatureFrontmatter } from './types.js';

/**
 * @coodra/shared/features — Zod schema for feature.md
 * frontmatter.
 *
 * Two layers:
 *
 *   1. `FRONTMATTER_SCHEMA` — strict structural validation. Mismatches
 *      become `errors` on `ParsedFeatureMd` and block index inclusion.
 *   2. `validateFrontmatterQuality` — non-fatal lint that surfaces in
 *      the web UI as a quality hint. The indexer never drops a feature
 *      for quality reasons; bad descriptions just mean the agent may
 *      not pick the feature, which is the user's problem to fix.
 */

/** Same regex used elsewhere in Coodra for slugs. */
export const FEATURE_SLUG_RE = /^[a-z0-9_-]+$/;

const MATURITY_VALUES = ['draft', 'beta', 'stable', 'deprecated'] as const;

/**
 * Parses an arbitrary YAML-decoded object into the canonical
 * `FeatureFrontmatter` shape. Every field except `name` and
 * `description` is optional. Unknown extra fields are silently dropped
 * (we don't `.strict()` because this format will grow over time and
 * forward-compat matters more than catching typos).
 */
export const FRONTMATTER_SCHEMA: z.ZodType<FeatureFrontmatter> = z
  .object({
    name: z
      .string()
      .min(1, 'name is required')
      .max(64, 'name must be ≤ 64 chars')
      .regex(FEATURE_SLUG_RE, 'name must be lowercase letters, digits, hyphens or underscores'),
    description: z
      .string()
      .min(1, 'description is required')
      .max(2000, 'description must be ≤ 2000 chars')
      .transform((v) => v.trim()),
    whenNotToUse: z
      .string()
      .max(2000, 'whenNotToUse must be ≤ 2000 chars')
      .transform((v) => v.trim())
      .optional(),
    maturity: z.enum(MATURITY_VALUES).optional(),
    owners: z.array(z.string().min(1)).max(64).optional(),
    tags: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'tag must be lowercase / digits / hyphens / underscores'))
      .max(64)
      .optional(),
  })
  .passthrough()
  .transform<FeatureFrontmatter>((v) => {
    const { name, description, whenNotToUse, maturity, owners, tags } = v;
    return {
      name,
      description,
      ...(whenNotToUse !== undefined ? { whenNotToUse } : {}),
      ...(maturity !== undefined ? { maturity } : {}),
      ...(owners !== undefined ? { owners: Object.freeze([...owners]) } : {}),
      ...(tags !== undefined ? { tags: Object.freeze([...tags]) } : {}),
    };
  });

/**
 * Quality-of-description heuristics. Returns warning strings; an empty
 * array means the description is in good shape. None of these block
 * indexing — they're surfaced in the web UI so the user knows why an
 * agent might not pick the feature.
 *
 * Heuristics:
 *   - description shorter than 30 chars → too generic to trigger on
 *   - description doesn't start with an imperative verb (Use|Call|Apply
 *     |Pick|Reach|Read|Run|Select|...) → may not register as a trigger
 *   - description has no concrete noun (no upper-case acronym, no
 *     code-fence span, no slash, no period-separated technical word)
 *     → too abstract to disambiguate from siblings
 */
export function validateFrontmatterQuality(fm: FeatureFrontmatter): ReadonlyArray<string> {
  const warnings: string[] = [];
  const desc = fm.description.trim();

  // Hard sentinel check — the CLI's `feature add` writes a "TODO:"
  // placeholder when the user doesn't supply --description. We flag it
  // here so the index records `hasWarnings=true` and the web UI / agent
  // know the description is unedited. Any description that *starts* with
  // "TODO" (case-insensitive, optionally followed by `:` and free text)
  // counts as un-filled-in. Single source of truth for the stub-detect
  // rule across the CLI, web, MCP, and bridge.
  if (/^todo\b/i.test(desc)) {
    warnings.push(
      'description still contains a TODO placeholder — replace it with a concrete "Use this when..." sentence so agents can decide whether to load this feature',
    );
  }
  if (desc.length < 30) {
    warnings.push('description is short (< 30 chars) — agents may not have enough signal to pick this feature');
  }
  // Soft check: imperative-verb start. Skill descriptions start with
  // "Use this when…", "Call this for…", etc.
  if (!/^(use|call|apply|pick|reach|read|run|select|choose|trigger|invoke|consult)\b/i.test(desc)) {
    warnings.push(
      'description should start with an imperative trigger (e.g. "Use this when...", "Call this for...") — improves agent selection accuracy',
    );
  }
  // Soft check: at least one concrete signal — code span, slashed path,
  // upper-case word, dotted technical name.
  const hasConcreteSignal =
    /`[^`]+`/.test(desc) || // code span
    /[a-z]+\.[a-z]+/i.test(desc) || // dotted name
    /\/[A-Za-z]/.test(desc) || // path
    /\b[A-Z]{2,}\b/.test(desc); // acronym
  if (!hasConcreteSignal) {
    warnings.push(
      'description has no concrete signal (code span, file path, acronym, or dotted name) — agents pick more accurately when descriptions name specific operations or files',
    );
  }
  return warnings;
}
