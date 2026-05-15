# STAKEHOLDER_PROMPTS_FULL.md — All prompts + commands, copy-paste ready

> Companion to `STAKEHOLDER_DEMO_FULL.md`. Open this on your phone or second monitor during the demo. Every prompt is verbatim — don't improvise.

---

## Pre-flight (run before stakeholder enters)

```bash
bash /Users/abishaikc/Coodra/presentation/setup.sh
coodra status
coodra doctor
```

Separate terminal:
```bash
cd /Users/abishaikc/Coodra/apps/web && pnpm dev
```

Pane B:
```bash
cd ~/taskforge-demo && coodra logs hooks --follow
```

---

## Phase 1 — Install review (Pane A)

```bash
ls ~/taskforge-demo
ls -la ~/taskforge-demo
cat ~/taskforge-demo/.coodra.json
ls ~/taskforge-demo/docs/feature-packs/taskforge-demo/
```

---

## Phase 2 — Doctor (Pane A)

```bash
coodra doctor
coodra doctor --full | head -50
```

---

## Phase 3 — In Claude Code (Pane C)

```
/mcp
```

**Prompt 1:**
```
What project is this and what are we building?
```

---

## Phase 4 — Live build (Pane C, then Pane A)

**Prompt 2:**
```
Let's build the storage layer per the implementation plan's Slice 2. Use the conventions from techstack.md. After you finish, record what you decided about storage format using record_decision.
```

After Claude finishes, in Pane A:
```bash
sqlite3 ~/.coodra/data.db \
  "SELECT description, rationale FROM decisions ORDER BY created_at DESC LIMIT 3;"

sqlite3 ~/.coodra/data.db \
  "SELECT id, source, prompt_text, state FROM intents ORDER BY created_at DESC LIMIT 3;"
```

---

## Phase 5 — Policy enforcement (Pane C, then Pane A)

**Prompt 3:**
```
Add a `.env` file at the project root with TASKFORGE_HOME=/tmp/taskforge-demo so the storage layer picks it up at runtime.
```

After Claude reports the deny, in Pane A:
```bash
sqlite3 ~/.coodra/data.db \
  "SELECT tool_name, permission_decision, reason, matched_rule_id
   FROM policy_decisions
   ORDER BY created_at DESC LIMIT 5;"
```

---

## Phase 6 — Kill switch (Pane A, then Pane C, then Pane A)

```bash
coodra pause --mode hard --scope tool --target Bash
```

In Pane C:
```
Run `npm install` and tell me what it outputs.
```

After Claude reports it can't run Bash, back in Pane A:
```bash
coodra resume
coodra status
```

---

## Phase 7 — Finish build (Pane C, then close)

**Prompt 4:**
```
Now build the `add` command per Slice 3, then the `list` command per Slice 4. Record any decisions you make.
```

Then close the Claude Code session (Cmd+Q or close tab).

In Pane A:
```bash
ls ~/taskforge-demo/docs/context-packs/
cat ~/taskforge-demo/docs/context-packs/$(ls -t ~/taskforge-demo/docs/context-packs/ | head -1) | head -40
```

---

## Phase 8 — Fresh session (Pane C, new Claude Code window in `~/taskforge-demo/`)

**Prompt 5:**
```
What did we decide about storage in the previous session, and why?
```

In Pane A while Claude responds:
```bash
sqlite3 ~/.coodra/data.db "SELECT COUNT(*) FROM decisions WHERE project_id IN (SELECT id FROM projects WHERE slug='taskforge-demo');"
sqlite3 ~/.coodra/data.db "SELECT COUNT(*) FROM intents WHERE state='resolved';"
sqlite3 ~/.coodra/data.db "SELECT COUNT(*) FROM run_events WHERE phase='post';"
```

---

## Phase 9 — Web App tour (Pane D, browser at http://localhost:3000)

Click order, top-to-bottom:

1. **Project picker** — point at "All systems operational" pill
2. Click `taskforge-demo`
3. Project overview — runs / intents / decisions / policy decisions tiles
4. Click most recent run → drill-down (timeline, intent, decisions, tool calls, Context Pack)
5. Left nav → `Packs` (Feature Packs + Context Packs, drag-drop area)
6. Left nav → `Policies` (25-rule baseline, deny-`.env` rule)
7. Left nav → `Kill switches` (audit log)
8. Left nav → `Doctor` (39-check dashboard)
9. *(optional)* Left nav → `Graph` (codebase graph, soft-fail OK)

---

## Phase 10 — Close one-liner

> "Four things: persistent project context, real policy enforcement, cross-session memory, single pane of glass. Works with any MCP agent. Local-first. Phase A through C shipped this week. Phase D is the audit-as-you-go program — every bug we debug becomes a permanent guardrail the next morning."

---

## If interrupted: "in plain English what is this?"

> "Coodra makes AI coding agents enterprise-safe. Three things: persistent project context they don't already have, real policy enforcement on every tool call — not advice, actual blocks — and a queryable audit trail of every decision. Local-first, works with any MCP agent, single command to install."

---

## After the demo

```bash
bash /Users/abishaikc/Coodra/presentation/teardown.sh
```
