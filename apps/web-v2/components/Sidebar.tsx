'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

import { BrandMark } from '@/components/BrandMark';

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly count?: string | number;
  readonly icon: React.ReactNode;
  readonly indent?: boolean;
}

interface NavGroup {
  readonly label: string;
  readonly items: ReadonlyArray<NavItem>;
}

interface SidebarProps {
  readonly mode: 'solo' | 'team';
  /**
   * Deployment-mode hint used to hide nav items that map to local-only
   * pages (which 404 on team-hosted servers): /sync, /workspace,
   * /onboarding/*, etc.
   *
   *   - undefined           → unknown, default to local behaviour
   *   - 'local-solo'        → solo defaults
   *   - 'local-team'        → team defaults with local-only pages visible
   *   - 'team-hosted'       → team defaults with local-only pages hidden
   */
  readonly deploymentMode?: 'local-solo' | 'local-team' | 'team-hosted';
  readonly userInitial?: string;
  readonly userName?: string;
  readonly userRole?: string;
  readonly projects: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  /** In team mode, the org slug (or org_id fallback) shown in the header. Null in solo. */
  readonly orgSlug?: string | null;
  /** In team mode, viewer's Clerk user id used for "you" attribution; passed through. */
  readonly viewerUserId?: string | null;
  /**
   * Optional footer slot. When set, replaces the default hardcoded
   * "user · role" pill with whatever the layout chose to render —
   * typically Clerk's `<UserButton />` + `<OrganizationSwitcher />`
   * in team-hosted mode. The layout owns the conditional Clerk
   * import so this client component doesn't have to.
   */
  readonly footerSlot?: React.ReactNode;
}

export function Sidebar({
  mode,
  deploymentMode,
  userInitial = 'A',
  userName = 'abishaikc',
  userRole = 'Local · MIT',
  projects,
  orgSlug = null,
  viewerUserId = null,
  footerSlot,
}: SidebarProps) {
  // viewerUserId is forwarded by the layout but the sidebar doesn't render
  // it directly (page-level components consume it). Reference it once so
  // typescript doesn't complain about the unused-prop pattern.
  void viewerUserId;
  // Rules-of-Hooks (React 19 strict, 2026-05-11 fix): every hook MUST
  // be called unconditionally on every render. Pre-fix the `useSearchParams()`
  // call lived AFTER the `if (isPublicPath) return null;` guard, so on
  // routes that flipped between public and authed (e.g. sign-in →
  // dashboard via Clerk redirect) the hook count differed between
  // renders, triggering React's "change in the order of Hooks" console
  // error. Lift every hook above any conditional return.
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();

  // Pre-auth pages — sign-in, sign-up, forbidden, install/<token> — must
  // not render the team-workspace sidebar. A signed-out visitor on
  // /auth/sign-in shouldn't see "Team workspace · Cloud — org pending"
  // (broken header) plus all the audit nav links they can't actually
  // reach yet. Match the same matchers the middleware treats as public.
  const isPublicPath =
    pathname.startsWith('/auth') || pathname.startsWith('/forbidden') || pathname.startsWith('/install');
  if (isPublicPath) return null;

  // Resolve the project shown in the pill: URL slug if we're under
  // /projects/[slug]/*, else carry the ?project= query if present (so
  // navigating from Runs → Policies preserves the project), else NO
  // project highlighted (do NOT default to projects[0] — that produced
  // the visible bug where clicking through to /runs from a project home
  // made the sidebar pill jump to the alphabetically-first project).
  //
  // useSearchParams is SSR-safe + reactive: server renders with the
  // request URL's query, client re-renders on navigation. Avoids the
  // hydration-mismatch trap of reading `window.location.search`.
  const projectMatch = /^\/projects\/([^/]+)/.exec(pathname);
  const urlSlug = projectMatch ? decodeURIComponent(projectMatch[1] ?? '') : null;
  const queryProject = searchParams?.get('project') ?? null;
  const activeSlug = urlSlug ?? queryProject;
  // When no project is in scope, render a "no project" pill rather than
  // silently picking projects[0]. The UI must reflect what the URL says.
  const activeProject =
    activeSlug !== null
      ? (projects.find((p) => p.slug === activeSlug) ?? { slug: activeSlug, name: activeSlug })
      : { slug: '—', name: 'All projects' };

  // When inside a project context, scope the audit / govern / knowledge
  // links to that project so clicking "Runs" while in /projects/taskforge
  // lands on /runs?project=taskforge instead of the global runs list.
  const scope = activeSlug !== null ? `?project=${encodeURIComponent(activeSlug)}` : '';

  // Sidebar groups differ structurally by mode so the user can see at a
  // glance what surfaces apply to them.
  //
  //   Solo mode (one developer, one machine):
  //     · No "Team" group. /settings/team 404s in solo anyway.
  //     · "Sync queue" hidden — solo has no outbox to drain.
  //     · "Setup" group offers an explicit upgrade-to-team CTA.
  //
  //   Team mode (multiple developers, shared org):
  //     · A dedicated "Team" group surfacing /settings/team and member-aware reads.
  //     · Sync queue visible (it's the heartbeat of cross-machine consistency).
  //     · "Setup" group is just diagnostics + mode-switch.
  // In team-hosted mode, several nav items 404 because the page they
  // point at is inherently local-laptop (see app/sync/page.tsx,
  // app/workspace/page.tsx). Hide them from the menu so users don't
  // click into a 404.
  const isHosted = deploymentMode === 'team-hosted';

  const teamGroupItems: NavItem[] = [{ href: '/settings/team', label: 'Members + org', icon: <IconUsers /> }];
  if (!isHosted) {
    teamGroupItems.push({ href: '/sync', label: 'Sync queue', icon: <IconSync /> });
  }

  const teamSystemItems: NavItem[] = [];
  if (!isHosted) {
    teamSystemItems.push({ href: '/workspace', label: 'Workspace', icon: <IconRack /> });
  }
  teamSystemItems.push({ href: '/settings', label: 'Settings', icon: <IconCog /> });
  teamSystemItems.push({ href: '/welcome', label: 'Welcome', icon: <IconSwitch /> });

  const groups: ReadonlyArray<NavGroup> =
    mode === 'team'
      ? [
          {
            label: 'Workspace',
            items: [
              { href: '/', label: 'Dashboard', icon: <IconDashboard /> },
              { href: '/roi', label: 'ROI', icon: <IconChart /> },
              { href: '/projects', label: 'Projects', icon: <IconStack /> },
            ],
          },
          { label: 'Team', items: teamGroupItems },
          {
            label: 'Audit',
            items: [
              { href: `/runs${scope}`, label: 'Runs', icon: <IconLedger /> },
              { href: `/decisions${scope}`, label: 'Decisions', icon: <IconLedger /> },
              { href: `/context-packs${scope}`, label: 'Context packs', icon: <IconPack /> },
            ],
          },
          {
            label: 'Govern',
            items: [
              { href: `/policies${scope}`, label: 'Policies', icon: <IconShield /> },
              { href: `/kill-switches${scope}`, label: 'Kill switches', icon: <IconKill /> },
            ],
          },
          {
            label: 'Knowledge',
            items: [
              { href: '/packs', label: 'Feature packs', icon: <IconPack /> },
              { href: '/features', label: 'Features', icon: <IconLedger /> },
              { href: '/wiki', label: 'Deep Wiki', icon: <IconGrid /> },
              { href: '/templates', label: 'Templates', icon: <IconGrid /> },
            ],
          },
          { label: 'System', items: teamSystemItems },
        ]
      : [
          {
            label: 'Workspace',
            items: [
              { href: '/', label: 'Dashboard', icon: <IconDashboard /> },
              { href: '/roi', label: 'ROI', icon: <IconChart /> },
              { href: '/projects', label: 'Projects', icon: <IconStack /> },
            ],
          },
          {
            label: 'Audit',
            items: [
              { href: `/runs${scope}`, label: 'Runs', icon: <IconLedger /> },
              { href: `/decisions${scope}`, label: 'Decisions', icon: <IconLedger /> },
              { href: `/context-packs${scope}`, label: 'Context packs', icon: <IconPack /> },
            ],
          },
          {
            label: 'Govern',
            items: [
              { href: `/policies${scope}`, label: 'Policies', icon: <IconShield /> },
              { href: `/kill-switches${scope}`, label: 'Kill switches', icon: <IconKill /> },
            ],
          },
          {
            label: 'Knowledge',
            items: [
              { href: '/packs', label: 'Feature packs', icon: <IconPack /> },
              { href: '/features', label: 'Features', icon: <IconLedger /> },
              { href: '/wiki', label: 'Deep Wiki', icon: <IconGrid /> },
              { href: '/templates', label: 'Templates', icon: <IconGrid /> },
            ],
          },
          {
            label: 'System',
            items: [
              { href: '/workspace', label: 'Workspace', icon: <IconRack /> },
              { href: '/settings', label: 'Settings', icon: <IconCog /> },
            ],
          },
          {
            label: 'Upgrade',
            items: [
              { href: '/welcome', label: 'About modes', icon: <IconStar /> },
              { href: '/onboarding/team', label: 'Create a team', icon: <IconUsers /> },
              { href: '/onboarding/team/join', label: 'Connect to existing', icon: <IconKey /> },
            ],
          },
        ];

  return (
    <aside className="side">
      <div className="side__brand">
        <BrandMark />
        <span className="side__brand-word">Coodra</span>
        <span
          className="side__brand-mode"
          style={mode === 'team' ? undefined : { color: 'var(--ink-mute)', borderColor: 'var(--rule-strong)' }}
        >
          {mode}
        </span>
      </div>

      {/* Mode-aware identity block. In solo: "Local · this machine".
          In team: org slug + status pill + link to /settings/team. The
          contrast is intentional — a team-mode user should never wonder
          which workspace they're looking at. */}
      <Link
        href={mode === 'team' ? '/settings/team' : '/welcome'}
        style={{
          display: 'block',
          padding: '14px 24px 16px',
          borderBottom: '1px solid var(--rule)',
          textDecoration: 'none',
          background: mode === 'team' ? 'rgba(125, 216, 125, 0.04)' : 'transparent',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: mode === 'team' ? 'var(--accent)' : 'var(--ink-mute)',
            marginBottom: 6,
          }}
        >
          {mode === 'team' ? '● Team workspace' : 'Solo workspace'}
        </div>
        <div
          style={{
            fontFamily: 'var(--serif)',
            fontSize: 18,
            fontWeight: 400,
            letterSpacing: '-0.005em',
            color: 'var(--ink)',
            lineHeight: 1.2,
          }}
        >
          {mode === 'team' && orgSlug !== null
            ? truncateMiddle(orgSlug, 24)
            : mode === 'team'
              ? 'Cloud — org pending'
              : 'This machine'}
        </div>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.06em',
            color: 'var(--ink-mute)',
            marginTop: 4,
          }}
        >
          {mode === 'team' ? 'syncing every 10 s · click for members' : '~/.coodra/data.db · click to upgrade'}
        </div>
      </Link>

      <div className="side__project">
        <div className="side__eyebrow">Project</div>
        {/* Native <details> dropdown — no React state, no hydration mismatch.
            Click the pill to expand a project list; pick any to switch. The
            previous implementation forced operators to navigate to /projects
            and click through a card to switch — three clicks for what should
            be one. */}
        <details className="side__project-picker" style={{ position: 'relative' }}>
          <summary
            className="side__project-pill"
            style={{ listStyle: 'none', cursor: 'pointer', textDecoration: 'none' }}
            title="Click to switch project"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              aria-hidden="true"
            >
              <path d="M3 7l9-4 9 4-9 4-9-4z" />
              <path d="M3 12l9 4 9-4" />
              <path d="M3 17l9 4 9-4" />
            </svg>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="side__project-name">{activeProject.name}</div>
              <div className="side__project-slug">{activeProject.slug}</div>
            </div>
            <svg
              className="side__caret"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />
            </svg>
          </summary>
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              marginTop: 6,
              background: 'var(--bg)',
              border: '1px solid var(--rule-strong)',
              padding: '8px 0',
              maxHeight: 320,
              overflowY: 'auto',
              zIndex: 50,
            }}
          >
            <Link
              href="/projects"
              style={{
                display: 'block',
                padding: '8px 14px',
                textDecoration: 'none',
                color: 'var(--ink-mute)',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                letterSpacing: '0.06em',
                borderBottom: '1px solid var(--rule)',
              }}
            >
              ← all projects
            </Link>
            {projects.length === 0 ? (
              <div
                style={{
                  padding: '12px 14px',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: 'var(--ink-mute)',
                  letterSpacing: '0.04em',
                }}
              >
                No projects yet. Run <code>coodra init</code>.
              </div>
            ) : (
              projects.map((p) => {
                const isCurrent = p.slug === activeProject.slug;
                return (
                  <Link
                    key={p.slug}
                    href={`/projects/${encodeURIComponent(p.slug)}`}
                    style={{
                      display: 'block',
                      padding: '8px 14px',
                      textDecoration: 'none',
                      background: isCurrent ? 'var(--bg-2)' : 'transparent',
                      color: isCurrent ? 'var(--accent)' : 'var(--ink)',
                      fontFamily: 'var(--mono)',
                      fontSize: 12,
                      letterSpacing: '0.04em',
                    }}
                  >
                    {isCurrent ? '● ' : '○ '}
                    {p.slug}
                  </Link>
                );
              })
            )}
          </div>
        </details>
        {activeSlug !== null ? (
          <Link
            href="/projects"
            className="side__project-slug"
            style={{ display: 'block', marginTop: 8, textDecoration: 'none', color: 'var(--ink-mute)' }}
          >
            ← all projects
          </Link>
        ) : null}
      </div>

      <nav className="side__nav">
        {groups.map((group) => (
          <div key={group.label} className="side__group">
            <div className="side__group-label">{group.label}</div>
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link key={item.href} href={item.href} className={`side__link${active ? ' is-active' : ''}`}>
                  {item.icon}
                  {item.label}
                  {item.count !== undefined ? <span className="side__link-count">{item.count}</span> : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="side__foot">
        {footerSlot !== undefined ? (
          footerSlot
        ) : (
          <>
            <div className="side__avatar">{userInitial}</div>
            <div className="side__user">
              <div className="side__user-name">{userName}</div>
              <div className="side__user-role">{userRole}</div>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Collapse long org slugs / clerk ids so they fit the 248px sidebar without wrapping. */
function truncateMiddle(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  const half = Math.floor((maxLen - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}

/* ---------- Icons (1.4 stroke, 24x24, sized via .side__link svg) ---------- */
function IconDashboard() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" />
      <rect x="14" y="3" width="7" height="5" />
      <rect x="14" y="12" width="7" height="9" />
      <rect x="3" y="16" width="7" height="5" />
    </svg>
  );
}
function IconChart() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <rect x="7" y="12" width="3" height="5" />
      <rect x="12" y="8" width="3" height="9" />
      <rect x="17" y="5" width="3" height="12" />
    </svg>
  );
}
function IconStack() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M3 7l9-4 9 4-9 4-9-4z" />
      <path d="M3 12l9 4 9-4" />
      <path d="M3 17l9 4 9-4" />
    </svg>
  );
}
function IconLedger() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <circle cx="6.5" cy="6.5" r="0.6" fill="currentColor" />
    </svg>
  );
}
function IconShield() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7l8-4z" />
    </svg>
  );
}
function IconKill() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="3" x2="12" y2="13" />
    </svg>
  );
}
function IconPack() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M4 5h16v14H4z" />
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="9" y1="5" x2="9" y2="19" />
    </svg>
  );
}
function IconGrid() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="3" y="3" width="8" height="8" />
      <rect x="13" y="3" width="8" height="8" />
      <rect x="3" y="13" width="8" height="8" />
      <rect x="13" y="13" width="8" height="8" />
    </svg>
  );
}
function IconRack() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="4" y="6" width="16" height="12" />
      <line x1="4" y1="10" x2="20" y2="10" />
      <circle cx="7" cy="8" r="0.6" fill="currentColor" />
    </svg>
  );
}
function IconSync() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M4 12a8 8 0 0114-5.3M20 12a8 8 0 01-14 5.3" />
      <path d="M16 6h4V2M8 18H4v4" />
    </svg>
  );
}
function IconCog() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 01-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1A1.7 1.7 0 004.5 9a1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 012.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 012.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </svg>
  );
}
function IconUsers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19c0-3.5 2.7-6 6-6s6 2.5 6 6" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M21 19c0-2.6-1.7-4.5-4-5" />
    </svg>
  );
}
function IconStar() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M12 3l2.6 6 6.4.6-4.9 4.4 1.5 6.4L12 17l-5.6 3.4 1.5-6.4L3 9.6 9.4 9 12 3z" />
    </svg>
  );
}
function IconSwitch() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M4 7h12l-3-3M20 17H8l3 3" />
    </svg>
  );
}
function IconKey() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="8" cy="14" r="3.5" />
      <path d="M11 14h10v4M17 14v4" />
    </svg>
  );
}
