# `/runs/[id]` — Run detail (S3)

HTML port of `coodra run show` + `coodra export <runId> --format markdown --include-audit`. Audit always visible (web is human-reading; nothing dropped to fit a Slack post).

## Desktop layout

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  [CTX]OS   verify-m08b ▾   ·   RUNS   POLICIES   PROJECTS   PACKS   TEMPLATES   KILL    │
│                                ────                                                     │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│  runs / run_verify_1777830445                                                           │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                         │
│  run_verify_1777830445                                          [cancelled]             │
│  ^^^^^^^^^^^^^^^^^^^^^^                                          ^^^^^^^^^^^             │
│  --font-mono weight 500 text-3xl (28/36)                       <StatusChip neutral>     │
│                                                                                         │
│  Project: verify-m08b   ·   Agent: claude_code (solo)   ·   Session: sess-export-verify │
│  ^^^^^^^^^^^^^^^^^^^^^^      ^^^^^^^^^^^^^^^^^^^^^^^^^      ^^^^^^^^^^^^^^^^^^^^^^^^^^   │
│  --font-sans 400 text-sm (14/22), --color-text-secondary, mono spans for IDs            │
│                                                                                         │
│  Started:  2026-05-04T22:47:25.000Z       Ended:  2026-05-04T22:47:26.000Z (1.0s)       │
│  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^       │
│  --font-mono text-sm                     --font-mono text-sm                            │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │ Overview │ Events (2) │ Decisions (1) │ Audit (3) │ Context Pack             │    │
│  │ ─────────                                                                       │    │
│  │  active                                                                         │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
│  OVERVIEW (default tab — auto-summary)                                                  │
│  ─────────                                                                              │
│                                                                                         │
│  This run executed 2 tool-use events and recorded 1 decision. 1 event was               │
│  denied; 0 were allowed-with-audit; 1 was allowed pass-through. Final status:           │
│  cancelled (operator-initiated via coodra run cancel).                                │
│                                                                                         │
│  EVENTS (tab)                                                                           │
│  ─────────                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │ ▶ pre   Edit  tu_v1   17:47:25  ─ src/index.js                          ▾      │    │
│  │ ◀ post  Edit  tu_v1   17:47:25  ─ src/index.js                  success ▾      │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
│  DECISIONS (tab)                                                                        │
│  ─────────────                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │  Test decision                                                                   │    │
│  │  17:47:25                                                                        │    │
│  │                                                                                  │    │
│  │  Rationale: For verification                                                     │    │
│  │                                                                                  │    │
│  │  Alternatives considered:                                                        │    │
│  │   • option A                                                                     │    │
│  │   • option B                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
│  AUDIT (tab)                                                                            │
│  ─────────                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │ TIME       DECISION   TOOL    REASON                              MATCHED RULE  │    │
│  ├─────────────────────────────────────────────────────────────────────────────────┤    │
│  │ 17:42:06   [DENIED]   Write   writes to .env are denied — …       p_default_42  │    │
│  │ 17:42:06   [DENIED]   Write   kill_switch_paused:ks_75e17d…        —             │    │
│  │ 17:42:06   [DENIED]   Bash    kill_switch_paused:ks_75e17d…        —             │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
│  CONTEXT PACK (tab — empty when no pack saved)                                          │
│  ──────────────                                                                         │
│  No context pack saved for this run.                                                    │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## Tab strip

| Tab | Slot | Behavior when empty |
|---|---|---|
| Overview | Auto-summary paragraph | Always present |
| Events | Timeline of `run_events` | Empty state: "No events recorded for this run." |
| Decisions | Cards from `decisions` | Empty state: "Agent recorded no decisions." |
| Audit | Table of `policy_decisions` | Empty state: "No policy decisions for this run." |
| Context Pack | Rendered markdown | Empty state: "No context pack saved for this run." |

Tabs sync to URL hash (`#events`, `#audit`) for shareable deep-links.

## `<RunEventRow>` component

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  ▶ pre   Edit  tu_v1   17:47:25  ─ src/index.js                            ▾       │
│  ^                                                                          ^       │
│  phase glyph                                                                expand  │
│  --color-text-tertiary                                                              │
│  pre = ▶, post = ◀, session = ●, turn = ○, user_prompt = ▼                          │
│                                                                                     │
│  (expanded:)                                                                        │
│  Tool input:                                                                        │
│  {                                                                                  │
│    "file_path": "src/index.js",                                                     │
│    "old_string": "// entry point",                                                  │
│    "new_string": "// rewritten entry"                                               │
│  }                                                                                  │
│  ^                                                                                  │
│  --font-mono weight 400 text-sm, --color-bg-surface background, --space-4 padding   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

Click row to expand `tool_input` JSON pretty-printed. Outcome (success / failure with text) shows on the post row.

## `<DecisionCard>` component

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  Test decision                                                                  │
│  ^^^^^^^^^^^^^^                                                                 │
│  --font-display weight 700 text-lg (18/28), --color-text-primary                │
│                                                                                 │
│  17:47:25                                                                       │
│  --font-mono text-xs --color-text-tertiary                                      │
│                                                                                 │
│  Rationale: For verification                                                    │
│  ^^^^^^^^^^^                                                                    │
│  Inter weight 700, --color-text-secondary, then Inter 400 prose                 │
│                                                                                 │
│  Alternatives considered:                                                       │
│   • option A                                                                    │
│   • option B                                                                    │
│  ^                                                                              │
│  bullet list, Inter 400 text-sm                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
 background: --color-bg-surface
 border: 1px solid --color-border-subtle
 padding: --space-6
```

## Audit table

Same `<PolicyDecisionRow>` component used here as in dashboard's deny drilldown. Decision column uses `<StatusChip>` mapped: `allow` → success, `deny` → error, `ask` → warning. Reason column truncates to 80 chars with full text on hover (`title=` attribute). Matched rule column links to `/policies/[id]` if the rule belongs to a policy.

## Live navigation

A button at the top-right corner reads `Watch live` when the run's status is `in_progress`. Click → navigates to `/runs/[id]/live`. When status is terminal, the button is hidden.

## Mobile

Tabs become a horizontal-scroll strip. Cards become full-width. Tables become card-lists.
