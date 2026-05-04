import { StatusChip } from '@/components/StatusChip';
import {
  Banner,
  Button,
  Card,
  Checkbox,
  ChevronDownIcon,
  EmptyState,
  FormRow,
  Input,
  PageHeader,
  PageShell,
  PlusIcon,
  Section,
} from '@/components/ui';
import { installTemplateFromPathAction } from '@/lib/actions/templates';
import { resolveProjectFromParams } from '@/lib/project-context';
import { listTemplates } from '@/lib/queries/templates';

/**
 * `/projects/[slug]/templates` — bundled + user-installed feature-pack
 * templates (M04 Phase 2 S2a IA migration; install action S13;
 * restyled in Phase 2 UI).
 */
export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly installed?: string;
  readonly error?: string;
  readonly errorMessage?: string;
}

export default async function TemplatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const sp = await searchParams;
  const templates = listTemplates();

  return (
    <PageShell>
      <PageHeader
        eyebrow="Project · templates"
        title="Templates"
        subtitle={
          <>
            Bundled + user templates available to <span className="font-mono">{project.slug}</span>. Install via the
            form below or <span className="font-mono">contextos template install &lt;path&gt;</span> from the CLI.
          </>
        }
      />

      {sp.installed !== undefined ? (
        <Banner kind="success">
          Installed template <span className="font-mono">{sp.installed}</span>.
        </Banner>
      ) : null}
      {sp.error !== undefined ? (
        <Banner kind="error" code={sp.error}>
          {sp.errorMessage ?? '—'}
        </Banner>
      ) : null}

      <Section title="Install from local path">
        <details className="group border border-border-subtle bg-bg-surface p-4">
          <summary className="flex cursor-pointer items-center gap-2 text-xs font-medium text-text-primary">
            <PlusIcon className="h-3 w-3" />
            <span>Install a template from a local path</span>
            <ChevronDownIcon className="ml-auto h-3 w-3 transition-transform duration-200 group-open:rotate-180" />
          </summary>
          <form action={installTemplateFromPathAction} className="mt-4 flex flex-col gap-4">
            <input type="hidden" name="projectSlug" value={project.slug} />
            <FormRow
              inputId="template-source"
              label="Source path (absolute)"
              required
              helper={
                <>
                  Source directory must contain <span className="font-mono">template.json</span>,{' '}
                  <span className="font-mono">spec.md.tmpl</span>,{' '}
                  <span className="font-mono">implementation.md.tmpl</span>,{' '}
                  <span className="font-mono">techstack.md.tmpl</span>, and{' '}
                  <span className="font-mono">meta.json.tmpl</span>.
                </>
              }
            >
              <Input id="template-source" name="source" required mono placeholder="/Users/you/path/to/template-dir" />
            </FormRow>
            <FormRow
              inputId="template-name"
              label="Name override (optional)"
              helper="Bundled-template names are reserved — use a name override if your name collides."
            >
              <Input id="template-name" name="name" mono placeholder="my-custom-template" pattern="[a-z0-9-]*" />
            </FormRow>
            <label htmlFor="template-force" className="flex items-center gap-3 text-sm">
              <Checkbox id="template-force" name="force" />
              <span>Force overwrite if a user template with this name exists</span>
            </label>
            <Button type="submit" variant="primary">
              Install template
            </Button>
          </form>
        </details>
      </Section>

      <Section title="Available templates" count={templates.length}>
        {templates.length === 0 ? (
          <EmptyState title="No templates available" body="Install one with the form above or via the CLI." />
        ) : (
          <div className="flex flex-col gap-4">
            {templates.map((t) => (
              <TemplateCard key={t.name} {...t} />
            ))}
          </div>
        )}
      </Section>
    </PageShell>
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
    <Card size="md">
      <article className="flex flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <h3 className="font-mono text-xl font-medium text-text-primary">{name}</h3>
          <StatusChip status={source === 'bundled' ? 'info' : 'neutral'}>{source}</StatusChip>
          {version !== null ? <span className="font-mono text-xs text-text-tertiary">v{version}</span> : null}
        </div>
        {description !== null ? <p className="text-sm text-text-secondary">{description}</p> : null}
        <dl className="grid grid-cols-1 gap-1 text-xs md:grid-cols-2">
          <Field label="Languages" value={languages.length > 0 ? languages.join(', ') : '—'} />
          <Field label="@auto sections" value={autoSections.length > 0 ? autoSections.join(', ') : '—'} />
          <Field label="Path" value={<span className="break-all font-mono">{dir}</span>} full />
        </dl>
      </article>
    </Card>
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
      <dt className="text-xs font-medium text-text-tertiary">{label}:</dt>
      <dd className="text-text-secondary">{value}</dd>
    </div>
  );
}
