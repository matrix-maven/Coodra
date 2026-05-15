'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * `apps/web/components/Sidebar.tsx` — editorial left navigation.
 *
 * 248px sticky sidebar. Brand mark + Coodra wordmark + mode badge
 * at the top. Project pill (when inside a project). Grouped nav with
 * mono uppercase group labels — Workspace · Audit · Govern · Knowledge ·
 * System — phosphor active border, faint hover. User avatar at the bottom.
 */

import {
  ActivityIcon,
  BookIcon,
  BoxIcon,
  CommandIcon,
  DatabaseIcon,
  GraphIcon,
  HelpCircleIcon,
  LayersIcon,
  LayoutIcon,
  PauseIcon,
  RefreshIcon,
  ScrollIcon,
  SettingsIcon,
  ShieldIcon,
} from './ui/icons';

export interface SidebarProps {
  /** User mode badge — shown at the top right of the brand row. */
  readonly mode?: 'solo' | 'team';
  /** Slot for user/auth controls at the very bottom (UserButton in team mode). */
  readonly footerSlot?: ReactNode;
}

function projectFromPath(pathname: string): { slug: string } | null {
  if (!pathname.startsWith('/projects/')) return null;
  const tail = pathname.slice('/projects/'.length);
  const slug = tail.split('/').filter(Boolean)[0];
  if (slug === undefined || slug.length === 0) return null;
  return { slug: decodeURIComponent(slug) };
}

interface NavItem {
  readonly label: string;
  readonly href: string;
  readonly icon: ReactNode;
  readonly count?: string | number;
  readonly subdued?: boolean;
}

interface NavGroup {
  readonly label: string;
  readonly items: ReadonlyArray<NavItem>;
}

const ICON_CLASS = 'h-4 w-4 shrink-0 opacity-90';

const WORKSPACE_GROUPS: ReadonlyArray<NavGroup> = [
  {
    label: 'Workspace',
    items: [{ label: 'Projects', href: '/', icon: <LayoutIcon className={ICON_CLASS} /> }],
  },
  {
    label: 'System',
    items: [
      { label: 'Sync queue', href: '/sync', icon: <RefreshIcon className={ICON_CLASS} /> },
      { label: 'Workspace', href: '/settings/workspace', icon: <DatabaseIcon className={ICON_CLASS} /> },
      { label: 'Settings', href: '/settings/account', icon: <SettingsIcon className={ICON_CLASS} /> },
    ],
  },
];

function projectGroups(slug: string): ReadonlyArray<NavGroup> {
  const base = `/projects/${encodeURIComponent(slug)}`;
  return [
    {
      label: 'Workspace',
      items: [{ label: 'Overview', href: base, icon: <LayoutIcon className={ICON_CLASS} /> }],
    },
    {
      label: 'Audit',
      items: [
        { label: 'Runs', href: `${base}/runs`, icon: <ActivityIcon className={ICON_CLASS} /> },
        { label: 'Context graph', href: `${base}/graph`, icon: <GraphIcon className={ICON_CLASS} /> },
      ],
    },
    {
      label: 'Govern',
      items: [
        { label: 'Policies', href: `${base}/policies`, icon: <ShieldIcon className={ICON_CLASS} /> },
        { label: 'Kill switches', href: `${base}/kill-switches`, icon: <PauseIcon className={ICON_CLASS} /> },
      ],
    },
    {
      label: 'Knowledge',
      items: [
        { label: 'Feature packs', href: `${base}/packs`, icon: <BoxIcon className={ICON_CLASS} /> },
        { label: 'Context packs', href: `${base}/context-packs`, icon: <LayersIcon className={ICON_CLASS} /> },
        { label: 'Templates', href: `${base}/templates`, icon: <BookIcon className={ICON_CLASS} /> },
      ],
    },
    {
      label: 'System',
      items: [
        { label: 'Doctor', href: `${base}/doctor`, icon: <CommandIcon className={ICON_CLASS} /> },
        { label: 'Logs', href: `${base}/logs`, icon: <ScrollIcon className={ICON_CLASS} /> },
        { label: 'Project settings', href: `${base}/settings`, icon: <SettingsIcon className={ICON_CLASS} /> },
      ],
    },
  ];
}

export function Sidebar({ mode, footerSlot }: SidebarProps) {
  const pathname = usePathname();
  const project = projectFromPath(pathname);
  const groups = project !== null ? projectGroups(project.slug) : WORKSPACE_GROUPS;
  const modeLabel = (mode ?? 'solo').toUpperCase();

  return (
    <aside className="sticky top-0 z-20 flex h-screen w-(--sidebar-width) shrink-0 flex-col border-r border-rule bg-bg-sidebar">
      {/* Brand · mark + word + mode chip */}
      <div className="flex items-center gap-3 border-b border-rule px-6 py-7">
        <Link href="/" aria-label="Coodra home" className="flex items-center gap-3">
          <BrandMark />
          <span className="font-sans text-[16px] font-semibold tracking-tight text-text-primary">Coodra</span>
        </Link>
        <span
          className="ml-auto border border-accent px-1.5 py-[3px] font-mono text-[9px] font-medium uppercase tracking-[0.18em] text-accent"
          title={`Mode ${modeLabel}`}
        >
          {modeLabel}
        </span>
      </div>

      {/* Project pill · only inside a project */}
      {project !== null ? (
        <div className="border-b border-rule px-6 pt-5 pb-4">
          <div className="eyebrow mb-2.5 text-text-muted">Project</div>
          <Link
            href={`/projects/${encodeURIComponent(project.slug)}` as never}
            className="group flex items-center gap-2.5 border border-rule-strong px-3 py-2.5 transition-colors hover:border-accent"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              className="text-text-secondary"
              aria-hidden="true"
            >
              <path d="M3 7l9-4 9 4-9 4-9-4z" />
              <path d="M3 12l9 4 9-4" />
              <path d="M3 17l9 4 9-4" />
            </svg>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-medium text-text-primary">{project.slug}</div>
              <div className="truncate font-mono text-[10px] tracking-[0.06em] text-text-tertiary">project · main</div>
            </div>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-text-tertiary"
              aria-hidden="true"
            >
              <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />
            </svg>
          </Link>
        </div>
      ) : null}

      {/* Scrollable nav · grouped */}
      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 py-5">
        {groups.map((group) => (
          <NavSection key={group.label} label={group.label}>
            {group.items.map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} />
            ))}
          </NavSection>
        ))}
      </nav>

      {/* Footer · user / auth */}
      <div className="border-t border-rule px-3 py-3">
        <NavLink
          item={{
            label: 'Help · docs',
            href: 'https://github.com/anthropics/claude-code',
            icon: <HelpCircleIcon className={ICON_CLASS} />,
            subdued: true,
          }}
          pathname={pathname}
          external
        />
        <div className="mt-3 border-t border-rule px-3 pt-3">{footerSlot ?? <UserPanel mode={mode ?? 'solo'} />}</div>
      </div>
    </aside>
  );
}

function NavSection({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="mb-6">
      <div className="eyebrow mb-2 px-3 text-text-muted">{label}</div>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

function NavLink({
  item,
  pathname,
  external,
}: {
  readonly item: NavItem;
  readonly pathname: string;
  readonly external?: boolean;
}) {
  const isActive =
    !external &&
    (item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(`${item.href}/`));
  const wrapperCls = `flex items-center gap-2.5 border-l-2 px-3 py-2.5 text-[13px] tracking-[-0.005em] transition-colors duration-150 ${
    isActive
      ? 'border-l-accent bg-brand-soft text-text-primary'
      : `border-l-transparent ${item.subdued ? 'text-text-tertiary' : 'text-text-tertiary'} hover:bg-bg-hover hover:text-text-primary`
  }`;
  const iconCls = isActive ? 'text-accent' : 'text-text-tertiary';
  const inner = (
    <>
      <span className={iconCls}>{item.icon}</span>
      <span className="truncate">{item.label}</span>
      {item.count !== undefined ? (
        <span
          className={`ml-auto font-mono text-[10px] tracking-[0.04em] ${isActive ? 'text-accent' : 'text-text-muted'}`}
        >
          {item.count}
        </span>
      ) : null}
    </>
  );

  if (external === true) {
    return (
      <a href={item.href} target="_blank" rel="noopener noreferrer" className={wrapperCls}>
        {inner}
      </a>
    );
  }

  return (
    <li>
      <Link href={item.href as never} aria-current={isActive ? 'page' : undefined} className={wrapperCls}>
        {inner}
      </Link>
    </li>
  );
}

function UserPanel({ mode }: { readonly mode: 'solo' | 'team' }) {
  return (
    <div className="flex items-center gap-3">
      <Avatar />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px] leading-[1.2] text-text-primary">
          {mode === 'solo' ? 'Local user' : 'Workspace'}
        </span>
        <span className="truncate font-mono text-[9px] uppercase tracking-[0.15em] text-text-muted">
          {mode === 'solo' ? 'Local · MIT' : 'Team mode'}
        </span>
      </div>
    </div>
  );
}

function Avatar() {
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent font-mono text-[11px] font-semibold text-bg-base">
      L
    </div>
  );
}

function BrandMark() {
  return (
    <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center">
      <svg viewBox="0 0 32 32" fill="none" className="h-7 w-7" aria-hidden="true">
        <circle cx="16" cy="16" r="14" stroke="#7dd87d" strokeWidth="1" />
        <circle cx="16" cy="16" r="2.2" fill="#7dd87d" />
        <line x1="2" y1="16" x2="30" y2="16" stroke="#e8e6e1" strokeWidth="0.6" strokeDasharray="2 3" />
      </svg>
    </span>
  );
}
