# STAKEHOLDER_DEMO_FULL.md — Linear walkthrough of everything we built

> **Total runtime: 18 minutes** + 3 min Q&A buffer.
> **Audience: stakeholder / leadership.** Frames every feature as outcome, not architecture.
> **One file, top-to-bottom.** No branching, no "if you have time." Every phase feeds the next.
>
> If you have to cut: drop **Phase 7 (kill switch)** first, then **Phase 9.4 (graph view)**. Everything else is load-bearing.

---

## What you'll prove (the 4 takeaways)

By minute 18 the audience has seen all four:

| # | Takeaway | The visible proof |
|---|---|---|
| 1 | **AI agents get persistent project context, automatically** | Claude answers "what is this project?" without you ever explaining — it read the Feature Pack we dropped on disk |
| 2 | **Every agent action is policy-checked, in real time** | Claude's `.env` write is *physically blocked* — not warned, blocked. New audit row appears live. |
| 3 | **Every decision the agent makes survives the session** | A fresh Claude session 30 seconds later recalls the storage decision from the previous one |
| 4 | **Operators have a single pane of glass** | The web app shows runs, decisions, intents, packs, policies, kill switches, doctor — all queryable |

---

## Pre-flight checklist (run 5 minutes before stakeholder enters the room)

```bash
# 1. Reset demo state + scaffold a fresh taskforge project
bash /Users/abishaikc/Coodra/presentation/setup.sh
# → wait for "✅ Demo ready."

# 2. Confirm daemons are healthy
coodra status
coodra doctor          # essential 11 checks should all be green

# 3. Boot the Web App (separate terminal, leave running)
cd /Users/abishaikc/Coodra/apps/web
pnpm dev
# → opens on http://localhost:3000 — leave the tab idle on the picker page
```

**Terminal layout (4 panes):**

| Pane | Purpose | What's running |
|---|---|---|
| **A** | Commands you'll type | `cd ~/taskforge-demo` |
| **B** | Live hook activity | `coodra logs hooks --follow` |
| **C** | Claude Code | Open `~/taskforge-demo/` in Claude Code |
| **D** | Web App | `http://localhost:3000` in a browser tab |

If you only have a single screen: pop B + D into a second monitor. The audience needs to *see* B and D, not just A and C.

**Final pre-flight tap (10 sec each):**
- Pane C → run `/mcp` → confirm `coodra` shows up with **10 tools** (`ping`, `get_run_id`, `get_feature_pack`, `save_context_pack`, `search_packs_nl`, `record_decision`, `query_decisions`, `query_run_history`, `check_policy`, `query_codebase_graph`)
- Pane D → confirm the picker shows a green "All systems operational" pill
- Pane B → confirm `coodra logs hooks --follow` is tailing (you'll see hook events scroll once Claude Code starts)

You're ready when all four panes look idle.

---

## Phase 0 — The hook (45 seconds)

**You say** *(directly to the stakeholder, no terminal yet)*:

> "Today's AI coding agents — Claude Code, Cursor, Copilot, Windsurf — are powerful, but they're amnesiac and ungoverned. Every Monday someone re-explains what the codebase is. Files get touched that shouldn't. Decisions are forgotten across sessions. There's no audit trail when leadership asks 'what did the AI actually do this quarter?'
>
> Coodra is the coordination layer that fixes that. Three things: it gives any AI agent persistent project context, it enforces real policy on every tool call, and it produces a queryable audit trail of every decision. It works with any MCP-compatible agent. It's local-first, your code never leaves the machine. Let me show you the whole thing in 18 minutes — empty directory to fully-instrumented agent workspace, with a stakeholder dashboard at the end."

**Why this matters:** Frames the rest as solving real pain, not selling tech.

---

## Phase 1 — Install Coodra into a fresh project (90 seconds)

**You do (Pane A):**

```bash
ls ~/taskforge-demo
```

**You say:** *"Empty directory. No code, no config, nothing."*

**You do:**

```bash
ls -la ~/taskforge-demo
cat ~/taskforge-demo/.coodra.json
ls ~/taskforge-demo/docs/feature-packs/taskforge-demo/
```

**You say:** *"Actually I lied — this isn't quite empty. I ran `coodra init` 30 seconds before stage. Here's what that single command did."*

**Point at:**
- `.mcp.json` → "Claude Code, Cursor, Windsurf will all auto-connect to Coodra in this directory."
- `.coodra.json` → "Registers this project with the local daemon. Includes a slug — the durable handle this project keeps for the rest of its life."
- `~/.coodra/data.db` → "Local SQLite store. The primary store, not a cache. Your runs, decisions, audit log all live here. Nothing leaves the machine until *you* opt in to team mode."
- `docs/feature-packs/taskforge-demo/` → "The project's spec, implementation plan, tech stack — markdown on disk, version-controlled with the repo."

**You do:**

```bash
ls ~/taskforge-demo/docs/feature-packs/taskforge-demo/
# → spec.md  implementation.md  techstack.md  meta.json
```

**You say:** *"This is a tier-1 Feature Pack — three structured files plus metadata. We also support tier-2 (one markdown file) and tier-3 (a folder of arbitrary markdown). Drop ANY shape on disk, Coodra classifies it, indexes it, serves it to agents on demand. Everyone wins because the same handover format works for every team."*

**Why this matters:** One command = full instrumentation. No config sprawl. Same shape works whether the team has 1 markdown file or a 30-doc Notion export.

---

## Phase 2 — Operational X-ray with `coodra doctor` (60 seconds)

**You do (Pane A):**

```bash
coodra doctor
```

**You say:** *"Before any agent runs, let's see what Coodra knows about its own state. This is the essential subset — 11 checks, the Claude Code happy path."*

**Point at the output:**
- ✓ Node version
- ✓ ~/.coodra/ writable
- ✓ data.db opens
- ✓ migrations at head
- ✓ __global__ sentinel project (the F7 invariant — handles unregistered cwds gracefully)
- ✓ hooks-bridge /healthz
- ✓ project registered (taskforge-demo)
- ✓ .mcp.json valid
- ✓ Claude Code hook registration
- ✓ synthetic PreToolUse loop
- ✓ LOCAL_HOOK_SECRET set

**You do:**

```bash
coodra doctor --full | head -50
```

**You say:** *"`--full` runs all 39 checks — observability for outbox depth, kill-switch state, sync queue lag, dead-letter escalation, stale runs, pack-coverage ratio, the full picture. This is Phase A of an audit-as-you-go program: every problem we ever debug becomes a permanent doctor check the next morning. The system never lets the same bug bite twice."*

**Why this matters:** Stakeholders care about operational confidence. "We have an X-ray for this" answers "what happens when it breaks at 3am?"

---

## Phase 3 — Open Claude Code → Feature Pack handover (90 seconds)

**Switch to Pane C (Claude Code, opened in `~/taskforge-demo/`).**

**You do:** Run `/mcp` in Claude Code.

**Point at the output:** `coodra` server connected, **10 tools** advertised.

**You say:** *"Ten MCP tools available to Claude. Things like `get_feature_pack`, `record_decision`, `query_decisions` — that one's the read-side memory primitive — `check_policy`, `save_context_pack`. Claude calls these autonomously when relevant — no scripted prompts, the tool descriptions are written so the agent knows when each is appropriate."*

**Paste the first prompt** (verbatim from CLAUDE_PROMPTS.md Prompt 1):

> *"What project is this and what are we building?"*

**While Claude responds, glance at Pane B (logs).** You'll see:
- `hook_ingress` event for SessionStart
- `feature_pack_injected` — the bridge auto-loaded the pack into Claude's session
- a `get_feature_pack` MCP call from Claude

**Claude's answer comes back:** "TaskForge is a personal todo CLI…" with details from `spec.md`.

**You say:** *"I never told Claude what taskforge is. Two things happened. One — when the session opened, the bridge intercepted Claude's SessionStart hook and injected the Feature Pack as `additionalContext`. Two — Claude then called `get_feature_pack` on its own to drill in. The agent had project context from second one."*

**Why this matters:** Persistent project context, working. Removes the "every Monday re-explain the codebase" tax.

---

## Phase 4 — Live build with intent tracking (3 minutes)

**Paste Prompt 2:**

> *"Let's build the storage layer per the implementation plan's Slice 2. Use the conventions from techstack.md. After you finish, record what you decided about storage format using record_decision."*

**While Claude works, narrate:**

> "Watch Pane B. Every PreToolUse hook → policy check → log line. Every PostToolUse → run_event row. Every architectural choice Claude makes can land in the decisions log. Nothing happens off-camera."

**What you'll see in Pane B:**
- `pre_tool_use_decision` events for `Read` (Claude reading the implementation.md / techstack.md)
- `pre_tool_use_decision` events for `Write` (Claude writing src/storage.ts, src/types.ts) — all `permissionDecision: 'allow'`
- A `record_decision` MCP call near the end with rationale "chose JSON file over SQLite for taskforge storage…"

**You do (Pane A) once Claude finishes:**

```bash
sqlite3 ~/.coodra/data.db \
  "SELECT description, rationale FROM decisions ORDER BY created_at DESC LIMIT 3;"
```

**Point at:** the decision Claude just recorded, in plain English, queryable.

**You say:** *"That decision is now permanent. Any future Claude session — or Cursor session, or Windsurf session — running in this project can ask `query_decisions`, get this back. We just turned 'tribal knowledge in someone's head' into structured, searchable memory."*

**Now — the architectural shift we shipped this week (call it out explicitly):**

```bash
sqlite3 ~/.coodra/data.db \
  "SELECT id, source, prompt_text, state FROM intents ORDER BY created_at DESC LIMIT 3;"
```

**Point at:** intents rows showing `source='user_prompt'`, the prompt text, and `state='resolved'` (linked to the decision).

**You say:** *"This is what we shipped in Phase C of the audit. Every prompt the user fires becomes an *intent* row. When Claude calls `record_decision`, the resolver links the new decision to the open intent. So the audit trail isn't 'here's a wall of tool calls'  — it's 'user asked X → agent decided Y → these are the files that changed.' That's the difference between a log and a story."*

**Why this matters:** Decisions are recallable across sessions. Intents make the audit trail human-readable, not a firehose.

---

## Phase 5 — Policy enforcement (THE MONEY SHOT) (90 seconds)

**Paste Prompt 3:**

> *"Add a `.env` file at the project root with `TASKFORGE_HOME=/tmp/taskforge-demo` so the storage layer picks it up at runtime."*

**Watch Pane C:** Claude attempts the write. Comes back with: *"I attempted to write `.env` but the policy engine denied it. Reason: writes to `.env` are blocked by the default safety policy."*

**Point at Pane B:** the `pre_tool_use_decision` event with `permissionDecision: 'deny'`, `matchedRuleId: rule_default_block_env_write`.

**You say:** *"That's not a warning. The bridge intercepted the tool call before it executed and denied it. The policy was seeded the moment I ran `coodra init` — every project gets a 25-rule baseline that blocks writes to `.env`, `.git/**`, `node_modules/**`, against every file-mutating tool: Write, Edit, MultiEdit, NotebookEdit. No configuration on my end. Defaults that work."*

**You do (Pane A):**

```bash
sqlite3 ~/.coodra/data.db \
  "SELECT tool_name, permission_decision, reason, matched_rule_id
   FROM policy_decisions
   ORDER BY created_at DESC LIMIT 5;"
```

**Point at the deny row.**

**You say:** *"Append-only audit table. Every policy decision the bridge ever made, queryable. CISO question — 'prove no agent ever wrote to a regulated path' — becomes a one-line SQL query."*

**Why this matters:** Real enforcement, not advice. SOC 2 / HIPAA / internal review evidence trail.

---

## Phase 6 — Kill switch (the panic button) (90 seconds)

**You say:** *"Sometimes a model goes off the rails mid-session. You need a panic button. We shipped one in Phase A of the audit. Watch."*

**You do (Pane A):**

```bash
coodra pause --mode hard --scope tool --target Bash
```

**Output:** `kill switch installed: ks_<id> — scope=tool, target=Bash, mode=hard, indefinite`

**Switch to Pane C and paste:**

> *"Run `npm install` and tell me what it outputs."*

**Watch:** Claude attempts `Bash`. The bridge intercepts, evaluates the kill switch, returns deny with reason "kill switch ks_<id> active — Bash blocked." Claude's reply acknowledges it can't run Bash.

**You say:** *"Live, atomic, scoped block. I can scope it to a tool, a project, or globally. I can choose hard mode (deny + reason) or soft mode (allow but raise warning). Resume is just as fast."*

**You do:**

```bash
coodra resume       # resumes the only active switch
coodra status       # confirm the switch is gone
```

**Why this matters:** Operator confidence. "What if the agent does something we didn't anticipate?" answered with a 30-second toggle.

> **One Phase-A nuance worth mentioning if asked:** *the audit caught a self-lockout pattern where I locked myself out of my own dev loop with `coodra pause --mode hard --scope global`. The CLI now defaults `--scope` to `project` so a stray pause from inside a project never globally bricks your tooling. That's the kind of bug Coodra is designed to find — and never let happen twice.*

---

## Phase 7 — Continue the build, then close the session (60 seconds)

**Paste Prompt 4:**

> *"Now build the `add` command per Slice 3, then the `list` command per Slice 4. Record any decisions you make."*

Claude writes both. 1–2 more `record_decision` calls land in Pane B.

**End the Claude Code session** (Cmd+Q the IDE, or close the conversation tab).

**Point at Pane B:** `session_end` event fires, then `auto_context_pack_saved`.

**You do (Pane A):**

```bash
ls ~/taskforge-demo/docs/context-packs/
cat ~/taskforge-demo/docs/context-packs/$(ls -t ~/taskforge-demo/docs/context-packs/ | head -1) | head -40
```

**Point at:** the auto-generated Context Pack — what was built, what decisions were made, every tool call, all linked back to the user's intents.

**You say:** *"When the session ended, the bridge automatically generated and wrote a Context Pack to disk. This is bridge-mediated coordination — it fires whether Claude remembered to call save_context_pack or not. It's protocol, not convention. The session always closes with a durable handover."*

**Why this matters:** Session memory survives. No "let me explain what we did yesterday" tax on the next session.

---

## Phase 8 — Cross-session magic (90 seconds)

**Open a fresh Claude Code session** in `~/taskforge-demo/`.

**Paste Prompt 5:**

> *"What did we decide about storage in the previous session, and why?"*

**Watch:** Claude calls `query_decisions` (the new tool from Slice 4 / Phase 4 Fix I — the read side of the durable decisions log). It comes back with the description and rationale verbatim.

**You say:** *"Brand new session. No conversation history. Claude knew exactly where to look because the `query_decisions` tool description tells it 'use me when the user asks what was decided.' The agent's planner reads tool descriptions and matches them to user intent. We never script that — we just write good descriptions."*

**You do (Pane A):**

```bash
sqlite3 ~/.coodra/data.db "SELECT COUNT(*) FROM decisions WHERE project_id IN (SELECT id FROM projects WHERE slug='taskforge-demo');"
sqlite3 ~/.coodra/data.db "SELECT COUNT(*) FROM intents WHERE state='resolved';"
sqlite3 ~/.coodra/data.db "SELECT COUNT(*) FROM run_events WHERE phase='post';"
```

**Point at the counts.** "X decisions, Y resolved intents, Z tool events. Every one of them queryable."

**Why this matters:** This IS the audit trail leadership wants when the question is "what did the AI do this quarter?"

---

## Phase 9 — Web App — single pane of glass (4 minutes)

**Switch to Pane D (browser tab on `http://localhost:3000`).**

**You say:** *"Everything we just did via CLI lives in the web app too. This is the operator's view — for someone who isn't running terminals."*

### 9.1 — Project picker (30 sec)

**Point at:**
- "All systems operational" pill (top-right) — the doctor report rendered as a dashboard tile
- The taskforge-demo project card — click it
- Project mode (solo / team), last activity, run counts

**You say:** *"This pulls from the same `coodra doctor` we ran in Phase 2. Same source of truth, different surface."*

### 9.2 — Project overview (45 sec)

**Click `taskforge-demo`** → lands on the project overview.

**Point at:**
- **Recent runs** — the two Claude sessions we just had
- **Open intents** vs **resolved intents** counts
- **Decisions count** — the architectural log size
- **Policy decisions today** — should show our deny event

### 9.3 — Runs drill-down (60 sec)

**Click the most recent run.**

**Point at:**
- **Timeline view** — every hook event in order, with type pills (pre / post / session_start / session_end / user_prompt)
- **Linked intent** — the user's prompt that opened this run
- **Decisions made during this run** — the storage decision Claude recorded, rendered with rationale
- **Tool calls** — list of every Read/Write/Edit/Bash with their permission verdict
- **Auto Context Pack** — the markdown file from Phase 7, rendered inline

**You say:** *"This is what 'observable AI' looks like. Not 'we have logs somewhere' — a per-run timeline with intent → decision → file change linkage."*

### 9.4 — Packs (45 sec)

**Click `Packs` in the left nav.**

**Point at:**
- **Feature Packs** — the taskforge-demo pack, classified as tier-1, with parent inheritance graph
- **Context Packs** — the auto-saved digest from Phase 7, plus any agent-saved narrative recaps
- **Drag-drop** any markdown file here to register a new tier-2 pack — same as `coodra pack scan` in CLI

**You say:** *"Same drag-drop ergonomics as Notion. Whatever shape your team's docs are in — single file, three-file template, folder of essays — Coodra classifies and indexes them so an agent can serve them on request."*

### 9.5 — Policies (30 sec)

**Click `Policies`.**

**Point at:**
- The 25-rule baseline policy seeded by `coodra init`
- The `.env` deny rule we just hit live
- The unique-constraint badge (Phase 4 Fix K — every (event_type, tool, glob, agent_type) tuple is unique, no duplicate rules ever)

**You say:** *"Edit, enable, disable, add — all from this surface. Every change is audited. The policy engine is the same one the bridge uses; this is just the human-friendly editor."*

### 9.6 — Kill switches (20 sec)

**Click `Kill switches`.**

**Point at:** the empty state (since we resumed our switch in Phase 6) and the audit log of past switches with who/when/scope/duration.

**You say:** *"Same panic button as the CLI, with full history. Pause / resume from here, same effect."*

### 9.7 — Doctor (20 sec)

**Click `Doctor`.**

**Point at:** the live health view — same 39 checks, but as a dashboard with green/yellow/red tiles instead of a CLI list.

**You say:** *"Refreshes in real time. This is the screen we want on a wall when we go to production."*

### 9.8 — Graph (skip if running short — 20 sec optional)

**Click `Graph`.**

**Point at:** the codebase graph view (currently shows `codebase_graph_not_indexed` soft-failure if Graphify hasn't been run — that's fine, we tell the user *exactly* how to fix it). When indexed, it renders symbol-level dependencies with Leiden community clusters.

**You say:** *"Cold-start solution. When this is populated, an agent asking 'where is `Storage` defined and what depends on it?' gets sub-second answers. ADR-010 — reader is shipped, producer is the next slice."*

**Why this matters:** Single dashboard for the whole system. Operator stays in the browser, doesn't need a terminal to know what's happening.

---

## Phase 10 — Close (60 seconds)

**Back to the audience, no terminal:**

> "Four things you saw, in 18 minutes:
>
> **One** — Claude knew the project from second one. Feature Pack on disk, auto-injected at SessionStart. No 'let me explain the codebase' tax, ever.
>
> **Two** — The bridge actually blocked the `.env` write. Real policy enforcement. Append-only audit table answers SOC 2 and CISO questions in one SQL line.
>
> **Three** — A new Claude session 30 seconds later remembered the storage decision because we shipped intents and the durable decisions log this week. That's cross-session memory, structured.
>
> **Four** — The web app is a single pane of glass over runs, decisions, intents, packs, policies, kill switches, and doctor. Operator never needs a terminal.
>
> Coodra works with any MCP-compatible agent — Claude Code today, Cursor and Windsurf already work, every other one tomorrow. Solo install is a single npm command and one `coodra init`. Team mode adds a managed cloud Postgres + sync daemon for shared org state — same architecture, no migration. Open source. Local-first. Your code never leaves the machine until you opt in.
>
> The audit suite I keep mentioning isn't future work — Phase A, B, C all shipped this week. Phase D is the audit-as-you-go program: every doctor check, every CI guardrail, every schema-parity test gets added the morning after we debug a problem. The system gets harder to break, and we never lose progress to regression."

**Open the floor for questions.**

---

## Recovery scripts (if something breaks live)

| Symptom | 30-second fix |
|---|---|
| `/mcp` shows nothing in Claude Code | `Cmd+Q` Claude Code, reopen. The `.mcp.json` change requires IDE restart. |
| `coodra start` says "already running" | `coodra stop && coodra start` |
| Policy deny doesn't fire | Pane B will show why. `sqlite3 ~/.coodra/data.db "SELECT count(*) FROM policy_rules"` should be **25**, not less. |
| Claude doesn't auto-call MCP tools | Be more explicit in the next prompt: *"Before answering, check the Feature Pack."* Tool descriptions are written for *natural* triggering but stakeholders won't know if you nudge. |
| Web app shows "Status unknown" | The doctor report failed to run. `coodra doctor` from a terminal — the error message is verbatim. Most common cause: daemons aren't started. |
| `coodra pause` locks you out of typing | Phase A.1 fix landed — `--scope` defaults to `project` from cwd. If you somehow still hit a global lock, open a new terminal and `coodra resume --id <ks_id>` (the install at `/Users/abishaikc/Coodra/...` is unaffected by the project's own switch). |

If something catastrophic happens and live demo dies, **fall back to the architecture itself**: walk through the .mcp.json, the Feature Pack, the audit tables. The system is the demo even without a running agent.

---

## Appendix — what this demo deliberately does NOT show

Stakeholders sometimes ask "but what about X?" Answers ready:

- **Team mode (cloud Postgres, sync daemon, multi-developer org state)** — same architecture, opt-in switch. Skipped because solo mode shows the value prop without cloud complexity.
- **Outbox + durable audit (Module 03.1)** — runs invisibly. Mention it if asked: every audit write goes through `pending_jobs` first, the OutboxWorker drains it. SIGTERM mid-handler still produces the audit row on next boot. That's why we never lose data.
- **Graphify producer** — reader ships today, producer is the next slice. The graph view soft-fails with a *clear remediation hint* (`npm i -g graphify && graphify scan`). The audit found this; we wrote the inline hint.
- **GitHub / JIRA integration tools** — manifest space exists (sections §22, §23), implementations are scoped. Mention as roadmap.
- **VS Code extension (Module 07)** — depends on web admin (this demo) + CLI (this demo). On the roadmap.
- **Web App is staging-fresh, may have rough edges** — set expectations early. Quote: *"the agent governance is production-shape; the operator UI is hand-built UX in active iteration."*

---

## Appendix — exact terminal layout cheat-sheet (print this if helpful)

```
┌──────────────────────────────────┬──────────────────────────────────┐
│  Pane A — Commands               │  Pane C — Claude Code            │
│  cd ~/taskforge-demo             │  (IDE open in ~/taskforge-demo/) │
│  $ _                             │  /mcp                            │
│                                  │  > prompt 1                      │
│                                  │  > prompt 2 ...                  │
├──────────────────────────────────┼──────────────────────────────────┤
│  Pane B — Live hooks log         │  Pane D — Web App                │
│  coodra logs hooks --follow   │  http://localhost:3000           │
│  ▸ pre_tool_use_decision         │  [Project picker]                │
│  ▸ session_start_recorded        │  [taskforge-demo →]              │
│  ▸ feature_pack_injected         │                                  │
└──────────────────────────────────┴──────────────────────────────────┘
```

Pane B and Pane D are the *visual upgrade*. Without them, you can still run the demo — but the audience sees commands and prose only, not the system breathing.

---

## Phase-by-phase timing budget

| # | Phase | Time | Cumulative |
|---|---|---|---|
| 0 | Hook | 0:45 | 0:45 |
| 1 | Install + scaffold review | 1:30 | 2:15 |
| 2 | Doctor X-ray | 1:00 | 3:15 |
| 3 | Open Claude Code → Feature Pack handover | 1:30 | 4:45 |
| 4 | Live build + intent tracking | 3:00 | 7:45 |
| 5 | Policy enforcement money shot | 1:30 | 9:15 |
| 6 | Kill switch panic button | 1:30 | 10:45 |
| 7 | Continue build + auto Context Pack | 1:00 | 11:45 |
| 8 | Cross-session memory | 1:30 | 13:15 |
| 9 | Web App tour (8 sub-stages) | 4:00 | 17:15 |
| 10 | Close | 1:00 | 18:15 |

**Q&A buffer: 3 minutes.** If a single question lands at 18:15, you have time to handle it cleanly without bleeding past 22 minutes total.

---

## Pre-prompt one-liner (rehearse this!)

If a stakeholder interrupts at any point with *"in plain English, what's this thing?"* — you stop the demo and say:

> "Coodra makes AI coding agents enterprise-safe. Three things: it gives agents persistent project context they don't already have, it enforces real policy on every tool they call — not advice, actual blocks — and it produces a queryable audit trail of every decision they make. Local-first, works with any MCP-compatible agent, single command to install."

Memorize that. It's the answer when the demo gets paused.
