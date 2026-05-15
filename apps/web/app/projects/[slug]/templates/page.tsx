import { StatusChip } from '@/components/StatusChip';
import {
  Banner,
  BoxIcon,
  Button,
  Card,
  Checkbox,
  ChevronDownIcon,
  EmptyState,
  FormRow,
  Input,
  LinkButton,
  PageHeader,
  PageShell,
  PlusIcon,
  Section,
} from '@/components/ui';
import { installTemplateFromPathAction } from '@/lib/actions/templates';
import { resolveProjectFromParams } from '@/lib/project-context';
import { listTemplates } from '@/lib/queries/templates';

/**
 * `/projects/[slug]/templates` — editorial templates page (mirrors
 * brand-kit Templates, screen 09).
 *
 * Two-column tile grid; each tile carries an icon glyph, serif title
 * with phosphor italic, lede, and a hooks footer + Install action.
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
        eyebrow="/04 · KNOWLEDGE · TEMPLATES"
        title={
          <>
            Start from a <em>known shape</em>.
          </>
        }
        subtitle={
          <>
            Templates ship with policy seeds, hook scripts, and a starter feature pack. Pick one — the CLI does the
            rest. Or run <span className="font-mono text-accent">coodra template install &lt;path&gt;</span> against{' '}
            <span className="font-mono text-accent">{project.slug}</span>.
          </>
        }
        meta={
          <>
            <strong className="font-medium text-text-primary">{templates.length} bundled</strong>
            <br />
            packages/cli/templates/
          </>
        }
      />

      {sp.installed !== undefined ? (
        <div className="mb-8">
          <Banner kind="success">
            Installed template <span className="font-mono">{sp.installed}</span>.
          </Banner>
        </div>
      ) : null}
      {sp.error !== undefined ? (
        <div className="mb-8">
          <Banner kind="error" code={sp.error}>
            {sp.errorMessage ?? '—'}
          </Banner>
        </div>
      ) : null}

      {templates.length === 0 ? (
        <EmptyState
          title={
            <>
              No <em>templates</em> available
            </>
          }
          body="Install one with the panel below or via the CLI."
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {templates.map((t) => (
            <TemplateTile key={t.name} {...t} />
          ))}
        </div>
      )}

      <div className="mt-14">
        <Section
          title={
            <>
              Install from <em>local path</em>
            </>
          }
          count="advanced"
        >
          <Card size="md">
            <details className="group">
              <summary className="flex cursor-pointer items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-primary">
                <PlusIcon className="h-3 w-3 text-accent" />
                <span>Install a template from a local path</span>
                <ChevronDownIcon className="ml-auto h-3 w-3 transition-transform duration-200 group-open:rotate-180" />
              </summary>
              <form action={installTemplateFromPathAction} className="mt-5 flex flex-col gap-5">
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
                  <Input id="template-source" name="source" required placeholder="/Users/you/path/to/template-dir" />
                </FormRow>
                <FormRow
                  inputId="template-name"
                  label="Name override (optional)"
                  helper="Bundled-template names are reserved — use a name override if your name collides."
                >
                  <Input id="template-name" name="name" placeholder="my-custom-template" pattern="[a-z0-9-]*" />
                </FormRow>
                <label
                  htmlFor="template-force"
                  className="flex items-center gap-3 font-mono text-[11px] tracking-[0.04em] text-text-tertiary"
                >
                  <Checkbox id="template-force" name="force" />
                  <span>Force overwrite if a user template with this name exists</span>
                </label>
                <Button type="submit" variant="primary">
                  Install template
                </Button>
              </form>
            </details>
          </Card>
        </Section>
      </div>
    </PageShell>
  );
}

function TemplateTile({
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
    <article className="flex min-h-[280px] flex-col border border-rule bg-bg-surface p-9">
      <div className="mb-5 flex items-center gap-3.5">
        <span className="flex h-12 w-12 items-center justify-center border border-rule-strong text-accent">
          <BoxIcon className="h-6 w-6" />
        </span>
        <h3 className="heading-display text-[28px] text-text-primary">
          <span>{source === 'bundled' ? <em>{name}</em> : name}</span>
        </h3>
      </div>
      <p className="flex-1 text-[14px] leading-[1.55] text-text-tertiary">
        {description ?? `${name} — bundled feature pack template.`}
      </p>
      <div className="mt-3 flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-[0.06em] text-text-muted">
        <StatusChip status={source === 'bundled' ? 'info' : 'neutral'}>{source}</StatusChip>
        {version !== null ? <span className="text-text-tertiary">v{version}</span> : null}
        {languages.length > 0 ? <span className="text-text-tertiary">· {languages.join(' · ')}</span> : null}
      </div>
      <div className="mt-7 flex items-center justify-between border-t border-rule pt-5">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted">
          {autoSections.length > 0 ? autoSections.slice(0, 4).join(' · ') : 'PRE · POST · START · END'}
        </span>
        <LinkButton href={`#${name}`} variant="primary" size="sm">
          Install
        </LinkButton>
      </div>
      <div className="mt-3 truncate font-mono text-[10px] text-text-muted">{dir}</div>
    </article>
  );
}
