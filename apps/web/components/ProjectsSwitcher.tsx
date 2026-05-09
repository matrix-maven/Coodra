'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ProjectStatusDotKind } from '@/components/StatusDot';

/**
 * `apps/web/components/ProjectsSwitcher.tsx` — quick project switcher
 * for the editorial Topbar. Native `<select>` styled square / mono.
 */

export interface ProjectsSwitcherOption {
  readonly slug: string;
  readonly statusDot: ProjectStatusDotKind;
}

export interface ProjectsSwitcherProps {
  readonly currentSlug: string;
  readonly options: ReadonlyArray<ProjectsSwitcherOption>;
}

export function ProjectsSwitcher({ currentSlug, options }: ProjectsSwitcherProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <label htmlFor="project-switcher" className="flex items-center gap-2">
      <span className="eyebrow text-text-muted">Switch</span>
      <select
        id="project-switcher"
        value={currentSlug}
        onChange={(e) => {
          const next = e.target.value;
          if (next === currentSlug) return;
          setPending(true);
          router.push(`/projects/${encodeURIComponent(next)}` as never);
        }}
        disabled={pending}
        className="h-8 border border-rule-strong bg-bg-base px-3 pr-8 font-mono text-[11px] text-text-primary transition-colors duration-150 hover:border-text-tertiary focus-visible:outline-none focus:border-accent"
      >
        {options.map((opt) => (
          <option key={opt.slug} value={opt.slug}>
            {opt.slug}
          </option>
        ))}
      </select>
    </label>
  );
}
