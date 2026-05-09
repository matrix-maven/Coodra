import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { resolveProjectFromParams } from '@/lib/project-context';
import { featuresRootForProject } from '@/lib/queries/features';

export const dynamic = 'force-dynamic';

/**
 * `/projects/[slug]/features/[fslug]/files/[...path]` — read one
 * supporting file inside a feature directory and render it inline as
 * a code block.
 *
 * Mirrors the MCP `get_feature_file` tool's allowlist + path-escape
 * defence so the web UI never surfaces a file the agent couldn't see.
 * Single source of truth for "what's a supporting file" is the
 * extension allowlist below — keep in lock-step with
 * `apps/mcp-server/src/tools/get-feature-file/handler.ts` (the
 * extension table copied verbatim).
 *
 * Why this is server-rendered and not a client fetch:
 *   - We're doing path-escape checks on the file system; the server
 *     is where that security check belongs.
 *   - Rendered output is small (capped at 256 KB by the same rule),
 *     and Next.js streams it to the browser fine.
 */

const MAX_FILE_BYTES = 256 * 1024;

const ALLOWED_EXTENSIONS = new Set<string>([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.csv',
  '.tsv',
  '.sql',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.rb',
  '.sh',
  '.bash',
  '.zsh',
  '.html',
  '.css',
  '.xml',
]);

interface RouteParams {
  readonly slug: string;
  readonly fslug: string;
  readonly path: string[];
}

export default async function FeatureFilePage({ params }: { params: Promise<RouteParams> }) {
  const project = await resolveProjectFromParams(params);
  const { fslug, path: pathSegments } = await params;
  const projectCwd = project.cwd ?? process.cwd();
  const featureSlug = decodeURIComponent(fslug);
  const relPath = pathSegments.map((s) => decodeURIComponent(s)).join('/');

  const featureDir = join(featuresRootForProject(projectCwd), featureSlug);
  if (!existsSync(featureDir) || !statSync(featureDir).isDirectory()) notFound();

  // Path-escape defence. The catch-all route already filters on
  // [...path] but a client can still craft `..` segments or absolute
  // paths in the URL — we resolve and ensure the file stays inside
  // the feature directory.
  if (isAbsolute(relPath) || relPath.split('/').includes('..')) notFound();
  const candidate = resolve(featureDir, relPath);
  const featureDirResolved = resolve(featureDir);
  const inside = relative(featureDirResolved, candidate);
  if (inside.startsWith('..') || isAbsolute(inside)) notFound();
  if (!existsSync(candidate)) notFound();
  const stat = statSync(candidate);
  if (!stat.isFile()) notFound();

  const ext = extname(candidate).toLowerCase();
  const allowed = ALLOWED_EXTENSIONS.has(ext);
  const tooLarge = stat.size > MAX_FILE_BYTES;

  const body = allowed && !tooLarge ? safeRead(candidate) : null;

  const featureUrl = `/projects/${encodeURIComponent(project.slug)}/features/${encodeURIComponent(featureSlug)}`;

  return (
    <>
      <Topbar
        crumb={`${project.slug} / features / ${featureSlug} / ${relPath}`}
        crumbPrefix="contextos / projects"
      />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/01 · PROJECT · FILE</div>
            <h1 className="head__title">
              <em>{relPath}</em>
            </h1>
            <p className="head__lede">
              Supporting file under <code style={mono}>{featureSlug}</code>. The agent reads this on demand via{' '}
              <code style={mono}>contextos__get_feature_file</code>.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{formatBytes(stat.size)}</strong>
              <br />
              {ext || '(no extension)'}
              <br />
              {candidate}
            </div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href={featureUrl}>
                ← back to {featureSlug}
              </Link>
            </div>
          </div>
        </div>

        {!allowed ? (
          <div
            className="card"
            style={{
              padding: 28,
              border: '1px solid var(--warn)',
              background: 'var(--warn-glow)',
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--warn)',
            }}
          >
            <p style={{ marginTop: 0 }}>
              Files with extension <code style={mono}>{ext}</code> are not rendered inline. The MCP tool
              <code style={mono}> get_feature_file</code> would also refuse this with{' '}
              <code style={mono}>extension_blocked</code>.
            </p>
            <p>
              Allowed extensions: {Array.from(ALLOWED_EXTENSIONS).sort().join(', ')}
            </p>
          </div>
        ) : tooLarge ? (
          <div
            className="card"
            style={{
              padding: 28,
              border: '1px solid var(--warn)',
              background: 'var(--warn-glow)',
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--warn)',
            }}
          >
            File is {formatBytes(stat.size)}; cap is {formatBytes(MAX_FILE_BYTES)}. Trim the file or split it across
            multiple supporting files.
          </div>
        ) : (
          <pre
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--rule)',
              padding: '20px 24px',
              fontFamily: 'var(--mono)',
              fontSize: 12,
              lineHeight: 1.6,
              color: 'var(--ink)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowX: 'auto',
              minHeight: 220,
            }}
          >
            {body ?? '(could not read file)'}
          </pre>
        )}
      </section>
    </>
  );
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const mono: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.92em',
  color: 'var(--accent)',
};
