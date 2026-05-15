# 03 — Context Memory Protocol

`context_memory/` is the agent's working memory across sessions and across PostToolUse hooks. It exists so any agent session can be interrupted at any point and the next session can resume without asking the user "what was I doing?". It is also how blockers and decisions accumulate coherently.

## 3.1 Folder layout (create on first use)

```
context_memory/
  README.md                      — How to read this folder (written once)
  current-session.md             — The ACTIVE session's running log. Overwritten at session start.
  sessions/
    YYYY-MM-DD-HHmm-<topic>.md   — Archived per-session logs. One per session.
  decisions-log.md               — Append-only log of every architectural or design decision made
  open-questions.md              — Questions waiting on the user. Moved out when answered.
  pending-user-actions.md        — Things only the user can do (see 02-agent-human-boundary.md §2.2). Moved out when done.
  blockers.md                    — Things preventing progress right now.
```

This is distinct from `docs/context-packs/` which holds **finalized, per-feature** Context Packs (the permanent record). `context_memory/` is **working memory** — ephemeral across weeks, persistent across hours/days.

## 3.2 Write rules

**At the start of every session:**

1. Read `current-session.md`, `open-questions.md`, `pending-user-actions.md`, `blockers.md` in that order.
2. If `current-session.md` has a "Next action" that is still valid, continue from it.
3. If any `pending-user-actions.md` items have been resolved by the user's latest message, move them out and act on them.
4. Archive the previous `current-session.md` to `sessions/<timestamp>-<topic>.md` before overwriting.

**After every PostToolUse hook** (every file edit, every command run, every MCP tool call that changes state):

- Append a one-to-three-line entry to `current-session.md` → Log section.
- Format: `- [HH:mm] <verb> <object> — <outcome>`
- Example: `- [14:22] edited apps/mcp-server/src/tools/github-get-pr-context.ts — added GraphQL query + Zod input schema, 87 lines, tsc passes`

**On a significant architectural or implementation decision:**

- Append to `decisions-log.md` with: timestamp, decision, rationale, alternatives considered.
- Mirror the decision to the Coodra MCP via `coodra__record_decision`.

**On a user action required:**

- Append to `pending-user-actions.md` with the format in `02-agent-human-boundary.md` §2.3.
- Ask the user in chat.

**On a blocker:**

- Append to `blockers.md`. Stop the blocked work. Pick up something else or ask the user.

**At the end of a session** (or before context collapse):

- Update `current-session.md` "Next action" so the next session knows exactly what to do first.
- Call `coodra__save_context_pack` with a full markdown summary.
- Do NOT archive `current-session.md` at session end — archive it at the next session's start so the next agent always has an authoritative current state to read.

## 3.3 `current-session.md` template

```markdown
# Current Session — YYYY-MM-DD

## Goal
[one sentence describing what this session is trying to achieve]

## Context loaded
- system-architecture.md §<section>
- External api and library reference.md → <library>
- Prior context packs consulted: <list>

## Last completed
[the last thing fully finished before this session resumed]

## Next action
[exactly what to do next, written so a cold agent can resume with no other input]

## Log (append-only per PostToolUse)
- [HH:mm] <verb> <object> — <outcome>
- [HH:mm] ...
```

## 3.4 Using context memory to recover

When something breaks, or the user asks "where were we?", or you hit unexpected state:

1. Read `current-session.md` top to bottom.
2. Read `blockers.md` and `open-questions.md`.
3. Grep `decisions-log.md` for the subject area.
4. Grep the most recent 3 files in `sessions/` for the same.
5. If you still don't have the answer, ask the user. Do not reconstruct from assumption.
