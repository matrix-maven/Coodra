# `/` — Dashboard home (S9)

CLI parity: `coodra doctor` (summary) + `coodra run list` + `coodra pause` status combined. The single load-bearing first-impression page; informs everything downstream.

## Desktop (≥ lg) — full layout

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  [CTX]OS   verify-m08b ▾   ·   RUNS   POLICIES   PROJECTS   PACKS   TEMPLATES   KILL   │
│                                                                                 ✕     │
│                                                                            Solo mode  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  verify-m08b                                                                           │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│  DASHBOARD                                                  Last refreshed 1s ago      │
│  ^^^^^^^^^                                                  ^^^^^^^^^^^^^^^^^^^^^      │
│  --font-display 900 text-4xl                                --font-mono text-xs        │
│                                                              --color-text-tertiary     │
│                                                                                        │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐│
│  │                  │  │                  │  │                  │  │                  ││
│  │  ACTIVE RUNS     │  │  DENIALS · 24h   │  │  ACTIVE PAUSES   │  │  DOCTOR          ││
│  │                  │  │                  │  │                  │  │                  ││
│  │       2          │  │       47         │  │        1         │  │  9 OK            ││
│  │  --color-brand   │  │  --color-status  │  │  --color-status  │  │  2 ⚠              ││
│  │                  │  │       -error     │  │       -warning   │  │  0 ✕              ││
│  │                  │  │                  │  │                  │  │                  ││
│  │  ──             ▸│  │  ──             ▸│  │  ──             ▸│  │  ──             ▸││
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  └──────────────────┘│
│   /runs?status=in_progress  /runs?denials_24h=1   /kill-switches    (expand on click)  │
│                                                                                        │
│  LATEST EVENTS                                                                         │
│  ^^^^^^^^^^^^^                                                                         │
│  --font-display 900 text-2xl (24/32)                                                   │
│                                                                                        │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ TIME ↓     PROJECT          PHASE   TOOL          SESSION       FILE/CMD        │  │
│  ├──────────────────────────────────────────────────────────────────────────────────┤  │
│  │ 17:50:12   verify-m08b      pre     Edit          sess-…45      src/index.js    │  │
│  │ 17:50:12   verify-m08b      post    Edit          sess-…45      src/index.js  ✓ │  │
│  │ 17:48:33   verify-m08b      pre     Bash          sess-…45      ls .            │  │
│  │ 17:48:33   verify-m08b      pre     Write         sess-…23      .env       DENY │  │
│  │ 17:42:27   verify-m08b      pre     Bash          sess-verify   ls         AUDIT│  │
│  │ 17:42:06   verify-m08b      pre     Write         sess-verify   /tmp/x     DENY │  │
│  │ 17:39:04   verify-m08b      sess.   —             sess-verify   —               │  │
│  │ 17:38:51   verify-m08b      sess.   —             sess-46           started     │  │
│  │ ...                                                                              │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                        │
│                                          View all runs ▸                              │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

## Token annotations

| Surface | Tokens |
|---|---|
| Page background | `--color-bg-base` |
| Tile background | `--color-bg-surface` |
| Tile border | 1px solid `--color-border-subtle` |
| Tile hover border | 1px solid `--color-brand`, 120ms motion |
| Tile label (e.g. "ACTIVE RUNS") | `--font-display` weight 700 text-xs (12/16) uppercase letter-spacing 0.04em `--color-text-secondary` |
| Tile value | `--font-display` weight 900 text-6xl (56/64) — color depends on status (see below) |
| Tile arrow `▸` | `--color-text-tertiary`, hover `--color-brand` |
| Latest events table header | `--font-display` weight 700 text-xs uppercase letter-spacing 0.04em `--color-text-secondary` |
| Table row | `--font-sans` weight 400 text-sm (14/22), borders `--color-border-subtle` |
| Mono columns (TIME, SESSION, FILE/CMD) | `--font-mono` weight 400 text-sm |
| Outcome chip (DENY / AUDIT / ✓) | `<StatusChip>` — see `03-component-inventory.md` |

## Tile color semantics

- **Active runs:** Inactive grey if 0; Precision Blue if > 0. Visually communicates "things are happening".
- **Denials · 24h:** Allowed green if 0; Denied red if > 0. Big red number is the operator's primary attention signal.
- **Active pauses:** Inactive grey if 0; Partial amber if > 0. Operator-intentional state, hence amber not red.
- **Doctor:** breakdown row of OK / WARN / FAIL. OK uses `--color-status-success`, WARN uses `--color-status-warning`, FAIL uses `--color-status-error`. Click expands the failed-checks list inline.

## Polling cadence

2000ms per spec §8. Each tile fades 120ms on value change. The "Last refreshed Xs ago" caption is a relative timestamp the polling adapter updates on every tick. When the tab is hidden, polling pauses and the caption shows "Paused (tab hidden)".

## Mobile (< sm)

Tiles stack vertically. Latest events table becomes a card list (one card per event). Header collapses to hamburger.

## Solo vs team

| Surface | Solo | Team |
|---|---|---|
| Tile counts | Local SQLite query | Cloud Postgres query, scoped to org |
| Doctor tile | Shells `coodra doctor --json --full`, cached 60s | Caption "Per-developer doctor; no cloud rollup" — values are dashes |
| Latest events | `run_events` LIMIT 10 ORDER BY created_at DESC, scoped to current project | Same query, scoped to org's projects |

## Empty state

When the project has zero runs:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                        │
│                              [glyph; 64×64, --color-text-tertiary]                     │
│                                                                                        │
│                              No activity yet.                                          │
│                                                                                        │
│                  Open Claude Code in this project to see                               │
│                       events flow into this view.                                      │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```
