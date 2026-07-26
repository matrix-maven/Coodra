import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { writeCoodraJson } from '../init/coodra-json.js';
import type { WriteOutcome } from '../init/types.js';

/**
 * `lib/project-store/config.ts` — project-local identity under
 * `<root>/.coodra/config.json`, the richer successor to the root-level
 * `<root>/.coodra.json`.
 *
 * Migration posture (staged, per the enhancement doc): this phase DUAL-WRITES.
 * `writeProjectConfig` writes the new `.coodra/config.json` AND keeps the
 * legacy `.coodra.json` current, so every existing reader (the hooks-bridge's
 * cwd→slug resolver, doctor check 12) keeps working UNCHANGED while new code
 * (the `coodra agent` context, `coodra files`) reads the richer file first via
 * `readProjectConfig`. Dropping the legacy write is a later release once all
 * readers prefer the new path — recorded so a future session doesn't remove
 * `.coodra.json` prematurely and break the bridge.
 */

export const PROJECT_CONFIG_REL = '.coodra/config.json' as const;
export const LEGACY_CONFIG_REL = '.coodra.json' as const;

export function projectConfigPath(root: string): string {
  return join(root, '.coodra', 'config.json');
}
export function legacyConfigPath(root: string): string {
  return join(root, '.coodra.json');
}

const projectConfigSchema = z
  .object({
    version: z.literal(1),
    projectSlug: z.string().min(1),
    mode: z.enum(['solo', 'team']).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  // Preserve unknown keys (e.g. a future `projectId`) so an older CLI that
  // reads + rewrites the file doesn't silently drop fields a newer CLI added.
  .loose();

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Read the project identity. Prefers `.coodra/config.json`; falls back to the
 * legacy `.coodra.json` (which carries only `projectSlug`). Returns null when
 * neither exists / neither has a usable slug.
 */
export async function readProjectConfig(root: string): Promise<ProjectConfig | null> {
  const fresh = await readJsonObject(projectConfigPath(root));
  if (fresh !== null) {
    const parsed = projectConfigSchema.safeParse(fresh);
    if (parsed.success) return parsed.data;
    // A present-but-malformed new file: try to salvage a slug so callers still work.
    if (typeof fresh.projectSlug === 'string' && fresh.projectSlug.length > 0) {
      return { version: 1, projectSlug: fresh.projectSlug };
    }
  }
  const legacy = await readJsonObject(legacyConfigPath(root));
  if (legacy !== null && typeof legacy.projectSlug === 'string' && legacy.projectSlug.length > 0) {
    return { version: 1, projectSlug: legacy.projectSlug };
  }
  return null;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.coodra.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

export interface WriteProjectConfigOptions {
  readonly root: string;
  readonly projectSlug: string;
  readonly mode?: 'solo' | 'team';
  readonly force: boolean;
  readonly dryRun: boolean;
  /** Injectable clock (tests). Defaults to the wall clock. */
  readonly now?: () => string;
}

/**
 * Write the project identity to BOTH `.coodra/config.json` (rich, new) and the
 * legacy `.coodra.json` (slug-only, via the existing `writeCoodraJson` with its
 * drift-preservation semantics). Returns one WriteOutcome per file.
 *
 * `.coodra/config.json` merge rules mirror `writeCoodraJson`: on an existing
 * file, the caller's slug is NOT forced over a user-edited one unless `force`
 * (drift is preserved); unknown fields are always retained; `updatedAt` bumps
 * on every real write, `createdAt` is set once.
 */
export async function writeProjectConfig(opts: WriteProjectConfigOptions): Promise<WriteOutcome[]> {
  const now = opts.now ?? (() => new Date().toISOString());
  const path = projectConfigPath(opts.root);
  const existing = await readJsonObject(path);
  const outcomes: WriteOutcome[] = [];

  if (existing === null) {
    const ts = now();
    const body: ProjectConfig = {
      version: 1,
      projectSlug: opts.projectSlug,
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    if (!opts.dryRun) await writeJsonAtomic(path, body);
    outcomes.push({ path, action: 'wrote', notes: `wrote projectSlug='${opts.projectSlug}'` });
  } else {
    const existingSlug = typeof existing.projectSlug === 'string' ? existing.projectSlug : undefined;
    const slugDrift = existingSlug !== undefined && existingSlug !== opts.projectSlug;
    if (slugDrift && !opts.force) {
      outcomes.push({
        path,
        action: 'unchanged',
        notes: `projectSlug='${existingSlug}' differs from requested '${opts.projectSlug}'; pass --force to overwrite`,
      });
    } else {
      const merged: Record<string, unknown> = {
        ...existing,
        version: 1,
        projectSlug: opts.projectSlug,
        ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
        createdAt: typeof existing.createdAt === 'string' ? existing.createdAt : now(),
        updatedAt: now(),
      };
      // No-op when the only thing that would change is updatedAt AND nothing
      // material moved — keep it simple: report merged/forced.
      if (!opts.dryRun) await writeJsonAtomic(path, merged);
      outcomes.push({
        path,
        action: opts.force && slugDrift ? 'forced' : 'merged',
        notes: `projectSlug='${opts.projectSlug}'`,
      });
    }
  }

  // Legacy `.coodra.json` — keep current via the existing writer (its own
  // drift-preservation + force semantics apply).
  outcomes.push(
    await writeCoodraJson({ cwd: opts.root, projectSlug: opts.projectSlug, force: opts.force, dryRun: opts.dryRun }),
  );
  return outcomes;
}

export interface EnsureProjectConfigResult {
  readonly outcomes: WriteOutcome[];
  /** True when the new `.coodra/config.json` did not exist before this call. */
  readonly createdConfig: boolean;
}

/**
 * Idempotent migration/ensure: guarantees `.coodra/config.json` exists for a
 * project, copying the slug from the legacy `.coodra.json` when present. Safe to
 * run repeatedly (`coodra init`, `coodra doctor --fix`). Never overwrites a
 * user-edited slug without `force`.
 */
export async function ensureProjectConfig(opts: WriteProjectConfigOptions): Promise<EnsureProjectConfigResult> {
  const existedBefore = (await readJsonObject(projectConfigPath(opts.root))) !== null;
  const outcomes = await writeProjectConfig(opts);
  return { outcomes, createdConfig: !existedBefore };
}
