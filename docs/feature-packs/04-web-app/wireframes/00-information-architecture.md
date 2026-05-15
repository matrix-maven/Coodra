# M04 S0.5 — Information Architecture

> Per-route hierarchy, chrome conventions, mode-aware affordances, and breadcrumb scheme for `apps/web`. Token names cite `docs/brand/brand.md`. Read alongside `01-nav-map.md` (which encodes the same tree as a navigation surface) and `02-screens/*.md` (per-route ASCII wireframes).

## Page tree

```
/                                   Dashboard home (S9)
├─ /runs                            Run list (S3)
│  └─ /runs/[id]                    Run detail (S3)
│     └─ /runs/[id]/live            Live run (S4) — auto-redirects to detail on terminal
├─ /policies                        Policy list (S5)
│  └─ /policies/[id]                Policy detail + add-rule (S5)
├─ /projects                        Project list (S6)
│  └─ /projects/[id]                Project detail + reset (S6)
├─ /packs                           Feature pack list (S7)
│  └─ /packs/[slug]                 Pack detail (S7)
├─ /templates                       Template browser (S7)
├─ /kill-switches                   Kill-switch admin (S8b)
├─ /settings                        Settings hub (team only)
│  ├─ /settings/account             User profile (Clerk component)
│  └─ /settings/team                Org members + invites (Clerk component)
└─ /auth                            Auth surfaces (team only)
   ├─ /auth/sign-in                 Clerk-hosted sign-in
   └─ /auth/sign-up                 Clerk-hosted sign-up

/api/healthz                        200 ok (S1, no chrome)
/api/runs/[id]/state                Polling endpoint for live view (S4)
/api/kill-switches                  Write endpoints (S8b)
```

**Solo-mode pruning:** `/auth/*` and `/settings/team` return 404 in solo mode (per spec §9 + OQ-3 lock). Every other route renders without sign-in as the synthetic `__solo__` user. The org switcher in the chrome is replaced by a "Solo mode" badge.

## Breadcrumb scheme

The chrome's breadcrumb track is a single horizontal row, JetBrains Mono, between the global header and the page H1. Examples:

| Route | Breadcrumb |
|---|---|
| `/` | (no breadcrumb — home is the root) |
| `/runs` | `runs` |
| `/runs/[id]` | `runs / run_verify_1777830445` |
| `/runs/[id]/live` | `runs / run_verify_1777830445 / live` |
| `/policies/[id]` | `policies / __default__` |
| `/projects/[id]` | `projects / verify-m08b` |
| `/packs/[slug]` | `packs / 04-web-app` |
| `/kill-switches` | `kill-switches` |
| `/settings/team` | `settings / team` |

- Token: `--font-mono` at the brand's `body-sm` (12/16) size, `--color-text-secondary`. Separator is ` / ` (space-slash-space, NOT chevron — chevrons would visually conflict with the brand's right-angle aesthetic).
- Each segment is a clickable link to its parent route. The current segment is non-clickable, `--color-text-primary`.
- IDs and slugs render verbatim — no truncation, no ellipsis. Long IDs wrap to a second row on small viewports rather than truncate (run ids and slugs are dense information that the operator copies; truncation would force them to view the page source).

## Global chrome

Every page (except `/api/*` and `/auth/*`) renders inside a 3-row layout:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  HEADER  (sticky, full-width, --color-bg-elevated dark / surface light) │
├─────────────────────────────────────────────────────────────────────────┤
│  BREADCRUMB TRACK  (sticky, --color-bg-surface, single row)             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  PAGE CONTENT  (scrollable, max-width 1200px, centered)                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Header — left edge

```
[CTX]OS  ·  verify-m08b ▾
^^^^^^^     ^^^^^^^^^^^^^^
weight 900  weight 300, uppercase, --color-text-secondary
display      project switcher (solo: read-only badge; team: <OrganizationSwitcher/>)
```

- `[CTX]OS` is the wordmark — Inter 900, `--font-display`, brand-mandatory weight contrast (matches brand.md §5 typography). The brackets are part of the mark, not decorative; they invoke "CTX" as a captured token.
- Project switcher uses Inter 300 uppercase letterspacing 0.04em (brand's display setting). The `▾` indicates a dropdown in team mode; in solo it's omitted.

### Header — right edge

| Mode | Right edge contents |
|---|---|
| **Solo** | `Solo mode` badge (`<StatusChip status="neutral">`), `--color-status-neutral`. No avatar. No menu. |
| **Team** | `<OrganizationSwitcher/>` from `@clerk/nextjs` (org dropdown), then a 32px divider, then `<UserButton/>` (avatar + dropdown to Settings + Sign out). |

### Header — middle (top-level nav)

In viewports ≥ `md` (768px), the header carries the top-level nav inline:

```
Runs   Policies   Projects   Packs   Templates   Kill switches
```

- Each item is `<font-display>` weight 700, `--color-text-primary`, uppercase letterspacing 0.04em. Active route gets a 2px underline in `--color-brand`.
- On viewports < `md`, the inline nav collapses into a hamburger menu (`<MenuIcon/>` left of the wordmark — the only place we accept rounded geometry, and only because the icon ships rounded; we override with `border-radius: 0` on its host button).

## Mode-aware affordance summary

| Surface | Solo | Team |
|---|---|---|
| Header — project switcher | Read-only "verify-m08b" badge (project from `.coodra.json`) | `<OrganizationSwitcher/>` Clerk component, multiple orgs |
| Header — right edge | "Solo mode" `<StatusChip>` | Org switcher + UserButton |
| `/auth/*` routes | 404 (no sign-in screen) | Clerk-hosted sign-in / sign-up |
| `/settings/team` route | 404 | `<OrganizationProfile/>` Clerk component |
| Dashboard home — `Doctor` tile | Shells `coodra doctor --json` (cached 60s) | "Per-developer doctor; no cloud rollup" caption (per spec §11 dashboard mechanics) |
| Kill-switches form | Writes to local SQLite; banner: "Solo mode — pause is local only" | Writes to cloud Postgres; banner: "Pauses propagate to all developers within ~10s" |
| Run list, run detail, policies, projects, packs, templates | All render with the same shape; queries scope to the local project | Queries scope to the org's projects via Clerk `auth().orgId` + Postgres RLS |

## Empty states (consistent voice across the app)

When a route has no data to show, render an `<EmptyState>` component (see component-inventory.md):

```
┌───────────────────────────────────────────────────────┐
│                                                       │
│                  [glyph; 64px square]                 │
│                                                       │
│            No runs yet for this project.              │
│            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^               │
│            Inter 400, 18/24, --color-text-secondary   │
│                                                       │
│       Open Claude Code in this project to see         │
│             events flow into this view.               │
│       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^          │
│       Inter 400, 14/22, --color-text-tertiary         │
│                                                       │
└───────────────────────────────────────────────────────┘
```

Voice rules: state the situation in one short sentence; tell the user what to do next in one short sentence; do not include emojis, exclamation marks, or marketing language. The brand's tone is "engineering rigor"; empty states are matter-of-fact.

## Error states

When a server action throws or a query fails:

- **Inline (in-component):** `<ErrorBanner severity="error">` with `--color-status-error` left-edge bar (4px), `--color-bg-base` body, error message in `--color-text-primary`, "Retry" button right-aligned (only when retry is meaningful — not for "no run with id" errors).
- **Page-level (route handler threw):** Next.js `error.tsx` boundary. Same component, but with the route's name in the title and a "Return to dashboard" link.

Never expose stack traces. Never expose database error codes verbatim. Server actions translate errors to a fixed enum (`not_found`, `validation_failed`, `unauthorized`, `forbidden`, `internal`) and the UI maps each to a human sentence.

## Loading states

Three patterns, picked per surface:

1. **Server-rendered routes** (run list, policy list, etc.) — Next.js's loading.tsx renders a `<TableSkeleton rows={10}/>` or `<TileGridSkeleton tiles={5}/>` matching the eventual shape. No spinners. The brand says "spinners are admission of failure"; we use shimmer skeletons that match the rendered geometry.
2. **Polling refreshes** (live view, dashboard, kill-switches) — no full-page state during refresh. Tile values briefly fade via 120ms motion (`--motion-quick`). If the underlying state is unchanged (304), no animation.
3. **Server action mutations** (add policy rule, pause kill-switch) — the submit button enters its `pending` state (Inter 700, `--color-text-secondary`, label changes to "PAUSING…"); on success the form unmounts and a 320ms slide-up `<Toast>` reports "Paused global; resume with `coodra resume --id ks_…`". Toasts auto-dismiss after 8 seconds; click to dismiss earlier.

## Mobile breakpoints

Per brand.md §11 responsive guidance:

| Breakpoint | Header nav | Page layout | Notes |
|---|---|---|---|
| `< sm` (< 640px) | Hamburger | Single column; tile grid stacks | Tables become card lists |
| `≥ sm`, `< md` | Hamburger | Single column wider; tile grid in 2 cols | |
| `≥ md`, `< lg` | Inline nav | Two-column where natural (run detail: events left, decisions right) | |
| `≥ lg` (≥ 1024px) | Inline nav | Full layout | Default desktop |
| `≥ xl` (≥ 1280px) | Inline nav | Same as lg with more horizontal padding | |

The polling adapter does NOT pause on small viewports — operators viewing on a phone want live updates as much as desktop.
