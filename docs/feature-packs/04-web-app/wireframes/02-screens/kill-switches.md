# `/kill-switches` — Kill-switch admin (S8b)

CLI parity: `contextos pause / resume`. The team-mode write surface that S8a (sync-daemon backend) made bidirectional.

## Desktop

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  kill-switches                                                                          │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                         │
│  KILL SWITCHES                                                          [STREAMING ●]  │
│  Pause and resume agent enforcement at four scopes: global, project, tool, agent type. │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │ Active (1) │ Recent (47) │ Pause New                                            │    │
│  │ ─────────                                                                        │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
│  ACTIVE (default tab)                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │ MODE     SCOPE             REASON                       AGE     PAUSED BY       │    │
│  ├─────────────────────────────────────────────────────────────────────────────────┤    │
│  │ [HARD]   global           verification — global hard …  2m      web:user_2…     │    │
│  │                                                                  ┌────────┐     │    │
│  │                                                                  │ RESUME │     │    │
│  │                                                                  └────────┘     │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
│  RECENT (tab — paused/resumed history, last 50)                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │ TIME ↓     ACTION    MODE   SCOPE        REASON                       BY        │    │
│  ├─────────────────────────────────────────────────────────────────────────────────┤    │
│  │ 17:47:32  resumed    soft   tool=Bash    verify soft audit            sess-…    │    │
│  │ 17:44:14  paused     soft   tool=Bash    verify soft audit            sess-…    │    │
│  │ 17:42:06  resumed    hard   global       (cleared)                    sess-…    │    │
│  │ 17:42:06  paused     soft   tool=Bash    soft audit Bash              sess-…    │    │
│  │ 17:41:48  paused     hard   global       verification — global …      sess-…    │    │
│  │ ...                                                                              │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
│  PAUSE NEW (tab)                                                                        │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │  Scope            [ ◯ global   ● tool   ◯ project   ◯ agent type ]               │    │
│  │  Target           [ Bash                                                       ] │    │
│  │  Mode             [ ● hard   ◯ soft ]                                            │    │
│  │  Reason*          [ blocking Bash for the duration of the incident response  ]   │    │
│  │  Expires          [ (optional) datetime-local picker                         ]   │    │
│  │                                                                                  │    │
│  │  Pauses propagate to all developers within ~10s (sync-daemon pulls every 5s,    │    │
│  │  bridge cache TTL 5s).                                                          │    │
│  │                                                                                  │    │
│  │                                                              ┌────────────┐     │    │
│  │                                                              │  PAUSE     │     │    │
│  │                                                              └────────────┘     │    │
│  │                                                              destructive        │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## Token annotations

| Surface | Tokens |
|---|---|
| Page header | `<PageHeader>` with action slot = `[STREAMING ●]` indicator (active when polling is on) |
| Active table — MODE col | `<StatusChip status="error">HARD</StatusChip>`, `<StatusChip status="warning">SOFT</StatusChip>` |
| Active table — SCOPE col | `--font-mono` text-sm; e.g. "global", "tool=Bash", "project=verify-m08b", "agent_type=claude_code" |
| REASON col | truncated 60ch with hover tooltip |
| AGE col | relative time, mono — "2m", "1h", "3d" |
| PAUSED BY col | mono identifier — `web:<userId>` for web-originated, `sess-<id>` for CLI, `local-only:<host>` for `--no-sync` |
| Resume button | `<Button variant="secondary" size="sm">` |
| Recent table — ACTION col | `<StatusChip>` mapped: paused → error, resumed → success |
| Pause New form | `<FormField>` primitive for each field |
| Submit button | `<Button variant="destructive">PAUSE</Button>` (red — pause is intentionally framed as destructive even though it's reversible) |
| Propagation note | `--font-sans` 400 text-xs `--color-text-tertiary` |

## Polling cadence

5000ms per spec §8 (kill-switches change rarely; faster polling wastes server work).

## Duplicate-active banner

When the user submits a Pause for a (scope, target) that already has an active switch:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ ⚠  This scope is already paused.                                                │
│    id ks_75e17d36e5cf43789e8f0a3ce5802489, paused 12 min ago by alice@org       │
│    Reason: "verification — global hard pause"                                   │
│                                                                                 │
│    Pause again with a new reason? Both switches will exist in the audit trail. │
│    The matcher's first-match-wins (oldest unresumed) means the existing switch  │
│    stays in effect until resumed.                                               │
│                                                                                 │
│                                              ┌────────────┐  ┌────────────┐     │
│                                              │  CONTINUE  │  │  CANCEL    │     │
│                                              └────────────┘  └────────────┘     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Solo vs team

| Surface | Solo | Team |
|---|---|---|
| Pause writes to | Local SQLite | Cloud Postgres (sync-daemon pulls; all devs see within ~10s) |
| Propagation note | "Solo mode — pause is local only." | "Pauses propagate to all developers within ~10s." |
| PAUSED BY col | mostly `sess-<id>` (CLI users) | mix of `sess-<id>` + `web:<userId>` |
| Resume button effect | Local resume only | Cloud resume; sync-daemon propagates |

## `--no-sync` flag visibility

Switches paused with `contextos pause --no-sync` (per S8a) appear in the Active table with PAUSED BY = `local-only:<host>`. The Resume button still works locally; the team won't see the local switch (it never went to cloud).

## Empty state

When zero active switches:

```
                              No active kill switches.
                              Bridge enforcement is active.

                              ┌─────────────────┐
                              │  PAUSE NEW ▸    │
                              └─────────────────┘
```

## Mobile

Tables become card lists (one card per switch). Pause New form stacks vertically. Resume button moves below each row in the active card.
