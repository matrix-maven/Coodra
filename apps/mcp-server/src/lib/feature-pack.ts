import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/contextos-db';
import { InternalError, type Logger } from '@coodra/contextos-shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

/** Structural shape of a `feature_packs` row, shared by both dialects. */
type FeaturePackRow = typeof sqliteSchema.featurePacks.$inferSelect;

import type { FeaturePackStore } from '../framework/tool-context.js';
import { createMcpLogger } from './logger.js';

/**
 * `apps/mcp-server/src/lib/feature-pack.ts` — filesystem-first
 * Feature-Pack store wired into `ToolContext.featurePack`.
 *
 * Storage model (Q-02-4):
 *   - Source of truth = markdown on disk, under
 *     `docs/feature-packs/<slug>/{spec,implementation,techstack}.md`.
 *   - Metadata = `docs/feature-packs/<slug>/meta.json` ({ slug,
 *     parentSlug?, sourceFiles? }).
 *   - DB row in `feature_packs` carries `id, slug, parentSlug,
 *     isActive, checksum, updatedAt` — indexed by slug, no
 *     `project_id` FK (globally unique slug namespace per
 *     docs/feature-packs/02-mcp-server/spec.md §81; see
 *     context_memory/decisions-log.md 2026-04-24 for the rationale
 *     and the future multi-project plan).
 *
 * Checksum = sha256 of the three markdown bodies concatenated in
 * the order (spec, implementation, techstack). Fixed order so the
 * checksum is reproducible across machines.
 *
 * Cache: 60s per-slug TTL (§5 AP cache-first); on checksum mismatch
 * the entry is dropped and the DB row is updated.
 *
 * Inheritance (§16 pattern 9): `parentSlug` walks root → leaf. No
 * in-file merge — consumers (S9 handler) render the chain in
 * order. Cycle detection via visited-set; `InternalError(
 * 'feature_pack_cycle', { chain })` on re-visit.
 *
 * `projectSlug === featurePackSlug` — confirmed design per
 * `docs/feature-packs/02-mcp-server/spec.md §81`. The interface's
 * `projectSlug` parameter names historical convention; the `get`
 * call looks up the `feature_packs` row by slug (no project_id
 * resolution).
 */

const featurePackLogger = createMcpLogger('lib-feature-pack');

const CACHE_TTL_MS = 60_000 as const;

// ---------------------------------------------------------------------------
// meta.json schema + return shapes
// ---------------------------------------------------------------------------

const metaJsonSchema = z.object({
  slug: z.string().min(1),
  parentSlug: z.string().min(1).nullable().optional(),
  sourceFiles: z.array(z.string().min(1)).optional(),
});
export type FeaturePackMeta = z.infer<typeof metaJsonSchema>;

export interface FeaturePackContent {
  readonly spec: string;
  readonly implementation: string;
  readonly techstack: string;
  readonly sourceFiles: ReadonlyArray<string>;
}

export interface FeaturePackMetadata {
  readonly id: string;
  readonly slug: string;
  readonly parentSlug: string | null;
  readonly isActive: boolean;
  readonly checksum: string;
  readonly updatedAt: Date;
}

export interface FeaturePackReturn {
  readonly metadata: FeaturePackMetadata;
  readonly content: FeaturePackContent;
}

export interface FeaturePackGetReturn extends FeaturePackReturn {
  /** Ancestor chain, root-first, NOT including self. */
  readonly inherited: ReadonlyArray<FeaturePackReturn>;
}

// The frozen `ToolContext.FeaturePackStore.get` types `filePath?` but
// S7c doesn't consume it — documented in the docblock. Kept in the
// signature so a Module 05 / 07 caller passing it doesn't break.

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function defaultFeaturePacksRoot(): string {
  // Defaults assume the compiled process starts from the repo root
  // (the CLI, the mcp-server's own dist, tests with explicit
  // fixtures). Tests pass an explicit `featurePacksRoot` so they do
  // not depend on this default.
  return resolve(process.cwd(), 'docs', 'feature-packs');
}

export interface CreateFeaturePackStoreDeps {
  readonly db: DbHandle;
  /** Root of the `<slug>/{spec,implementation,techstack}.md` tree. Defaults to `${cwd}/docs/feature-packs`. */
  readonly featurePacksRoot?: string;
  /** Override `Date.now()` for deterministic cache-TTL tests. */
  readonly now?: () => number;
  /** TTL override for tests (default 60_000). */
  readonly cacheTtlMs?: number;
  readonly logger?: Logger;
}

interface CacheEntry {
  readonly result: FeaturePackReturn;
  readonly loadedAt: number;
}

// ---------------------------------------------------------------------------
// FS helpers
// ---------------------------------------------------------------------------

function packDir(root: string, slug: string): string {
  return resolve(root, slug);
}

/**
 * Read a single file or return null on ENOENT. Mirrors the bridge's
 * `readMaybe` pattern at apps/hooks-bridge/src/lib/feature-pack-loader.ts:52
 * (M04 S11 cleanup — the two readers are now symmetric).
 */
async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function readPackFromDisk(
  root: string,
  slug: string,
): Promise<{ content: FeaturePackContent; meta: FeaturePackMeta } | null> {
  const dir = packDir(root, slug);
  if (!existsSync(dir)) return null;
  // M04 S11 cleanup: spec.md + meta.json stay required; implementation.md
  // and techstack.md are optional (mirror the bridge's loader, fixing the
  // pre-existing latent fragility documented in
  // context_memory/blockers.md ✅ 2026-05-02 entry: a hand-created pack
  // with only spec.md previously threw `handler_threw` from the MCP-side
  // get_feature_pack roundtrip).
  const [specTxt, implTxt, techTxt, metaTxt] = await Promise.all([
    readMaybe(join(dir, 'spec.md')),
    readMaybe(join(dir, 'implementation.md')),
    readMaybe(join(dir, 'techstack.md')),
    readMaybe(join(dir, 'meta.json')),
  ]);
  if (specTxt === null) {
    throw new InternalError(`feature-pack '${slug}' missing required spec.md`);
  }
  if (metaTxt === null) {
    throw new InternalError(`feature-pack '${slug}' missing required meta.json`);
  }
  const parsed = metaJsonSchema.safeParse(JSON.parse(metaTxt));
  if (!parsed.success) {
    throw new InternalError(
      `feature-pack meta.json invalid for slug '${slug}': ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  if (parsed.data.slug !== slug) {
    throw new InternalError(
      `feature-pack meta.json slug mismatch for '${slug}': meta.json declares '${parsed.data.slug}'`,
    );
  }
  return {
    content: {
      spec: specTxt,
      // Optional fields default to empty strings so the rest of the
      // pipeline (checksum, search, agent context) sees a stable shape.
      implementation: implTxt ?? '',
      techstack: techTxt ?? '',
      sourceFiles: parsed.data.sourceFiles ?? [],
    },
    meta: parsed.data,
  };
}

function computeChecksum(content: FeaturePackContent): string {
  const h = createHash('sha256');
  h.update(content.spec);
  h.update(content.implementation);
  h.update(content.techstack);
  return `sha256:${h.digest('hex')}`;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function selectFeaturePackRow(db: DbHandle, slug: string): Promise<FeaturePackRow | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select()
      .from(sqliteSchema.featurePacks)
      .where(eq(sqliteSchema.featurePacks.slug, slug))
      .limit(1);
    return (rows[0] as FeaturePackRow | undefined) ?? null;
  }
  const rows = await db.db
    .select()
    .from(postgresSchema.featurePacks)
    .where(eq(postgresSchema.featurePacks.slug, slug))
    .limit(1);
  return (rows[0] as FeaturePackRow | undefined) ?? null;
}

async function upsertFeaturePackRow(
  db: DbHandle,
  row: {
    readonly id: string;
    readonly slug: string;
    readonly parentSlug: string | null;
    readonly isActive: boolean;
    readonly checksum: string;
    readonly updatedAt: Date;
  },
): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.db
      .insert(sqliteSchema.featurePacks)
      .values(row)
      .onConflictDoUpdate({
        target: sqliteSchema.featurePacks.slug,
        set: {
          parentSlug: row.parentSlug,
          isActive: row.isActive,
          checksum: row.checksum,
          updatedAt: row.updatedAt,
        },
      });
    return;
  }
  await db.db
    .insert(postgresSchema.featurePacks)
    .values(row)
    .onConflictDoUpdate({
      target: postgresSchema.featurePacks.slug,
      set: {
        parentSlug: row.parentSlug,
        isActive: row.isActive,
        checksum: row.checksum,
        updatedAt: row.updatedAt,
      },
    });
}

// ---------------------------------------------------------------------------
// Load + sync: one slug, no inheritance walk
// ---------------------------------------------------------------------------

async function loadOne(
  db: DbHandle,
  root: string,
  slug: string,
  log: Logger,
  now: () => number,
): Promise<FeaturePackReturn | null> {
  const disk = await readPackFromDisk(root, slug);
  if (!disk) return null;
  const checksum = computeChecksum(disk.content);
  const existing = await selectFeaturePackRow(db, slug);
  const updatedAt = new Date(now());
  if (!existing || existing.checksum !== checksum || existing.parentSlug !== (disk.meta.parentSlug ?? null)) {
    const id = existing?.id ?? `fp_${randomUUID()}`;
    await upsertFeaturePackRow(db, {
      id,
      slug,
      parentSlug: disk.meta.parentSlug ?? null,
      isActive: existing?.isActive ?? true,
      checksum,
      updatedAt,
    });
    log.info(
      {
        event: existing ? 'feature_pack_checksum_updated' : 'feature_pack_bootstrapped',
        slug,
        prevChecksum: existing?.checksum ?? null,
        nextChecksum: checksum,
      },
      existing
        ? 'feature pack checksum mismatch — DB row updated from filesystem'
        : 'feature pack bootstrapped from filesystem',
    );
    return {
      metadata: {
        id,
        slug,
        parentSlug: disk.meta.parentSlug ?? null,
        isActive: existing?.isActive ?? true,
        checksum,
        updatedAt,
      },
      content: disk.content,
    };
  }
  return {
    metadata: {
      id: existing.id,
      slug,
      parentSlug: existing.parentSlug ?? null,
      isActive: existing.isActive,
      checksum: existing.checksum,
      updatedAt: existing.updatedAt,
    },
    content: disk.content,
  };
}

// ---------------------------------------------------------------------------
// Inheritance walk — root-first, cycle detection
// ---------------------------------------------------------------------------

async function walkAncestors(
  db: DbHandle,
  root: string,
  leafSlug: string,
  leafParentSlug: string | null,
  log: Logger,
  now: () => number,
): Promise<ReadonlyArray<FeaturePackReturn>> {
  const visited = new Set<string>([leafSlug]);
  const chain: FeaturePackReturn[] = [];
  let cursor = leafParentSlug;
  while (cursor !== null) {
    if (visited.has(cursor)) {
      throw new InternalError(`feature_pack_cycle: ${[...visited, cursor].join(' → ')}`);
    }
    visited.add(cursor);
    const parent = await loadOne(db, root, cursor, log, now);
    if (!parent) {
      throw new InternalError(
        `feature_pack_parent_missing: slug '${cursor}' referenced by child but absent from disk + DB`,
      );
    }
    chain.push(parent);
    cursor = parent.metadata.parentSlug;
  }
  chain.reverse(); // root-first
  return chain;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createFeaturePackStore(deps: CreateFeaturePackStoreDeps): FeaturePackStore {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createFeaturePackStore requires an options object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createFeaturePackStore: deps.db must be a DbHandle from @coodra/contextos-db');
  }
  const log = deps.logger ?? featurePackLogger;
  const root = deps.featurePacksRoot ?? defaultFeaturePacksRoot();
  const now = deps.now ?? (() => Date.now());
  const cacheTtlMs = deps.cacheTtlMs ?? CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  log.info(
    { event: 'feature_pack_store_wired', featurePacksRoot: root, cacheTtlMs },
    'createFeaturePackStore: filesystem-first store wired (checksum-invalidated 60s cache).',
  );

  async function getCached(slug: string): Promise<FeaturePackReturn | null> {
    const cached = cache.get(slug);
    if (cached && now() - cached.loadedAt < cacheTtlMs) {
      return cached.result;
    }
    const fresh = await loadOne(deps.db, root, slug, log, now);
    if (!fresh) {
      cache.delete(slug);
      return null;
    }
    // Invalidate on checksum change (the cache's raison d'être) —
    // `loadOne` has already updated the DB row when mismatched.
    if (cached && cached.result.metadata.checksum !== fresh.metadata.checksum) {
      cache.delete(slug);
    }
    cache.set(slug, { result: fresh, loadedAt: now() });
    return fresh;
  }

  return {
    async get({ projectSlug, filePath: _filePath }) {
      if (typeof projectSlug !== 'string' || projectSlug.length === 0) {
        throw new InternalError('feature-pack.get: projectSlug is required (feature-pack slug namespace)');
      }
      const leaf = await getCached(projectSlug);
      if (!leaf) {
        throw new InternalError(`feature-pack.get: slug '${projectSlug}' not found on disk + DB`);
      }
      const inherited = await walkAncestors(deps.db, root, projectSlug, leaf.metadata.parentSlug, log, now);
      const result: FeaturePackGetReturn = { ...leaf, inherited };
      return result;
    },

    async list({ projectSlug }) {
      if (typeof projectSlug !== 'string' || projectSlug.length === 0) {
        throw new InternalError('feature-pack.list: projectSlug is required');
      }
      const leaf = await getCached(projectSlug);
      if (!leaf) return [];
      const inherited = await walkAncestors(deps.db, root, projectSlug, leaf.metadata.parentSlug, log, now);
      // Root-first, including the leaf itself at the end.
      return [...inherited, leaf];
    },

    async upsert(pack) {
      const upsertSchema = z.object({
        slug: z.string().min(1),
        parentSlug: z.string().min(1).nullable().optional(),
        sourceFiles: z.array(z.string().min(1)).optional(),
        spec: z.string(),
        implementation: z.string(),
        techstack: z.string(),
      });
      const parsed = upsertSchema.safeParse(pack);
      if (!parsed.success) {
        throw new InternalError(
          `feature-pack.upsert: invalid pack payload: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        );
      }
      const { slug, parentSlug, sourceFiles, spec, implementation, techstack } = parsed.data;
      const dir = packDir(root, slug);
      await mkdir(dir, { recursive: true });
      await Promise.all([
        writeFile(join(dir, 'spec.md'), spec, 'utf8'),
        writeFile(join(dir, 'implementation.md'), implementation, 'utf8'),
        writeFile(join(dir, 'techstack.md'), techstack, 'utf8'),
        writeFile(
          join(dir, 'meta.json'),
          `${JSON.stringify({ slug, parentSlug: parentSlug ?? null, sourceFiles: sourceFiles ?? [] }, null, 2)}\n`,
          'utf8',
        ),
      ]);
      cache.delete(slug); // force next read to observe the new checksum
      const loaded = await loadOne(deps.db, root, slug, log, now);
      if (!loaded) {
        throw new InternalError(`feature-pack.upsert: write succeeded but reload failed for '${slug}'`);
      }
      return loaded;
    },
  };
}
