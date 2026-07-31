import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  absOf,
  type GraphCommunitySummary,
  type GraphHubNode,
  type GraphifyPaths,
  resolveGraphifyPaths,
  summarizeGraph,
} from '../graphify/artifacts.js';
import type { KnowledgeGrounding } from './knowledge.js';

/**
 * `lib/wiki/grounding.ts` — Module 10 Deep Wiki grounding bundle.
 *
 * `coodra wiki build` assembles a compact, bounded snapshot of the
 * project — directory rollup, a capped file list, the README, package
 * manifests, and (if present) a Graphify graph summary — and writes it
 * to `.coodra/wiki/grounding.md`. The agent reads this in the structure
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

// 1500 paths ≈ ~100 KB of file list — well within what a structure-pass
// agent reads comfortably, and 2.5× the old 600 cap that starved coverage
// on many-small-file repos (field report 2026-07-12).
const MAX_FILES = 1500;
const MAX_DEPTH = 7;
const README_MAX_CHARS = 6_000;

/** How much of `GRAPH_REPORT.md` to inline. It is prose; a few KB orients. */
const GRAPH_REPORT_MAX_CHARS = 8_000;

export interface GraphifySummary {
  readonly nodeCount: number | null;
  readonly edgeCount: number | null;
  readonly communityCount: number | null;
  /** True when graph.json existed but its shape wasn't recognised. */
  readonly unrecognised: boolean;
  /** Where the graph was found, project-relative — `.coodra/graphify/out` or `graphify-out`. */
  readonly outputDir: string;
  /**
   * Largest Leiden communities with member samples — the raw material for
   * "communities → candidate wiki sections" (ADR-017). Empty when the graph
   * carries no community assignments.
   */
  readonly communities: ReadonlyArray<GraphCommunitySummary>;
  /** Highest-degree nodes — candidate high-importance pages. */
  readonly hubs: ReadonlyArray<GraphHubNode>;
  /** Bounded `GRAPH_REPORT.md` excerpt (god nodes, cycles, surprising edges). */
  readonly report: string | null;
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
  /** Graphify graph summary when the project's resolved `graph.json` exists. */
  readonly graphify: GraphifySummary | null;
  /**
   * Prior recorded work — decisions and context packs from Coodra's own store.
   * Null when the DB wasn't reachable or the project isn't registered; the
   * grounding degrades to code-only rather than failing the whole command.
   */
  readonly knowledge: KnowledgeGrounding | null;
}

function walk(root: string): { files: string[]; truncated: boolean } {
  const out: string[] = [];
  let truncated = false;

  // Breadth-first: every directory at depth N is sampled before ANY file
  // at depth N+1, so when the MAX_FILES cap hits, the sample still
  // represents the whole tree — each top-level area appears. The pre-fix
  // depth-first walk exhausted the budget inside the first alphabetical
  // subtree and silently dropped entire later subtrees, starving the
  // wiki structure pass of coverage (field report 2026-07-12).
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const next = queue.shift() as { dir: string; depth: number };
    if (next.depth > MAX_DEPTH) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name));
    const files = entries.filter((e) => e.isFile() && !IGNORED_DIRS.has(e.name));
    for (const f of files) {
      if (out.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      out.push(relative(root, join(next.dir, f.name)).split(sep).join('/'));
    }
    if (truncated) break;
    for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
      queue.push({ dir: join(next.dir, d.name), depth: next.depth + 1 });
    }
  }

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

/**
 * Read the project's Graphify graph, if any.
 *
 * Two bugs lived here before Phase 4 and both silently degraded the grounding
 * rather than failing loudly:
 *
 *   1. the path was hardcoded to `graphify-out/graph.json`, so any project
 *      using the Coodra-managed layout (`.coodra/graphify/out/`, which is what
 *      `coodra graphify build` sets up) looked to the wiki like it had no graph
 *      at all. Resolution now goes through the SAME `resolveGraphifyPaths` the
 *      CLI and the web `/graphify` page use, so all three agree.
 *   2. the edge count read `json.edges`. NetworkX node-link names that array
 *      `links`, so the count was always null on a real Graphify graph. The
 *      shared `summarizeGraph` accepts either key.
 *
 * The summary is now more than three numbers: the largest communities (with
 * member labels and files) and the highest-degree nodes go into the grounding
 * document itself. Previously the grounding said "query Graphify's MCP for the
 * structure" — true, but an instruction the structure pass frequently skipped,
 * leaving the plan ungrounded. Handing over the material directly is what makes
 * "communities → sections, hubs → important pages" actually happen.
 */
function readGraphify(cwd: string, paths: GraphifyPaths): GraphifySummary | null {
  const graphJsonAbs = absOf(cwd, paths.graphJson);
  if (!existsSync(graphJsonAbs)) return null;

  const report = readGraphReport(cwd, paths);
  const base = { outputDir: paths.outputDir, report };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(graphJsonAbs, 'utf8'));
  } catch {
    return {
      ...base,
      nodeCount: null,
      edgeCount: null,
      communityCount: null,
      unrecognised: true,
      communities: [],
      hubs: [],
    };
  }

  const summary = summarizeGraph(parsed, { maxCommunities: 15, maxHubs: 15 });
  if (summary === null) {
    return {
      ...base,
      nodeCount: null,
      edgeCount: null,
      communityCount: null,
      unrecognised: true,
      communities: [],
      hubs: [],
    };
  }
  return {
    ...base,
    nodeCount: summary.counts.nodes,
    edgeCount: summary.counts.links,
    communityCount: summary.counts.communities,
    unrecognised: false,
    communities: summary.communities,
    hubs: summary.hubs,
  };
}

function readGraphReport(cwd: string, paths: GraphifyPaths): string | null {
  const p = absOf(cwd, paths.report);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    return raw.length > GRAPH_REPORT_MAX_CHARS
      ? `${raw.slice(0, GRAPH_REPORT_MAX_CHARS)}\n\n…(GRAPH_REPORT.md truncated — read the full file at ${paths.report})`
      : raw;
  } catch {
    return null;
  }
}

/**
 * Assemble the grounding snapshot for a project root. Read-only; never throws.
 *
 * `knowledge` is passed IN rather than fetched here: this module is pure
 * filesystem, and the caller owns the DB handle lifecycle (see
 * `lib/wiki/knowledge.ts`). Pass null when the store is unavailable — the
 * grounding is still useful, just code-only.
 */
export async function assembleGrounding(args: {
  readonly cwd: string;
  readonly projectSlug: string;
  readonly knowledge?: KnowledgeGrounding | null;
}): Promise<GroundingResult> {
  const { cwd, projectSlug } = args;
  const { files, truncated } = walk(cwd);
  const graphifyPaths = await resolveGraphifyPaths(cwd);

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
    graphify: readGraphify(cwd, graphifyPaths),
    knowledge: args.knowledge ?? null,
  };
}

/** Render the grounding result as the `.coodra/wiki/grounding.md` document. */
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
    const gf = g.graphify;
    lines.push('## Graphify graph (structural map)');
    if (gf.unrecognised) {
      lines.push(
        `- \`${gf.outputDir}/graph.json\` present (shape not recognised). Query it live via the \`graphify\` MCP tools.`,
      );
    } else {
      lines.push(
        `- **${gf.nodeCount ?? '?'} nodes · ${gf.edgeCount ?? '?'} edges · ${gf.communityCount ?? '?'} communities** (\`${gf.outputDir}/graph.json\`).`,
      );
      lines.push('');

      if (gf.communities.length > 0) {
        lines.push(
          `### Largest communities → candidate sections (${gf.communities.length} of ${gf.communityCount ?? '?'} shown)`,
        );
        lines.push('');
        lines.push(
          'Each Leiden community is a cluster of code that references itself densely. Treat these as **candidate wiki sections / pages** — but map them onto real modules, do NOT mint one page per community (ADR-015: 1-community-1-artefact produced noise, most communities are a single config file).',
        );
        lines.push('');
        for (const c of gf.communities) {
          const files = c.files.length > 0 ? ` — files: ${c.files.map((f) => `\`${f}\``).join(', ')}` : '';
          lines.push(`- **Community ${c.id}** (${c.size} nodes): ${c.sampleLabels.join(' · ')}${files}`);
        }
        lines.push('');
      }

      if (gf.hubs.length > 0) {
        lines.push('### God nodes → candidate high-importance pages');
        lines.push('');
        lines.push(
          'The most-connected nodes are the core abstractions; whatever explains them deserves an `importance: "high"` page, and changing them has the widest blast radius.',
        );
        lines.push('');
        for (const h of gf.hubs) {
          lines.push(`- \`${h.label}\` — ${h.degree} edges${h.sourceFile !== null ? ` (\`${h.sourceFile}\`)` : ''}`);
        }
        lines.push('');
      }

      lines.push(
        'Query the graph live via Graphify’s MCP tools (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`) when you need neighbours or a dependency path that isn’t summarised here.',
      );
      lines.push('');
    }

    if (gf.report !== null) {
      lines.push('### GRAPH_REPORT.md (Graphify’s own analysis)');
      lines.push('');
      lines.push(gf.report.trimEnd());
      lines.push('');
    }
  }

  if (g.knowledge !== null && (g.knowledge.decisions.length > 0 || g.knowledge.contextPacks.length > 0)) {
    lines.push('## Prior recorded work (Coodra’s own store)');
    lines.push('');
    lines.push(
      'Decisions and Context Packs this project already recorded. **Use them.** The wiki should explain the architecture that was actually decided — with the recorded rationale — instead of re-deriving an explanation from the code alone and contradicting it. When a decision is load-bearing, say so on the relevant page and cite the reason given here.',
    );
    lines.push('');

    if (g.knowledge.decisions.length > 0) {
      lines.push(`### Decisions (${g.knowledge.decisions.length} most recent of ${g.knowledge.decisionCount})`);
      lines.push('');
      for (const d of g.knowledge.decisions) {
        lines.push(`- **${d.description}**`);
        if (d.rationale !== null && d.rationale.length > 0) lines.push(`  - why: ${d.rationale}`);
        if (d.alternatives.length > 0) lines.push(`  - alternatives considered: ${d.alternatives.join('; ')}`);
      }
      lines.push('');
    }

    if (g.knowledge.contextPacks.length > 0) {
      lines.push(`### Context packs (${g.knowledge.contextPacks.length} most recent of ${g.knowledge.packCount})`);
      lines.push('');
      lines.push(
        'Session recaps of completed work. Read the full body of any that matter with `coodra__read_context_pack({ packId })`, or search with `coodra__search_packs_nl`.',
      );
      lines.push('');
      for (const p of g.knowledge.contextPacks) {
        lines.push(`- \`${p.id}\` — **${p.title}**`);
        if (p.excerpt.length > 0) lines.push(`  - ${p.excerpt}`);
      }
      lines.push('');
    }
  }

  lines.push('## Directory rollup');
  for (const r of g.dirRollup.slice(0, 30)) {
    lines.push(`- \`${r.dir}/\` — ${r.files} file${r.files === 1 ? '' : 's'}`);
  }
  if (g.dirRollup.length > 30) {
    lines.push(`- …and ${g.dirRollup.length - 30} more top-level entries`);
  }
  lines.push('');

  lines.push(`## Files (${g.fileCount}${g.truncated ? '+, sample capped' : ''})`);
  if (g.truncated) {
    lines.push('');
    lines.push('> ⚠ **This file list is a capped SAMPLE — the repo holds more files than shown.**');
    lines.push('> Do NOT plan the wiki structure from this list alone: enumerate the');
    lines.push('> under-represented directories yourself (list files per top-level dir, or');
    lines.push('> query Graphify) and make sure every major area of the REPO gets coverage,');
    lines.push('> not just the sampled files.');
    lines.push('');
  }
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
