# context_memory/

> Agent working memory across sessions and across PostToolUse hooks.
> Spec: `essentialsforclaude/03-context-memory.md`.

## Files

- `current-session.md` — active session state (overwritten at each session start; archived to `sessions/` first).
- `sessions/` — archived per-session logs; one file per past session, named `YYYY-MM-DD-HHmm-<topic>.md`.
- `decisions-log.md` — append-only log of every architectural or design decision made during implementation.
- `open-questions.md` — questions waiting on the user. Items are moved out of this file (into the relevant decision or pack) when answered.
- `pending-user-actions.md` — things only the user can do (per `02-agent-human-boundary.md` §2.2). Moved out when the user confirms done.
- `blockers.md` — things actively preventing progress right now. Kept minimal.

## Distinction from `docs/context-packs/`

`context_memory/` is **ephemeral working memory** — valid across hours/days, discarded after the matching Context Pack is written. `docs/context-packs/` is the **permanent archive** — one finalized Pack per completed module or feature.

## Read order on session start

1. `current-session.md`
2. `open-questions.md`
3. `pending-user-actions.md`
4. `blockers.md`

If `current-session.md` has a "Next action" that is still valid, continue from it. Otherwise, archive it to `sessions/<timestamp>-<topic>.md` and write a fresh `current-session.md` for the new session.

## Bootstrap note (2026-04-22)

During the Module 01 bootstrap, the Coodra MCP server does not yet exist. That means:

- `coodra__record_decision` is **not callable** — all decisions are written directly to `decisions-log.md`.
- `coodra__save_context_pack` is **not callable** — Module 01's pack is written by hand to `docs/context-packs/2026-04-22-module-01-foundation.md`.
- `coodra__search_packs_nl`, `coodra__query_run_history`, etc. likewise unavailable — agents fall back to `grep` over this folder.

This is a temporary condition; once Module 02 ships and `.mcp.json` points to a live server, the tool-loop closes and the MCP calls become the primary record path. The manual discipline in `essentialsforclaude/03-context-memory.md` remains the fallback even after that.
