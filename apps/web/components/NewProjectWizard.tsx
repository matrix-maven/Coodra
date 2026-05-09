'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  HelpCircleIcon,
  PageHeader,
  PageShell,
  RocketIcon,
  Section,
  StatPill,
} from '@/components/ui';

/**
 * `apps/web/components/NewProjectWizard.tsx` — editorial /init form.
 *
 * Three-column layout: progress on the left, fields in the centre,
 * "what this will do" on the right. Editorial tone — eyebrow + serif
 * italic title — borrowed from the brand kit, fields run mono.
 */

export interface NewProjectWizardProps {
  readonly action: (formData: FormData) => Promise<void>;
  readonly templates: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly ides: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly initial: {
    readonly cwd: string;
    readonly slug: string;
    readonly ide: string;
    readonly template: string;
  };
  readonly errorMessage?: string;
  readonly errorCode?: string;
}

const SLUG_REGEX = /^[a-z0-9_-]+$/;

export function NewProjectWizard(props: NewProjectWizardProps) {
  const [cwd, setCwd] = useState(props.initial.cwd);
  const [slug, setSlug] = useState(props.initial.slug);
  const [ide, setIde] = useState(props.initial.ide);
  const [template, setTemplate] = useState(props.initial.template);
  const [advancedOpen, setAdvancedOpen] = useState(true);

  const cwdValid = useMemo(() => cwd.startsWith('/') && cwd.length > 1, [cwd]);
  const slugValid = useMemo(() => SLUG_REGEX.test(slug) && slug.length > 0 && slug.length <= 64, [slug]);
  const ideValid = ide.length > 0;

  const step1Done = cwdValid && slugValid;
  const step2Done = ideValid;
  const currentStep: 1 | 2 | 3 = !step1Done ? 1 : !step2Done ? 2 : 3;

  return (
    <PageShell variant="workspace">
      <div className="flex items-center justify-between mb-8">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-text-tertiary transition-colors hover:text-text-primary"
        >
          <ChevronLeftIcon className="h-3 w-3" />
          Projects
        </Link>
        <a
          href="https://github.com/anthropics/claude-code"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 items-center gap-2 border border-rule-strong px-3 font-mono text-[10px] uppercase tracking-[0.18em] text-text-tertiary transition-colors hover:border-text-primary hover:text-text-primary"
        >
          <HelpCircleIcon className="h-3 w-3" />
          Need help?
        </a>
      </div>

      <PageHeader
        eyebrow="/00 · INIT"
        title={
          <>
            New <em>project</em>.
          </>
        }
        subtitle={
          <>
            Web parity with <span className="font-mono text-accent">contextos init</span>. Provisions{' '}
            <span className="font-mono text-accent">~/.contextos/data.db</span>, scaffolds a feature pack at{' '}
            <span className="font-mono text-accent">{`<cwd>/docs/feature-packs/<slug>/`}</span>, registers the project +
            default policy + Claude Code hook entries.
          </>
        }
      />

      {props.errorMessage !== undefined ? (
        <div className="mb-8">
          <Banner kind="error" {...(props.errorCode !== undefined ? { code: props.errorCode } : {})}>
            {props.errorMessage}
          </Banner>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_minmax(0,1fr)_280px]">
        {/* Left: progress */}
        <aside className="flex flex-col gap-4">
          <Card size="md">
            <Section title={<>Progress</>} compact>
              <div className="flex flex-col">
                <Step n={1} title="Project details" subtitle="cwd · slug" state={stepStateOf(1, currentStep)} />
                <Step n={2} title="Configuration" subtitle="IDE · template" state={stepStateOf(2, currentStep)} />
                <Step n={3} title="Review" subtitle="confirm + create" state={stepStateOf(3, currentStep)} />
              </div>
            </Section>
          </Card>
          <Card size="md" tone="info">
            <Section
              title={
                <>
                  What's <em>next</em>?
                </>
              }
              compact
            >
              <p className="font-mono text-[11px] tracking-[0.04em] leading-[1.6] text-text-tertiary">
                We'll set up your project, scaffold the structure, register the default policy + Claude Code hooks.
              </p>
            </Section>
          </Card>
        </aside>

        {/* Center: form */}
        <form action={props.action} className="flex flex-col gap-5">
          <Card size="lg">
            <FieldRow
              label="Project root (cwd)"
              required
              helper="Absolute path. Must contain package.json, pyproject.toml, Cargo.toml, or .git."
              valid={cwd.length > 0 ? cwdValid : undefined}
            >
              <FormInput
                id="init-cwd"
                name="cwd"
                value={cwd}
                onChange={setCwd}
                placeholder="/Users/you/projects/my-app"
                required
                valid={cwd.length > 0 ? cwdValid : undefined}
              />
            </FieldRow>

            <FieldRow
              label="Project slug"
              required
              helper="Lowercase letters, digits, underscores, hyphens. 1–64 characters."
              valid={slug.length > 0 ? slugValid : undefined}
            >
              <FormInput
                id="init-slug"
                name="projectSlug"
                value={slug}
                onChange={setSlug}
                placeholder="my-app"
                required
                pattern="[a-z0-9_-]+"
                maxLength={64}
                valid={slug.length > 0 ? slugValid : undefined}
              />
            </FieldRow>

            <FieldRow
              label="IDE to wire"
              required
              helper="claude wires ~/.claude/settings.json hooks. cursor + windsurf land in M07. all wires every IDE detected."
              valid
            >
              <FormSelect id="init-ide" name="ide" value={ide} onChange={setIde}>
                {props.ides.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </FormSelect>
            </FieldRow>

            <FieldRow
              label="Feature-pack template"
              helper="Optional starter template for the auto-marker sections. Skipping = minimal skeleton."
            >
              <FormSelect id="init-template" name="template" value={template} onChange={setTemplate}>
                {props.templates.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </FormSelect>
            </FieldRow>

            <div className="border border-rule">
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                aria-expanded={advancedOpen}
                className="flex w-full items-center gap-2 px-4 py-3 font-mono text-[10px] uppercase tracking-[0.18em] text-text-primary transition-colors hover:bg-bg-hover"
              >
                <ChevronDownIcon
                  className={`h-3 w-3 text-text-tertiary transition-transform ${advancedOpen ? '' : '-rotate-90'}`}
                />
                Advanced options
              </button>
              {advancedOpen ? (
                <div className="border-t border-rule px-4 py-3">
                  <label
                    htmlFor="init-noGraphify"
                    className="flex items-start gap-3 font-mono text-[11px] tracking-[0.04em] text-text-tertiary"
                  >
                    <input
                      id="init-noGraphify"
                      name="noGraphify"
                      type="checkbox"
                      defaultChecked
                      className="mt-0.5 h-3.5 w-3.5 cursor-pointer border-rule-strong bg-bg-base accent-accent"
                    />
                    <span>
                      <span className="font-medium text-text-primary">Skip Graphify scan</span>{' '}
                      <span className="text-text-muted">
                        — default. Graphify producer is deferred per ADR-010 Slice 11; install graphify CLI separately.
                      </span>
                    </span>
                  </label>
                </div>
              ) : null}
            </div>
          </Card>

          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" leftIcon={<RocketIcon className="h-3 w-3" />}>
              Provision project
            </Button>
            <Link
              href="/"
              className="inline-flex h-(--button-height) items-center border border-rule-strong px-5 font-mono text-[10px] uppercase tracking-[0.18em] text-text-tertiary transition-colors hover:border-text-primary hover:text-text-primary"
            >
              Cancel
            </Link>
          </div>
        </form>

        {/* Right: outcomes */}
        <aside className="flex flex-col gap-4">
          <Card size="md">
            <Section
              title={
                <>
                  What this <em>will do</em>
                </>
              }
              compact
            >
              <Outcome title="Create project" body="Registers your project and sets up the basic structure." />
              <Outcome title="Scaffold structure" body="Creates data.db and docs/feature-packs/." />
              <Outcome title="Configure policies" body="Applies default policy and Claude Code hooks." />
              <Outcome title="Ready to develop" body="Project ready in seconds. Next session auto-injects the pack." />
            </Section>
          </Card>
        </aside>
      </div>
    </PageShell>
  );
}

/* ───────────────────────── Wizard steps ───────────────────────── */

type StepState = 'done' | 'active' | 'upcoming';

function stepStateOf(n: 1 | 2 | 3, current: 1 | 2 | 3): StepState {
  if (n < current) return 'done';
  if (n === current) return 'active';
  return 'upcoming';
}

function Step({
  n,
  title,
  subtitle,
  state,
}: {
  readonly n: number;
  readonly title: string;
  readonly subtitle: string;
  readonly state: StepState;
}) {
  const numCls =
    state === 'active'
      ? 'border-accent text-accent'
      : state === 'done'
        ? 'border-accent/60 text-accent/60'
        : 'border-rule-strong text-text-muted';
  const titleCls = state === 'upcoming' ? 'text-text-muted' : 'text-text-primary';
  return (
    <div className="flex items-center gap-3 border-b border-rule py-3 last:border-b-0">
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center border font-mono text-[10px] tracking-[0.04em] ${numCls}`}
      >
        {state === 'done' ? <CheckIcon className="h-3 w-3" /> : n}
      </span>
      <div className="flex flex-col">
        <span className={`font-mono text-[11px] tracking-[0.04em] ${titleCls}`}>{title}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">{subtitle}</span>
      </div>
    </div>
  );
}

/* ───────────────────────── Field row ───────────────────────── */

function FieldRow({
  label,
  required,
  helper,
  valid,
  children,
}: {
  readonly label: string;
  readonly required?: boolean;
  readonly helper?: React.ReactNode;
  readonly valid?: boolean | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-rule pb-5 last:border-b-0">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
          {label}
          {required === true ? <span className="ml-1 text-status-error">*</span> : null}
        </span>
        {valid === true ? (
          <StatPill tone="ok" dot>
            valid
          </StatPill>
        ) : valid === false ? (
          <StatPill tone="warn" dot>
            invalid
          </StatPill>
        ) : null}
      </div>
      {children}
      {helper !== undefined ? (
        <p className="font-mono text-[10px] tracking-[0.05em] text-text-muted">{helper}</p>
      ) : null}
    </div>
  );
}

function FormInput({
  id,
  name,
  value,
  onChange,
  placeholder,
  required,
  pattern,
  maxLength,
  valid,
}: {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly pattern?: string;
  readonly maxLength?: number;
  readonly valid?: boolean | undefined;
}) {
  const borderCls =
    valid === false
      ? 'border-status-error focus:border-status-error'
      : valid === true
        ? 'border-accent focus:border-accent'
        : 'border-rule-strong focus:border-accent';
  return (
    <input
      id={id}
      name={name}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      required={required}
      pattern={pattern}
      maxLength={maxLength}
      className={`h-(--input-height) w-full border bg-bg-base px-3.5 font-mono text-[12px] tracking-[0.04em] text-text-primary placeholder:text-text-muted transition-colors hover:border-text-tertiary focus-visible:outline-none ${borderCls}`}
    />
  );
}

function FormSelect({
  id,
  name,
  value,
  onChange,
  children,
}: {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <select
        id={id}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-(--input-height) w-full appearance-none border border-rule-strong bg-bg-base px-3.5 pr-10 font-mono text-[12px] tracking-[0.04em] text-text-primary transition-colors hover:border-text-tertiary focus-visible:outline-none focus:border-accent"
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-3 w-3 -translate-y-1/2 text-text-tertiary" />
    </div>
  );
}

/* ───────────────────────── Outcome (right sidebar) ───────────────────────── */

function Outcome({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-rule py-3 last:border-b-0">
      <span className="font-mono text-[11px] tracking-[0.04em] text-text-primary">{title}</span>
      <span className="font-mono text-[10px] tracking-[0.04em] text-text-muted leading-[1.5]">{body}</span>
    </div>
  );
}
