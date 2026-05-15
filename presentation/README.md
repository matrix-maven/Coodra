# Coodra Demo — `taskforge`

A complete, rehearsable, 12-minute demo of Coodra end-to-end.

## What's in here

| File | Purpose |
|---|---|
| `README.md` | This file. Orientation. |
| `DEMO_SCRIPT.md` | Minute-by-minute presenter script. What to say, what to type, what to point at. |
| `CLAUDE_PROMPTS.md` | The exact prompts to paste into Claude Code at each step. Copy-paste, no improvisation. |
| `TROUBLESHOOTING.md` | If anything breaks live: known issues + 30-second fixes. |
| `setup.sh` | One-shot script that creates the demo project and copies in the Feature Pack. Run BEFORE presentation. |
| `teardown.sh` | One-shot cleanup after demo. Removes the demo project. |
| `taskforge-feature-pack/` | The pre-written Feature Pack (spec + implementation + techstack + meta). This is what makes the demo "real" — Claude reads this at SessionStart and immediately knows the project. |

## How to use this

**Tonight (rehearsal — 30 minutes):**
1. Read `DEMO_SCRIPT.md` end-to-end once.
2. Run `bash setup.sh`. Confirm it ends with "✅ Demo ready."
3. Open Claude Code in `~/taskforge-demo/`. Run `/mcp`. Confirm `coodra` shows up with all 9 tools.
4. Walk through `CLAUDE_PROMPTS.md` once, pasting each prompt in order. See the full flow.
5. Run `bash teardown.sh` to reset state.

**Tomorrow (presentation):**
1. Run `bash setup.sh` 2 minutes before going live.
2. Open two terminal windows side by side: one for `coodra` commands, one for `coodra logs hooks --follow`.
3. Open Claude Code in the third pane.
4. Follow `DEMO_SCRIPT.md` minute-by-minute.

## Why this project (`taskforge`)

A 5-command Node.js CLI for managing personal todos. Small enough Claude can build the core during the demo. Universal enough every audience member instantly understands what's happening. Has a `.env` file → live policy denial moment. Has real architectural decisions Claude will record live. Stays on TypeScript so the audience reads code at a glance.

## What the audience sees

By the end of the demo:
- An empty directory becomes a fully-instrumented Claude Code workspace in 30 seconds
- Claude builds working code without being told the project's conventions (it reads them from the Feature Pack)
- Claude's attempt to write `.env` is **physically blocked** by the bridge — not a warning, an actual block
- Every architectural decision Claude makes is recorded to a queryable log
- A NEW Claude session 30 seconds later already knows what was decided
- A real audit file appears on disk capturing the entire session
