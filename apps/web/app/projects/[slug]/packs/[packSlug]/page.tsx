import { dirname } from 'node:path';

import { notFound } from 'next/navigation';

import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { StatusChip } from '@/components/StatusChip';
import {
  AlertTriangleIcon,
  Banner,
  Breadcrumbs,
  Button,
  Card,
  Checkbox,
  ChevronDownIcon,
  type Crumb,
  FormRow,
  Input,
  LinkButton,
  PageHeader,
  PageShell,
  Section,
  Select,
} from '@/components/ui';
import { deletePackAction, installTemplateAction, regeneratePackAction } from '@/lib/actions/packs';
import { resolveProjectFromParams } from '@/lib/project-context';
import { getPack } from '@/lib/queries/packs';

/**
 * `/projects/[slug]/packs/[packSlug]` — server-rendered pack detail
 * (S4 + S5, restyled in Phase 2 UI).
 *
 * Header carries 4 actions in a single bar: Edit, Activity,
 * Regenerate (yes/no confirm in <details>), Install template (typed
 * confirm), Delete (typed confirm). Body renders all 3 markdown files
 * via the brand-styled MarkdownRenderer.
 */
export const dynamic = 'force-dynamic';

const BUNDLED_TEMPLATES = [
  'generic',
  'nextjs-saas',
  'node-monorepo',
  'python-fastapi',
  'python-ml',
  'rust-cli',
  'go-service',
] as const;

interface SearchParams {
  readonly regenerated?: string;
  readonly deleted?: string;
  readonly installed?: string;
  readonly edited?: string;
  readonly error?: string;
  readonly errorMessage?: string;
}

export default async function PackDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; packSlug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const { packSlug: rawPackSlug } = await params;
  const packSlug = decodeURIComponent(rawPackSlug);
  const pack = getPack(packSlug);
  if (pack === null) notFound();
  if (pack.slug !== project.slug && pack.parentSlug !== project.slug) notFound();
  const sp = await searchParams;
  const cwd = dirname(dirname(pack.dir));
  const baseHref = `/projects/${encodeURIComponent(project.slug)}`;
  const packHref = `${baseHref}/packs/${encodeURIComponent(pack.slug)}`;
  const trail: ReadonlyArray<Crumb> = [
    { label: 'Projects', href: '/' },
    { label: project.slug, href: baseHref, mono: true },
    { label: 'Packs', href: `${baseHref}/packs` },
    { label: pack.slug, mono: true },
  ];

  return (
    <PageShell>
      <Breadcrumbs trail={trail} />
      <PageHeader
        eyebrow="Feature pack"
        title={pack.slug}
        actions={
          <>
            <LinkButton href={`${packHref}/edit?file=spec.md`} variant="secondary" size="sm">
              Edit
            </LinkButton>
            <LinkButton href={`${packHref}/runs`} variant="secondary" size="sm">
              Activity
            </LinkButton>
            <RegenerateMenu projectSlug={project.slug} packSlug={pack.slug} cwd={cwd} />
            <InstallTemplateMenu projectSlug={project.slug} packSlug={pack.slug} cwd={cwd} />
            <DeleteMenu projectSlug={project.slug} packSlug={pack.slug} cwd={cwd} />
          </>
        }
      />

      <Card size="sm">
        <dl className="grid grid-cols-1 gap-2 text-sm md:grid-cols-3">
          <Field
            label="Active"
            value={
              <StatusChip status={pack.isActive ? 'success' : 'neutral'}>
                {pack.isActive ? 'active' : 'inactive'}
              </StatusChip>
            }
          />
          <Field label="Parent" value={<span className="font-mono">{pack.parentSlug ?? '—'}</span>} />
          <Field
            label="Files"
            value={
              <span className="inline-flex items-center gap-2 font-mono">
                {pack.fileCount}/4
                {pack.fileCount < 4 ? <AlertTriangleIcon className="h-3 w-3 text-status-warning" /> : null}
              </span>
            }
          />
          <Field label="Directory" value={<span className="break-all font-mono text-xs">{pack.dir}</span>} />
        </dl>
      </Card>

      <Banners {...sp} packSlug={pack.slug} />

      <Section title="spec.md">
        <MarkdownBody body={pack.spec} />
      </Section>

      <Section title="implementation.md">
        <MarkdownBody body={pack.implementation} />
      </Section>

      <Section title="techstack.md">
        <MarkdownBody body={pack.techstack} />
      </Section>

      <Section title="meta.json">
        <FileBody body={pack.metaRaw} mono />
      </Section>
    </PageShell>
  );
}

function FileBody({ body, mono }: { readonly body: string | null; readonly mono?: boolean }) {
  if (body === null) {
    return (
      <Card size="md">
        <p className="text-center text-sm text-text-tertiary">File not present.</p>
      </Card>
    );
  }
  return (
    <pre
      className={
        mono === true
          ? 'overflow-x-auto whitespace-pre border border-border-subtle bg-bg-surface p-4 font-mono text-xs text-text-primary'
          : 'overflow-x-auto whitespace-pre-wrap border border-border-subtle bg-bg-surface p-4 font-mono text-xs text-text-primary'
      }
    >
      {body}
    </pre>
  );
}

function MarkdownBody({ body }: { readonly body: string | null }) {
  if (body === null) {
    return (
      <Card size="md">
        <p className="text-center text-sm text-text-tertiary">File not present.</p>
      </Card>
    );
  }
  return (
    <Card size="md">
      <MarkdownRenderer body={body} />
    </Card>
  );
}

function Field({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-xs font-medium text-text-secondary">{label}</dt>
      <dd className="text-text-primary">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action menus (S5 mutations)
// ---------------------------------------------------------------------------

function ActionMenuShell({
  label,
  variant = 'secondary',
  children,
}: {
  readonly label: string;
  readonly variant?: 'secondary' | 'destructive';
  readonly children: React.ReactNode;
}) {
  const summaryClass =
    variant === 'destructive'
      ? 'inline-flex h-7 cursor-pointer items-center gap-1.5 border border-status-error/40 bg-bg-base px-3 text-xs font-medium text-status-error transition-colors duration-200 hover:bg-status-error/10'
      : 'inline-flex h-7 cursor-pointer items-center gap-1.5 border border-border-default bg-bg-base px-3 text-xs font-medium text-text-primary transition-colors duration-200 hover:border-brand hover:text-brand';
  return (
    <details className="group relative">
      <summary className={`list-none ${summaryClass}`}>
        <span>{label}</span>
        <ChevronDownIcon className="h-3 w-3 transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <div
        className={`absolute right-0 z-10 mt-1 w-96 border bg-bg-surface p-4 shadow-md ${
          variant === 'destructive' ? 'border-status-error/40' : 'border-border-default'
        }`}
      >
        {children}
      </div>
    </details>
  );
}

function RegenerateMenu({
  projectSlug,
  packSlug,
  cwd,
}: {
  readonly projectSlug: string;
  readonly packSlug: string;
  readonly cwd: string;
}) {
  return (
    <ActionMenuShell label="Regenerate">
      <form action={regeneratePackAction} className="flex flex-col gap-3">
        <input type="hidden" name="projectSlug" value={projectSlug} />
        <input type="hidden" name="packSlug" value={packSlug} />
        <input type="hidden" name="cwd" value={cwd} />
        <p className="text-xs text-text-secondary">
          Re-renders auto-managed sections from the template. User-edited content outside auto-marker blocks is
          preserved.
        </p>
        <label htmlFor={`regen-confirm-${packSlug}`} className="flex items-center gap-2 text-sm">
          <Checkbox id={`regen-confirm-${packSlug}`} name="confirm" value="yes" required />
          <span>Yes, regenerate this pack</span>
        </label>
        <Button type="submit" variant="primary" size="sm">
          Regenerate
        </Button>
      </form>
    </ActionMenuShell>
  );
}

function InstallTemplateMenu({
  projectSlug,
  packSlug,
  cwd,
}: {
  readonly projectSlug: string;
  readonly packSlug: string;
  readonly cwd: string;
}) {
  return (
    <ActionMenuShell label="Install template">
      <form action={installTemplateAction} className="flex flex-col gap-3">
        <input type="hidden" name="projectSlug" value={projectSlug} />
        <input type="hidden" name="packSlug" value={packSlug} />
        <input type="hidden" name="cwd" value={cwd} />
        <p className="text-xs text-text-secondary">
          Overlays a bundled template onto this pack. Auto-managed sections are replaced; unmanaged user content is
          preserved by the seed merger.
        </p>
        <FormRow inputId={`install-template-${packSlug}`} label="Template" required>
          <Select id={`install-template-${packSlug}`} name="templateName" defaultValue="generic" mono required>
            {BUNDLED_TEMPLATES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </FormRow>
        <FormRow
          inputId={`install-confirm-${packSlug}`}
          label="Type to confirm"
          required
          helper={
            <>
              <span className="font-mono">install &lt;template-name&gt;</span> exactly
            </>
          }
        >
          <Input
            id={`install-confirm-${packSlug}`}
            name="confirmation"
            required
            mono
            placeholder="install <template-name>"
            autoComplete="off"
          />
        </FormRow>
        <Button type="submit" variant="primary" size="sm">
          Install
        </Button>
      </form>
    </ActionMenuShell>
  );
}

function DeleteMenu({
  projectSlug,
  packSlug,
  cwd,
}: {
  readonly projectSlug: string;
  readonly packSlug: string;
  readonly cwd: string;
}) {
  return (
    <ActionMenuShell label="Delete" variant="destructive">
      <form action={deletePackAction} className="flex flex-col gap-3">
        <input type="hidden" name="projectSlug" value={projectSlug} />
        <input type="hidden" name="packSlug" value={packSlug} />
        <input type="hidden" name="cwd" value={cwd} />
        <p className="text-xs text-text-primary">
          Per CLI semantics: removes <span className="font-mono">{`docs/feature-packs/${packSlug}/`}</span> from disk
          AND flips <span className="font-mono">feature_packs.is_active = false</span>. Row preserved per ADR-007.
        </p>
        <FormRow
          inputId={`delete-confirm-${packSlug}`}
          label="Type to confirm"
          required
          helper={
            <>
              <span className="font-mono">delete {packSlug}</span> exactly
            </>
          }
        >
          <Input
            id={`delete-confirm-${packSlug}`}
            name="confirmation"
            required
            mono
            placeholder={`delete ${packSlug}`}
            autoComplete="off"
            invalid
          />
        </FormRow>
        <Button type="submit" variant="destructive" size="sm">
          Delete
        </Button>
      </form>
    </ActionMenuShell>
  );
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

function Banners(sp: SearchParams & { readonly packSlug: string }) {
  if (
    sp.regenerated === undefined &&
    sp.deleted === undefined &&
    sp.installed === undefined &&
    sp.edited === undefined &&
    sp.error === undefined
  ) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      {sp.regenerated !== undefined ? (
        <Banner kind="success">Regenerated. Auto-managed sections refreshed.</Banner>
      ) : null}
      {sp.installed !== undefined ? (
        <Banner kind="success">
          Installed template <span className="font-mono">{sp.installed}</span>.
        </Banner>
      ) : null}
      {sp.edited !== undefined ? (
        <Banner kind="success">
          Saved <span className="font-mono">{sp.edited}</span>. Auto-marker contract preserved.
        </Banner>
      ) : null}
      {sp.deleted !== undefined ? (
        <Banner kind="info">
          Pack <span className="font-mono">{sp.deleted}</span> deleted.
        </Banner>
      ) : null}
      {sp.error !== undefined ? (
        <Banner kind="error" code={sp.error}>
          {sp.errorMessage ?? '—'}
        </Banner>
      ) : null}
    </div>
  );
}
