import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * `lib/wiki/grounding.ts` — Module 10 Deep Wiki grounding bundle.
 *
 * `coodra wiki generate` assembles a compact, bounded snapshot of the
 * project — directory rollup, a capped file list, the README, package
 * manifests, and (if present) a Graphify graph summary — and writes it
 * to `.coodra/wiki-grounding.md`. The agent reads this in the structure
 * pass to plan a grounded WikiStructure (rather than hallucinating an
 * architecture). It is orientation, not the full source: the agent reads
 * the actual files itself when authoring each page.
 */

/** Directories never worth walking for a wiki grounding bundle. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'target',
  'vendor',
  '.pnpm',
  '.yarn',
  'graphify-out',
  '.coodra',
  '.idea',
  '.vscode',
  '.DS_Store',
]);

const MAX_FILES = 600;
const MAX_DEPTH = 7;
const README_MAX_CHARS = 6_000;

export interface GraphifySummary {
  readonly nodeCount: number | null;
  readonly edgeCount: number | null;
  readonly communityCount: number | null;
  /** True when graph.json existed but its shape wasn't recognised. */
  readonly unrecognised: boolean;
}

export interface ManifestSummary {
  readonly path: string;
  readonly name: string | null;
}

export interface GroundingResult {
  readonly projectSlug: string;
  readonly cwd: string;
  /** Total non-ignored files discovered (may exceed the listed sample). */
  readonly fileCount: number;
  /** Whether the walk hit the MAX_FILES cap (sample is partial). */
  readonly truncated: boolean;
  /** Per-top-level-directory file counts, descending. */
  readonly dirRollup: ReadonlyArray<{ readonly dir: string; readonly files: number }>;
  /** Sorted, repo-root-relative file paths (capped at MAX_FILES). */
  readonly files: ReadonlyArray<string>;
  /** README.md (or readme.md / README) content, capped. null when absent. */
  readonly readme: string | null;
  /** package.json / pyproject.toml / Cargo.toml / go.mod names found. */
  readonly manifests: ReadonlyArray<ManifestSummary>;
  /** Graphify graph summary when `graphify-out/graph.json` exists. */
  readonly graphify: GraphifySummary | null;
}

function walk(root: string): { files: string[]; truncated: boolean } {
  const out: string[] = [];
  let truncated = false;

  function recurse(dir: string, depth: number): void {
    if (truncated || depth > MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Directories first (stable, predictable ordering), then files.
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name));
    const files = entries.filter((e) => e.isFile() && !IGNORED_DIRS.has(e.name));
    for (const f of files) {
      if (out.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      out.push(relative(root, join(dir, f.name)).split(sep).join('/'));
    }
    for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
      recurse(join(dir, d.name), depth + 1);
      if (truncated) return;
    }
  }

  recurse(root, 0);
  out.sort((a, b) => a.localeCompare(b));
  return { files: out, truncated };
}

function readReadme(cwd: string): string | null {
  for (const candidate of ['README.md', 'readme.md', 'README', 'README.rst', 'docs/README.md']) {
    const p = join(cwd, candidate);
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf8');
        return raw.length > README_MAX_CHARS ? `${raw.slice(0, README_MAX_CHARS)}\n\n…(README truncated)` : raw;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function readManifests(cwd: string, files: ReadonlyArray<string>): ManifestSummary[] {
  const out: ManifestSummary[] = [];
  const wanted = files.filter(
    (f) =>
      f === 'package.json' ||
      f.endsWith('/package.json') ||
      f === 'pyproject.toml' ||
      f === 'Cargo.toml' ||
      f === 'go.mod',
  );
  for (const rel of wanted.slice(0, 40)) {
    const p = join(cwd, rel);
    let name: string | null = null;
    try {
      const raw = readFileSync(p, 'utf8');
      if (rel.endsWith('package.json')) {
        const json = JSON.parse(raw) as { name?: unknown };
        name = typeof json.name === 'string' ? json.name : null;
      } else if (rel.endsWith('pyproject.toml') || rel.endsWith('Cargo.toml')) {
        const m = raw.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
        name = m?.[1] ?? null;
      } else if (rel.endsWith('go.mod')) {
        const m = raw.match(/^module\s+(\S+)/m);
        name = m?.[1] ?? null;
      }
    } catch {
      name = null;
    }
    out.push({ path: rel, name });
  }
  return out;
}

function readGraphify(cwd: string): GraphifySummary | null {
  const p = join(cwd, 'graphify-out', 'graph.json');
  if (!existsSync(p)) return null;
  try {
    const json = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    const nodes = Array.isArray(json.nodes) ? json.nodes : null;
    const edges = Array.isArray(json.edges) ? json.edges : null;
    // Community count: prefer an explicit `communities` array, else count
    // distinct `community` ids across nodes.
    let communityCount: number | null = null;
    if (Array.isArray(json.communities)) {
      communityCount = json.communities.length;
    } else if (nodes) {
      const ids = new Set<unknown>();
      for (const n of nodes) {
        if (n && typeof n === 'object' && 'community' in n) ids.add((n as Record<string, unknown>).community);
      }
      communityCount = ids.size > 0 ? ids.size : null;
    }
    const unrecognised = nodes === null && edges === null && communityCount === null;
    return {
      nodeCount: nodes ? nodes.length : null,
      edgeCount: edges ? edges.length : null,
      communityCount,
      unrecognised,
    };
  } catch {
    return { nodeCount: null, edgeCount: null, communityCount: null, unrecognised: true };
  }
}

/** Assemble the grounding snapshot for a project root. Pure I/O read; never throws. */
export function assembleGrounding(args: { readonly cwd: string; readonly projectSlug: string }): GroundingResult {
  const { cwd, projectSlug } = args;
  const { files, truncated } = walk(cwd);

  const counts = new Map<string, number>();
  for (const f of files) {
    const top = f.includes('/') ? (f.split('/')[0] as string) : '(root)';
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const dirRollup = [...counts.entries()]
    .map(([dir, count]) => ({ dir, files: count }))
    .sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir));

  return {
    projectSlug,
    cwd,
    fileCount: files.length,
    truncated,
    dirRollup,
    files,
    readme: readReadme(cwd),
    manifests: readManifests(cwd, files),
    graphify: readGraphify(cwd),
  };
}

/** Render the grounding result as the `.coodra/wiki-grounding.md` document. */
export function renderGroundingMarkdown(g: GroundingResult): string {
  const lines: string[] = [];
  lines.push(`# Deep Wiki grounding — ${g.projectSlug}`);
  lines.push('');
  lines.push(
    'A bounded snapshot of the codebase to orient the **structure pass**. Plan the wiki from this; read the actual files when authoring each page.',
  );
  lines.push('');

  lines.push('## Stack / packages');
  if (g.manifests.length === 0) {
    lines.push('- (no package.json / pyproject.toml / Cargo.toml / go.mod found)');
  } else {
    for (const m of g.manifests) {
      lines.push(`- \`${m.path}\`${m.name ? ` → **${m.name}**` : ''}`);
    }
  }
  lines.push('');

  if (g.graphify) {
    lines.push('## Graphify graph (structural map)');
    if (g.graphify.unrecognised) {
      lines.push(
        '- `graphify-out/graph.json` present (shape not recognised). Query it live via the `graphify` MCP tools.',
      );
    } else {
      lines.push(
        `- nodes: ${g.graphify.nodeCount ?? '?'}, edges: ${g.graphify.edgeCount ?? '?'}, communities: ${g.graphify.communityCount ?? '?'}.`,
      );
      lines.push(
        '- Query it live via Graphify’s MCP tools (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`) — communities are candidate wiki sections; high-degree nodes are candidate high-importance pages.',
      );
    }
    lines.push('');
  }

  lines.push('## Directory rollup');
  for (const r of g.dirRollup.slice(0, 30)) {
    lines.push(`- \`${r.dir}/\` — ${r.files} file${r.files === 1 ? '' : 's'}`);
  }
  lines.push('');

  lines.push(`## Files (${g.fileCount}${g.truncated ? '+, sample capped' : ''})`);
  lines.push('```');
  for (const f of g.files) lines.push(f);
  lines.push('```');
  lines.push('');

  lines.push('## README');
  if (g.readme === null) {
    lines.push('_(no README found)_');
  } else {
    lines.push(g.readme.trimEnd());
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}
