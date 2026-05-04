import {
  Banner,
  Button,
  Card,
  Checkbox,
  FormRow,
  Input,
  LinkButton,
  PageHeader,
  PageShell,
  Select,
} from '@/components/ui';
import { initProjectAction } from '@/lib/actions/init';

/**
 * `/init` — Project provisioning wizard (M04 Phase 2 S3, restyled in
 * Phase 2 UI).
 *
 * Web parity with `contextos init --project-slug X --no-graphify
 * --ide claude` per the OQ-4 lock. On success the Server Action
 * redirects to `/projects/[newSlug]`. On failure it returns here with
 * the form prefilled and an inline <Banner> describing the error.
 */

export const dynamic = 'force-dynamic';

const BUNDLED_TEMPLATES: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: '', label: 'minimal — skeleton (no template overlay)' },
  { value: 'generic', label: 'generic' },
  { value: 'nextjs-saas', label: 'nextjs-saas' },
  { value: 'node-monorepo', label: 'node-monorepo' },
  { value: 'python-fastapi', label: 'python-fastapi' },
  { value: 'python-ml', label: 'python-ml' },
  { value: 'rust-cli', label: 'rust-cli' },
  { value: 'go-service', label: 'go-service' },
];

const IDE_OPTIONS = [
  { value: 'claude', label: 'claude' },
  { value: 'cursor', label: 'cursor (M07)' },
  { value: 'windsurf', label: 'windsurf (M07)' },
  { value: 'all', label: 'all detected' },
];

interface SearchParams {
  readonly error?: string;
  readonly errorMessage?: string;
  readonly cwd?: string;
  readonly projectSlug?: string;
  readonly ide?: string;
  readonly template?: string;
}

export default async function InitWizardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  return (
    <PageShell variant="workspace">
      <PageHeader
        eyebrow="Workspace"
        title="New project"
        subtitle={
          <>
            Web parity with <span className="font-mono">contextos init</span>. Provisions{' '}
            <span className="font-mono">~/.contextos/data.db</span>, scaffolds a feature pack at{' '}
            <span className="font-mono">{`<cwd>/docs/feature-packs/<slug>/`}</span>, registers the project + default
            policy + Claude Code hook entries.
          </>
        }
      />

      {sp.error !== undefined ? (
        <Banner kind="error" code={sp.error}>
          {sp.errorMessage ?? 'Provision failed.'}
        </Banner>
      ) : null}

      <Card size="lg">
        <form action={initProjectAction} className="flex flex-col gap-6">
          <FormRow
            inputId="init-cwd"
            label="Project root (cwd)"
            required
            helper="Absolute path. Must contain package.json, pyproject.toml, Cargo.toml, or .git."
          >
            <Input
              id="init-cwd"
              name="cwd"
              required
              mono
              placeholder="/Users/you/projects/my-app"
              defaultValue={sp.cwd ?? ''}
            />
          </FormRow>

          <FormRow
            inputId="init-slug"
            label="Project slug"
            required
            helper="Lowercase letters, digits, underscores, hyphens. 1–64 characters. Mirrors the CLI's slug rule."
          >
            <Input
              id="init-slug"
              name="projectSlug"
              required
              mono
              pattern="[a-z0-9_-]+"
              maxLength={64}
              placeholder="my-app"
              defaultValue={sp.projectSlug ?? ''}
            />
          </FormRow>

          <FormRow
            inputId="init-ide"
            label="IDE to wire"
            required
            helper="claude wires ~/.claude/settings.json hooks. cursor + windsurf land in M07. all wires every IDE detected."
          >
            <Select id="init-ide" name="ide" defaultValue={sp.ide ?? 'claude'}>
              {IDE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </FormRow>

          <FormRow
            inputId="init-template"
            label="Feature-pack template"
            helper="Optional — picks a starter template for the auto-marker sections. Skipping = minimal skeleton."
          >
            <Select id="init-template" name="template" defaultValue={sp.template ?? ''}>
              {BUNDLED_TEMPLATES.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </FormRow>

          <fieldset className="flex flex-col gap-2 border border-border-subtle bg-bg-elevated p-4">
            <legend className="px-2 text-xs font-medium text-text-secondary">Advanced</legend>
            <label htmlFor="init-noGraphify" className="flex items-start gap-3 text-sm">
              <Checkbox id="init-noGraphify" name="noGraphify" defaultChecked />
              <span>
                Skip Graphify scan (default — Graphify producer is deferred per ADR-010 Slice 11; install graphify CLI
                separately if needed).
              </span>
            </label>
          </fieldset>

          <div className="flex items-center gap-3 border-t border-border-subtle pt-6">
            <Button type="submit" variant="primary">
              Provision project
            </Button>
            <LinkButton href="/" variant="ghost">
              Cancel
            </LinkButton>
          </div>
        </form>
      </Card>
    </PageShell>
  );
}
