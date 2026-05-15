/**
 * @coodra/shared/features — types
 *
 * `features/` is Coodra's skill-style knowledge layer. Each feature is
 * a self-contained directory under `<project-root>/docs/features/<slug>/`
 * with one mandatory `feature.md` (frontmatter + body) plus any number
 * of supporting files. The skill-pattern insight: agents read the
 * generated INDEX (cheap — names + descriptions only) on every session
 * start, then call `coodra__get_feature(slug)` to load a body on
 * demand when a relevant prompt arrives.
 *
 * This module is the canonical source of truth for the feature shape.
 * The CLI authors features, the bridge injects the INDEX, the MCP server
 * surfaces them as tools, and the web UI manages them — all four call
 * into this package so the on-disk format and the parsed shape stay in
 * lock-step. NEVER duplicate any of these types; import from here.
 */

/**
 * Maturity progression for a feature. Mirrors ADR maturity in spirit.
 *
 *   - `draft`      — being written; not yet usable as agent context.
 *   - `beta`       — usable, expect rough edges.
 *   - `stable`     — the canonical reference.
 *   - `deprecated` — kept for history; should not be loaded by agents.
 *
 * The bridge's index injection skips `deprecated` features so they
 * don't pollute the agent's mental map without explicit opt-in (the
 * MCP `list_features` tool returns them, with `maturity` surfaced).
 */
export type FeatureMaturity = 'draft' | 'beta' | 'stable' | 'deprecated';

/**
 * Parsed frontmatter — the load-bearing metadata every feature.md must
 * declare. The body of the markdown after the closing `---` is held
 * separately on `ParsedFeatureMd.body`.
 */
export interface FeatureFrontmatter {
  /**
   * Slug of the feature. MUST match the parent folder name (the
   * indexer rejects mismatches). Use kebab-case: lowercase, digits,
   * hyphens or underscores.
   */
  readonly name: string;
  /**
   * Trigger description — the load-bearing field. The skill pattern
   * works because agents see this short blurb up front and decide
   * whether to load the body. Aim for 1-3 sentences that name concrete
   * triggers (operations, files, entity names, user intents).
   *
   * Quality bar (lint warns when missed, never fails):
   *   - Starts with "Use this when..." or similar imperative
   *   - Names ≥ 1 concrete operation / entity / file path
   *   - ≥ 30 chars, ≤ 600 chars
   */
  readonly description: string;
  /**
   * Optional inverse trigger. Steers the agent away from picking this
   * feature for adjacent-but-different concerns (e.g. "Don't use for
   * non-Stripe payment paths — PayPal lives under `paypal`.").
   */
  readonly whenNotToUse?: string;
  /** Maturity. Defaults to `draft` when missing. */
  readonly maturity?: FeatureMaturity;
  /**
   * Free-form list of owner identifiers — emails, GitHub handles,
   * team names. Surfaced in the web detail UI; not used by the agent.
   */
  readonly owners?: ReadonlyArray<string>;
  /**
   * Free-form tags. Surfaced in the web list filter and in
   * INDEX.json so external tooling can group features by theme.
   */
  readonly tags?: ReadonlyArray<string>;
}

/**
 * One supporting file inside a feature directory. Paths are POSIX-
 * style relative to the feature dir (never absolute, never `..`-prefixed).
 * `feature.md` itself is NOT listed here — it's the metadata file, not
 * a supporting file.
 */
export interface FeatureFile {
  /** POSIX-style path relative to the feature directory. */
  readonly path: string;
  /** Byte size on disk. */
  readonly bytes: number;
  /** ISO-8601 last-modified timestamp. */
  readonly modifiedAt: string;
}

/**
 * The fully-parsed view of one feature on disk — frontmatter, body,
 * supporting files, derived stats.
 */
export interface FeatureRow {
  /** Slug == folder name. */
  readonly slug: string;
  /** Absolute path to `<projectRoot>/docs/features/<slug>/`. */
  readonly dir: string;
  /** Frontmatter parsed from feature.md. */
  readonly frontmatter: FeatureFrontmatter;
  /** Body of feature.md (markdown after the closing `---`). */
  readonly body: string;
  /** Supporting files, recursive, sorted by path. */
  readonly files: ReadonlyArray<FeatureFile>;
  /** Total bytes across feature.md + every supporting file. */
  readonly totalBytes: number;
  /** ISO-8601 last-modified across all files in the feature. */
  readonly lastUpdatedAt: string;
  /**
   * Non-fatal validation warnings. Surface these in the web UI to nudge
   * the user toward better descriptions; the indexer doesn't block on
   * them. See `validateFrontmatter` in `./schema` for the exact rules.
   */
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Lightweight projection of `FeatureRow` suitable for the bridge's
 * SessionStart injection and the MCP `list_features` tool. Drops the
 * body and per-file paths; keeps everything an agent needs to decide
 * "should I load this?".
 */
export interface FeatureIndexEntry {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly whenNotToUse: string | null;
  readonly maturity: FeatureMaturity;
  readonly owners: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly lastUpdatedAt: string;
  readonly hasWarnings: boolean;
}

/**
 * Top-level shape of `INDEX.json`. Versioned so future schema changes
 * (e.g. adding embedding vectors) can opt in without breaking older
 * readers.
 */
export interface FeatureIndex {
  /** Bumped on breaking schema changes. v1 is the initial shape. */
  readonly version: 1;
  /** The project this index belongs to (matches `projects.slug`). */
  readonly projectSlug: string;
  /**
   * ISO-8601 timestamp at index regeneration. Bridge / web compare this
   * to `mtime(docs/features/)` to decide whether to re-index on read.
   */
  readonly generatedAt: string;
  /**
   * Highest `mtime` seen across the feature tree at generation time.
   * Used by the bridge's stale-index guard: if `mtime(docs/features/) >
   * indexerSourceMtime`, the bridge regenerates before injection.
   */
  readonly indexerSourceMtime: number;
  /** Sorted by slug, ascending. */
  readonly features: ReadonlyArray<FeatureIndexEntry>;
}

/**
 * Result of `parseFeatureMd` — the raw split between frontmatter and
 * body, with structured errors when the format is invalid. `frontmatter`
 * is null when parsing failed; `errors` carries the reasons.
 */
export interface ParsedFeatureMd {
  readonly frontmatter: FeatureFrontmatter | null;
  readonly body: string;
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}
