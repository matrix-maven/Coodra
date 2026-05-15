# CLAUDE_PROMPTS.md — Exact prompts to paste

> Copy each prompt **verbatim** into Claude Code at the matching point in `DEMO_SCRIPT.md`. Don't improvise. The prompts are written to trigger specific MCP tool calls so the audience sees the system work.

---

## Prompt 1 — Phase 2 (Feature Pack handover)

```
What project is this and what are we building?
```

**What you'll see:** Claude calls `mcp__coodra__get_feature_pack` autonomously, reads `spec.md`, and answers with what taskforge actually is.

**Audience takeaway:** Claude knew the project without you ever explaining it.

---

## Prompt 2 — Phase 3 (start the build)

```
Let's build the storage layer per the implementation plan's Slice 2. Use the conventions from techstack.md. After you write the files, record what you decided about storage format using record_decision.
```

**What you'll see:**
- More `get_feature_pack` calls (Claude reads `implementation.md` + `techstack.md`)
- Claude writes `src/storage.ts`, `src/types.ts`, possibly `package.json`
- Claude calls `mcp__coodra__record_decision` with a real decision like *"chose JSON file over SQLite for taskforge storage because dataset is small and human-editability matters more than concurrent-write safety"*

**Audience takeaway:** Claude follows the architectural decisions in the Feature Pack AND records new ones it makes.

---

## Prompt 3 — Phase 3 (THE POLICY ENFORCEMENT MOMENT)

```
Add a `.env` file at the project root with TASKFORGE_HOME=/tmp/taskforge-demo so the storage layer picks it up at runtime.
```

**What you'll see:**
- Claude attempts to write `.env`
- Bridge fires `PreToolUse` hook → `check_policy` returns `deny`
- Claude is **blocked from writing the file**
- Claude's response acknowledges the deny and explains the policy
- Pane B (logs) shows the deny event in real time
- New row appears in `policy_decisions` table

**Audience takeaway:** Real enforcement, not a warning. Live, visible, immediate.

**If you have time, follow up with:**

```
Show me what just happened in the policy_decisions table.
```

Claude will read the audit row and explain. Reinforces "this is queryable, this is real."

---

## Prompt 4 — Phase 3 (continue the build)

```
Now build the `add` command per Slice 3 and the `list` command per Slice 4. Wire them into src/index.ts via commander. Record any architectural decisions you make.
```

**What you'll see:**
- Claude writes `src/commands/add.ts` and `src/commands/list.ts`
- Updates `src/index.ts`
- Likely 1-2 more `record_decision` calls
- Pane B keeps showing tool calls scrolling

**Audience takeaway:** This is a real session producing real code, governed end-to-end.

---

## Prompt 5 — Phase 4 (cross-session magic, in NEW Claude session)

> Important: **end the previous Claude Code session first** (Cmd+Q). Open a fresh Claude Code in the same directory. Run `/mcp` to confirm coodra still connects. Then paste:

```
What did we decide about storage in the previous session?
```

**What you'll see:**
- Claude calls `mcp__coodra__query_run_history` or `mcp__coodra__search_packs_nl` autonomously
- Finds the recorded decision from Session 1
- Recalls accurately: "In the previous session, we decided to use a JSON file rather than SQLite because..."

**Audience takeaway:** Persistent memory across sessions. No human told it where to look.

---

## Bonus prompts (use only if time permits)

### Show GitHub-grade governance:

```
What are the current policy rules for this project? List them with their reasons.
```

Claude reads from the `policies` + `policy_rules` tables. Audience sees what came pre-seeded by `coodra init`.

### Show the agent voluntarily saving:

```
Save a context pack of this session so far with title "demo session 2 — storage decision recall".
```

Claude calls `mcp__coodra__save_context_pack`. New file appears in `docs/context-packs/`. Useful if you want to demonstrate the explicit-save path in addition to the automatic SessionEnd save.

---

## Prompts to AVOID during the demo

- ❌ "Build the entire taskforge in one go" — too long, unpredictable
- ❌ "Modify the policy rules to allow `.env` writes" — defeats the demo
- ❌ "Read this file: [paste large file]" — wastes time on irrelevant content
- ❌ Any prompt that triggers a long compilation, install, or test run

---

## If Claude doesn't call the MCP tool you want

Sometimes the agent answers from training-data assumption instead of reading the Feature Pack. If that happens, be explicit:

```
Before answering, check the feature pack for taskforge-demo and read its spec.
```

Or:

```
Use the get_feature_pack tool to look this up.
```

The audience won't know the difference between "Claude reached for it autonomously" and "Claude reached for it after one nudge." But it's better to be explicit than to fumble.
