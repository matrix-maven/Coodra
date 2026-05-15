import 'server-only';

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

import { postgresSchema, sqliteSchema } from '@coodra/db';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web/lib/queries/packs.ts` — server-only filesystem scanner for
 * `<cwd>/docs/feature-packs/<slug>/`. Each pack directory holds the
 * canonical four files (spec.md, implementation.md, techstack.md,
 * meta.json). Missing files are tolerated (mirrors the bridge's
 * readMaybe pattern) so a hand-created pack with only spec.md still
 * lists.
 *
 * Solo mode: scans the operator's repo (process.cwd()/docs/feature-packs/).
 * Team mode: same path; if the operator runs the web from outside a
 * project root, the listing is empty (acceptable v1 behaviour — pack
 * editing is operator-side anyway).
 *
 * No DB hits — this is purely on-disk pack metadata, separate from
 * the `feature_packs` table (which is the MCP-side index for
 * `search_packs_nl`).
 */

/**
 * meta.json schema. Exported so server actions (lib/actions/packs.ts →
 * uploadPackAction's primary-pack patch step) can re-validate after
 * mutating `parentSlug`. `passthrough()` preserves any future fields
 * (e.g. `kind: "freeform"`) that the action shouldn't strip.
 */
export const META_SCHEMA = z
  .object({
    slug: z.string(),
    parentSlug: z.string().nullable().optional(),
    sourceFiles: z.array(z.string()).optional(),
    isActive: z.boolean().optional(),
  })
  .passthrough();

export interface PackListRow {
  readonly slug: string;
  readonly dir: string;
  readonly parentSlug: string | null;
  readonly isActive: boolean;
  readonly hasMeta: boolean;
  readonly hasSpec: boolean;
  readonly hasImplementation: boolean;
  readonly hasTechstack: boolean;
  readonly fileCount: number;
  /**
   * True when this pack was written by `coodra init` and never edited
   * — i.e. it is the canonical 4-file template stub. Used by the web
   * upload flow to auto-allow overwrite without forcing the operator to
   * tick the "force" checkbox; uploading over a stub is *not* an
   * overwrite the operator needs to be warned about, it's the obvious
   * intent.
   *
   * Detection rule: `meta.json` has no `kind` field (freeform uploads
   * always set `kind: 'freeform'`) AND the pack lacks any operator
   * edits. Conservative — false-negatives just mean the operator has
   * to tick "force" the way they do today; false-positives would
   * silently overwrite hand-written packs which would be bad.
   */
  readonly isTemplateStub: boolean;
}

export interface PackDetail extends PackListRow {
  readonly spec: string | null;
  readonly implementation: string | null;
  readonly techstack: string | null;
  readonly metaRaw: string | null;
}

/**
 * Walks up from `start` looking for the closest `docs/feature-packs/`
 * directory. Returns null if none found within 6 levels.
 *
 * Why walk up: `process.cwd()` is whatever directory Next.js was
 * launched from — running `pnpm --filter @coodra/web start`
 * lands in `apps/web/` (the package dir), but the project's
 * `docs/feature-packs/` lives at the repo root. Walking up finds it
 * regardless of the launch dir.
 */
function findPacksRoot(start: string = process.cwd()): string | null {
  let cursor = start;
  for (let i = 0; i < 6; i++) {
    const candidate = join(cursor, 'docs', 'feature-packs');
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        // continue walking up
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

/**
 * Resolve the on-disk packs root. Exported so server actions
 * (lib/actions/packs.ts → uploadPackAction) write to the same
 * directory the listing reads from.
 *
 * Behaviour by `cwd` source:
 *
 * 1. Caller passes `projects.cwd` (the absolute project root recorded by
 *    the bridge / CLI) → return `<projectCwd>/docs/feature-packs` directly.
 *    No walk-up: the project root is authoritative; we want every per-project
 *    upload to land *inside* that project, not in some ancestor that happens
 *    to also have a `docs/feature-packs/` directory (e.g. the Coodra repo
 *    root when web-v2 is dev-served from there).
 *
 * 2. Caller omits cwd or passes `process.cwd()` → fall back to the legacy
 *    walk-up behaviour. Used by the workspace-global `/packs/new` route
 *    where there is no project context, and by pre-2026-05-08 projects
 *    rows that have a null `cwd`.
 *
 * 3. `COODRA_PACKS_ROOT` env override always wins (test / containerized
 *    deploys that pin packs to a known absolute path).
 */
export function packsRoot(cwd: string = process.cwd()): string {
  const override = process.env.COODRA_PACKS_ROOT;
  if (typeof override === 'string' && override.length > 0) {
    return override;
  }
  // When a caller supplies a cwd that ISN'T process.cwd(), they're declaring
  // it authoritative (typically `projects.cwd` from the DB). Treat the path
  // as the project root and pin packs to its `docs/feature-packs` child
  // without any walk-up that could escape into an ancestor.
  if (cwd !== process.cwd()) {
    return resolve(cwd, 'docs', 'feature-packs');
  }
  return findPacksRoot(cwd) ?? resolve(cwd, 'docs', 'feature-packs');
}

function readMaybe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function buildRow(slug: string, dir: string): PackListRow {
  const metaPath = join(dir, 'meta.json');
  const specPath = join(dir, 'spec.md');
  const implPath = join(dir, 'implementation.md');
  const techPath = join(dir, 'techstack.md');
  const metaRaw = readMaybe(metaPath);
  const hasMeta = metaRaw !== null;
  const hasSpec = existsSync(specPath);
  const hasImplementation = existsSync(implPath);
  const hasTechstack = existsSync(techPath);
  let parentSlug: string | null = null;
  let isActive = true;
  let metaKind: string | undefined;
  if (metaRaw !== null) {
    try {
      const parsed = META_SCHEMA.parse(JSON.parse(metaRaw));
      parentSlug = parsed.parentSlug ?? null;
      isActive = parsed.isActive ?? true;
      // `kind` is freeform on `META_SCHEMA.passthrough()`. Cast through
      // unknown so we don't depend on a typed field that may not exist
      // on every meta.json; the runtime check below handles missing
      // gracefully.
      const k = (parsed as unknown as { kind?: unknown }).kind;
      if (typeof k === 'string') metaKind = k;
    } catch {
      // Leave defaults; invalid meta.json is reported via fileCount delta.
    }
  }
  const fileCount = [hasMeta, hasSpec, hasImplementation, hasTechstack].filter(Boolean).length;
  // Template-stub detection. Two signals:
  //  1. meta.json's `kind` is NOT 'freeform'. `coodra init`
  //     historically wrote meta.json without a `kind` field (or with a
  //     template-specific value). The web `uploadPackAction` always
  //     writes `kind: 'freeform'`, so its absence reliably marks a
  //     never-uploaded pack.
  //  2. spec.md still has the verbatim "Status: TODO" line that
  //     `buildSpecSkeleton` writes. This catches the legacy skeleton
  //     output AND most published templates which inherit the same
  //     "Status:" header convention.
  // EITHER signal is enough — false negatives (real freeform pack that
  // happens to start with "Status: TODO") are rare and just mean the
  // operator has to tick "force" the way they do today. False positives
  // would silently overwrite real content, so we keep the rule
  // conservative.
  const specBody = hasSpec ? readMaybe(specPath) : null;
  const looksLikeStubSpec = specBody !== null && /^>?\s*\*?\*?Status:\*?\*?\s*TODO/m.test(specBody.slice(0, 600));
  const isTemplateStub = hasMeta && metaKind !== 'freeform' && (looksLikeStubSpec || !hasSpec);
  return {
    slug,
    dir,
    parentSlug,
    isActive,
    hasMeta,
    hasSpec,
    hasImplementation,
    hasTechstack,
    fileCount,
    isTemplateStub,
  };
}

/**
 * Phase F.6 — collect every registered project's cwd from the local
 * SQLite. Used by `listPacks` to union packs across projects (Next.js
 * runs from one dir, but the user has many projects) and by
 * `getPack(slug)` to short-circuit straight to the slug's project cwd.
 *
 * Sentinel orgs (`__solo__` / `__global__`) ARE included — a solo
 * developer's projects all live under `__solo__`. Team-mode rows
 * have real Clerk org_ids and also get walked. The query filters
 * sentinel SLUGS (`__global__`) so we don't try to read packs from
 * the global sentinel row's cwd.
 */
function getRegisteredProjectCwds(): Map<string, string> {
  try {
    const handle = createWebDb();
    const out = new Map<string, string>();
    if (handle.kind === 'sqlite') {
      const rows = handle.raw
        .prepare("SELECT slug, cwd FROM projects WHERE cwd IS NOT NULL AND slug NOT LIKE '\\_\\_%' ESCAPE '\\'")
        .all() as Array<{ slug: string; cwd: string }>;
      for (const r of rows) {
        if (typeof r.cwd === 'string' && r.cwd.length > 0) out.set(r.slug, r.cwd);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * Phase F.6+ — synthesize a PackListRow from a cloud feature_packs row.
 * Used when the FS has no copy yet (team-hosted web just wrote to cloud,
 * sync-daemon hasn't materialized FS yet OR machine has no FS at all).
 */
function buildRowFromCloudJson(
  slug: string,
  contentJson: string | null,
  parentSlug: string | null,
  isActive: boolean,
): PackListRow {
  let hasSpec = false;
  let hasImplementation = false;
  let hasTechstack = false;
  let hasMeta = false;
  if (contentJson !== null) {
    try {
      const parsed = JSON.parse(contentJson) as Record<string, unknown>;
      hasSpec = typeof parsed.spec === 'string' && (parsed.spec as string).length > 0;
      hasImplementation = typeof parsed.implementation === 'string' && (parsed.implementation as string).length > 0;
      hasTechstack = typeof parsed.techstack === 'string' && (parsed.techstack as string).length > 0;
      hasMeta = parsed.meta !== undefined && parsed.meta !== null;
    } catch {
      // ignore
    }
  }
  return {
    slug,
    dir: `(cloud) feature_packs.slug='${slug}'`,
    parentSlug,
    isActive,
    hasMeta,
    hasSpec,
    hasImplementation,
    hasTechstack,
    fileCount: [hasMeta, hasSpec, hasImplementation, hasTechstack].filter(Boolean).length,
    isTemplateStub: false,
  };
}

/**
 * Phase F.6+ — read cloud feature_packs (postgres or sqlite mirror)
 * for completeness. Returns a Map of slug → row data, including null
 * for unknown/missing fields. Used as the cross-mode fallback when
 * FS-based scans miss a slug.
 */
async function readDbPackRows(): Promise<
  Map<
    string,
    {
      readonly contentJson: string | null;
      readonly parentSlug: string | null;
      readonly isActive: boolean;
      readonly status: string;
    }
  >
> {
  const out = new Map<
    string,
    { contentJson: string | null; parentSlug: string | null; isActive: boolean; status: string }
  >();
  try {
    const handle = createWebDb();
    if (handle.kind === 'postgres') {
      const rows = await handle.db
        .select({
          slug: postgresSchema.featurePacks.slug,
          contentJson: postgresSchema.featurePacks.contentJson,
          parentSlug: postgresSchema.featurePacks.parentSlug,
          isActive: postgresSchema.featurePacks.isActive,
          status: postgresSchema.featurePacks.status,
        })
        .from(postgresSchema.featurePacks)
        .limit(500);
      for (const r of rows) {
        out.set(r.slug, {
          contentJson: r.contentJson,
          parentSlug: r.parentSlug,
          isActive: r.isActive,
          status: r.status,
        });
      }
    } else {
      const rows = await handle.db
        .select({
          slug: sqliteSchema.featurePacks.slug,
          contentJson: sqliteSchema.featurePacks.contentJson,
          parentSlug: sqliteSchema.featurePacks.parentSlug,
          isActive: sqliteSchema.featurePacks.isActive,
          status: sqliteSchema.featurePacks.status,
        })
        .from(sqliteSchema.featurePacks)
        .limit(500);
      for (const r of rows) {
        out.set(r.slug, {
          contentJson: r.contentJson,
          parentSlug: r.parentSlug,
          isActive: r.isActive,
          status: r.status,
        });
      }
    }
  } catch {
    // DB unreachable — fall through with empty map. FS path still works.
  }
  return out;
}

export async function listPacks(cwd: string = process.cwd()): Promise<PackListRow[]> {
  // Phase F.6+ — union FS-scanned rows + DB rows. Dedupe by slug
  // (DB row takes precedence if both exist; FS may be stale).
  const seenDirs = new Set<string>();
  const fsRows: PackListRow[] = [];

  const addFromRoot = (root: string): void => {
    if (!existsSync(root)) return;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return;
    }
    for (const entry of entries) {
      const dir = join(root, entry);
      if (seenDirs.has(dir)) continue;
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      seenDirs.add(dir);
      fsRows.push(buildRow(entry, dir));
    }
  };

  addFromRoot(packsRoot(cwd));
  for (const projectCwd of getRegisteredProjectCwds().values()) {
    addFromRoot(packsRoot(projectCwd));
  }

  // Cloud / DB rows: include any slug not present on disk.
  const dbRows = await readDbPackRows();
  const seenSlugs = new Set(fsRows.map((r) => r.slug));
  for (const [slug, dbRow] of dbRows) {
    if (seenSlugs.has(slug)) continue;
    fsRows.push(buildRowFromCloudJson(slug, dbRow.contentJson, dbRow.parentSlug, dbRow.isActive));
  }

  return fsRows.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function getPack(slug: string, cwd: string = process.cwd()): Promise<PackDetail | null> {
  // Phase F.6+ — FS lookup first (instant local feedback). Fall back
  // to the DB layer (cloud Postgres in team-hosted, local SQLite
  // mirror otherwise) when FS doesn't have the slug.
  const projectCwds = getRegisteredProjectCwds();
  const candidates: string[] = [];
  const direct = projectCwds.get(slug);
  if (direct !== undefined) candidates.push(packsRoot(direct));
  for (const projectCwd of projectCwds.values()) {
    const r = packsRoot(projectCwd);
    if (!candidates.includes(r)) candidates.push(r);
  }
  const walkUp = packsRoot(cwd);
  if (!candidates.includes(walkUp)) candidates.push(walkUp);

  for (const root of candidates) {
    const dir = join(root, slug);
    if (!existsSync(dir)) continue;
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const row = buildRow(slug, dir);
    return {
      ...row,
      spec: readMaybe(join(dir, 'spec.md')),
      implementation: readMaybe(join(dir, 'implementation.md')),
      techstack: readMaybe(join(dir, 'techstack.md')),
      metaRaw: readMaybe(join(dir, 'meta.json')),
    };
  }

  // FS miss — try DB layer. In team-hosted this is cloud Postgres
  // (the only place the pack lives); in local-team it's the local
  // SQLite mirror which the sync-daemon keeps current.
  const dbRows = await readDbPackRows();
  const dbRow = dbRows.get(slug);
  if (dbRow === undefined) return null;
  let spec: string | null = null;
  let implementation: string | null = null;
  let techstack: string | null = null;
  let metaRaw: string | null = null;
  if (dbRow.contentJson !== null) {
    try {
      const parsed = JSON.parse(dbRow.contentJson) as Record<string, unknown>;
      spec = typeof parsed.spec === 'string' ? (parsed.spec as string) : null;
      implementation = typeof parsed.implementation === 'string' ? (parsed.implementation as string) : null;
      techstack = typeof parsed.techstack === 'string' ? (parsed.techstack as string) : null;
      if (parsed.meta !== undefined && parsed.meta !== null) {
        metaRaw = JSON.stringify(parsed.meta, null, 2);
      }
    } catch {
      // malformed content_json — show as empty body but row still renders
    }
  }
  const listRow = buildRowFromCloudJson(slug, dbRow.contentJson, dbRow.parentSlug, dbRow.isActive);
  return { ...listRow, spec, implementation, techstack, metaRaw };
}
