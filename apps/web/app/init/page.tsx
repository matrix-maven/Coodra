import { NewProjectWizard } from '@/components/NewProjectWizard';
import { initProjectAction } from '@/lib/actions/init';

/**
 * `/init` — Project provisioning wizard.
 *
 * Server reads search params (error message + prefilled values), then
 * hands everything to the client-side <NewProjectWizard /> which owns
 * the form state, validation indicators, and 3-column layout.
 */

export const dynamic = 'force-dynamic';

const BUNDLED_TEMPLATES: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: '', label: 'Minimal — skeleton (no template overlay)' },
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
    <NewProjectWizard
      action={initProjectAction}
      templates={BUNDLED_TEMPLATES}
      ides={IDE_OPTIONS}
      initial={{
        cwd: sp.cwd ?? '',
        slug: sp.projectSlug ?? '',
        ide: sp.ide ?? 'claude',
        template: sp.template ?? '',
      }}
      {...(sp.errorMessage !== undefined ? { errorMessage: sp.errorMessage } : {})}
      {...(sp.error !== undefined ? { errorCode: sp.error } : {})}
    />
  );
}
