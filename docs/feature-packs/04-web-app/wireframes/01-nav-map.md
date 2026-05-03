# M04 S0.5 — Navigation Map

> Concrete navigation surfaces — top header nav, hamburger menu, breadcrumb, sidebar (none in v1), per-route mini-nav. Read alongside `00-information-architecture.md` (page tree + chrome) and `02-screens/*.md` (per-route layouts). Tokens cite `docs/brand/brand.md`.

## Top-level navigation (desktop, ≥ md)

The global header carries the top-level nav inline:

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  [CTX]OS   verify-m08b ▾   ·   RUNS   POLICIES   PROJECTS   PACKS   TEMPLATES   KILL    │
│                                                                              SWITCHES   │
│                                                            ───────                  Solo │
│                                                              ^^^^^                       │
│                                                          active (S5)                     │
│                                                          2px underline --color-brand     │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- Six nav items, alphabetised by destination slug — Runs, Policies, Projects, Packs, Templates, Kill switches. NOT alphabetised by their label, which would put Packs before Policies (intentional override: the operator's mental ordering matches the audit-trail flow: see what ran → see what governed it → see what got reset → see what was authored → see what's available → see what's paused).
- Active route gets a 2px underline in `--color-brand`. Inactive items have no underline. Hover gives a 1px underline in `--color-text-tertiary`.
- Spacing between items: `--space-6` (24px).
- Typography: `--font-display` (Inter) weight 700, `text-sm` (14/22), uppercase letter-spacing 0.04em.

## Top-level navigation (mobile, < md)

```
┌─────────────────────────────────────────────────┐
│  ☰  [CTX]OS   verify-m08b               ·  Solo │
└─────────────────────────────────────────────────┘
```

The hamburger expands into an overlay panel:

```
┌─────────────────────────────────────────────────┐
│  ✕  CLOSE                                       │
├─────────────────────────────────────────────────┤
│                                                 │
│  HOME                                           │
│  ────                                           │
│                                                 │
│  RUNS                                           │
│  POLICIES                                       │
│  PROJECTS                                       │
│  PACKS                                          │
│  TEMPLATES                                      │
│  KILL SWITCHES                                  │
│                                                 │
│  ────                                           │
│                                                 │
│  SETTINGS  (team only)                          │
│  SIGN OUT  (team only)                          │
│                                                 │
└─────────────────────────────────────────────────┘
```

- Each row is `--space-12` (48px) tall; tap target meets accessibility minimum.
- Active row is filled with `--color-bg-elevated` and the underline becomes a 4px left-edge bar in `--color-brand`.
- The HOME row is the dashboard; included explicitly so the hamburger has it (the wordmark click on desktop covers the same nav, but on mobile the wordmark sits above the hamburger and the operator may not realise it's clickable).

## Breadcrumb track

A single horizontal row immediately below the header, sticky-on-scroll. Always present (even on `/`, where it shows just the project slug as a non-clickable label so the eye knows where it is).

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  ◂  runs  /  run_verify_1777830445  /  live                                              │
│     ^^^^                                                                                 │
│     clickable, --color-brand                                                             │
│     hover: --color-brand-hover                                                           │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- Optional left arrow (`◂`) when there's a parent route; navigates to the parent.
- Each segment except the current is a link in `--color-brand`. Hover swaps to `--color-brand-hover`. Visited state is intentionally NOT styled — every link in the dashboard goes to data the operator just generated, not external URLs; `:visited` discoloration would cosmetically degrade the UI within minutes.
- Separator: ` / ` (space-slash-space) in `--font-mono`, `--color-text-tertiary`.
- Final segment is the route name in `--color-text-primary`, non-clickable.

## Sidebar — INTENTIONALLY ABSENT in v1

We considered a left sidebar (it's the default in many admin tools) and rejected it. Reasons:

1. **Brand identity** — the brand mandates "information density via typography, not chrome". A persistent sidebar adds chrome.
2. **Top nav suffices** — six top-level routes fit comfortably in the header on desktop; a sidebar would duplicate their function.
3. **Mobile parity** — sidebars don't survive mobile; we'd need a hamburger anyway. Two patterns instead of one is more code without payoff.

If a future surface (M07 VS Code webview-as-sidebar) needs a vertical nav, that's a different consumer of the same data, not a layout change in `apps/web`.

## Per-route mini-nav

Some routes have an inner navigation surface (a tab strip, a filter row). Each one is documented in its `02-screens/*.md` file. Brief overview:

| Route | Mini-nav |
|---|---|
| `/runs` | Filter row (status filter, project filter, date range), sort dropdown |
| `/runs/[id]` | Tab strip: Overview · Events · Decisions · Audit · Context Pack |
| `/runs/[id]/live` | Same tab strip + a "STREAMING" indicator (Precision Blue dot, Inter 700 caption) |
| `/policies/[id]` | Tab strip: Rules · Add Rule · History |
| `/projects/[id]` | Tab strip: Overview · Recent Runs · Reset (destructive — visually demoted) |
| `/packs/[slug]` | Tab strip: spec.md · implementation.md · techstack.md · meta.json |
| `/kill-switches` | Tab strip: Active · Recent · Pause New |

- Tabs are `--font-display` weight 700, `text-sm`, uppercase letter-spacing 0.04em (mirrors top nav typography for visual rhythm).
- Active tab: 2px bottom border in `--color-brand`.
- Inactive tabs: no border. Hover: 1px bottom border in `--color-text-tertiary`.
- Tabs are full-width on mobile (stacked vertically) when the route's tabs exceed 4 items; otherwise inline-scroll horizontally.

## Routing transitions

Per brand.md §10 motion:

- **Inter-route navigation:** 320ms slide-up (`--motion-route`, ease-out). Old route fades out 80ms, new route slides up 240ms.
- **Tab switches within a route:** 200ms cross-fade (`--motion-section`, ease-in-out). No layout shift; the underlying URL updates.
- **Hover states:** 120ms (`--motion-quick`).

The polling adapter's data refresh does NOT trigger any route motion (it updates in place; only the affected tile/row gets a 120ms fade).

## Keyboard shortcuts (S1-deferred; post-M04)

Reserved namespace: `Cmd+K` for command palette (out of scope for M04). `g d` (goto dashboard), `g r` (goto runs), `g p` (goto policies), `g k` (goto kill-switches) — out of scope. The brand spec mentions shortcuts as a "future consideration"; we agree.

`Esc` always closes overlay state (modals, hamburger, dropdown). `Tab` and `Shift+Tab` traverse focusable elements per native browser behaviour.

## Focus ring

```
┌──────────────────────────────────┐
│                                  │
│         <button>FOCUSED</button> │
│                                  │
└──────────────────────────────────┘
   2px outline, --color-brand, offset 2px
```

- Per brand.md, all interactive elements get a 2px outline in `--color-brand` at offset 2px on `:focus-visible`. Mouse-click focus is suppressed; keyboard `Tab` shows the ring.
- Accessibility-mandatory; the unit test in M04 acceptance criterion 10 (spec §2 AC-10) does NOT cover focus rings (DOM mutation testing is heavy); we cover them with a Vitest + happy-dom assertion in the brand-tokens test suite.
