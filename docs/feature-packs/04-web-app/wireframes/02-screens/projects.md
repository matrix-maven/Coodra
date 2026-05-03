# `/projects` and `/projects/[id]` — Project admin (S6)

CLI parity: `contextos project {list, show, reset}`.

## `/projects` — desktop

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  projects                                                                               │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                         │
│  PROJECTS                                                                               │
│  Every project registered in this <solo|team> install.                                  │
│                                                                                         │
│  ┌──────────────────────────┐  ┌──────────────────────────┐  ┌──────────────────────────┐
│  │                          │  │                          │  │                          │
│  │  verify-m08b             │  │  contextos               │  │  __global__              │
│  │  ^^^^^^^^^^^^            │  │  ^^^^^^^^^                │  │  ^^^^^^^^^^^^             │
│  │  --font-mono 500 text-2xl│  │                           │  │                           │
│  │                          │  │                          │  │  (sentinel — F7)         │
│  │  org: __solo__           │  │  org: __solo__           │  │  org: __solo__           │
│  │                          │  │                          │  │                          │
│  │  Runs: 47                │  │  Runs: 1284              │  │  Runs: 3                 │
│  │  Last: 2026-05-04 17:50  │  │  Last: 2026-05-04 23:10  │  │  Last: 2026-05-02 14:22  │
│  │                          │  │                          │  │                          │
│  │  ──                    ▸│  │  ──                    ▸│  │  ──                    ▸│  │
│  └──────────────────────────┘  └──────────────────────────┘  └──────────────────────────┘
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

- One card per project. Cards reuse the dashboard `<Tile>` primitive but with project-specific layout (no big number; a card with details).
- `__global__` is shown explicitly with the `(sentinel — F7)` caption — operators need to know it's special and not confuse it with a real project.
- Hover: card border swaps to `--color-brand`.
- Click: navigate to `/projects/[id]`.

## `/projects/[id]` — desktop

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  projects / verify-m08b                                                                 │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                         │
│  verify-m08b                                                                            │
│  ^^^^^^^^^^^^                                                                           │
│  --font-mono weight 500 text-3xl                                                        │
│                                                                                         │
│  id: a5c004e1-7439-422e-9639-aa992e957d1a                                               │
│  org: __solo__                                                                          │
│  created: 2026-05-04T17:39:04.000Z                                                      │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │ Overview │ Recent Runs (47) │ Reset                                             │    │
│  │ ─────────                                                                        │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
│  OVERVIEW                                                                               │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐                      │
│  │  TOTAL RUNS      │  │  COMPLETED       │  │  CANCELLED       │                      │
│  │       47         │  │       38         │  │        9         │                      │
│  │  --color-brand   │  │  --color-status- │  │  --color-status- │                      │
│  │                  │  │       success    │  │       neutral    │                      │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘                      │
│                                                                                         │
│  RECENT RUNS (tab)                                                                      │
│  (same shape as /runs filtered to this project; reuses RunRow component)                │
│                                                                                         │
│  RESET (tab)                                                                            │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │  Resetting verify-m08b will delete:                                              │    │
│  │   • 47 runs                                                                       │    │
│  │   • 1,284 run_events                                                              │    │
│  │   • 3 decisions                                                                   │    │
│  │   • 89 policy_decisions                                                           │    │
│  │   • 0 context_packs                                                               │    │
│  │                                                                                   │    │
│  │  Preserved (default):                                                             │    │
│  │   • policies (1)                                                                  │    │
│  │   • policy_rules (26)                                                             │    │
│  │   • project-scoped kill_switches (0)                                              │    │
│  │                                                                                   │    │
│  │  ☐ Also delete policies + rules + project-scoped kill switches                    │    │
│  │                                                                                   │    │
│  │  ┌────────────────────────────────────────────────────┐                           │    │
│  │  │ Type project slug to confirm: [             ]      │                           │    │
│  │  └────────────────────────────────────────────────────┘                           │    │
│  │                                                                                   │    │
│  │                                                                  ┌──────────┐    │    │
│  │                                                                  │  RESET   │    │    │
│  │                                                                  └──────────┘    │    │
│  │                                                                  destructive     │    │
│  │                                                                  --color-status- │    │
│  │                                                                       error      │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## Reset semantics

- Counts pre-flight via SELECT before the user types-to-confirm. Updates if user toggles "Also delete policies".
- `__global__` project: the Reset tab is replaced with a banner: "The `__global__` sentinel project (F7 invariant) cannot be reset from this UI. To clear `__global__` rows, run `contextos project reset __global__ --force` after backing up data.db."
- Reset button is disabled until the user types the project slug verbatim (case-sensitive; copy-paste works). Activates 320ms `--motion-route` to draw eye to it.
- After reset: server action returns the deleted-rows JSON; UI shows a success toast with the breakdown ("Deleted 47 runs, 1,284 events…") and navigates back to `/projects`.

## Token annotations

(All consistent with previous wireframes — `--font-mono` for IDs/slugs, `<StatusChip>` for status, `--color-status-error` for destructive actions.)

## Mobile

Cards stack. Tabs become horizontal scroll. Reset form stacks vertically; the type-to-confirm input gets full width.

## Solo vs team

- Solo: every card is in `__solo__` org.
- Team: each card shows `org: <Clerk org slug>`. Org switcher in the chrome filters this list to the current org.
