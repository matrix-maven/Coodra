'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * `apps/web/components/Sidebar.tsx` — persistent left navigation
 * (full UI redesign).
 *
 * Always-visible 248px sidebar with:
 *   - Brand mark at top
 *   - Workspace section (Projects, New project, Sync, Settings)
 *   - Optional Project section (when inside /projects/[slug]/*)
 *
 * Active item is highlighted with brand-soft bg + brand-color text.
 * Hover state lifts the background to elevated. The sidebar is a
 * client component so it can use usePathname() for active highlighting
 * without prop drilling.
 */

import {
  ActivityIcon,
  BookIcon,
  BoxIcon,
  CommandIcon,
  DatabaseIcon,
  GaugeIcon,
  GraphIcon,
  LayersIcon,
  LayoutIcon,
  PauseIcon,
  PlusIcon,
  RefreshIcon,
  ScrollIcon,
  SettingsIcon,
  ShieldIcon,
} from './ui/icons';

export interface SidebarProps {
  /** User mode badge — shown at the bottom. */
  readonly mode?: 'solo' | 'team';
  /** Slot for user/auth controls at the very bottom (UserButton in team mode). */
  readonly footerSlot?: ReactNode;
}

/**
 * Derive the active project slug from the current pathname.
 * `/projects/foo` and `/projects/foo/runs/abc` both resolve to `foo`.
 * Anything outside `/projects/*` returns null and the project section
 * stays hidden.
 */
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
  readonly comingSoon?: boolean;
}

const ICON_CLASS = 'h-4 w-4 shrink-0';

const WORKSPACE_NAV: ReadonlyArray<NavItem> = [
  { label: 'Projects', href: '/', icon: <LayoutIcon className={ICON_CLASS} /> },
  { label: 'New project', href: '/init', icon: <PlusIcon className={ICON_CLASS} /> },
  { label: 'Sync', href: '/sync', icon: <RefreshIcon className={ICON_CLASS} /> },
  { label: 'Settings', href: '/settings/workspace', icon: <SettingsIcon className={ICON_CLASS} /> },
];

function projectNav(slug: string): ReadonlyArray<NavItem> {
  const base = `/projects/${encodeURIComponent(slug)}`;
  return [
    { label: 'Overview', href: base, icon: <GaugeIcon className={ICON_CLASS} /> },
    { label: 'Runs', href: `${base}/runs`, icon: <ActivityIcon className={ICON_CLASS} /> },
    { label: 'Policies', href: `${base}/policies`, icon: <ShieldIcon className={ICON_CLASS} /> },
    { label: 'Feature packs', href: `${base}/packs`, icon: <BoxIcon className={ICON_CLASS} /> },
    { label: 'Context packs', href: `${base}/context-packs`, icon: <LayersIcon className={ICON_CLASS} /> },
    { label: 'Templates', href: `${base}/templates`, icon: <BookIcon className={ICON_CLASS} /> },
    { label: 'Kill switches', href: `${base}/kill-switches`, icon: <PauseIcon className={ICON_CLASS} /> },
    { label: 'Graph', href: `${base}/graph`, icon: <GraphIcon className={ICON_CLASS} /> },
    { label: 'Doctor', href: `${base}/doctor`, icon: <CommandIcon className={ICON_CLASS} /> },
    { label: 'Logs', href: `${base}/logs`, icon: <ScrollIcon className={ICON_CLASS} /> },
    { label: 'Project settings', href: `${base}/settings`, icon: <DatabaseIcon className={ICON_CLASS} /> },
  ];
}

export function Sidebar({ mode, footerSlot }: SidebarProps) {
  const pathname = usePathname();
  const project = projectFromPath(pathname);
  return (
    <aside className="sticky top-0 z-20 flex h-screen w-(--sidebar-width) shrink-0 flex-col border-r border-border-subtle bg-bg-sidebar">
      {/* Brand */}
      <div className="flex h-(--topbar-height) items-center gap-2 border-b border-border-subtle px-5">
        <Link
          href="/"
          aria-label="ContextOS home"
          className="flex items-center gap-2 font-display text-base font-semibold tracking-tight text-text-primary transition-colors duration-200 hover:text-brand"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand text-white">
            <BoltIcon className="h-4 w-4" />
          </span>
          <span>ContextOS</span>
        </Link>
      </div>

      {/* Scrollable nav area */}
      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 py-4">
        <NavSection label="Workspace">
          {WORKSPACE_NAV.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}
        </NavSection>

        {project !== null ? (
          <NavSection label={project.slug} mono>
            {projectNav(project.slug).map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} />
            ))}
          </NavSection>
        ) : null}
      </nav>

      {/* Footer */}
      <div className="border-t border-border-subtle p-3">
        {mode !== undefined ? (
          <div className="mb-2 flex items-center justify-between rounded-md bg-bg-elevated px-3 py-2 text-xs">
            <span className="text-text-secondary">Mode</span>
            <span className="font-mono font-medium uppercase text-text-primary">{mode}</span>
          </div>
        ) : null}
        {footerSlot}
      </div>
    </aside>
  );
}

function NavSection({
  label,
  children,
  mono,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly mono?: boolean;
}) {
  return (
    <div className="mb-6">
      <div
        className={`mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-text-tertiary uppercase ${
          mono === true ? 'font-mono normal-case tracking-tight' : ''
        }`}
      >
        {label}
      </div>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

function NavLink({ item, pathname }: { readonly item: NavItem; readonly pathname: string }) {
  // Active when the pathname equals the href OR (for non-root hrefs) starts with `${href}/`.
  // Special-case for `/` so it doesn't match every page.
  const isActive =
    item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(`${item.href}/`);
  const cls = isActive
    ? 'bg-brand-soft text-brand'
    : 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary';
  return (
    <li>
      <Link
        href={item.href as never}
        aria-current={isActive ? 'page' : undefined}
        className={`flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors duration-150 ${cls}`}
      >
        <span className={isActive ? 'text-brand' : 'text-text-tertiary'}>{item.icon}</span>
        <span className="truncate">{item.label}</span>
        {item.comingSoon === true ? (
          <span className="ml-auto rounded-sm bg-bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary">
            Soon
          </span>
        ) : null}
      </Link>
    </li>
  );
}

function BoltIcon({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M13 2L4.5 13.5h6L11 22l8.5-11.5h-6L13 2z" />
    </svg>
  );
}
