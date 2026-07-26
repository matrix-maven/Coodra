import 'server-only';

import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import {
  absOf,
  type GraphifyArtifactScan,
  type GraphSummary,
  readGraphSummary,
  resolveGraphifyPaths,
  scanGraphifyArtifacts,
} from '@coodra/cli/lib/graphify';

import { isCloudHostedWeb } from '@/lib/deployment-mode';
import { listProjects } from '@/lib/queries/projects';

/**
 * `apps/web-v2/lib/queries/graphify.ts` — read-side for `/graphify`
 * (Module 09 track 9B, artifact half — the web counterpart of
 * `coodra graphify build|open|status`).
 *
 * Coodra generates none of this. Graphify's own CLI writes `graph.json`,
 * `graph.html` and `GRAPH_REPORT.md`; `coodra graphify build` only pins
 * `GRAPHIFY_OUT` so the output lands somewhere Coodra can find again
 * (ADR-010/015 — consume Graphify by configuration, not by code). This module
 * reads those files back and nothing else.
 *
 * ## Path resolution is the security boundary
 *
 * The project root is ALWAYS taken from the registered `projects.cwd` column,
 * resolved through the org-scoped `listProjects()` — never from a query
 * parameter, a header, or a form field. A caller can name a project slug; it
 * can never name a path. On top of that every file this module opens is
 * containment-checked against the project root **after** `realpath()`, because
 * the output directory is recorded in `.coodra/graphify.json`, which is a file
 * inside the repository — i.e. attacker-controlled if you clone a hostile repo.
 * Without the check, a crafted record (or a symlink planted at
 * `.coodra/graphify/out/graph.html`) would turn this route into an arbitrary
 * local-file reader.
 *
 * ## Local-only
 *
 * A team-hosted deployment has no developer checkout on disk, so every entry
 * point short-circuits on `isCloudHostedWeb()` and the page renders the CLI
 * instructions instead of a broken embed.
 */

/** Refuse to inline an absurd `graph.html` rather than OOM the render. */
const MAX_GRAPH_HTML_BYTES = 32 * 1024 * 1024;
/** `GRAPH_REPORT.md` is prose; anything past this is truncated for display. */
const MAX_REPORT_BYTES = 512 * 1024;

export interface GraphifyProjectSummary {
  readonly slug: string;
  readonly name: string;
  /** Absolute project root, or null on a pre-0010 row that never recorded one. */
  readonly cwd: string | null;
  /** Project-relative (or absolute) output dir Graphify writes into. */
  readonly outputDir: string;
  /** True when the output lives under `.coodra/` with `GRAPHIFY_OUT` pinned by Coodra. */
  readonly managedByCoodra: boolean;
  readonly hasGraph: boolean;
  readonly hasHtml: boolean;
  readonly hasReport: boolean;
  readonly nodes: number | null;
  readonly links: number | null;
  readonly communities: number | null;
  /** ISO timestamp of the newest artifact, or null when nothing is built. */
  readonly builtAt: string | null;
}

export interface GraphifyIndex {
  /** True on a deployed server — no local checkout to read. */
  readonly cloudHosted: boolean;
  readonly projects: ReadonlyArray<GraphifyProjectSummary>;
}

function newestMtime(scan: GraphifyArtifactScan): string | null {
  const stamps = [scan.graphJson.modifiedAt, scan.graphHtml.modifiedAt, scan.report.modifiedAt].filter(
    (s): s is string => typeof s === 'string',
  );
  if (stamps.length === 0) return null;
  return stamps.sort().at(-1) ?? null;
}

/**
 * Is `candidate` inside `root` once both are fully resolved? Returns false when
 * either path can't be realpath'd (missing file, dangling symlink) — the caller
 * treats that as "not available", which is the correct conservative answer.
 */
async function isContained(root: string, candidate: string): Promise<boolean> {
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = await realpath(root);
    realCandidate = await realpath(candidate);
  } catch {
    return false;
  }
  const rel = relative(realRoot, realCandidate);
  // Empty  → candidate IS the root (a directory, never a file we serve).
  // `..`   → escapes upward.
  // absolute → different Windows drive; `relative` gives an absolute path.
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Artifact status for every project in the actor's org that recorded a cwd.
 * Read-only; never spawns Graphify.
 */
export async function listGraphifyProjects(): Promise<GraphifyIndex> {
  if (isCloudHostedWeb()) return { cloudHosted: true, projects: [] };

  const projects = await listProjects();
  const out: GraphifyProjectSummary[] = [];

  for (const project of projects) {
    if (project.cwd === null) {
      out.push({
        slug: project.slug,
        name: project.name,
        cwd: null,
        outputDir: '—',
        managedByCoodra: false,
        hasGraph: false,
        hasHtml: false,
        hasReport: false,
        nodes: null,
        links: null,
        communities: null,
        builtAt: null,
      });
      continue;
    }
    const paths = await resolveGraphifyPaths(project.cwd);
    const scan = await scanGraphifyArtifacts(project.cwd, paths);
    out.push({
      slug: project.slug,
      name: project.name,
      cwd: project.cwd,
      outputDir: paths.outputDir,
      managedByCoodra: paths.managedByCoodra,
      hasGraph: scan.graphJson.exists,
      hasHtml: scan.graphHtml.exists,
      hasReport: scan.report.exists,
      nodes: scan.counts?.nodes ?? null,
      links: scan.counts?.links ?? null,
      communities: scan.counts?.communities ?? null,
      builtAt: newestMtime(scan),
    });
  }

  // Projects with a built graph first, then by name — the page is about
  // graphs, so a project with artifacts outranks one without.
  return {
    cloudHosted: false,
    projects: out.sort((a, b) => Number(b.hasGraph) - Number(a.hasGraph) || a.name.localeCompare(b.name)),
  };
}

export interface GraphifyProjectDetail {
  readonly slug: string;
  readonly name: string;
  readonly cwd: string;
  readonly outputDir: string;
  readonly managedByCoodra: boolean;
  readonly scan: GraphifyArtifactScan;
  readonly summary: GraphSummary | null;
  /** `GRAPH_REPORT.md` body, or null when absent / unreadable / outside the root. */
  readonly report: string | null;
  readonly reportTruncated: boolean;
  /** True when `graph.html` exists AND passes containment — i.e. safe to embed. */
  readonly embeddable: boolean;
  readonly builtAt: string | null;
}

export type GraphifyDetailResult =
  | { readonly ok: true; readonly detail: GraphifyProjectDetail }
  | { readonly ok: false; readonly reason: 'cloud_hosted' | 'not_found' | 'no_cwd' };

/**
 * Full artifact detail for one project. `slug` is matched against the
 * org-scoped project list — an unknown or out-of-org slug is indistinguishable
 * from a missing project.
 */
export async function getGraphifyProjectDetail(slug: string): Promise<GraphifyDetailResult> {
  if (isCloudHostedWeb()) return { ok: false, reason: 'cloud_hosted' };

  const project = (await listProjects()).find((p) => p.slug === slug);
  if (project === undefined) return { ok: false, reason: 'not_found' };
  if (project.cwd === null) return { ok: false, reason: 'no_cwd' };

  const root = project.cwd;
  const paths = await resolveGraphifyPaths(root);
  const scan = await scanGraphifyArtifacts(root, paths);

  const graphJsonContained = scan.graphJson.exists && (await isContained(root, absOf(root, paths.graphJson)));
  const summary = graphJsonContained ? await readGraphSummary(root, paths, { maxCommunities: 12, maxHubs: 10 }) : null;

  let report: string | null = null;
  let reportTruncated = false;
  if (scan.report.exists && (await isContained(root, absOf(root, paths.report)))) {
    try {
      const raw = await readFile(absOf(root, paths.report), 'utf8');
      reportTruncated = raw.length > MAX_REPORT_BYTES;
      report = reportTruncated ? raw.slice(0, MAX_REPORT_BYTES) : raw;
    } catch {
      report = null;
    }
  }

  const embeddable = scan.graphHtml.exists && (await isContained(root, absOf(root, paths.graphHtml)));

  return {
    ok: true,
    detail: {
      slug: project.slug,
      name: project.name,
      cwd: root,
      outputDir: paths.outputDir,
      managedByCoodra: paths.managedByCoodra,
      scan,
      summary,
      report,
      reportTruncated,
      embeddable,
      builtAt: newestMtime(scan),
    },
  };
}

export type GraphHtmlResult =
  | { readonly ok: true; readonly html: string }
  | {
      readonly ok: false;
      readonly reason: 'cloud_hosted' | 'not_found' | 'no_cwd' | 'no_artifact' | 'outside_root' | 'too_large';
    };

/**
 * Read the project's `graph.html` for the sandboxed embed route.
 *
 * Every guard that matters lives here rather than in the route handler, so the
 * route stays a thin header-setter and the rules are unit-testable:
 *   1. local-only;
 *   2. slug → project row through the org-scoped list (never a caller path);
 *   3. the file must resolve inside the project root after `realpath`;
 *   4. bounded size.
 */
export async function readGraphHtml(slug: string): Promise<GraphHtmlResult> {
  if (isCloudHostedWeb()) return { ok: false, reason: 'cloud_hosted' };

  const project = (await listProjects()).find((p) => p.slug === slug);
  if (project === undefined) return { ok: false, reason: 'not_found' };
  if (project.cwd === null) return { ok: false, reason: 'no_cwd' };

  const root = project.cwd;
  const paths = await resolveGraphifyPaths(root);
  const abs = absOf(root, paths.graphHtml);

  let size: number;
  try {
    size = (await stat(abs)).size;
  } catch {
    return { ok: false, reason: 'no_artifact' };
  }
  if (!(await isContained(root, abs))) return { ok: false, reason: 'outside_root' };
  if (size > MAX_GRAPH_HTML_BYTES) return { ok: false, reason: 'too_large' };

  try {
    return { ok: true, html: await readFile(abs, 'utf8') };
  } catch {
    return { ok: false, reason: 'no_artifact' };
  }
}
