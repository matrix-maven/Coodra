# `/policies` and `/policies/[id]` — Policy admin (S5)

CLI parity: `contextos policy {list, show, add, enable, disable}`.

## `/policies` — desktop

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  [CTX]OS   verify-m08b ▾   ·   RUNS   POLICIES   PROJECTS   PACKS   TEMPLATES   KILL    │
│                                       ────────                                          │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│  policies                                                                               │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                         │
│  POLICIES                                                                               │
│  Active rule sets evaluated by the bridge before every PreToolUse.                      │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │  Project: [verify-m08b ▾]    Status: [All ▾]                                    │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │ NAME            PROJECT       STATUS    RULES   UPDATED ↓               ACTIONS │    │
│  ├─────────────────────────────────────────────────────────────────────────────────┤    │
│  │ __default__    verify-m08b   active     26      2026-05-04T22:48:11   ▸ View   │    │
│  │ __default__    __global__    active     25      2026-05-03T17:39:04   ▸ View   │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

- NAME column uses `--font-mono` (policy names are identifier-like).
- STATUS uses `<StatusChip status="success">active</StatusChip>` or `neutral` for inactive.
- RULES is a numeric count.
- UPDATED is the most recent rule's `created_at`, mono.
- ACTIONS column has a `▸ View` link only — enable/disable lives on the detail page.

## `/policies/[id]` — desktop

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  policies / __default__                                                                 │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                         │
│  __default__                                                          [active]   ▾      │
│  ^^^^^^^^^^^                                                          ^^^^^^^^   ^      │
│  --font-mono weight 500 text-3xl                                      StatusChip toggle │
│                                                                                         │
│  id: b4bb7198-eb11-4fb1-9abc-bf401edd8749                                               │
│  project: a5c004e1-7439-422e-9639-aa992e957d1a (verify-m08b)                            │
│  description: Default policy seeded by `contextos init` (Phase 3 Fix D + Phase 4        │
│  Fix F, 2026-05-02). Denies file-mutating tools (Write, Edit, MultiEdit,                │
│  NotebookEdit) writing to .env / **/.env / .git/** / node_modules/**; asks before       │
│  Bash. Edit via `policy` UI or by writing custom rules with higher priority.            │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │ Rules (26) │ Add Rule │ History                                                 │    │
│  │ ─────────                                                                        │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
│  RULES (default tab)                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │ PRI ↑   DECISION   EVENT       TOOL          PATH GLOB         REASON           │    │
│  ├─────────────────────────────────────────────────────────────────────────────────┤    │
│  │  10    [DENY]      PreToolUse  Write         .env              writes to .env…  │    │
│  │  11    [DENY]      PreToolUse  Write         **/.env           writes to .env…  │    │
│  │  12    [DENY]      PreToolUse  Write         **/.git/**        writes to .git…  │    │
│  │  ...                                                                             │    │
│  │ 105    [DENY]      PreToolUse  Edit          **/forbidden/**   verification:…   │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
│  ADD RULE (tab)                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │  Tool name           [ Edit                                              ▾ ]    │    │
│  │  Decision            [ ◯ allow   ● deny   ◯ ask ]                                │    │
│  │  Path glob           [ **/forbidden/**                                       ]    │    │
│  │  Agent type          [ * (any)                                           ▾ ]    │    │
│  │  Event type          [ PreToolUse                                        ▾ ]    │    │
│  │  Priority            [ 105                                                  ]    │    │
│  │  Reason*             [ verification: deny Edit on forbidden paths           ]    │    │
│  │                                                                                  │    │
│  │                                                       ┌──────────┐  ┌──────┐    │    │
│  │                                                       │   ADD    │  │ CANCEL│    │    │
│  │                                                       └──────────┘  └──────┘    │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
│   Note: bridge cache TTL is 60s. New rule visible to bridge within 60s.                 │
│   ^                                                                                     │
│   --font-sans 400 text-xs --color-text-tertiary                                         │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## Token annotations

| Surface | Tokens |
|---|---|
| Policy name (h1) | `--font-mono` weight 500 text-3xl `--color-text-primary` |
| Status chip | `<StatusChip>` |
| Toggle (▾) | dropdown menu: Disable / Edit description / Delete (delete out of scope for v1) |
| Description | `--font-sans` 400 text-sm `--color-text-secondary` |
| ID + project | `--font-mono` text-sm `--color-text-tertiary` |
| Rules table — PRI col | `--font-mono` weight 500 text-sm |
| Rules table — DECISION col | `<StatusChip>` mapped: allow → success, deny → error, ask → warning |
| Rules table — TOOL col | `<ToolBadge>` |
| Rules table — PATH GLOB col | `--font-mono` text-sm `--color-text-code` |
| Rules table — REASON col | `--font-sans` 400 text-sm, truncated 60ch with full on hover |
| Add Rule form labels | `<FormField>` primitive |
| Add Rule decision radio | `<Select>` styled as radio group; `--space-2` between options |
| Add Rule submit button | `<Button variant="primary">` |
| Cache-TTL note | `--font-sans` 400 text-xs `--color-text-tertiary` |

## Disable toggle

```
[active]  ▾                                                       [active]  ▾
                                                                            │
   click ▾                                                                  ▼
                                                                ┌──────────────┐
                                                                │ DISABLE      │
                                                                │ EDIT META    │
                                                                └──────────────┘
```

Click "DISABLE" → confirmation dialog: "Disabling __default__ stops all 26 of its rules from applying within ~60s. Continue?". Confirm → server action → status flips to `[inactive]`. Bridge cache TTL applies; the dialog says so.

## History tab

(Lower priority — defer to S5 closeout if time-pressed.) Shows append-only changes: when rules were added, who added them, the bridge-cache propagation delay observed. Reads from `policy_rules.created_at` ordered desc.

## Mobile

Rules table → card list, one card per rule. Add Rule form stacks vertically (already does). Tab strip becomes scroll-horizontal.

## Solo vs team

- Solo: project filter shows current project + `__global__`.
- Team: project filter shows every project in the org. Adding a rule prompts which project the rule is for (defaults to current project's slug).
