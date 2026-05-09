import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { type DbHandle, ensureProject, postgresSchema, sqliteSchema } from '@coodra/contextos-db';
import { createLogger } from '@coodra/contextos-shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * `apps/hooks-bridge/src/lib/resolve-project-slug` — two-stage resolver:
 *   1. cwd → slug  (read `<cwd>/.contextos.json`, or derive from basename)
 *   2. slug → projects.id  (DB lookup; M04 Phase 2 S1 adds optional auto-ensure)
 *
 * Both stages are cached (60s) per-key. The policy evaluator filters
 * rules by `policies.project_id`, which is a foreign key into
 * `projects.id` (a UUID); the slug stored in `.contextos.json` and
 * referenced by tools is the human-readable lookup key. The hooks-
 * bridge pre-tool handler uses this resolver to bridge the gap.
 *
 * On any failure (file missing, schema mismatch, DB error, project
 * unregistered): `resolve()` returns undefined. The policy evaluator
 * falls back to the `__global__` cache slot, which loads the
 * unfiltered union of every project's rules. This is a soft-fail by
 * design — the policy still runs, just at a coarser scope.
 *
 * **M04 Phase 2 S1 (F3 root cause, 2026-05-04, OQ-2 lock).** Added
 * `resolveAndEnsure(cwd, db)`. Audit handlers (`recordPolicyDecision`,
 * `recordPostToolUse`, etc.) call this variant — it auto-creates a
 * `projects` row when none exists. Before the fix, every event from
 * an un-registered cwd landed with `run_id=NULL` and decisions
 * attributed to `__global__`; the 2026-05-04 audit found 1,405 of
 * 1,407 historical events orphaned this way. The runtime fix here
 * + the 0009 backfill migration close that loop.
 *
 * `resolve()` (read-only) stays the public surface for policy
 * evaluation — auto-ensuring during a hot-path read is a side effect
 * we want to keep out of the policy decision flow.
 */

const projectSlugLogger = createLogger('hooks-bridge.resolve-project-slug');

const ContextosJsonSchema = z
  .object({
    projectSlug: z.string().min(1).optional(),
  })
  .passthrough();

interface SlugCacheEntry {
  readonly slug: string | undefined;
  readonly loadedAt: number;
}

interface IdCacheEntry {
  readonly projectId: string | undefined;
  readonly loadedAt: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;

export interface CreateProjectResolverOptions {
  /** Cache TTL override (tests). */
  readonly cacheTtlMs?: number;
  /** Clock injection. */
  readonly now?: () => number;
}

export interface ProjectResolution {
  /** From `.contextos.json`. */
  readonly slug: string | undefined;
  /** From the projects table. Undefined if slug not registered. */
  readonly projectId: string | undefined;
}

export interface ProjectSlugResolver {
  /**
   * Read-only resolve. Returns `{ slug, projectId }` for the cwd.
   * Both fields are undefined when no `.contextos.json` is present;
   * only `projectId` is undefined when the slug is set but not yet
   * registered as a `projects` row. Used by the policy-evaluator
   * hot path (no side effects).
   */
  resolve(cwd: string | undefined, db: DbHandle): Promise<ProjectResolution>;
  /**
   * M04 Phase 2 S1 (F3 root-cause fix). Resolve, then auto-create
   * the `projects` row when missing — using the slug from
   * `.contextos.json` if present, else deriving a slug from
   * `basename(cwd)`. Returns the resolved `{ slug, projectId }`;
   * if cwd cannot yield a usable slug (reserved name, empty,
   * sanitization fails) BOTH fields are undefined and the caller
   * falls back to `__global__` per the F7 invariant.
   *
   * Used by audit handlers (run-recorder, policy-decision recorder)
   * so events always land with a real `projects` FK + `runs.run_id`.
   */
  resolveAndEnsure(cwd: string | undefined, db: DbHandle): Promise<ProjectResolution>;
  /** Test helper — drops both caches. */
  invalidate(): void;
}

export function createProjectSlugResolver(options: CreateProjectResolverOptions = {}): ProjectSlugResolver {
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const slugCache = new Map<string, SlugCacheEntry>();
  const idCache = new Map<string, IdCacheEntry>();
  // Process-lifetime memo of slugs we've already attempted to backfill `cwd`
  // on. The hot path (every audit write hits resolveAndEnsure) would
  // otherwise fire one extra `ensureProject` roundtrip per request — this
  // set caps the cost at one extra UPDATE per slug per process. The DB-side
  // backfill is also idempotent (only writes when projects.cwd IS NULL), so
  // re-attempting is safe but pointless.
  const backfilledSlugs = new Set<string>();

  async function resolveSlug(cwd: string): Promise<string | undefined> {
    const cached = slugCache.get(cwd);
    if (cached && now() - cached.loadedAt < cacheTtlMs) return cached.slug;
    // Walk up from the literal cwd looking for the closest `.contextos.json`.
    // This is the project-root analogue of how Git finds `.git/`. Without
    // walk-up, an agent started in `~/Coodra/apps/web-v2` would derive a
    // `web-v2` slug and create a stub project, even though `~/Coodra` is
    // the real registered root with slug `contextos`. Cap depth at 12 to
    // bound disk I/O if the cwd is far below the project root.
    let slug: string | undefined;
    let cursor = cwd;
    for (let i = 0; i < 12; i++) {
      try {
        const raw = await readFile(join(cursor, '.contextos.json'), 'utf8');
        const parsed = ContextosJsonSchema.parse(JSON.parse(raw));
        slug = parsed.projectSlug;
        if (slug !== undefined) break;
      } catch {
        // Not at this level — keep walking up.
      }
      const parent = dirname(cursor);
      if (parent === cursor) break; // hit filesystem root
      cursor = parent;
    }
    if (slug === undefined) {
      projectSlugLogger.debug(
        { event: 'project_slug_unavailable', cwd },
        '.contextos.json not found between cwd and filesystem root; using __global__ policy cache',
      );
    } else if (cursor !== cwd) {
      projectSlugLogger.debug(
        { event: 'project_slug_resolved_from_ancestor', cwd, ancestor: cursor, slug },
        'resolved project slug from ancestor `.contextos.json`',
      );
    }
    slugCache.set(cwd, { slug, loadedAt: now() });
    return slug;
  }

  async function resolveProjectId(slug: string, db: DbHandle): Promise<string | undefined> {
    const cached = idCache.get(slug);
    if (cached && now() - cached.loadedAt < cacheTtlMs) return cached.projectId;
    let projectId: string | undefined;
    try {
      if (db.kind === 'sqlite') {
        const rows = await db.db
          .select({ id: sqliteSchema.projects.id })
          .from(sqliteSchema.projects)
          .where(eq(sqliteSchema.projects.slug, slug))
          .limit(1);
        projectId = rows[0]?.id;
      } else {
        const rows = await db.db
          .select({ id: postgresSchema.projects.id })
          .from(postgresSchema.projects)
          .where(eq(postgresSchema.projects.slug, slug))
          .limit(1);
        projectId = rows[0]?.id;
      }
    } catch (err) {
      projectSlugLogger.warn(
        { event: 'project_id_lookup_failed', slug, err: err instanceof Error ? err.message : String(err) },
        'project id lookup threw; treating as not-registered',
      );
      projectId = undefined;
    }
    idCache.set(slug, { projectId, loadedAt: now() });
    return projectId;
  }

  return {
    async resolve(cwd, db) {
      if (cwd === undefined || cwd.length === 0) {
        return { slug: undefined, projectId: undefined };
      }
      const slug = await resolveSlug(cwd);
      if (slug === undefined) {
        return { slug: undefined, projectId: undefined };
      }
      const projectId = await resolveProjectId(slug, db);
      return { slug, projectId };
    },
    async resolveAndEnsure(cwd, db) {
      if (cwd === undefined || cwd.length === 0) {
        return { slug: undefined, projectId: undefined };
      }
      // First try the read-only path — fast happy path when project exists.
      const sidecarSlug = await resolveSlug(cwd);
      let slug = sidecarSlug;
      if (slug !== undefined) {
        const existing = await resolveProjectId(slug, db);
        if (existing !== undefined) {
          // Project row exists. Try to backfill `projects.cwd` once per
          // process lifetime — covers projects created before the column
          // existed (legacy rows) AND projects auto-ensured by basename
          // before the bridge knew the cwd. ensureProject is idempotent
          // (the SQL update fires only when the column is null), so this
          // is a one-time UPDATE per slug.
          if (!backfilledSlugs.has(slug)) {
            backfilledSlugs.add(slug);
            try {
              await ensureProject(db, { slug, cwd });
            } catch (err) {
              projectSlugLogger.debug(
                {
                  event: 'project_cwd_backfill_failed',
                  slug,
                  cwd,
                  err: err instanceof Error ? err.message : String(err),
                },
                'cwd backfill on existing row threw; continuing with cached projectId',
              );
            }
          }
          return { slug, projectId: existing };
        }
      }
      // Need to create. If no sidecar slug, derive from cwd basename.
      if (slug === undefined) {
        const derived = deriveSlugFromCwd(cwd);
        if (derived === undefined) {
          // Reserved / unusable basename → fall back to __global__ via undefined.
          projectSlugLogger.debug(
            { event: 'project_slug_derive_failed', cwd },
            'cwd basename could not yield a usable slug; falling back to __global__',
          );
          return { slug: undefined, projectId: undefined };
        }
        slug = derived;
      }
      // Auto-create. ensureProject is idempotent at the unique-slug index, so
      // a concurrent insert from another handler is benign. Pass `cwd` so the
      // projects row records the absolute filesystem path of the project root
      // (the directory containing `.contextos.json`) — the web app's per-project
      // pack uploader reads this to write into the right folder.
      // ensureProject backfills only when the existing row's cwd is null, so
      // a stale cwd from a renamed/moved project never overwrites the original.
      try {
        const result = await ensureProject(db, { slug, cwd });
        // Cache the brand-new id so the next read is instant.
        idCache.set(slug, { projectId: result.id, loadedAt: now() });
        // If the slug was derived (no sidecar), also cache the cwd→slug
        // mapping so subsequent events from the same cwd skip the disk
        // read + re-derivation.
        if (sidecarSlug === undefined) {
          slugCache.set(cwd, { slug, loadedAt: now() });
        }
        if (result.created) {
          projectSlugLogger.info(
            {
              event: 'project_auto_ensured',
              cwd,
              slug,
              projectId: result.id,
              source: sidecarSlug !== undefined ? 'sidecar' : 'basename',
            },
            'auto-created projects row from un-registered cwd (M04 Phase 2 S1 F3 fix)',
          );
        }
        return { slug, projectId: result.id };
      } catch (err) {
        projectSlugLogger.warn(
          { event: 'project_auto_ensure_failed', cwd, slug, err: err instanceof Error ? err.message : String(err) },
          'ensureProject threw; falling back to __global__',
        );
        return { slug, projectId: undefined };
      }
    },
    invalidate() {
      slugCache.clear();
      idCache.clear();
    },
  };
}

/**
 * Derive a project slug from a cwd path's basename. Returns undefined
 * when the basename can't yield a usable slug (reserved name, empty,
 * regex-fails-after-sanitization, too long).
 *
 * Sanitization: lowercase + collapse non-`[a-z0-9-]` runs to `-` +
 * trim leading/trailing `-`. Cap at 64 chars to match the CLI's slug
 * validator (`packages/cli/src/lib/init/run.ts`'s `validateSlug`).
 *
 * Reserved-name reject list: filesystem-root-ish basenames where
 * auto-creating a project would be wrong (e.g. `/Users/abishaikc` →
 * `abishaikc` is fine; `/tmp` → `tmp` is reserved). The list is
 * conservative; users hitting one of these can ship a `.contextos.json`
 * to be explicit.
 */
const RESERVED_BASENAMES = new Set(['', '/', 'root', 'tmp', 'var', 'home', 'users', 'private', 'opt', 'etc']);

function deriveSlugFromCwd(cwd: string): string | undefined {
  const base = basename(cwd);
  if (RESERVED_BASENAMES.has(base.toLowerCase())) return undefined;
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (sanitized.length === 0 || sanitized.length > 64) return undefined;
  if (RESERVED_BASENAMES.has(sanitized)) return undefined;
  return sanitized;
}
