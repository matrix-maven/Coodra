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
   * True when this pack was written by `contextos init` and never edited
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
 * launched from — running `pnpm --filter @coodra/contextos-web start`
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
 * 3. `CONTEXTOS_PACKS_ROOT` env override always wins (test / containerized
 *    deploys that pin packs to a known absolute path).
 */
export function packsRoot(cwd: string = process.cwd()): string {
  const override = process.env.CONTEXTOS_PACKS_ROOT;
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
  //  1. meta.json's `kind` is NOT 'freeform'. `contextos init`
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
