import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

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

const META_SCHEMA = z
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

function packsRoot(cwd: string = process.cwd()): string {
  // Honor explicit override via env, then walk up. Fallback to literal
  // `<cwd>/docs/feature-packs` so the empty-state behaviour is the same
  // when no project is reachable.
  const override = process.env.COODRA_PACKS_ROOT;
  if (typeof override === 'string' && override.length > 0) {
    return override;
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
  if (metaRaw !== null) {
    try {
      const parsed = META_SCHEMA.parse(JSON.parse(metaRaw));
      parentSlug = parsed.parentSlug ?? null;
      isActive = parsed.isActive ?? true;
    } catch {
      // Leave defaults; invalid meta.json is reported via fileCount delta.
    }
  }
  const fileCount = [hasMeta, hasSpec, hasImplementation, hasTechstack].filter(Boolean).length;
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
  };
}

export function listPacks(cwd: string = process.cwd()): PackListRow[] {
  const root = packsRoot(cwd);
  if (!existsSync(root)) return [];
  const out: PackListRow[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(buildRow(entry, dir));
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function getPack(slug: string, cwd: string = process.cwd()): PackDetail | null {
  const root = packsRoot(cwd);
  const dir = join(root, slug);
  if (!existsSync(dir)) return null;
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
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
