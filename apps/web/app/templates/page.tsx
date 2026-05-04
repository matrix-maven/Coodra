import { StatusChip } from '@/components/StatusChip';
import { listTemplates } from '@/lib/queries/templates';

/**
 * `/templates` — bundled + user-installed feature-pack templates per
 * `docs/feature-packs/04-web-app/wireframes/02-screens/templates.md`.
 * Read-only in S7. Install-from-path form is reserved for an S7
 * follow-up (server action requires `installTemplate` extraction
 * from packages/cli — that's M08b S17 internal logic).
 *
 * M04 Phase 2 S1 (F1, OQ-9 lock): force-dynamic so newly installed
 * templates (`contextos template install <path>`) appear without a
 * rebuild.
 */
export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const templates = listTemplates();
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-black uppercase tracking-wide">Templates</h1>
        <p className="text-sm text-(--color-text-secondary)">
          Bundled and user-installed feature-pack templates. Install with{' '}
          <span className="font-mono">contextos template install &lt;path&gt;</span>.
        </p>
      </header>

      {templates.length === 0 ? (
        <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-12 text-center">
          <p className="font-display text-lg font-light uppercase tracking-wider text-(--color-text-secondary)">
            No templates available.
          </p>
          <p className="mt-2 text-sm text-(--color-text-tertiary)">
            Reinstall the CLI or use <span className="font-mono">contextos template install</span> to add one.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {templates.map((t) => (
            <TemplateCard key={t.name} {...t} />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({
  name,
  source,
  dir,
  description,
  version,
  languages,
  autoSections,
}: {
  readonly name: string;
  readonly source: 'bundled' | 'user';
  readonly dir: string;
  readonly description: string | null;
  readonly version: string | null;
  readonly languages: ReadonlyArray<string>;
  readonly autoSections: ReadonlyArray<string>;
}) {
  return (
    <article className="flex flex-col gap-2 border border-(--color-border-subtle) bg-(--color-bg-surface) p-6">
      <div className="flex items-baseline gap-3">
        <h2 className="font-mono text-xl font-medium text-(--color-text-primary)">{name}</h2>
        <StatusChip status={source === 'bundled' ? 'info' : 'neutral'}>{source}</StatusChip>
        {version !== null ? <span className="font-mono text-xs text-(--color-text-tertiary)">v{version}</span> : null}
      </div>
      {description !== null ? <p className="text-sm text-(--color-text-secondary)">{description}</p> : null}
      <dl className="grid grid-cols-1 gap-1 text-xs md:grid-cols-2">
        <Field label="Languages" value={languages.length > 0 ? languages.join(', ') : '—'} />
        <Field label="@auto sections" value={autoSections.length > 0 ? autoSections.join(', ') : '—'} />
        <Field label="Path" value={<span className="font-mono">{dir}</span>} full />
      </dl>
    </article>
  );
}

function Field({
  label,
  value,
  full,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly full?: boolean;
}) {
  return (
    <div className={`flex gap-2 ${full === true ? 'md:col-span-2' : ''}`}>
      <dt className="font-display text-[10px] font-bold uppercase tracking-wider text-(--color-text-tertiary)">
        {label}:
      </dt>
      <dd className="text-(--color-text-secondary)">{value}</dd>
    </div>
  );
}
