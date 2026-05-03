# M04 S0.5 — Component Inventory

> Every reusable component the M04 implementation slices can lean on, with brand-token annotations + the slice that ships it. S1 ships the chrome + three primitives; subsequent slices add the bigger composites colocated with their first consumer.

## Naming convention

- React components are PascalCase, default-exported from `apps/web/components/<Name>.tsx`.
- Components specific to a single route live under `apps/web/app/<route>/components/<Name>.tsx` and are not listed here (they're not reusable).
- Server-only components (e.g. `<RunDetailServer>`) suffix with `Server`; client components suffix nothing (Next.js's `'use client'` directive is the discriminator).

## Primitives (S1 ships these)

### `<StatusChip status="success | warning | error | info | neutral">{label}</StatusChip>`

Small inline chip — the primary status-comm component used in tile values, table cells, and inline run status. Brand: §13 component primitives.

```
┌────────────┐    ┌────────────┐    ┌───────────┐    ┌─────────┐    ┌────────┐
│ ALLOWED    │    │ PARTIAL    │    │ DENIED    │    │ INFO    │    │ NONE   │
└────────────┘    └────────────┘    └───────────┘    └─────────┘    └────────┘
 24px height
 --space-2 px on each side, no border-radius
 background: --color-status-{success,warning,error,info,neutral} at 12% opacity
 border-left: 2px solid --color-status-{...}
 typography: --font-mono, weight 500, text-2xs (11/16), uppercase, --color-text-primary
```

### `<RiskBadge level="low | medium | high">{label}</RiskBadge>`

Same dimensions as StatusChip but uses the risk palette (`--color-risk-low|medium|high`). Used on policy rules + kill-switches for severity affordance.

### `<ToolBadge name="Write">` (just renders the tool name, branded)

```
┌──────┐  ┌──────┐  ┌──────┐  ┌──────────┐  ┌───────────────┐
│Write │  │ Edit │  │ Bash │  │MultiEdit │  │ NotebookEdit  │
└──────┘  └──────┘  └──────┘  └──────────┘  └───────────────┘
 20px height
 --space-2 px each side
 background: --color-bg-elevated
 border: 1px solid --color-border-subtle
 typography: --font-mono, weight 500, text-2xs (11/16), --color-text-primary
```

## Layout primitives (S1 ships)

### `<PageHeader title={string} subtitle={string?} action={ReactNode?}>`

The H1 strip below the breadcrumb. `action` slot is right-aligned (typically a primary button or a status indicator).

```
┌────────────────────────────────────────────────────────────────────────────┐
│  RUNS                                              [STREAMING ●]           │
│  ^^^^                                              ^^^^^^^^^^^^^           │
│  --font-display weight 900 text-4xl (32/40)        action slot             │
│                                                                            │
│  All runs across this project, sorted by started_at descending.            │
│  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^           │
│  --font-sans weight 400 text-sm (14/22) --color-text-secondary             │
└────────────────────────────────────────────────────────────────────────────┘
```

### `<TileGrid>` + `<Tile>` (dashboard home — S9, but the primitive ships in S1)

```
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│                  │  │                  │  │                  │
│  ACTIVE RUNS     │  │  DENIALS · 24h   │  │  ACTIVE PAUSES   │
│                  │  │                  │  │                  │
│       2          │  │       47         │  │        1         │
│  ^^^^^^^^^       │  │  ^^^^^^^^^       │  │   ^^^^^^^^^^     │
│  --font-display  │  │  --font-display  │  │  --font-display  │
│  weight 900      │  │  weight 900      │  │  weight 900      │
│  text-6xl (56/64)│  │  text-6xl        │  │  text-6xl        │
│  --color-brand   │  │  --color-status  │  │  --color-status  │
│                  │  │       -error     │  │       -warning   │
│                  │  │                  │  │                  │
│  ──             ▸│  │  ──             ▸│  │  ──             ▸│
└──────────────────┘  └──────────────────┘  └──────────────────┘
 280px width × 200px height (3-tile row at lg+, 2 at md, 1 at sm)
 background: --color-bg-surface
 border: 1px solid --color-border-subtle
 padding: --space-6
 hover: border --color-brand, 120ms motion
 click: navigate (link wraps the whole tile)
```

### `<EmptyState glyph={ReactNode?} title={string} hint={string?}>`

Generic empty-state container; see `00-information-architecture.md` §"Empty states" for typography spec.

### `<ErrorBanner severity="error | warning | info" onRetry={?}>`

Inline error component; left-edge bar + body. See `00-information-architecture.md` §"Error states".

### `<TableSkeleton rows={number}>` and `<TileGridSkeleton tiles={number}>`

Shimmer skeletons that match the geometry of the eventual data. No spinners (brand: "spinners are admission of failure"). Skeleton color: 1px `--color-border-subtle` border + `--color-bg-elevated` shimmer at 60% → 100% opacity, 1.5s linear.

## Composites (each lands in its owning slice)

### `<RunRow run>` — S3

One row in `/runs` table. Columns: ID (mono), status (StatusChip), agent type (ToolBadge), started_at (relative time + abs on hover), session id (mono).

### `<RunEventRow event>` — S3

One row in the timeline on `/runs/[id]`. Phase glyph (▶ pre / ◀ post), ToolBadge, tool_use_id (mono), expand-toggle (▾) for tool_input/output JSON.

### `<DecisionCard decision>` — S3

Renders one row from the `decisions` table. Header (description), body (rationale), footer (alternatives as bullet list), timestamp (mono, secondary).

### `<PolicyDecisionRow row>` — S3

One row in the audit table. Decision (StatusChip), tool, reason, matched_rule_id (mono link to policy detail).

### `<ContextPackPanel pack>` — S3

Shown when a context pack exists for the run. Markdown rendered via the same renderer M08b S12 ships. `__CTX_CODE_N__` sentinel pattern.

### `<RuleTable rules>` — S5

Sortable + filterable table of policy_rules. Columns: priority, decision, event, tool, path-glob, reason, actor, created_at.

### `<AddRuleForm onSubmit>` — S5

Server-action form. Fields per spec §10 (project, tool, decision, reason, path-glob, agent-type, priority).

### `<ProjectCard project>` — S6

Card layout: project slug (Inter 900), org (mono), run count, last-run timestamp, "View" link.

### `<ResetConfirmDialog projectSlug>` — S6

Two-step confirm dialog: (1) Read warning + cascade-order list; (2) Type the project slug to enable Reset button.

### `<PackHeader pack>` — S7

Header for `/packs/[slug]`: pack slug (Inter 900), template name (mono), parent slug (mono link), `isActive` toggle.

### `<TemplateCard template>` — S7

Bundled vs user-installed badge, languages, autoSections, install path.

### `<ActiveSwitchRow switch>` — S8b

Active kill-switch row. Mode (StatusChip warning if soft, error if hard), scope/target (mono), reason (truncated to 80 chars w/ tooltip), age (relative time), Resume button.

### `<PauseForm onSubmit>` — S8b

Server-action form. Fields: scope select, target text (conditional on scope ≠ global), mode select (default hard), reason textarea, expires-at datetime (optional).

## Navigation primitives (S1 ships)

### `<HeaderNav active={routeKey}>` — top-level nav row, see `01-nav-map.md`.

### `<HamburgerMenu open setOpen>` — mobile overlay, see `01-nav-map.md`.

### `<Breadcrumb segments={Segment[]}>` — see `00-information-architecture.md`.

### `<TabStrip tabs={Tab[]} active={tabKey}>` — per-route tab strip, see `01-nav-map.md`.

## Form primitives (S1 ships)

### `<FormField label={string} hint={string?} error={string?}>`

Wraps every form input. Label above (Inter 700, text-xs uppercase, `--color-text-secondary`), hint below input (text-xs, `--color-text-tertiary`), error replaces hint (text-xs, `--color-status-error`).

### `<TextInput>`, `<TextArea>`, `<Select>`, `<DateTimeInput>`, `<NumberInput>`

Native HTML elements styled to brand: 1px `--color-border-default`, no border-radius, `--space-3` vertical padding + `--space-4` horizontal, `--font-sans` 400 text-sm. Focus: 2px outline `--color-brand` offset 2px (per `01-nav-map.md`).

### `<Button variant="primary | secondary | destructive" size="md | sm">`

```
PRIMARY            SECONDARY            DESTRUCTIVE
┌──────────┐       ┌──────────┐         ┌──────────┐
│   ADD    │       │  CANCEL  │         │  RESET   │
└──────────┘       └──────────┘         └──────────┘
 bg --color-brand   bg transparent       bg --color-status-error
 fg white           fg --color-text-     fg white
                       primary
                    border 1px            
                    --color-border-default
```

Typography for all variants: `--font-display` weight 700, text-sm, uppercase letter-spacing 0.04em. Height: `--space-12` (48px) for `md`, `--space-8` (32px) for `sm`.

### `<Toast toasts={Toast[]}>` — S5+ ships when first server action lands

Bottom-right stack of toasts. Slide-up 320ms (`--motion-route`), auto-dismiss 8s, click-to-dismiss earlier. Brand: `--color-bg-elevated` background, 1px `--color-border-default`, mono caption, status-color left edge.

## Components NOT shipping in M04

- `<Modal>` — no use case in M04 (every confirm uses a route or an inline section). Reserved for M07.
- `<Drawer>` — same.
- `<DropdownMenu>` — Clerk components carry their own; we don't author one.
- `<DatePicker>` — native `<input type="datetime-local">` is sufficient; no custom calendar.
- `<Chart>` — no charts in M04 (deferred per techstack.md).
- `<Tooltip>` — minimal native `title=` attributes only. Custom tooltips reserved for M07 (where the VS Code webview's hover-info needs richer markup).
