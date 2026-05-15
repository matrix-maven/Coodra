# `/runs` — Run list (S3)

CLI parity: `coodra run list`. Read-only table of every run on the current project (solo) or every project in the org (team).

## Desktop layout

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  [CTX]OS   verify-m08b ▾   ·   RUNS   POLICIES   PROJECTS   PACKS   TEMPLATES   KILL   │
│                                ────                                            ✕      │
│                                                                            Solo mode  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  runs                                                                                  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│  RUNS                                                                                  │
│  All runs across this project, sorted by started_at descending.                        │
│                                                                                        │
│  ┌────────────────────────────────────────────────────────────────────────────────┐    │
│  │  Status: [All ▾]   Project: [verify-m08b ▾]   Last: [24 hours ▾]               │    │
│  │  ^^^^^^^^^^^^^^^^^                                                              │    │
│  │  --color-bg-surface, 1px border --color-border-subtle, --space-4 padding        │    │
│  └────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                        │
│  ┌────────────────────────────────────────────────────────────────────────────────┐    │
│  │ ID                          STATUS        AGENT         STARTED ↓     EVENTS   │    │
│  ├────────────────────────────────────────────────────────────────────────────────┤    │
│  │ run_verify_1777830445       cancelled    claude_code   17:47:25      2  ▸     │    │
│  │ run_verify_1777830426       in_progress  claude_code   17:47:06      1  ▸     │    │
│  │ run_proj_0d1738d            completed    claude_code   17:42:00     17  ▸     │    │
│  │ run_proj_a2b1c3d            completed    claude_code   17:39:00      8  ▸     │    │
│  │ run_proj_e4f5g6h            failed       claude_code   17:30:00      3  ▸     │    │
│  │ ...                                                                            │    │
│  └────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                        │
│  ◂ Newer    Page 1 of 12    Older ▸                                                    │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

## Token annotations

| Surface | Tokens |
|---|---|
| Filter row container | `<aside>` element, `--color-bg-surface`, 1px border `--color-border-subtle`, `--space-4` padding |
| Filter labels | `--font-display` weight 700 text-xs uppercase letter-spacing 0.04em `--color-text-secondary` |
| Filter dropdowns | `<Select>` primitive (see `03-component-inventory.md`) |
| Table header | `--font-display` weight 700 text-xs uppercase letter-spacing 0.04em `--color-text-secondary`, `--color-bg-elevated` background |
| Table row | `--font-sans` weight 400 text-sm (14/22), `--color-text-primary`, `--color-bg-base` |
| Row hover | `--color-bg-surface` |
| ID column | `--font-mono` weight 500 text-sm `--color-text-code` (Precision Blue dimmed `#0653B6`) |
| STATUS column | `<StatusChip>` mapped: `in_progress` → info, `completed` → success, `cancelled` → neutral, `failed` → error |
| AGENT column | `<ToolBadge name="claude_code">` (re-using ToolBadge primitive for non-tool labels too) |
| STARTED column | `--font-mono` weight 400 text-sm, time only on the same day, full timestamp on prior days |
| EVENTS column | numeric count, `--font-mono` weight 500 |
| Sort indicator (`↓`) | active sort column has the arrow; `--color-brand` |
| Pagination | bottom-aligned, `--font-display` weight 700 text-xs uppercase, `◂`/`▸` arrows in `--color-brand` |

## Filter behaviour

- Status filter: All / in_progress / completed / cancelled / failed.
- Project filter: dropdown of every project in scope (solo: just the current; team: all projects in the org).
- Last filter: 1h / 24h / 7d / 30d / All. Default 24h.
- Filter changes navigate to the same route with new querystring (`?status=in_progress&last=7d`); Server Components re-render with the filter applied.
- No "Apply" button — filter changes apply on `onChange`. Live URL state.

## Sort

- Column header click toggles asc/desc. Default: STARTED desc.
- Sortable columns: ID (lex), STATUS (custom order), STARTED, EVENTS.
- Non-sortable: AGENT (low cardinality, not useful).

## Pagination

50 rows per page. Cursor-based (no offset for performance) — `?cursor=<started_at_iso>` for next/prev. Page count is approximate (computed from `count(*)` once per session, cached client-side).

## Empty state

When zero runs match the filter:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                        │
│                            No runs match the current filter.                           │
│                                                                                        │
│                                Reset filters to view all.                              │
│                                                                                        │
│                                ┌─────────────────┐                                     │
│                                │  RESET FILTERS  │                                     │
│                                └─────────────────┘                                     │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

## Mobile (< sm)

The table becomes a card list. Each card:

```
┌──────────────────────────────────────────────────────────┐
│  run_verify_1777830445                                   │
│  cancelled  ·  claude_code                          ▸    │
│  17:47:25  ·  2 events                                   │
└──────────────────────────────────────────────────────────┘
```

Tap the card to navigate to `/runs/[id]`. Filter row stays at the top.
