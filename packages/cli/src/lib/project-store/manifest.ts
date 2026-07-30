import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';

/**
 * `lib/project-store/manifest.ts` — `<root>/.coodra/manifest.json`, the
 * generated-file ownership ledger. Every file Coodra (or an agent, or a
 * third-party integration) writes into a project gets an entry: its owner,
 * kind, the command that created it, and a cleanup policy. This is what makes
 * Coodra "intentional instead of file-noisy" — `coodra files status` shows the
 * ledger, `coodra files clean` acts on it, and `coodra uninstall` can consult
 * it. The manifest itself + the project config are `preserve`; agent configs
 * are `ask`; pure generated artifacts are `safe`.
 */

export const MANIFEST_REL = '.coodra/manifest.json' as const;

export function manifestPath(root: string): string {
  return join(root, '.coodra', 'manifest.json');
}

export type CleanupPolicy = 'preserve' | 'ask' | 'safe';
export type ManifestScope = 'project' | 'global';

const manifestEntrySchema = z
  .object({
    /** Project-relative for `scope: 'project'`; absolute for `scope: 'global'`. */
    path: z.string().min(1),
    scope: z.enum(['project', 'global']),
    owner: z.string().min(1),
    kind: z.string().min(1),
    createdBy: z.string().min(1),
    cleanup: z.enum(['preserve', 'ask', 'safe']),
    safeToDelete: z.boolean(),
    updatedAt: z.string().optional(),
  })
  .strict();

export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
export type ManifestEntryInput = Omit<ManifestEntry, 'updatedAt'>;

const manifestSchema = z
  .object({
    version: z.literal(1),
    projectSlug: z.string().min(1),
    entries: z.array(manifestEntrySchema),
  })
  .loose();

export type Manifest = z.infer<typeof manifestSchema>;

/**
 * Read the manifest LENIENTLY: a single malformed entry must not hide the whole
 * ledger. We validate the envelope (needs a projectSlug) and then keep only the
 * entries that individually pass validation, dropping the rest. Returns null
 * only when the file is absent / unparseable / has no usable projectSlug.
 */
export async function readManifest(root: string): Promise<Manifest | null> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(root), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const projectSlug = typeof obj.projectSlug === 'string' && obj.projectSlug.length > 0 ? obj.projectSlug : null;
  if (projectSlug === null) return null;
  const rawEntries = Array.isArray(obj.entries) ? obj.entries : [];
  const entries: ManifestEntry[] = [];
  for (const candidate of rawEntries) {
    const result = manifestEntrySchema.safeParse(candidate);
    if (result.success) entries.push(result.data);
  }
  return { version: 1, projectSlug, entries };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.coodra.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

export interface RecordManifestOptions {
  readonly root: string;
  readonly projectSlug: string;
  readonly entries: readonly ManifestEntryInput[];
  readonly dryRun: boolean;
  /** Injectable clock (tests). */
  readonly now?: () => string;
}

/**
 * Idempotent upsert of manifest entries, keyed on `path`. Re-recording a path
 * replaces its metadata (and bumps `updatedAt`); other entries are untouched.
 * Entries are sorted by (scope, path) for a stable on-disk diff. Returns the
 * count of entries in the manifest after the write.
 */
export async function recordManifestEntries(opts: RecordManifestOptions): Promise<{ total: number; recorded: number }> {
  if (opts.entries.length === 0) {
    const existing = await readManifest(opts.root);
    return { total: existing?.entries.length ?? 0, recorded: 0 };
  }
  const now = opts.now ?? (() => new Date().toISOString());
  const existing = await readManifest(opts.root);
  const byPath = new Map<string, ManifestEntry>();
  for (const e of existing?.entries ?? []) byPath.set(e.path, e);
  for (const input of opts.entries) {
    byPath.set(input.path, { ...input, updatedAt: now() });
  }
  const entries = [...byPath.values()].sort((a, b) =>
    a.scope === b.scope ? a.path.localeCompare(b.path) : a.scope.localeCompare(b.scope),
  );
  const manifest: Manifest = { version: 1, projectSlug: opts.projectSlug, entries };
  if (!opts.dryRun) await writeJsonAtomic(manifestPath(opts.root), manifest);
  return { total: entries.length, recorded: opts.entries.length };
}

/** Remove entries by path. Returns the paths that were actually present + removed. */
export async function pruneManifestEntries(
  root: string,
  paths: readonly string[],
  opts: { dryRun: boolean },
): Promise<string[]> {
  const existing = await readManifest(root);
  if (existing === null) return [];
  const drop = new Set(paths);
  const kept = existing.entries.filter((e) => !drop.has(e.path));
  const removed = existing.entries.filter((e) => drop.has(e.path)).map((e) => e.path);
  if (removed.length > 0 && !opts.dryRun) {
    await writeJsonAtomic(manifestPath(root), { ...existing, entries: kept });
  }
  return removed;
}

// ---------------------------------------------------------------------------
// File classification — the single mapping from a generated file to its
// owner / kind / cleanup policy. Both `coodra init` and `coodra agent add`
// classify their WriteOutcome paths through this so the metadata is defined
// in ONE place.
// ---------------------------------------------------------------------------

interface Classification {
  readonly owner: string;
  readonly kind: string;
  readonly cleanup: CleanupPolicy;
  readonly safeToDelete: boolean;
}

/** basename / relative-suffix → classification. Order matters (first match wins). */
const RULES: ReadonlyArray<{ test: (rel: string, base: string) => boolean; cls: Classification }> = [
  {
    test: (rel) => rel === '.coodra/config.json',
    cls: { owner: 'coodra', kind: 'project-config', cleanup: 'preserve', safeToDelete: false },
  },
  {
    test: (rel) => rel === '.coodra/manifest.json',
    cls: { owner: 'coodra', kind: 'project-manifest', cleanup: 'preserve', safeToDelete: false },
  },
  {
    test: (rel) => rel === '.coodra/skill-packs',
    cls: { owner: 'coodra', kind: 'skill-packs-dir', cleanup: 'preserve', safeToDelete: false },
  },
  {
    test: (rel) => rel === '.coodra/graphify',
    cls: { owner: 'coodra', kind: 'graphify-dir', cleanup: 'preserve', safeToDelete: false },
  },
  {
    test: (rel) => rel === '.coodra/wiki',
    cls: { owner: 'coodra', kind: 'wiki-dir', cleanup: 'preserve', safeToDelete: false },
  },
  {
    test: (_rel, base) => base === '.env',
    cls: { owner: 'coodra', kind: 'env', cleanup: 'preserve', safeToDelete: false },
  },
  {
    test: (_rel, base) => base === 'data.db',
    cls: { owner: 'coodra', kind: 'sqlite-db', cleanup: 'preserve', safeToDelete: false },
  },
  {
    test: (_rel, base) => base === 'logs',
    cls: { owner: 'coodra', kind: 'logs-dir', cleanup: 'preserve', safeToDelete: false },
  },
  {
    test: (_rel, base) => base === 'pids',
    cls: { owner: 'coodra', kind: 'pids-dir', cleanup: 'preserve', safeToDelete: false },
  },
  {
    test: (rel) => rel === '.mcp.json',
    cls: { owner: 'coodra', kind: 'mcp-config', cleanup: 'ask', safeToDelete: true },
  },
  {
    test: (rel) => rel.startsWith('docs/feature-packs/'),
    cls: { owner: 'coodra', kind: 'feature-pack', cleanup: 'preserve', safeToDelete: false },
  },
  {
    test: (rel) => rel === '.cursor/mcp.json',
    cls: { owner: 'agent:cursor', kind: 'mcp-config', cleanup: 'ask', safeToDelete: true },
  },
  {
    test: (rel) => rel === '.cursorrules',
    cls: { owner: 'agent:cursor', kind: 'instruction-file', cleanup: 'ask', safeToDelete: true },
  },
  {
    test: (rel) => rel === '.codex/config.toml',
    cls: { owner: 'agent:codex', kind: 'mcp-config', cleanup: 'ask', safeToDelete: true },
  },
  {
    test: (rel) => rel === 'AGENTS.md',
    cls: { owner: 'agent:codex', kind: 'instruction-file', cleanup: 'ask', safeToDelete: true },
  },
  {
    test: (rel) => rel === 'CLAUDE.md',
    cls: { owner: 'agent:claude', kind: 'instruction-file', cleanup: 'ask', safeToDelete: true },
  },
  {
    test: (rel) => rel === '.windsurfrules',
    cls: { owner: 'agent:windsurf', kind: 'instruction-file', cleanup: 'ask', safeToDelete: true },
  },
  {
    test: (_rel, base) => base === 'settings.json',
    cls: { owner: 'agent:claude', kind: 'hooks', cleanup: 'preserve', safeToDelete: false },
  },
  {
    test: (_rel, base) => base === 'mcp_config.json',
    cls: { owner: 'agent:windsurf', kind: 'mcp-config', cleanup: 'preserve', safeToDelete: false },
  },
];

const DEFAULT_CLASSIFICATION: Classification = {
  owner: 'coodra',
  kind: 'generated',
  cleanup: 'ask',
  safeToDelete: true,
};

/**
 * Turn an absolute file path (a WriteOutcome.path) into a manifest entry input.
 * Files under `root` are recorded project-relative with `scope: 'project'`;
 * files elsewhere (a global agent config like `~/.claude/settings.json`) are
 * recorded absolute with `scope: 'global'` and always `preserve` — they are
 * shared across projects, so `coodra files clean` never touches them (they're
 * managed by `coodra agent remove` / `coodra uninstall`).
 */
export function classifyGeneratedPath(absPath: string, root: string, createdBy: string): ManifestEntryInput {
  const rel = relative(root, absPath);
  const isProject = rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
  const base = absPath.split(/[\\/]/).pop() ?? absPath;
  if (!isProject) {
    // Global-scope file — classify for owner/kind but force a preserve policy.
    const match = RULES.find((r) => r.test('', base))?.cls ?? {
      ...DEFAULT_CLASSIFICATION,
      cleanup: 'preserve',
      safeToDelete: false,
    };
    return {
      path: absPath,
      scope: 'global',
      owner: match.owner,
      kind: match.kind,
      createdBy,
      cleanup: 'preserve',
      safeToDelete: false,
    };
  }
  const relPosix = rel.split(sep).join('/');
  const cls = RULES.find((r) => r.test(relPosix, base))?.cls ?? DEFAULT_CLASSIFICATION;
  return {
    path: relPosix,
    scope: 'project',
    owner: cls.owner,
    kind: cls.kind,
    createdBy,
    cleanup: cls.cleanup,
    safeToDelete: cls.safeToDelete,
  };
}
