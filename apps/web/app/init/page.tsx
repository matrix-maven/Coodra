import Link from 'next/link';

import { initProjectAction } from '@/lib/actions/init';

/**
 * `/init` — Project provisioning wizard (M04 Phase 2 S3).
 *
 * Web parity with `contextos init --project-slug X --no-graphify
 * --ide claude` per the OQ-4 lock. Form fields:
 *   - cwd            (absolute path of the project to initialise)
 *   - projectSlug    (regex-validated)
 *   - ide            (claude / cursor / windsurf / all)
 *   - template       (bundled-template name; default = minimal)
 *   - noGraphify     (always true for v1; the toggle is informational)
 *
 * On success, the Server Action redirects to `/projects/[newSlug]`.
 * On failure, it redirects back here with `?error=<code>` +
 * `?errorMessage=<text>` + repopulated form fields so the user can
 * fix and resubmit.
 *
 * In team mode, this page still renders — the `runInit` library
 * promotion respects the workspace's auth model (web Server Actions
 * inherit the middleware's auth check).
 */

export const dynamic = 'force-dynamic';

const BUNDLED_TEMPLATES = [
  { value: '', label: 'minimal — skeleton (no template overlay)' },
  { value: 'generic', label: 'generic' },
  { value: 'nextjs-saas', label: 'nextjs-saas' },
  { value: 'node-monorepo', label: 'node-monorepo' },
  { value: 'python-fastapi', label: 'python-fastapi' },
  { value: 'python-ml', label: 'python-ml' },
  { value: 'rust-cli', label: 'rust-cli' },
  { value: 'go-service', label: 'go-service' },
] as const;

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
    <div className="mx-auto flex max-w-[800px] flex-col gap-12 px-8 py-12">
      <header className="flex flex-col gap-3">
        <Link
          href="/"
          className="self-start font-display text-[10px] font-bold uppercase tracking-widest text-(--color-text-secondary) hover:text-(--color-brand)"
        >
          ◂ All projects
        </Link>
        <h1 className="font-display text-[56px] leading-[64px] font-black uppercase tracking-wide">New project</h1>
        <p className="text-sm text-(--color-text-secondary)">
          Web parity with <span className="font-mono">contextos init</span>. Provisions{' '}
          <span className="font-mono">~/.contextos/data.db</span>, scaffolds a feature pack at{' '}
          <span className="font-mono">{`<cwd>/docs/feature-packs/<slug>/`}</span>, registers the project + default
          policy + Claude Code hook entries.
        </p>
      </header>

      {sp.error !== undefined ? (
        <div className="border-l-4 border-(--color-status-error) bg-(--color-status-error)/10 px-4 py-3 text-sm">
          <div className="font-display text-xs font-bold uppercase tracking-wider text-(--color-status-error)">
            Failed: {sp.error}
          </div>
          {sp.errorMessage !== undefined ? (
            <div className="mt-1 text-(--color-text-primary)">{sp.errorMessage}</div>
          ) : null}
        </div>
      ) : null}

      <form action={initProjectAction} className="flex flex-col gap-6">
        <FormField
          label="Project root (cwd) *"
          name="cwd"
          placeholder="/Users/you/projects/my-app"
          defaultValue={sp.cwd ?? ''}
          hint="Absolute path. Must contain package.json, pyproject.toml, Cargo.toml, or .git."
          required
        />
        <FormField
          label="Project slug *"
          name="projectSlug"
          placeholder="my-app"
          defaultValue={sp.projectSlug ?? ''}
          hint="Lowercase letters, digits, underscores, hyphens. 1-64 characters. Mirrors the CLI's slug rule."
          pattern="[a-z0-9_-]+"
          maxLength={64}
          required
        />
        <FormField
          label="IDE to wire *"
          name="ide"
          type="select"
          defaultValue={sp.ide ?? 'claude'}
          hint="claude wires ~/.claude/settings.json hooks. cursor + windsurf land in M07. all wires every IDE detected."
          options={[
            { value: 'claude', label: 'claude' },
            { value: 'cursor', label: 'cursor (M07)' },
            { value: 'windsurf', label: 'windsurf (M07)' },
            { value: 'all', label: 'all detected' },
          ]}
        />
        <FormField
          label="Feature-pack template"
          name="template"
          type="select"
          defaultValue={sp.template ?? ''}
          hint="Optional — picks a starter template for the auto-marker sections. Skipping = minimal skeleton."
          options={[...BUNDLED_TEMPLATES]}
        />
        <fieldset className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-4">
          <legend className="px-2 font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
            Advanced
          </legend>
          <label className="flex items-center gap-3 text-sm">
            <input type="checkbox" name="noGraphify" defaultChecked />
            <span>
              Skip Graphify scan (default — Graphify producer is deferred per ADR-010 Slice 11; install graphify CLI
              separately if needed)
            </span>
          </label>
        </fieldset>
        <div className="flex items-center gap-4 border-t border-(--color-border-subtle) pt-6">
          <button
            type="submit"
            className="bg-(--color-brand) px-8 py-3 font-display text-xs font-bold uppercase tracking-wider text-white hover:bg-(--color-brand-hover)"
          >
            Provision project
          </button>
          <Link
            href="/"
            className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary) hover:text-(--color-brand)"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

interface FormFieldProps {
  readonly label: string;
  readonly name: string;
  readonly type?: 'text' | 'select';
  readonly placeholder?: string;
  readonly hint?: string;
  readonly defaultValue?: string;
  readonly options?: ReadonlyArray<{ value: string; label: string }>;
  readonly required?: boolean;
  readonly pattern?: string;
  readonly maxLength?: number;
}

function FormField({
  label,
  name,
  type = 'text',
  placeholder,
  hint,
  defaultValue,
  options,
  required,
  pattern,
  maxLength,
}: FormFieldProps) {
  const inputId = `init-${name}`;
  const inputClass =
    'w-full border border-(--color-border-default) bg-(--color-bg-base) px-3 py-2 font-sans text-sm text-(--color-text-primary)';
  return (
    <label htmlFor={inputId} className="flex flex-col gap-1">
      <span className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
        {label}
      </span>
      {type === 'select' && options !== undefined ? (
        <select id={inputId} name={name} defaultValue={defaultValue} required={required} className={inputClass}>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={inputId}
          type="text"
          name={name}
          required={required}
          placeholder={placeholder}
          defaultValue={defaultValue}
          {...(pattern !== undefined ? { pattern } : {})}
          {...(maxLength !== undefined ? { maxLength } : {})}
          className={inputClass}
        />
      )}
      {hint !== undefined ? <span className="text-xs text-(--color-text-tertiary)">{hint}</span> : null}
    </label>
  );
}
