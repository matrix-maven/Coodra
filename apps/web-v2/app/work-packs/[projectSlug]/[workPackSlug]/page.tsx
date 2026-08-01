import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { WorkPackMarkdown } from '@/components/work-packs/WorkPackMarkdown';
import { getWorkPackDetailBySlug } from '@/lib/queries/work-packs';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly projectSlug: string; readonly workPackSlug: string }>;
}

export default async function WorkPackDetailPage({ params }: PageProps) {
  const { projectSlug, workPackSlug } = await params;
  const pack = await getWorkPackDetailBySlug(projectSlug, workPackSlug);
  if (pack === null) notFound();

  const metadata = parseMetadata(pack.metadataJson);

  return (
    <>
      <Topbar crumb={`${pack.projectSlug} / ${pack.slug}`} crumbPrefix="coodra / work packs" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">
              /12 · WORK PACKS ·{' '}
              <Link href={`/work-packs/${encodeURIComponent(pack.projectSlug)}`} style={{ color: 'var(--accent)' }}>
                {pack.projectSlug}
              </Link>
            </div>
            <h1 className="head__title">{pack.title}</h1>
            <p className="head__lede">
              Local Work Pack details imported from the planning system. Jira remains the external source of issue
              state; Coodra keeps the implementation record, context, and sync notes local to the project.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{pack.externalKey ?? pack.slug}</strong>
              <br />
              {pack.packType} · {pack.status}
              <br />
              updated · {formatRelative(pack.updatedAt)}
            </div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href={`/work-packs/${encodeURIComponent(pack.projectSlug)}`}>
                ← Project packs
              </Link>
              {pack.externalUrl !== null ? (
                <a className="btn btn--accent" href={pack.externalUrl} target="_blank" rel="noreferrer">
                  Open Jira ↗
                </a>
              ) : null}
            </div>
          </div>
        </div>

        <div style={layoutStyle}>
          <aside style={asideStyle}>
            <Info label="Project" value={pack.projectName} />
            <Info label="Pack slug" value={pack.slug} mono />
            <Info label="Pack type" value={pack.packType} />
            <Info label="Local status" value={pack.status} />
            <Info label="Sync state" value={pack.syncState ?? 'local'} />
            <Info label="Provider" value={pack.externalProvider ?? 'local'} />
            <Info label="External key" value={pack.externalKey ?? 'none'} mono />
            <Info label="Issue type" value={pack.externalIssueType ?? 'unknown'} />
            <Info label="Issue status" value={pack.externalStatus ?? 'unknown'} />
            {metadata.length > 0 ? (
              <div style={{ marginTop: 18 }}>
                <div style={sectionKickerStyle}>Metadata</div>
                <div style={metadataGridStyle}>
                  {metadata.slice(0, 12).map(([key, value]) => (
                    <div key={key} style={metadataRowStyle}>
                      <span style={metadataKeyStyle}>{key}</span>
                      <code style={metadataValueStyle}>{value}</code>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </aside>

          <article style={contentStyle}>
            <MarkdownSection title="Requirements and Acceptance Criteria" markdown={pack.specMarkdown} />
            <MarkdownSection title="Implementation Notes" markdown={pack.implementationMarkdown} />
            <MarkdownSection title="Sync and Write-Back Notes" markdown={pack.syncMarkdown} />
          </article>
        </div>
      </section>
    </>
  );
}

function MarkdownSection({ title, markdown }: { readonly title: string; readonly markdown: string }) {
  return (
    <section style={sectionStyle}>
      <div style={sectionKickerStyle}>{title}</div>
      <WorkPackMarkdown markdown={markdown} />
    </section>
  );
}

function Info({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <div style={infoStyle}>
      <div style={infoLabelStyle}>{label}</div>
      <div style={mono ? infoMonoValueStyle : infoValueStyle}>{value}</div>
    </div>
  );
}

function parseMetadata(raw: string): Array<[string, string]> {
  if (raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, stringifyMetadata(value)]);
  } catch {
    return [];
  }
}

function stringifyMetadata(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return JSON.stringify(value);
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const layoutStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '280px minmax(0, 1fr)',
  gap: 24,
  alignItems: 'start',
};

const asideStyle: React.CSSProperties = {
  position: 'sticky',
  top: 16,
  border: '1px solid var(--rule)',
  borderRadius: 8,
  background: 'var(--bg-2)',
  padding: 18,
};

const contentStyle: React.CSSProperties = {
  minWidth: 0,
  display: 'grid',
  gap: 16,
};

const sectionStyle: React.CSSProperties = {
  border: '1px solid var(--rule)',
  borderRadius: 8,
  background: 'var(--bg-2)',
  padding: '22px 24px',
};

const sectionKickerStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--ink-mute)',
  marginBottom: 12,
};

const infoStyle: React.CSSProperties = {
  padding: '10px 0',
  borderBottom: '1px solid var(--rule)',
};

const infoLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--ink-mute)',
  marginBottom: 4,
};

const infoValueStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--ink)',
  overflowWrap: 'anywhere',
};

const infoMonoValueStyle: React.CSSProperties = {
  ...infoValueStyle,
  fontFamily: 'var(--mono)',
  fontSize: 12,
};

const metadataGridStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8,
};

const metadataRowStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
};

const metadataKeyStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--ink-mute)',
};

const metadataValueStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink-dim)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};
