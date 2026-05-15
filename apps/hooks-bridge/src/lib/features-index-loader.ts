import { statSync } from 'node:fs';

import {
  type FeatureIndex,
  type FeatureIndexEntry,
  featuresRoot,
  generateFeaturesIndex,
} from '@coodra/shared/features';
import { createLogger } from '@coodra/shared';

/**
 * `apps/hooks-bridge/src/lib/features-index-loader` — reads
 * `<cwd>/docs/features/INDEX.json` for SessionStart `additionalContext`
 * injection.
 *
 * The skill-pattern insight: the agent reads the index (cheap — names
 * + descriptions only) on every session start, then calls
 * `coodra__get_feature(slug)` to load a body on demand. The bridge
 * is the courier that ships the index to the agent at turn zero.
 *
 * Three behaviours this module guarantees:
 *
 *   1. **Stale-index regen.** If `docs/features/` has a higher mtime
 *      than the recorded `indexerSourceMtime` in `INDEX.json`, the
 *      bridge silently regenerates before reading. This means the
 *      agent always sees a fresh index even when the user dropped a
 *      file under `docs/features/<slug>/` without running `feature
 *      index`.
 *
 *   2. **Size cap.** The bridge appends up to `MAX_INDEX_BYTES` of
 *      rendered index text. If the full index would exceed the cap,
 *      we drop the oldest features (by `lastUpdatedAt`) and append a
 *      "+N more (use coodra__list_features)" footer so the agent
 *      knows it can fetch the rest.
 *
 *   3. **Soft failure on every error.** No throw escapes this module.
 *      Missing `docs/features/`, unreadable INDEX.json, parse errors
 *      — all logged at info / warn and treated as "no features
 *      available", which matches the existing feature-pack-loader's
 *      contract.
 *
 * The rendered output is a markdown block ready to slot into
 * `additionalContext`. The session-start handler controls block
 * ordering and HR separators; this module only knows how to render
 * the feature-index block.
 */

const featuresIndexLoaderLogger = createLogger('hooks-bridge.features-index-loader');

/**
 * Per Phase plan §7: cap on the rendered features-index block. Claude
 * Code accepts ~20KB of `additionalContext` reliably; the pack body
 * usually runs 2-6KB; 12KB for the index leaves headroom for the
 * session contract + recent decisions blocks. Tunable here without
 * touching the indexer.
 */
const MAX_INDEX_BYTES = 12 * 1024;

export interface LoadFeaturesIndexOptions {
  /** Project root (the directory containing `.coodra.json`). */
  readonly cwd: string;
  /** Project slug — used for the "stale regen" path which requires it. */
  readonly projectSlug: string;
}

export interface LoadedFeaturesIndex {
  /** Rendered markdown block ready to splice into `additionalContext`. */
  readonly content: string;
  /** How many features actually surfaced after truncation. */
  readonly entriesShown: number;
  /** Total entries available (≥ entriesShown); the delta hit the size cap. */
  readonly entriesTotal: number;
  /** Raw bytes of the rendered block — useful for telemetry. */
  readonly bytes: number;
}

/**
 * Read the features index for a session. Returns `null` when there are
 * no features to surface (no `docs/features/` directory, an empty
 * index, or any read error). The session-start handler treats `null`
 * as "skip the features block" — same shape as the existing pack
 * loader's contract.
 *
 * **Read-time regeneration.** This loader ALWAYS calls
 * `generateFeaturesIndex` on read, then uses the in-memory index it
 * returns. Why: detecting "did anyone edit a feature.md since the last
 * index?" via mtime alone is unreliable — the parent directory's mtime
 * doesn't change when a file *inside* gets edited (only on add/remove),
 * so editing `payments-flow/feature.md` from $EDITOR or the web UI
 * leaves `mtime(docs/features/)` untouched. The cleanest fix is
 * idempotent regen-on-read: the generator only writes to disk when
 * content actually changed (verified by Phase A test "is idempotent —
 * second run with no changes does not rewrite"), so the cost is bounded
 * to a walk + a content compare.
 *
 * For projects with hundreds of features, regen-on-read remains cheap
 * — Phase A walk is sync statSync + small-file YAML parse, well under
 * the §6 SessionStart latency budget.
 */
export async function loadFeaturesIndexForSession(
  options: LoadFeaturesIndexOptions,
): Promise<LoadedFeaturesIndex | null> {
  const root = featuresRoot(options.cwd);

  // Step 1 — does the directory exist at all? If not, this project
  // simply hasn't adopted features yet. Quietly return null.
  let rootExists = false;
  try {
    rootExists = statSync(root).isDirectory();
  } catch {
    rootExists = false;
  }
  if (!rootExists) {
    return null;
  }

  // Step 2 — always regenerate on read. The generator's `changed` flag
  // means we only pay disk-write cost when something actually changed
  // (compared to the existing INDEX.json bytes). Failure here is
  // soft-fail: the SessionStart proceeds without a features block.
  let parsedIndex: FeatureIndex;
  try {
    const result = generateFeaturesIndex({
      projectCwd: options.cwd,
      projectSlug: options.projectSlug,
    });
    parsedIndex = result.index;
    if (result.changed) {
      featuresIndexLoaderLogger.info(
        {
          event: 'features_index_refreshed_on_read',
          cwd: options.cwd,
          features: parsedIndex.features.length,
          slugsWithWarnings: result.slugsWithWarnings,
        },
        'features INDEX.{md,json} regenerated to reflect on-disk edits before SessionStart injection',
      );
    }
  } catch (err) {
    featuresIndexLoaderLogger.warn(
      {
        event: 'features_index_regen_failed',
        cwd: options.cwd,
        err: err instanceof Error ? err.message : String(err),
      },
      'features index regeneration threw; SessionStart will skip features block',
    );
    return null;
  }

  if (parsedIndex.features.length === 0) {
    return null;
  }

  // Step 3 — render with a size cap. Drop oldest first when over the
  // budget (matches the spec's "+N more" footer pattern).
  const { content, shown, total } = renderForInjection(parsedIndex, MAX_INDEX_BYTES);
  return {
    content,
    entriesShown: shown,
    entriesTotal: total,
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

/**
 * Render the index into a markdown block + apply the size cap.
 * Returns the trimmed body, the number of entries shown, and the
 * number of entries available pre-truncation.
 *
 * Ordering: features sort lexicographically by slug (matches the
 * generator output). When truncating, we drop the OLDEST first so the
 * most-recently-touched features survive — those are most likely
 * relevant to whatever the agent is about to do next.
 */
/**
 * Reserve at minimum this many bytes for the truncation footer + any
 * trailing whitespace. The footer template is fixed-format; in practice
 * it lands at ~150 bytes for any plausible drop-count. 256 gives us a
 * comfortable margin so the final assembled block never overshoots
 * `maxBytes` by entry-then-footer concatenation.
 */
const FOOTER_RESERVATION_BYTES = 256;

function renderForInjection(
  index: FeatureIndex,
  maxBytes: number,
): { content: string; shown: number; total: number } {
  const total = index.features.length;
  const ordered = [...index.features].sort((a, b) => a.slug.localeCompare(b.slug));

  // First pass: try the full alphabetical render at the FULL byte budget
  // (no footer needed if everything fits). This preserves the simple
  // "all features in slug order" output for the common case.
  let content = renderHeader(index.projectSlug, total);
  let alphabeticalFits = true;
  for (const f of ordered) {
    const candidate = `${content}${renderEntry(f)}`;
    if (Buffer.byteLength(candidate, 'utf8') > maxBytes) {
      alphabeticalFits = false;
      break;
    }
    content = candidate;
  }
  if (alphabeticalFits) {
    return { content, shown: total, total };
  }

  // Truncated path: drop oldest by `lastUpdatedAt` (freshest survive,
  // matches the spec's "most-likely-relevant" intent), and reserve
  // FOOTER_RESERVATION_BYTES so the appended footer can't push the
  // assembled block past maxBytes. Without the reservation, the entry
  // loop fills right up to maxBytes and the footer makes us overshoot
  // by ~150 bytes — surfaced by the Phase C functional sweep at 150
  // features.
  const byRecency = [...ordered].sort((a, b) =>
    a.lastUpdatedAt < b.lastUpdatedAt ? 1 : a.lastUpdatedAt > b.lastUpdatedAt ? -1 : 0,
  );
  const entryBudget = Math.max(maxBytes - FOOTER_RESERVATION_BYTES, Math.floor(maxBytes / 2));
  let recencyContent = renderHeader(index.projectSlug, total);
  let recencyShown = 0;
  for (const fe of byRecency) {
    const candidate = `${recencyContent}${renderEntry(fe)}`;
    if (Buffer.byteLength(candidate, 'utf8') > entryBudget) break;
    recencyContent = candidate;
    recencyShown += 1;
  }
  const recencyDropped = total - recencyShown;
  const footer = renderFooter(recencyDropped);
  const finalContent = `${recencyContent}${footer}`;
  const finalBytes = Buffer.byteLength(finalContent, 'utf8');
  featuresIndexLoaderLogger.info(
    {
      event: 'features_index_truncated',
      total,
      shown: recencyShown,
      dropped: recencyDropped,
      maxBytes,
      entryBudget,
      actualBytes: finalBytes,
    },
    'features index exceeded SessionStart size cap; truncated by lastUpdatedAt desc',
  );
  return { content: finalContent, shown: recencyShown, total };
}

function renderHeader(projectSlug: string, total: number): string {
  return [
    '## Available features (skill-style index)',
    '',
    `This project (${projectSlug}) has ${total} feature${total === 1 ? '' : 's'} available on demand. Each entry below`,
    'declares **when to use it** — read the trigger description and call',
    '`coodra__get_feature({slug:"<slug>"})` to load the body of any that fits the current task.',
    '',
  ].join('\n');
}

function renderEntry(f: FeatureIndexEntry): string {
  const lines: string[] = [];
  lines.push(`### ${f.slug}`);
  if (f.maturity !== 'stable') {
    lines.push(`> _${f.maturity}_`);
  }
  lines.push(`**When:** ${normaliseWhitespace(f.description)}`);
  if (f.whenNotToUse !== null && f.whenNotToUse.length > 0) {
    lines.push(`**Not for:** ${normaliseWhitespace(f.whenNotToUse)}`);
  }
  if (f.tags.length > 0) {
    lines.push(`**Tags:** ${f.tags.join(', ')}`);
  }
  lines.push(`**Files:** ${f.fileCount}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function renderFooter(droppedCount: number): string {
  if (droppedCount <= 0) return '';
  return [
    '',
    `_+${droppedCount} more feature${droppedCount === 1 ? '' : 's'} omitted to fit the context budget._`,
    `_Call \`coodra__list_features({projectSlug:"<slug>"})\` to see the full list._`,
    '',
  ].join('\n');
}

function normaliseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
