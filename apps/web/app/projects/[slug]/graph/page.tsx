import {
  AlertTriangleIcon,
  Banner,
  Button,
  Card,
  EmptyState,
  Input,
  LinkButton,
  PageHeader,
  PageShell,
  SearchIcon,
  Section,
  Select,
  StatusDot,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { resolveProjectFromParams } from '@/lib/project-context';
import { type GraphNodeProjection, loadGraph } from '@/lib/queries/graph';

/**
 * `/projects/[slug]/graph` — Codebase-graph reader (M04 Phase 2 S10,
 * restyled in Phase 2 UI).
 *
 * Three render paths: missing (empty-state CTA per ADR-010), invalid
 * (parse error display), ok (search-table). Filtering is server-side
 * via `?q=` and `?community=` querystring; no client JS.
 */
export const dynamic = 'force-dynamic';

const PAGE_LIMIT = 200;

interface SearchParams {
  readonly q?: string;
  readonly community?: string;
}

export default async function GraphPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const sp = await searchParams;
  const q = (sp.q ?? '').trim().toLowerCase();
  const community = (sp.community ?? '').trim();
  const result = loadGraph(project.slug);
  const baseHref = `/projects/${encodeURIComponent(project.slug)}`;

  return (
    <PageShell>
      <PageHeader
        eyebrow="/02 · AUDIT · GRAPH"
        title={
          <>
            Files the <em>agent</em> read.
          </>
        }
        subtitle={
          <>
            A graph of files touched, the order they were touched, and the runs that touched them. Read-only view of{' '}
            <span className="font-mono text-accent">graph.json</span> for{' '}
            <span className="font-mono text-accent">{project.slug}</span> (ADR-010).
          </>
        }
        meta={
          result.status === 'ok' ? (
            <>
              <strong className="font-medium text-text-primary">{result.nodes.length} nodes</strong>
              <br />
              {result.edgeCount} edges
              <br />
              indexed · {result.mtime.toISOString().slice(0, 10)}
            </>
          ) : (
            <>
              <strong className="font-medium text-text-primary">no index</strong>
              <br />
              graphify CLI required
            </>
          )
        }
        actions={
          result.status === 'ok' ? (
            <>
              <LinkButton href={`${baseHref}/graph`} variant="ghost">
                Reset view
              </LinkButton>
              <LinkButton href={`${baseHref}/graph`} variant="primary">
                Export
              </LinkButton>
            </>
          ) : undefined
        }
      />

      {result.status === 'missing' ? (
        <MissingState slug={project.slug} path={result.path} howToFix={result.howToFix} />
      ) : result.status === 'invalid' ? (
        <InvalidState path={result.path} reason={result.reason} />
      ) : (
        <Populated baseHref={baseHref} q={q} community={community} result={result} />
      )}
    </PageShell>
  );
}

function Populated({
  baseHref,
  q,
  community,
  result,
}: {
  readonly baseHref: string;
  readonly q: string;
  readonly community: string;
  readonly result: {
    readonly path: string;
    readonly mtime: Date;
    readonly nodes: ReadonlyArray<GraphNodeProjection>;
    readonly edgeCount: number;
  };
}) {
  const filtered = result.nodes
    .filter((n) => (q.length === 0 ? true : `${n.name} ${n.path}`.toLowerCase().includes(q)))
    .filter((n) => (community.length === 0 ? true : n.community === community));
  const truncated = filtered.length > PAGE_LIMIT;
  const visible = truncated ? filtered.slice(0, PAGE_LIMIT) : filtered;
  const communities = uniqueCommunities(result.nodes);

  return (
    <>
      <Section title="Search">
        <form className="flex flex-wrap items-end gap-3" action={`${baseHref}/graph`}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="graph-q" className="text-xs font-medium text-text-secondary">
              Symbol or path
            </label>
            <Input id="graph-q" name="q" defaultValue={q} mono placeholder="substring" className="w-72" />
          </div>
          {communities.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="graph-community" className="text-xs font-medium text-text-secondary">
                Community
              </label>
              <Select id="graph-community" name="community" defaultValue={community} mono className="w-48">
                <option value="">— any —</option>
                {communities.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <Button type="submit" variant="secondary" leftIcon={<SearchIcon className="h-3 w-3" />}>
            Filter
          </Button>
          {q !== '' || community !== '' ? (
            <LinkButton href={`${baseHref}/graph`} variant="ghost">
              Clear
            </LinkButton>
          ) : null}
        </form>
      </Section>

      <p className="text-xs text-text-tertiary">
        {result.nodes.length} nodes · {result.edgeCount} edges · {filtered.length} match
        {filtered.length === 1 ? '' : 'es'}
        {truncated ? ` (showing first ${PAGE_LIMIT})` : ''} · indexed{' '}
        <span className="font-mono">{result.mtime.toISOString()}</span>
      </p>

      {visible.length === 0 ? (
        <EmptyState title="No nodes match the filter" body="Loosen the search term or clear the filter." />
      ) : (
        <Section title="Nodes" count={visible.length}>
          <Table>
            <THead>
              <TR hoverable={false}>
                <TH>Name</TH>
                <TH>Kind</TH>
                <TH>Path</TH>
                <TH>Community</TH>
                <TH align="right">Raw</TH>
              </TR>
            </THead>
            <TBody>
              {visible.map((n) => (
                <TR key={n.id}>
                  <TD mono>{n.name}</TD>
                  <TD mono muted>
                    {n.kind}
                  </TD>
                  <TD mono muted>
                    {n.path}
                  </TD>
                  <TD mono muted>
                    {n.community ?? '—'}
                  </TD>
                  <TD align="right">
                    <details>
                      <summary className="cursor-pointer text-xs font-medium text-brand hover:text-brand-hover">
                        View
                      </summary>
                      <pre className="mt-2 max-w-md overflow-x-auto whitespace-pre border border-border-subtle bg-bg-base p-2 text-left font-mono text-[11px] text-text-primary">
                        {JSON.stringify(n.raw, null, 2)}
                      </pre>
                    </details>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Section>
      )}

      <p className="text-xs text-text-tertiary">
        File: <span className="font-mono break-all">{result.path}</span>
      </p>
    </>
  );
}

function uniqueCommunities(nodes: ReadonlyArray<GraphNodeProjection>): string[] {
  const set = new Set<string>();
  for (const n of nodes) {
    if (n.community !== null) set.add(n.community);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function MissingState({
  slug,
  path,
  howToFix,
}: {
  readonly slug: string;
  readonly path: string;
  readonly howToFix: string;
}) {
  return (
    <Card size="lg">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <StatusDot tone="neutral" />
          <h2 className="font-display text-xl font-bold uppercase tracking-wide text-text-primary">
            No graphify index yet
          </h2>
        </div>
        <p className="text-sm text-text-secondary">
          Coodra reads <span className="font-mono">graph.json</span> from{' '}
          <span className="break-all font-mono">{path}</span>. The graphify CLI is third-party (ADR-010) — install it
          once, then scan from the repo root for <span className="font-mono">{slug}</span>.
        </p>
        <pre className="overflow-x-auto whitespace-pre border border-border-default bg-bg-base p-3 font-mono text-xs text-text-primary">
          {howToFix}
        </pre>
        <p className="text-xs text-text-tertiary">
          Once <span className="font-mono">graph.json</span> exists, this page renders the searchable symbol table — no
          rebuild needed.
        </p>
      </div>
    </Card>
  );
}

function InvalidState({ path, reason }: { readonly path: string; readonly reason: string }) {
  return (
    <Card size="lg" tone="danger">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <AlertTriangleIcon className="h-5 w-5 text-status-error" />
          <h2 className="font-display text-xl font-bold uppercase tracking-wide text-status-error">
            graph.json is invalid
          </h2>
        </div>
        <p className="text-sm text-text-primary">
          File at <span className="break-all font-mono">{path}</span> exists but failed to parse.
        </p>
        <Banner kind="error" code="parse_failed">
          {reason}
        </Banner>
        <p className="text-xs text-text-tertiary">
          Re-run <span className="font-mono">graphify scan</span> from the repo root, or open{' '}
          <span className="font-mono break-all">{path}</span> manually to inspect.
        </p>
      </div>
    </Card>
  );
}
