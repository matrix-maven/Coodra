import { createLogger, InternalError } from '@coodra/shared';
import picomatch from 'picomatch';

import type { ToolContext } from '../../framework/tool-context.js';
import type { FeaturePackGetReturn, FeaturePackReturn } from '../../lib/feature-pack.js';
import type { FeaturePackShape, GetFeaturePackInput, GetFeaturePackOutput } from './schema.js';

/**
 * Handler for `coodra__get_feature_pack`.
 *
 * Delegates to `ctx.featurePack.get(...)` (the S7c FS-first store)
 * then maps the result into the §24.4 external shape:
 *
 *   { ok: true, pack, subPack: null, inherited: [...root-first...] }
 *
 * `pack` is the deepest Feature Pack whose `sourceFiles` globs match
 * `filePath` (or the slug's own pack when `filePath` is absent / no
 * glob matches). Decisions-log 2026-04-24 15:00 confirms this
 * reading of §24.4's "Returns the Feature Pack for the module that
 * owns the given path" — owner-centric, singular. `subPack` is
 * always `null` in Module 02; it is reserved for Module 07+ folder-
 * nested sub-feature-packs (a different scoping axis from
 * inheritance).
 *
 * Error mapping — the store throws `InternalError` for three
 * recoverable states; each maps to a canonical soft-failure branch:
 *
 *   - "feature-pack.get: slug '<x>' not found on disk + DB"
 *     → { ok: false, error: 'pack_not_found', howToFix }
 *
 *   - "feature_pack_parent_missing: ..."
 *     → { ok: false, error: 'pack_not_found', howToFix } with the
 *       parent slug named. Root cause: a meta.json `parentSlug`
 *       points at a pack that doesn't exist on disk + DB. The
 *       user-recoverable fix is the same as `pack_not_found` (register
 *       or correct the slug).
 *
 *   - "feature_pack_cycle: a → b → c → a"
 *     → { ok: false, error: 'feature_pack_cycle', chain, howToFix }
 *       with the chain parsed out of the error message so the caller
 *       can surface it.
 *
 * Any other throw propagates — the registry wraps it in the generic
 * `handler_threw` envelope. That is the honest shape for
 * programming bugs (DB outage, null invariants) vs user-recoverable
 * misconfigurations.
 *
 * Caching: this handler does NOT add a second cache layer. The
 * store owns the 60s TTL with checksum invalidation (S7c) — a tool-
 * level cache would re-introduce staleness windows.
 */

const handlerLogger = createLogger('mcp-server.tool.get_feature_pack');

const PACK_NOT_FOUND_HOWTO =
  'Register the pack via docs/feature-packs/<slug>/{spec,implementation,techstack}.md + meta.json, or proceed with default conventions if this slug is intentionally unregistered.';

/** Parse "feature_pack_cycle: a → b → c → a" into ['a','b','c','a']. */
function parseCycleChain(message: string): string[] {
  const match = message.match(/feature_pack_cycle:\s*(.+)$/);
  const body = match?.[1];
  if (!body) return [];
  return body
    .split(/\s*→\s*/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Convert the store's internal `FeaturePackReturn` (with `updatedAt: Date`)
 * into the wire shape (`updatedAt: string`). The registry's output
 * schema uses `z.string().datetime()` so we serialise at the handler
 * boundary rather than relying on `JSON.stringify` downstream.
 */
function toWireShape(pack: FeaturePackReturn): FeaturePackShape {
  return {
    metadata: {
      id: pack.metadata.id,
      slug: pack.metadata.slug,
      parentSlug: pack.metadata.parentSlug,
      isActive: pack.metadata.isActive,
      checksum: pack.metadata.checksum,
      updatedAt: pack.metadata.updatedAt.toISOString(),
    },
    content: {
      spec: pack.content.spec,
      implementation: pack.content.implementation,
      techstack: pack.content.techstack,
      sourceFiles: [...pack.content.sourceFiles],
      ...(pack.content.structure !== undefined ? { structure: pack.content.structure } : {}),
    },
  };
}

/**
 * Resolve `filePath` against each level of the inheritance chain
 * (leaf-first). Returns the index in the chain of the deepest pack
 * whose `sourceFiles` matches the path, or `null` if nothing matches.
 *
 * `chain` is ordered root-first at index 0, leaf at the last index —
 * so "deepest match" means the highest index whose sourceFiles glob
 * matches. We walk from the end (leaf) backwards until we find a hit.
 */
function findDeepestMatchIndex(chain: ReadonlyArray<FeaturePackShape>, filePath: string): number | null {
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const level = chain[i];
    if (!level) continue;
    for (const pattern of level.content.sourceFiles) {
      const matcher = picomatch(pattern, { dot: false, nobrace: true });
      if (matcher(filePath)) {
        return i;
      }
    }
  }
  return null;
}

export async function getFeaturePackHandler(
  input: GetFeaturePackInput,
  ctx: ToolContext,
): Promise<GetFeaturePackOutput> {
  // Fetch via the store. Pass `filePath` through — the store itself
  // doesn't act on it today, but we respect the interface so a future
  // store-side enhancement can move the resolution without touching
  // the tool handler.
  let storeResult: FeaturePackGetReturn;
  try {
    const storeInput: { projectSlug: string; filePath?: string } = { projectSlug: input.projectSlug };
    if (input.filePath !== undefined) {
      storeInput.filePath = input.filePath;
    }
    storeResult = (await ctx.featurePack.get(storeInput)) as FeaturePackGetReturn;
  } catch (err) {
    if (err instanceof InternalError) {
      const message = err.message;
      if (message.startsWith('feature_pack_cycle:')) {
        const chain = parseCycleChain(message);
        handlerLogger.warn(
          {
            event: 'feature_pack_cycle_surfaced',
            projectSlug: input.projectSlug,
            chain,
          },
          'get_feature_pack: returning cycle soft-failure',
        );
        return {
          ok: false,
          error: 'feature_pack_cycle',
          chain,
          howToFix:
            chain.length > 0
              ? `Remove the parentSlug cycle in meta.json: ${chain.join(' → ')}. Pick one parent and stop.`
              : 'Remove the parentSlug cycle in meta.json. Pick one parent and stop.',
        };
      }
      if (message.includes('not found on disk + DB') || message.startsWith('feature_pack_parent_missing:')) {
        handlerLogger.info(
          {
            event: 'feature_pack_not_found',
            projectSlug: input.projectSlug,
            message,
          },
          'get_feature_pack: returning pack_not_found soft-failure',
        );
        return {
          ok: false,
          error: 'pack_not_found',
          howToFix: PACK_NOT_FOUND_HOWTO,
        };
      }
    }
    // Any other throw is a programming-bug / system-fault path — let
    // the registry wrap it in handler_threw.
    throw err;
  }

  // Build the wire-shape chain: [root, ..., parent-of-leaf, leaf].
  const leafWire = toWireShape({ metadata: storeResult.metadata, content: storeResult.content });
  const inheritedWire = storeResult.inherited.map(toWireShape);
  const fullChain: ReadonlyArray<FeaturePackShape> = [...inheritedWire, leafWire];

  if (input.filePath === undefined) {
    return {
      ok: true,
      pack: leafWire,
      subPack: null,
      inherited: inheritedWire,
    };
  }

  const deepestIdx = findDeepestMatchIndex(fullChain, input.filePath);
  if (deepestIdx === null) {
    // Silent fallback per user directive Q3: filePath missing the
    // chain is an advisory that didn't apply, not a misbehavior.
    // DEBUG level so operators who care can observe; default log
    // level (info) doesn't emit this.
    handlerLogger.debug(
      {
        event: 'feature_pack_filepath_no_match',
        projectSlug: input.projectSlug,
        filePath: input.filePath,
      },
      'get_feature_pack: filePath does not match any sourceFiles in the inheritance chain; falling back to slug pack',
    );
    return {
      ok: true,
      pack: leafWire,
      subPack: null,
      inherited: inheritedWire,
    };
  }

  // pack = chain[deepestIdx]; inherited = chain[0 .. deepestIdx-1].
  const pack = fullChain[deepestIdx];
  if (!pack) {
    // Unreachable — findDeepestMatchIndex returns an index that is
    // in bounds by construction. Guard satisfies TypeScript's
    // noUncheckedIndexedAccess; any path here is a bug and re-throws.
    throw new Error(
      `get_feature_pack: invalid deepest-match index ${deepestIdx} against chain length ${fullChain.length}`,
    );
  }
  const inherited = fullChain.slice(0, deepestIdx);
  return {
    ok: true,
    pack,
    subPack: null,
    inherited: [...inherited],
  };
}
