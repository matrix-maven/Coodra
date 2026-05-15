# TROUBLESHOOTING.md — If something breaks live

> Every fix here is < 30 seconds. Do them silently while talking through whatever's already on screen.

---

## `/mcp` shows nothing in Claude Code

**Cause:** The IDE was open before `.mcp.json` existed, so the MCP subprocess wasn't spawned.

**Fix:**
```bash
# In Claude Code: Cmd+Q to fully quit
# Then reopen Claude Code in ~/taskforge-demo/
# Run /mcp again
```

**While you wait, say:** *"Claude Code is restarting to pick up the MCP config — takes about 5 seconds."*

---

## `coodra start` says "already running"

**Cause:** Daemons from a prior demo are still up.

**Fix:**
```bash
coodra stop
coodra start
```

---

## `coodra doctor` shows red checks

**Most common red:** `__global__ sentinel project missing` or `data.db not at head`.

**Fix:**
```bash
# Re-run init from inside the project dir — idempotent, fixes both
cd ~/taskforge-demo
coodra init
coodra doctor
```

---

## `coodra doctor` shows a yellow on `~/.coodra/` permissions

**Fix:**
```bash
chmod 0700 ~/.coodra
```

This is cosmetic — not blocking the demo. You can skip the fix and just say *"yellow is informational, not blocking — proceed."*

---

## Policy deny doesn't fire when Claude tries to write `.env`

**Cause 1:** No policy rules seeded.

**Check:**
```bash
sqlite3 ~/.coodra/data.db "SELECT COUNT(*) FROM policy_rules;"
```

Should return 9. If it returns 0:
```bash
cd ~/taskforge-demo
coodra init   # idempotent, re-seeds the default policy
```

**Cause 2:** The Hooks Bridge isn't intercepting.

**Check pane B (logs):** are tool-call events showing up at all? If pane B is silent during Claude activity, the hooks aren't firing.

**Fix:**
```bash
coodra stop
coodra start
coodra doctor
```

If still broken, restart Claude Code (Cmd+Q + reopen).

---

## Claude doesn't call MCP tools naturally

**Cause:** Some prompts don't trigger tool calls; Claude answers from general knowledge.

**Fix:** Be explicit. Add to the prompt: *"Use the get_feature_pack tool to look this up."* or *"Check the feature pack first, then answer."*

The audience won't know the difference. Ship it.

---

## Pane B (logs) is empty even when Claude is working

**Cause 1:** Logs file doesn't exist yet.

**Check:**
```bash
ls -la ~/.coodra/logs/
```

Should show `hooks-bridge.log` and `mcp-server.log`. If missing, the daemons aren't writing — `coodra stop && coodra start`.

**Cause 2:** `--follow` is reading from the wrong file.

**Fix:**
```bash
# Manual tail as fallback:
tail -f ~/.coodra/logs/hooks-bridge.log
```

---

## Cross-session memory test (Prompt 5) returns nothing

**Cause:** Session 1 didn't actually save a Context Pack.

**Check:**
```bash
ls -la ~/taskforge-demo/docs/context-packs/
```

Should have a recent file. If empty:
```bash
sqlite3 ~/.coodra/data.db "SELECT title, created_at FROM context_packs ORDER BY created_at DESC LIMIT 3;"
```

If both are empty, the SessionEnd hook didn't fire. Workaround: in Session 2, ask Claude *"Use the query_run_history tool to look up recent runs and decisions on this project."* — `query_run_history` reads from `runs` + `decisions` tables which DO populate even without an explicit pack save.

---

## Audience asks "what about [Cursor / Copilot / Codex]?"

**Honest answer:** *"Same architecture. Cursor uses `.cursor/hooks/` and `~/.cursor/mcp.json`; Windsurf uses `~/.windsurf/`. The Hooks Bridge has a normalized webhook that any MCP-aware agent can hit. Today's demo is Claude Code because that's what I have on this machine — the same flow works for the others."*

---

## Audience asks "is this open source?"

**Honest answer:** *"Yes. The repo is at [your GitHub URL]. Solo mode is free forever, runs locally, your code never leaves the machine. Team mode is the hosted coordination layer for sharing context across an engineering org."*

---

## Audience asks "what's the storage backend?"

**Honest answer:** *"SQLite locally — every developer's machine has its own primary store at `~/.coodra/data.db`. Even in team mode, your code and your audit data stay on your machine; the cloud Postgres is a sync target for cross-team visibility, not a primary store. That's the local-first architecture — the answer to every CISO who'll ask 'where does my code go?'."*

---

## Audience asks "how does this scale?"

**Honest answer:** *"Solo: single SQLite file, sub-millisecond reads, handles 100s of MCP calls per second. Team: hosted Postgres + pgvector + Upstash Redis, designed for 10–100 dev teams per tenant. Enterprise: dedicated tenant available."*

---

## If you're going to crash hard

**Pivot to:** walk through the code in the IDE.

- Open `~/taskforge-demo/docs/feature-packs/taskforge-demo/spec.md` — *"This is what Claude reads at session start."*
- Open `~/taskforge-demo/.mcp.json` — *"This is how Claude Code finds the MCP server."*
- Run `sqlite3 ~/.coodra/data.db ".tables"` — *"This is the data plane: 11 tables, append-only audit, sqlite-vec for semantic search."*
- Show the open Coodra repo on GitHub — *"And this is the architecture, fully open."*

The architecture itself is the demo even if live agent activity fails.

---

## After-demo recovery

```bash
bash /Users/abishaikc/Coodra/presentation/teardown.sh
```

Clean slate. Run `setup.sh` again to redo the demo.
