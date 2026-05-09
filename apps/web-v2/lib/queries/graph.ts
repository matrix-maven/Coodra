import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `apps/web/lib/queries/graph.ts` — server-only filesystem reader for
 * the Graphify index (M04 Phase 2 S10).
 *
 * Mirrors the MCP server's `apps/mcp-server/src/lib/graphify.ts` reader
 * but stripped of the run-resolution + caching + DbHandle dependencies
 * — the web surface just needs to read `<root>/<slug>/graph.json` for
 * the URL-bound project.
 *
 * Per ADR-010: the producer (graphify CLI) is third-party and not yet
 * bundled with ContextOS. Operators must `npm i -g graphify` and run
 * `graphify scan` at repo root to populate the index. The page renders
 * an empty-state CTA with this command when no graph.json is present.
 */

export interface GraphNodeProjection {
  /** Stable id (best-effort: `id` field, else stringified index). */
  readonly id: string;
  /** Display name (best-effort: `name`, `label`, or `id`). */
  readonly name: string;
  /** Symbol kind (best-effort: `kind`, `type`, or '—'). */
  readonly kind: string;
  /** Source path (best-effort: `path`, `file`, `filePath`, or '—'). */
  readonly path: string;
  /** Community / cluster id when present (`community`, `cluster`). */
  readonly community: string | null;
  /** The raw node, retained so the detail panel can dump JSON. */
  readonly raw: unknown;
}

export interface GraphReadOk {
  readonly status: 'ok';
  readonly slug: string;
  readonly path: string;
  readonly mtime: Date;
  readonly nodes: ReadonlyArray<GraphNodeProjection>;
  readonly edgeCount: number;
}

export interface GraphReadMissing {
  readonly status: 'missing';
  readonly slug: string;
  readonly path: string;
  readonly howToFix: string;
}

export interface GraphReadInvalid {
  readonly status: 'invalid';
  readonly slug: string;
  readonly path: string;
  readonly reason: string;
}

export type GraphReadResult = GraphReadOk | GraphReadMissing | GraphReadInvalid;

const HOWTO_INSTALL = 'npm install -g graphify';
const HOWTO_RUN = 'graphify scan';

function defaultGraphifyRoot(): string {
  return join(homedir(), '.contextos', 'graphify');
}

function graphifyRoot(): string {
  const override = process.env.CONTEXTOS_GRAPHIFY_ROOT;
  if (typeof override === 'string' && override.length > 0) return override;
  return defaultGraphifyRoot();
}

export function loadGraph(slug: string): GraphReadResult {
  const root = graphifyRoot();
  const path = join(root, slug, 'graph.json');
  if (!existsSync(path)) {
    return {
      status: 'missing',
      slug,
      path,
      howToFix: `Run \`${HOWTO_INSTALL}\` once, then \`${HOWTO_RUN}\` at the repo root for ${slug}.`,
    };
  }
  let mtime: Date;
  try {
    mtime = new Date(statSync(path).mtimeMs);
  } catch {
    mtime = new Date(0);
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { status: 'invalid', slug, path, reason: `read failed: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: 'invalid', slug, path, reason: `JSON parse failed: ${(err as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'invalid', slug, path, reason: 'graph.json root is not an object' };
  }
  const obj = parsed as { nodes?: unknown; edges?: unknown };
  const nodesRaw = Array.isArray(obj.nodes) ? obj.nodes : [];
  const edgesRaw = Array.isArray(obj.edges) ? obj.edges : [];
  const nodes = nodesRaw.map((n, i) => projectNode(n, i));
  return {
    status: 'ok',
    slug,
    path,
    mtime,
    nodes,
    edgeCount: edgesRaw.length,
  };
}

function projectNode(node: unknown, index: number): GraphNodeProjection {
  if (typeof node !== 'object' || node === null) {
    return { id: String(index), name: String(index), kind: '—', path: '—', community: null, raw: node };
  }
  const o = node as Record<string, unknown>;
  const idField = o.id ?? o._id ?? null;
  const id = typeof idField === 'string' || typeof idField === 'number' ? String(idField) : String(index);
  const nameField = o.name ?? o.label ?? o.symbol ?? id;
  const name = typeof nameField === 'string' ? nameField : id;
  const kindField = o.kind ?? o.type ?? '—';
  const kind = typeof kindField === 'string' ? kindField : '—';
  const pathField = o.path ?? o.file ?? o.filePath ?? '—';
  const path = typeof pathField === 'string' ? pathField : '—';
  const community = o.community ?? o.cluster ?? null;
  return {
    id,
    name,
    kind,
    path,
    community: typeof community === 'string' || typeof community === 'number' ? String(community) : null,
    raw: node,
  };
}
