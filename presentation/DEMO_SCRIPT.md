# DEMO_SCRIPT.md — Minute-by-minute presenter guide

> Total runtime: **12 minutes**, with a 2-minute buffer for Q&A. If you need to cut, drop **Phase 4 (Cross-session magic)** — keep everything else.

## Before you start (do this 2 minutes before going live)

```bash
bash /Users/abishaikc/Coodra/presentation/setup.sh
```

Wait for `✅ Demo ready.`

Open **three terminal panes** side by side:

| Pane | What runs in it | Purpose |
|---|---|---|
| **A — Commands** | `cd ~/taskforge-demo` | You'll type `coodra` commands here |
| **B — Live logs** | `cd ~/taskforge-demo && coodra logs hooks --follow` | Audience watches activity scroll in real time |
| **C — Claude Code** | Open Claude Code in `~/taskforge-demo/` | The agent does its work here |

If you only have two screens, drop pane B. The logs are the visual upgrade, not the load-bearing piece.

---

## Phase 0 — The hook (30 seconds)

**Say:**

> "Today's AI coding agents — Claude Code, Cursor, Copilot — are powerful, but they're amnesiac. They forget what was decided yesterday. They write to files they shouldn't touch. They don't share state with each other. Every team using them is paying tax on every session."
>
> "Coodra fixes that. It's the coordination layer that gives any AI agent persistent project context, real policy enforcement, and a shared memory across sessions. It works with Claude Code, Cursor, Windsurf — anything that speaks MCP. Let me show you."

---

## Phase 1 — Setup (1 minute)

**In pane A, run:**

```bash
ls ~/taskforge-demo
```

**Say:** *"This is an empty directory. No code, no config, nothing."*

```bash
cat ~/taskforge-demo/.coodra.json
ls ~/taskforge-demo/docs/feature-packs/taskforge-demo/
```

**Say:** *"Actually I lied — it's not quite empty. I ran `coodra init` 30 seconds before going on stage. Here's what that single command did."*

Show them:
- `.mcp.json` exists → Claude Code will auto-connect to Coodra
- `.coodra.json` exists → registers this project with the local daemon
- `~/.coodra/data.db` → SQLite store with the project + 9 default policy rules already seeded
- `docs/feature-packs/taskforge-demo/` → the project's spec, implementation plan, tech stack — already written

**Say:** *"That's everything I had to do to instrument this project. One command, 30 seconds. Now watch what happens when I open Claude Code."*

---

## Phase 2 — Feature Pack handover (2 minutes)

**Switch to pane C (Claude Code, opened in `~/taskforge-demo/`).**

**In Claude Code, run:**

```
/mcp
```

**Show the audience:** `coodra` is connected, 9 tools listed.

**Say:** *"Nine MCP tools are now available to Claude. Things like `get_feature_pack`, `record_decision`, `check_policy`, `save_context_pack`. The agent can call any of these autonomously when relevant."*

**Now paste the first prompt** (from `CLAUDE_PROMPTS.md` Prompt 1):

> *"What project is this and what are we building?"*

**Watch:** Claude calls `get_feature_pack` autonomously, reads the spec.md you wrote, and answers with the actual project context — without you ever telling it what taskforge is.

**Say:** *"I never told Claude what this project is. The bridge auto-injected the Feature Pack when the session started. That's persistent project context, working."*

**Glance at pane B:** the logs show the `get_feature_pack` call being recorded.

---

## Phase 3 — Live build with policy enforcement (6 minutes)

**Paste Prompt 2** (from `CLAUDE_PROMPTS.md`):

> *"Let's build the storage layer per the implementation plan's Slice 2. Use the conventions from techstack.md."*

**Watch Claude:**
- Reads `implementation.md` and `techstack.md` (more `get_feature_pack` calls in pane B)
- Writes `src/storage.ts` with the atomic-rename pattern
- Writes `src/types.ts`
- Calls `record_decision` to log "chose JSON over SQLite for taskforge storage" — visible in pane B

**Say:** *"Notice Claude just called `record_decision`. That decision is now in a queryable audit log. Any future Claude session — or Cursor session, or Windsurf session — can search it."*

### The policy enforcement moment (THE MONEY-SHOT)

**Paste Prompt 3** (from `CLAUDE_PROMPTS.md`):

> *"Add a `.env` file with TASKFORGE_HOME=~/.taskforge so the storage layer picks it up at runtime."*

**Watch:** Claude tries to write `.env`. The bridge intercepts, calls `check_policy`, the policy engine returns `deny` because of the seeded rule "deny writes to `.env`". Claude is **physically blocked** — it cannot write the file. Claude's response will say something like "I attempted to write `.env` but the policy engine denied it. The policy is..."

**In pane B**, audience sees the deny event scroll past.

**Say:** *"That's not a warning. The bridge actually blocked the write. The policy rule was seeded into this project the moment I ran `coodra init`. Every project gets a baseline of safe defaults — deny `.env`, deny `.git/**`, deny `node_modules/**` — without any configuration."*

**Show the audit:**

```bash
sqlite3 ~/.coodra/data.db "SELECT tool_name, permission_decision, reason FROM policy_decisions ORDER BY created_at DESC LIMIT 5;"
```

**Say:** *"Every policy decision is in an immutable, append-only audit table. CISOs love this. 'Prove no agent ever wrote to a regulated file path' becomes a one-line SQL query."*

### Continue the build

**Paste Prompt 4:**

> *"Build the `add` command per Slice 3. Then the `list` command per Slice 4."*

Claude writes both commands. Records 1-2 more decisions along the way. Pane B keeps scrolling.

---

## Phase 4 — Cross-session magic (2 minutes)

**End the current Claude Code session** (Cmd+Q or close the window).

**In pane A, show:**

```bash
ls ~/taskforge-demo/docs/context-packs/
cat ~/taskforge-demo/docs/context-packs/2026-05-*.md | head -50
```

**Say:** *"When the session ended, the Hooks Bridge automatically saved a Context Pack. Here it is — what was built, what decisions were made, every tool call. Persistent memory of the session."*

**Open a fresh Claude Code session** in `~/taskforge-demo/`.

**Paste Prompt 5:**

> *"What did we decide about storage in the previous session?"*

**Watch:** Claude calls `query_run_history` or `search_packs_nl`, finds the decision, recalls it accurately — across sessions, with no prompting from you about what to look for.

**Say:** *"Brand new session. No conversation history. Claude knew to look in the run history because the manifest told it that's where past decisions live. That's how a team using Coodra stops re-explaining the same context every Monday morning."*

---

## Phase 5 — Forensics + close (1 minute)

**In pane A:**

```bash
sqlite3 ~/.coodra/data.db "SELECT description, rationale FROM decisions ORDER BY created_at DESC LIMIT 3;"
```

**Say:** *"Every architectural decision Claude made in those two sessions, queryable. This is the audit trail teams need for SOC 2, HIPAA, internal review — anything where 'show me what the AI did' becomes a question."*

```bash
coodra doctor
```

**Say:** *"And the system tells you it's healthy. 9 essential checks. Clean."*

### Close

> "Three things you saw:
>
> One — Claude knew the project from second one. No 'let me explain this codebase' prompt every session.
>
> Two — The bridge actually blocked the `.env` write. Real policy enforcement, not advice.
>
> Three — A new session 30 seconds later remembered everything. Real cross-session state.
>
> Coodra works with any MCP-compatible agent — Claude Code today, every other one tomorrow. Solo install is one npm command. Team mode shares context across an entire engineering org. Open source, runs locally, your code never leaves the machine."

---

## After the demo

```bash
bash /Users/abishaikc/Coodra/presentation/teardown.sh
```

This stops the daemons and removes `~/taskforge-demo/`. Your other Coodra projects are untouched.

---

## If something goes wrong

See `TROUBLESHOOTING.md`. Most likely issues:

- **`/mcp` shows nothing in Claude Code** → Cmd+Q Claude Code, reopen, retry. The `.mcp.json` change requires an IDE restart.
- **`coodra start` says "already running"** → Run `coodra stop` first, then `coodra start`.
- **Policy deny doesn't fire** → Pane B logs will show why. Check `sqlite3 ~/.coodra/data.db "SELECT * FROM policy_rules;"` — should have 9 rows.
- **Claude doesn't call MCP tools naturally** → Be more explicit: "Before answering, check the feature pack."

If something truly catastrophic happens, the safest pivot is: walk through the Feature Pack files, the .mcp.json, and the audit tables. The architecture itself is the demo even without live agent activity.
