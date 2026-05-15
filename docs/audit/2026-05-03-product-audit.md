# Coodra — Product audit, 2026-05-03

> **Scope.** Read-only end-to-end exercise of the live local install against `~/taskforge-demo`. Every finding is backed by a tool result, DB query, log excerpt, or config-file read. No code, tests, or schema were modified during this audit.
>
> **Branch under audit.** `feat/phase4-fix-f-policy-tool-coverage` (HEAD `a638dca`). The fix branch is checked out locally but **NOT merged to `main`**. Where production behavior diverges from this branch, the report calls it out explicitly. The bundled CLI runtime (`packages/cli/dist/runtime/mcp-server/index.js`) the demo's `.mcp.json` invokes was last built `2026-05-02 17:23` — i.e. **before** Phase 4 Fix F's source edits. Real Claude Code sessions therefore exercise pre-Fix-F code today.
>
> **Testbed.** `~/taskforge-demo` was last set up via `presentation/setup.sh` at 14:02 today. SQLite store at `~/.coodra/data.db`. Hooks bridge listening on `127.0.0.1:3101` (PID 71801, uptime ~30 min as of test).

---

## §1 Executive summary

**Is this shippable today?** **No** — not as the "agent-governance product" it claims to be, and **not yet** for any audience that expects PreToolUse policy enforcement to actually fire when a Claude Code agent runs `Edit` against `.env`. The implementation underneath is real and the MCP-tool surface works end-to-end. But the *integration boundary* between Claude Code and Coodra is broken in production: the `~/.claude/settings.json` matcher is a literal sentinel that doesn't match any real Claude Code tool, so PreToolUse and PostToolUse events for the agent's actual file-mutating calls **never reach the bridge** in a real session. The bridge logs from real Claude Code activity in this testbed show 33 `turn_end` events and **0** PreToolUse / PostToolUse events from real sessions. Fix F branch addresses this; not merged.

That said: this product is **shippable today as a single-developer Feature-Pack injector + manual-decision-recorder for Claude Code**, where `SessionStart` Feature-Pack injection and `record_decision`-via-MCP are the genuine value. Those work cleanly, end-to-end, with no defects observed. That's a real (narrow) audience — a solo dev who wants project context auto-injected into every Claude Code session and a structured decision log they can grep later.

It is **not** shippable as the broader "policy enforcement / governance / cross-agent coordination" product the architecture spec describes.

### Top 3 BROKEN

1. **Production hook matcher (`__coodra__` sentinel)** — Claude Code's PreToolUse / PostToolUse hooks never fire because the matcher field is a regex over tool names and `'__coodra__'` matches no real tool. Evidence in §3.2.
2. **Default policy missing tool coverage** — `ensureDefaultPolicy` (the seed every fresh install gets) covers only `Write`/`Edit`; `MultiEdit` / `NotebookEdit` against `.env` / `.git/` / `node_modules/` slip through with `permissionDecision: "allow"`. Reproduced in §2 tool 8c. Fix F branch addresses it; not merged.
3. **Auto-saved Context Pack omits decisions** — the bridge's SessionEnd auto-pack writes an event-digest (writes/edits counts, files touched), not the decision body. A new session calling `search_packs_nl` cannot retrieve "what was decided" from prior sessions. Evidence in §3.4 + §3.5.

### Top 3 GROUND-LEVEL LIMITS

1. **`search_packs_nl` is LIKE-substring single-project** — pre-M05 fallback is `WHERE content_excerpt LIKE %query%` scoped to one project. A query like `"audit synthetic"` returns zero results when the words aren't contiguous. Cross-project search isn't supported. Until M05 NL Assembly lands (no spec doc exists), the agent has no real semantic-recall path. Evidence in §2 tool 5 + §3.5.
2. **No MCP tool reads the `decisions` table** — `record_decision` writes; nothing else exposes them via MCP. A new session asking "what did we decide last week?" has no path other than `search_packs_nl` (which only matches packs, not decisions, and which is broken per item 1). Decisions live in the DB but are write-only from the agent's perspective. Evidence in §3.5.
3. **Auto-Context-Pack is DB-only, never materialized to filesystem** — `bridge auto-save → context_packs` row lands; `~/.coodra/packs/<runId>.md` is **not** written. Compare with manual `save_context_pack` which writes both. Means `git`-based replay / external review / CI exports of "what happened in run X" don't work for autonomously-saved packs. Evidence in §3.4.

### Top 3 HIGH-VALUE OPPORTUNITIES

1. **Surface the `decisions` table via MCP** — a `query_decisions` tool that returns recent decisions for a project (or by text search) would close the cross-session memory gap immediately, with hours of work, without needing M05.
2. **Materialize bridge auto-packs to filesystem + include decision body** — would make every session's record `git`-able / `grep`-able, complete with the rationale, not just event counts.
3. **Replace `__coodra__` matcher with an explicit tool-name regex** AND ship a one-shot `coodra repair` (or self-healing init) so existing installs migrate. Fix F branch does the matcher half; the repair UX is what makes existing installs viable without the user knowing they're broken.

---

## §2 Tool-by-tool audit

Harness: `/tmp/audit-2026-05-03/harness.mjs` (stdio MCP client against the demo's bundled runtime). Full responses in `/tmp/audit-2026-05-03/findings2.json`. Side effects verified via `sqlite3 ~/.coodra/data.db` and `ls ~/.coodra/packs/`.

| # | Tool | Input shape | Returned shape | Side effect verified | Classification |
|---|---|---|---|---|---|
| 1 | `ping` | `{}` | `{ ok: true, pong: true, serverTime, sessionId, idempotencyKey }` | none expected | ✅ **WORKS** |
| 2 | `get_run_id` | `{ projectSlug:'taskforge-demo', agentSessionId, agentType }` | `{ ok:true, runId:'run:ae2b09c5...:audit-...:...', startedAt }` | new `runs` row landed (`status='in_progress'`) ✓ | ✅ **WORKS** |
| 3 | `get_feature_pack` | `{ projectSlug:'taskforge-demo' }` | `{ ok:true, pack:{ metadata, content:{ spec, implementation, techstack, sourceFiles } }, subPack:null, inherited:[] }` | reads from disk (`docs/feature-packs/taskforge-demo/`) — content matches | ✅ **WORKS** |
| 4 | `save_context_pack` | `{ runId, title:'AUDIT 2026-05-03 — synthetic test pack', content }` | `{ ok:true, contextPackId:'cp_b5108940-...', savedAt, contentExcerpt }` | row in `context_packs` ✓ AND filesystem `~/.coodra/packs/2026-05-03-run-ae2b09c5-624.md` (121 bytes) ✓ | ✅ **WORKS** |
| 5 | `search_packs_nl` | `{ projectSlug:'taskforge-demo', query:'phase 4 fix coverage', limit:3 }` | `{ ok:true, packs:[], notice:'no_embeddings_yet', howToFix:'Module 05 …' }` | none — read-only | ⏳ **PLANNED-FUTURE** (M05 NL Assembly — no spec doc on disk) |
| 6 | `record_decision` | `{ runId, description:'AUDIT 2026-05-03 — synthetic decision …', rationale, alternatives:['skip the test', 'use a different run id'] }` | `{ ok:true, decisionId:'dec_aec5c8ae-...', createdAt, created:true }` | row in `decisions` table ✓ | ✅ **WORKS** |
| 7 | `query_run_history` | `{ projectSlug:'taskforge-demo', limit:5 }` | `{ ok:true, runs:[…4 runs…] }` (returns audit run + 3 prior `taskforge-demo` runs) | none — read-only | ✅ **WORKS** |
| 8a | `check_policy` | `{ projectSlug, sessionId, agentType:'claude_code', eventType:'PreToolUse', toolName:'Write', toolInput:{file_path:'.env'} }` | `{ ok:true, permissionDecision:'deny', matchedRuleId:'091025a8-...', reason:'writes to .env are denied …' }` | row in `policy_decisions` ✓ | ✅ **WORKS** |
| 8b | `check_policy` | same shape, `toolName:'MultiEdit', file_path:'apps/web/.env'` | `permissionDecision:'deny', matchedRuleId:'766c4346225c7a528d5d8a853cee9809'` | row in `policy_decisions` ✓ | ✅ **WORKS** — but the matched rule was hand-INSERTed by `presentation/setup.sh` via raw SQL, NOT by `ensureDefaultPolicy` (see §5c) |
| 8c | `check_policy` | same shape, `toolName:'NotebookEdit', file_path:'.git/HEAD'` | `permissionDecision:'allow', matchedRuleId:null, reason:'no_rule_matched'` | row in `policy_decisions` (recording the allow) ✓ | ❌ **BROKEN** — Phase 4 Fix F gap. Default rule list misses `NotebookEdit` entirely, and setup.sh's hand-patch only covers `**/.env`, not `.git/**`. |
| 9 | `query_codebase_graph` | `{ projectSlug:'taskforge-demo', query:'auth handler' }` | `{ ok:true, ok:false, error:'codebase_graph_not_indexed', howToFix:'run \`graphify scan\` at repo root' }` | none — soft failure | ⏳ **PLANNED-FUTURE** — graphify integration is documented but no `graphify` index exists for the demo project; documented soft-failure shape works correctly |

**Inner-`ok` discriminated-union note (per `09-common-patterns.md` §9.1.2):** every tool returns a `{ ok: <transport>, data: { ok: <domain>, … } }` shape. Both ok-checks are required. The 9-tool surface honors this consistently. My harness's first run failed because I read `parsed.runId` instead of `parsed.data.runId` — a documented contract pitfall, surfaced exactly as the spec warned.

---

## §3 Lifecycle audit

### §3.1 SessionStart — Feature Pack injection

- **Synthetic test (POST `/v1/hooks/claude-code` with `hook_event_name:'SessionStart'`)** returned `{ ok:true, hookSpecificOutput:{ permissionDecision:'allow', additionalContext:<13383 bytes> } }`. The `additionalContext` body verbatim contains `# Coodra Feature Pack — taskforge-demo` followed by the project's `spec.md` + `implementation.md` + `techstack.md` inlined.
- Bridge log: `event:"session_start_recorded", projectId:"ae2b09c5-...", projectSlug:"taskforge-demo", additionalContextBytes:13383` at `2026-05-03T09:00:51.067Z`.
- Side effect: a `runs` row was opened with `status='in_progress'` for `audit-bridge-2026-05-03`.

**Classification: ✅ WORKS** end-to-end at the bridge level. Pattern 20 (decision `dec_83ba10c1`) is real and load-bearing.

**But:** in real Claude Code sessions today, `~/.claude/settings.json` *does* register the SessionStart hook (matcher field is irrelevant for non-tool events), so SessionStart firing in real sessions is also confirmed: 6 distinct sessionIds visible in the bridge log over the last 23 hours, all from `claude_code` agent.

### §3.2 PreToolUse — Write / Edit / MultiEdit / NotebookEdit

- **Synthetic test:** PreToolUse for `Write→.env` returned `permissionDecision:"deny"` with `matchedRuleId:"091025a8-0744-461c-9fdd-f1e3678ec752"` (the seeded `Write→.env` rule from `ensureDefaultPolicy`). Bridge log `pre_tool_use_decision` event confirms the run was `run:ae2b09c5-...:audit-bridge-2026-05-03:b5668883-...`.
- PreToolUse for `NotebookEdit→.git/HEAD` returned `permissionDecision:"allow"` with `matchedRuleId:null` and `reason:"no_rule_matched"`.
- **Real Claude Code traffic (production today):** `grep '"eventPhase":"pre"' ~/.coodra/logs/hooks-bridge.log` shows **2 events total**, both from a verification harness on May 2 09:14 (`projectSlug:"stranger-app"`, sessionId `t4-verify-strict-...`) — NOT from real Claude Code sessions. The 33 `turn_end` events from real Claude Code in the same period have NO matching `pre` events.

This is the matcher problem in action. The `~/.claude/settings.json` PreToolUse entry has `matcher: "__coodra__"`. Per Claude Code's hook spec the matcher field is a regex on tool name; the literal string `__coodra__` matches no real tool name, so the hook never fires. Quoted from `~/.claude/settings.json:13` (live machine state):

```json
"PreToolUse": [{ "matcher": "__coodra__", "hooks": [{ "type":"http", "url":"http://127.0.0.1:3101/v1/hooks/claude-code", … }] }]
```

**Classification: ❌ BROKEN** for real Claude Code traffic; ✅ WORKS for synthetic / non-Claude-Code agents (Cursor / Windsurf POST directly without going through the matcher).

Phase 4 Fix F branch fixes this (per-event matcher: `Write|Edit|MultiEdit|NotebookEdit|Bash` for tool events; omitted for SessionStart/Stop). **Not merged.**

### §3.3 PostToolUse — recording to `run_events`

- **Synthetic test:** POST `PostToolUse` for `Write→src/foo.ts` returned `{ ok:true, hookSpecificOutput:{ hookEventName:'PostToolUse', permissionDecision:'allow' } }`. Bridge log: `event:"post_tool_use_recorded", turnId:"tu-post"`.
- DB verified: `SELECT phase, tool_name FROM run_events WHERE run_id=…` returned `phase='post', tool_name='Write'` ✓.
- **Real Claude Code traffic:** `run_events` table has **0 rows from real Claude Code agent activity** in the demo. The only run_events row that exists is the synthetic one I just generated. Same matcher gate as §3.2 — PostToolUse never reaches the bridge from Claude Code in production.

**Classification: ❌ BROKEN** for real Claude Code traffic (matcher issue); ✅ WORKS for synthetic. Same root cause as §3.2.

### §3.4 SessionEnd / Stop — runs.status flip + auto-Context-Pack

- **Synthetic test SessionEnd:** Returned 200 ok. Bridge log: `event:"auto_context_pack_saved", runId, contextPackId:"cp_07271a1a-...", eventCount:1, decisionCount:0, contentBytes:721`.
- DB verified: `runs.status='completed'` and `runs.ended_at` set ✓. `context_packs` row exists with title `"Auto-saved session run:ae2b09c5-..."` and 721-byte content ✓.
- Pack content (full): event-digest format with counts (events recorded / writes-edits / reads-greps / shell-commands / policy denies) and a "Files touched" bullet list. **No decision body is included** — even a session with N decisions writes a pack reporting only `decisionCount: N` in the bridge log, not the actual decision rows. The auto-pack content prose has no section listing the decisions.
- **Filesystem materialization:** `ls ~/.coodra/packs/` shows TWO files — both manually saved via MCP `save_context_pack` (one from May 2, one from my harness today). The auto-saved pack `cp_07271a1a-...` exists in the DB but **NOT on the filesystem**. Compare to manual-save which DOES write to filesystem.
- **Real Claude Code traffic:** Stop hooks DO fire for real sessions (matcher field is documented as not applying to Stop events). Bridge log shows `turn_end` events for 6 different sessionIds. **But:** querying `runs` table shows that `taskforge-demo`'s 3 most recent runs (since May 2 23:18) are all `status='in_progress'` with `ended_at=NULL`. The Stop hook logs `event:"hook_ingress", eventPhase:"turn_end"` but the `runs.status` is NOT being flipped to `completed` for these sessions. (Earlier `proj_da379e0` sessions DID complete cleanly. Something regressed between then and the May 2 23:18 demo sessions — possibly that the Stop adapter routes to phase `turn_end` which is plain-ack-only per `dispatch.ts`, not `session_end` which triggers the pack-save + status-flip; the bridge only flips status on `SessionEnd`, not on `turn_end`/`Stop`.)

**Classification:** Auto-pack save: ✅ WORKS (DB), ❌ BROKEN (filesystem materialization missing). Decisions in pack content: ❌ BROKEN-vs-design (the bridge has decision counts but doesn't enumerate them in pack body — see §5c). Status flip on real Claude Code Stop: ❌ BROKEN — Stop maps to `turn_end` which is plain-ack-only; `runs.status` never advances past `in_progress`.

### §3.5 Cross-session — "what did we decide?"

Tested by:
- `query_run_history` from a fresh stdio session — returns the runs but **no decision content inline**, only `runId / startedAt / endedAt / status / title / issueRef / prRef`.
- `search_packs_nl projectSlug='taskforge-demo' query='audit synthetic'` — returns `packs: [], notice: 'no_embeddings_yet'`. The audit pack title contains "synthetic" and content has "audit" but the LIKE substring match `%audit synthetic%` fails because the words aren't contiguous.
- Same query with single-word `'session'` against `taskforge-demo` returns 1 pack (the auto-saved one matching "session" in title).
- Same query `'phase 2'` against `taskforge-demo` returns 0 (no taskforge-demo pack mentions Phase 2).
- Same query `'phase 2'` against `coodra` returns 1 (the Phase 3 pack mentions Phase 2 in body).
- `decisions` table has 8 rows (incl. the synthetic one I just wrote). **No MCP tool exposes these rows.** The agent can write decisions via `record_decision` but cannot read them back through any documented MCP path.
- Of the 4 packs in the DB, only 2 reference decisions in their content (the 2 manually-saved Phase-2 / Phase-3 packs that included narrative text). The 2 auto-saved packs don't contain decision bodies.

**Classification: ❌ BROKEN** — the user's question "Does the new session find prior decisions through any path?" — answer: **no path that's documented as a feature**. The agent could `get_feature_pack` to load the static spec/impl/techstack files (those don't contain session-level decisions). `search_packs_nl` LIKE-fallback might surface a pack that mentions a decision *if* the agent guesses the right substring AND the pack was manually authored to include decision text.

This is a real cross-session continuity gap. The architecture promises that "decisions are append-only history" (`11-adrs.md` ADR-007) but the read-path is incomplete.

---

## §4 Soft-failure shape audit

Canonical shape per `09-common-patterns.md §9.1.2`: `{ ok: false, error: '<stable_code>', howToFix: <string min(1)> }`.

| # | Code | Trigger used | Returned shape | Match? |
|---|---|---|---|---|
| 1 | `project_not_found` | `get_run_id projectSlug='this-project-definitely-does-not-exist-2026'` | `{ ok:false, error:'project_not_found', howToFix:'Register the project via the CLI (\`coodra init\`) or verify the slug matches an existing entry in the projects table.' }` | ✅ **canon** |
| 2 | `run_not_found` | `save_context_pack runId='run:bogus-project:bogus-session:00000000-0000-0000-0000-000000000000'` | `{ ok:false, error:'run_not_found', howToFix:'Call get_run_id first to create a run for this session, then retry save_context_pack with the returned runId.' }` | ✅ **canon** |
| 3 | `pack_not_found` | `get_feature_pack projectSlug='this-pack-does-not-exist-anywhere'` | `{ ok:false, error:'pack_not_found', howToFix:'Register the pack via docs/feature-packs/<slug>/{spec,implementation,techstack}.md + meta.json, or proceed with default conventions if this slug is intentionally unregistered.' }` | ✅ **canon** |
| 4 | `feature_pack_cycle` | (NOT TESTED — would require disk mutation; out of read-only scope) | n/a | ⚠️ **untested** |
| 5 | `codebase_graph_not_indexed` | `query_codebase_graph projectSlug='taskforge-demo'` (the demo has no graphify index) | `{ ok:false, error:'codebase_graph_not_indexed', howToFix:'run \`graphify scan\` at repo root' }` | ✅ **canon** |

Bonus observation: `query_codebase_graph projectSlug='this-project-has-no-graph-2026'` (non-existent project) short-circuits to `project_not_found` rather than `codebase_graph_not_indexed`. Reasonable precedence — project existence is the more general invariant.

**Classification: ✅ WORKS** for the 4 testable codes. `feature_pack_cycle` is untested in this audit (would require writing a `meta.json` with a self-referential `parentSlug`). I have no reason to suspect it's broken; just couldn't trigger it read-only.

---

## §5 Roadmap delta

### §5a CONFIRMED PLANNED — gaps explicitly scoped in a future module/slice

| Gap (observed) | Owning module / slice | Cite |
|---|---|---|
| Real semantic search via `summary_embedding` (currently LIKE-fallback) | **M05 NL Assembly** | `08b-cli-expansion/spec.md:51` ("No `feature_pack_section_usage` table. Same reason as quality signals: needs M05 to populate"); the `search_packs_nl` `howToFix` itself names "Module 05 (NL Assembly) will populate summary_embedding on save". |
| `feature_pack_section_usage` table (which sections of a pack the agent referenced) | **M05 NL Assembly** | `08b-cli-expansion/spec.md:179` ("populating it requires NL Assembly hooks (M05) to detect section references in agent output"). |
| Web App admin surfaces (`policy list / policy add / project reset / run cancel`) | **M04 Web App** + **M08b CLI Expansion** for the CLI parallel | `08b-cli-expansion/spec.md:6` ("M04 Web App will eventually expose admin surfaces parallel to `policy/project/run/export`"). |
| Cross-agent shared state surfacing (admin sees "dev A's agent edited X 3 minutes ago") | **M04 Web App** + hooks-bridge enrichment | `08b-cli-expansion/spec.md:36` ("cross-agent shared state surfacing lands in **M04 Web App**"). |
| Codebase graph (graphify integration) | Owner unclear — `system-architecture.md` mentions Graphify but no feature-pack folder exists for it | `query_codebase_graph` is shipped as a soft-failure-aware tool, but no module owns building the index. |
| Phase 4 Fix F (matcher + default policy expansion) | **In flight** on `feat/phase4-fix-f-policy-tool-coverage` (commit `a638dca`); awaiting review/merge | `08a-cli/implementation.md:311` (Phase 4 Fix F entry). |

### §5b SHOULD BE PLANNED BUT ISN'T — gaps that fell through the planning cracks

| Gap | Why it matters | Recommended owner |
|---|---|---|
| **No MCP tool to query the `decisions` table.** | `record_decision` writes; nothing exposes them. A new session has no path to "what did we decide last week" except a flaky LIKE on `search_packs_nl`. The architecture's claim that decisions are durable history is only half-true if the read path doesn't exist. | New M02 follow-up slice (`query_decisions` MCP tool). Estimated <200 lines; same shape as `query_run_history`. |
| **Auto-Context-Pack does not materialize to filesystem.** | Manual `save_context_pack` writes both DB and `~/.coodra/packs/<runId>.md`. Bridge auto-save writes only DB. Operators / CI / git-based replay can't see autonomous packs. | M03 follow-up (small fix — auto-save handler should call the same store path manual save uses). |
| **Auto-Context-Pack content omits decision bodies.** | The pack has aggregate counts but no decision rationale / alternatives. A new session reading prior packs sees "decisionCount: 3" but not what the 3 decisions were. | Same M03 follow-up — assemble pack body from `events ∪ decisions`, not events alone. |
| **`runs.status` doesn't flip to `completed` on real Claude Code Stop.** | Real sessions go `pending → in_progress → in_progress` forever. The 3 most recent `taskforge-demo` runs are stuck `in_progress`. The bridge maps Claude Code Stop → `turn_end` (plain-ack-only). Status-flip only fires on `session_end`. The Claude Code adapter routes Stop to the wrong phase OR the dispatcher needs to flip status on either phase. | M03 / Phase-4 follow-up — adapter mapping or dispatcher logic. |
| **`presentation/setup.sh` patches `policy_rules` via raw SQL.** | The setup script openly acknowledges the default policy is broken and INSERTs missing rules directly into SQLite. It's also non-idempotent (each re-run inserts 3 more duplicate rows; the demo has 9 priority-1 rules where it should have 3). This is a workaround for the Phase-4-Fix-F bug AND a setup-script defect. | Phase 4 Fix F merge fixes the underlying need; setup.sh should drop §5b once Fix F lands. Separate setup.sh idempotency fix needed regardless. |
| **MCP server log is in a 42 MB EADDRINUSE crash loop.** | `~/.coodra/logs/mcp-server.log` shows the daemon repeatedly failing to bind 127.0.0.1:3100 because PID 25612 (a stale `pnpm --filter` dev process running 23 hours) already holds it. Daemon manager has been retrying continuously. Operational pain; will exhaust disk on a long-running dev box. | M08a follow-up — `coodra start` should detect existing-port-owner before launching, OR `doctor` should flag this case. M08b S18 doctor checks could cover. |
| **`search_packs_nl` LIKE fallback is contiguous-substring + single-project.** | Even within the constraints of the deferred M05 work, the fallback is unhelpful for multi-word queries. Tokenizing on whitespace and AND'ing the matches would buy real value for the LIKE codepath alone. | M02 follow-up slice (small — a few lines in the SQLite query builder). |

### §5c BROKEN VS DOCUMENTED — implementations that don't match their own spec docs

#### C1. `claude-settings-merge.ts` — matcher value contradicts hook spec

**Doc claim** (`packages/cli/src/lib/init/claude-settings-merge.ts:42-43`, pre-Fix-F): "Idempotency: every Coodra entry uses the matcher `__coodra__`. The merger finds entries whose matcher matches that sentinel and replaces them, leaving every other user-authored entry untouched."

**Actual behavior** (live `~/.claude/settings.json` on this machine): the matcher IS `__coodra__` for all four events, but per Claude Code's hook spec the matcher field on PreToolUse / PostToolUse is a *regex over tool names* — the sentinel matches no real tool, so the hook never fires for Claude Code's tool-call events. **The architecture spec assumed the matcher was an arbitrary tag; the runtime treats it as a regex.** The merger contract was logically sound; the behavior is broken.

Fix F branch addresses this by giving tool events a real tool-name regex matcher (`Write|Edit|MultiEdit|NotebookEdit|Bash`) and switching ownership detection from matcher-equality to URL-equality.

#### C2. `ensureDefaultPolicy` — claimed "deny dangerous writes" but only covers Write/Edit

**Doc claim** (`packages/db/src/ensure-default-policy.ts:12-19`, pre-Fix-F): "Phase 3 Fix D — pre-Phase-3 init created the project row but inserted zero `policy_rules`. The MCP `check_policy` evaluator returned `'allow'` for everything because no rule ever matched. Result: destructive writes (.env, .git/**, node_modules/**) and dangerous Bash commands (rm -rf /, git push --force) sailed through. Fix D seeds a default Policy named `'__default__'` with the rules listed below."

**Actual behavior** (synthetic test 8c, also reproduced in `policy_decisions` audit log): NotebookEdit on `.git/HEAD` returns `permissionDecision: "allow"`. The seeded rule list covers only `Write` / `Edit` × 4 globs; MultiEdit and NotebookEdit are absent. Real Claude Code agents use all four tool names. **Phase 3 Fix D's claim "destructive writes are denied" is partially false.**

Fix F branch closes the gap (4 tools × 6 globs = 24 deny rules + 1 ask = 25 rules total).

#### C3. Auto-Context-Pack content vs Pattern 20 description

**Doc claim** (`system-architecture.md` §16 Pattern 20): "SessionEnd / Stop hook → bridge generates a structured summary from `run_events` + decisions for the closing run, then calls `contextPack.save(...)` against the same store the MCP `save_context_pack` tool uses."

**Actual behavior** (audit pack `cp_07271a1a-...`, content reproduced in §3.4): the pack body has aggregate counts (events recorded, writes/edits, reads, shell commands, policy denies) and a Files-touched list. The `decisionCount` is logged in the bridge's structured event but the pack body does NOT enumerate the decisions themselves. The implementation summarizes events; it does NOT join with decisions. **"Generates a structured summary from `run_events` + decisions" is half-true — events yes, decisions no.**

Also: filesystem materialization is missing for auto-saves (per §3.4). The doc says "calls `contextPack.save(...)` against the same store the MCP tool uses" — the MCP tool's store writes both DB and filesystem; the bridge's auto-save writes only DB. Either the store has two paths, or the bridge bypasses the filesystem write.

#### C4. `runs.status` lifecycle vs M03 acceptance criteria

**Doc claim** (`docs/feature-packs/03-hooks-bridge/spec.md` AC #15): "Sending `Stop` after `Stop` updates `ended_at` once and is a no-op the second time. `runs.status` transitions: `pending → in_progress` (first PostToolUse) → `completed` (Stop)."

**Actual behavior:** the Claude Code adapter (`packages/shared/src/hooks/adapters/claude-code.ts`) maps `Stop` to phase `'turn_end'`. The bridge dispatcher routes `'turn_end'` to a plain-ack handler (no status update). The status-flip-to-completed code path is only invoked for `'session_end'` phase, which only Claude Code's separate `SessionEnd` event maps to. **Real Claude Code currently sends `Stop` events at end-of-turn, never `SessionEnd` events for the actual session-end** — visible in the bridge log: 33 `turn_end` events vs 0 `session_end` events. Result: 4 `taskforge-demo` runs stuck `in_progress` indefinitely. The M03 spec promises Stop completes a run; the implementation routes Stop to a different phase that doesn't complete it.

---

## §6 What's keeping this at ground level

Opinionated, in priority order:

1. **The matcher bug.** Until Phase 4 Fix F merges (or an equivalent fix lands), every fresh `coodra init` followed by a real Claude Code session produces a settings.json that DOESN'T enforce policy. The product's central claim — "Coodra denies dangerous writes" — is false in production. Fix exists but is on a branch.
2. **The Stop / SessionEnd phase mapping bug.** Even with the matcher fixed, a real Claude Code session's `Stop` events are routed to `turn_end` (plain-ack), never `session_end`. Result: runs never complete, auto-save never fires for real sessions, Context Packs accumulate as orphaned `in_progress` rows. The single most observable symptom of "is the product alive?" is broken.
3. **No MCP path to read decisions.** The whole pitch is "your decisions become persistent history that future sessions can see." With no read tool, a new session cannot find prior decisions reliably. `search_packs_nl` is gated on M05 (no spec doc). This is the heart of the value proposition and is missing.
4. **Auto-pack omits decisions and skips filesystem.** Even when auto-save works (synthetic test), the pack content is an event-count digest. Reading it later is an audit shell, not a memory aid. And without filesystem materialization, there's no way to inspect packs outside SQLite.
5. **No M04 / M05 / M06 / M07 spec docs.** Four of eight planned modules in `essentialsforclaude/08-implementation-order.md` have NO feature-pack folder. The roadmap is still aspirational for the user-facing surfaces (Web App admin, real semantic search, semantic diff, VS Code extension). Until at least M04 admin or M05 semantic search lands, the product is "MCP server + hooks bridge for one developer".
6. **Demo setup script does direct SQL inserts.** When the demo's reproduction recipe needs `INSERT INTO policy_rules` to make the product look like it works, the gap between documented and actual behavior is operational. A user reading setup.sh will know there's a problem.
7. **MCP-server crash loop swallowing 42 MB of logs.** A stale dev process holds port 3100; the daemon manager has retried for 23 hours. `doctor` doesn't catch it. This is the "operationally healthy?" canary, and it's quietly red.

---

## §7 What would make this high-value

Beyond the planned roadmap, ranked by impact-to-effort:

### H1 — `query_decisions` MCP tool (Impact: HIGH / Effort: <1 day)

A single new tool exposing the `decisions` table with a `projectSlug` + `query` (LIKE substring) + `limit`. Same factory pattern as existing tools. Closes the "what did we decide" gap immediately, without M05. Pairs with `record_decision` symmetrically.

### H2 — Decision-aware Context Pack body (Impact: HIGH / Effort: ~1 day)

When the bridge's SessionEnd auto-save assembles the pack, fold the decisions for the run into the body — title + rationale + alternatives. Plus filesystem materialization (the existing manual-save store already does this). Suddenly every session leaves a real durable record.

### H3 — `coodra verify` — runtime invariant checker (Impact: HIGH / Effort: ~2 days)

Doctor-level checks that go beyond "is the binary up?" — actually exercise the loop: write a synthetic SessionStart → assert Feature Pack returned, write a synthetic PreToolUse on `.env` → assert deny lands in `policy_decisions`, write a synthetic Stop → assert run completes. Today's `doctor` doesn't catch the matcher bug because it doesn't actually test enforcement; this would.

### H4 — Migration command for existing installs (Impact: MED / Effort: ~1 day)

`coodra migrate` (or self-healing `init`): detect missing-from-baseline policy rules and add them; detect legacy `__coodra__` matchers and rewrite them. Currently a user upgrading after Fix F merges needs to know to re-run init AND that init's repair logic will fix things. A dedicated upgrade command surfaces this explicitly.

### H5 — "What changed?" pack — git-diff awareness (Impact: HIGH / Effort: ~3-5 days)

Auto-pack today knows files-touched. It does NOT know what those edits actually did. Wiring `apps/semantic-diff` (M06, unplanned) into the pack-assembly path would let auto-saved packs say "added auth middleware to apps/web/src/middleware/auth.ts; renamed `getUser` to `requireUser`" — actual semantic content. This is the difference between a session log and a session memory.

### H6 — Cross-project search (Impact: MED / Effort: ~1 day, gated on H1)

Once `query_decisions` exists (H1), allow it to search across projects ("what did I decide about auth in any project last quarter?"). The architecture pretends each project is independent, but in practice a developer wears one head — cross-project recall is a real value-add.

### H7 — Live policy editor (Impact: MED / Effort: M08b-equivalent, ~1 week)

`coodra policy add --tool MultiEdit --deny --glob 'apps/*/secrets/**'` from the CLI. M08b's spec docs scope this; nothing's built. A solo dev with a shoot-from-the-hip glob would tighten their config in 30 seconds.

### H8 — Slack / GitHub / JIRA integration "in the loop" (Impact: HIGH for teams / Effort: large)

`system-architecture.md §22-§23` describes JIRA + GitHub integrations in detail; no feature-pack folders exist. For solo, low value. For a team, this is "the whole pitch" — agent activity tied to tickets and PRs. Massive effort to build right.

---

## §8 Recommended next-cycle priorities

Five items in proposed order. Each names its bucket, why-now, rough effort, and dependencies.

### Priority 1 — Merge Phase 4 Fix F (BROKEN)

**Why now:** Production today doesn't enforce policy on Claude Code agents — the central claim of the product is false. The fix branch exists, has tests, has a clean per-slice gate. The only blocker is the user's review.

**Effort:** Review only — the work is done. Estimated 30 min for a careful PR review + merge.

**Deps:** None (branch is rebased on main).

**Bucket:** ❌ BROKEN.

### Priority 2 — Fix the Stop → run.status / auto-save lifecycle (BROKEN)

**Why now:** Even with Fix F merged, real Claude Code sessions don't complete runs. The matcher fix only restores PreToolUse / PostToolUse delivery; Stop's phase routing is a separate, smaller bug. The `runs` table accumulates orphaned `in_progress` rows that the demo's three taskforge sessions exhibit (May 2 23:18, May 2 23:28, May 3 14:04 — all stuck).

**Effort:** Small — 1-2 days. Likely a single change in `packages/shared/src/hooks/adapters/claude-code.ts` to map `Stop` → `session_end` (or to teach the dispatcher to fire run-completion + auto-save on `turn_end` too).

**Deps:** Phase 4 Fix F merged so we know the matcher isn't masking the symptom.

**Bucket:** ❌ BROKEN.

### Priority 3 — Materialize auto-Context-Pack to filesystem + include decisions in body (BROKEN-vs-design)

**Why now:** Auto-pack is the bridge's autonomy promise (Pattern 20). Today it lands in DB only and contains no decisions. Manual `save_context_pack` already does both. Re-using that store path in the auto-save handler is a small, mechanical change. After this, the product's "every session leaves a durable record" story is actually true.

**Effort:** ~1 day. The auto-save handler in `apps/hooks-bridge/src/lib/auto-context-pack.ts` should call `contextPackStore.save(…)` with the same options the MCP tool uses, and the digest assembler should query `decisions WHERE run_id=?` and append them to the body.

**Deps:** Priority 2 (auto-save needs to actually fire on real sessions first).

**Bucket:** ❌ BROKEN-vs-design (§5c.C3).

### Priority 4 — Ship `query_decisions` MCP tool (HIGH-VALUE)

**Why now:** The cross-session memory gap is the single highest-leverage missing feature. A new tool exposing the `decisions` table by `projectSlug` + LIKE-substring search + limit closes it immediately. Same factory shape as `query_run_history`. Doesn't need M05.

**Effort:** <1 day. New tool dir under `apps/mcp-server/src/tools/query-decisions/`, manifest, handler, schema, unit + integration tests. Same patterns as existing 9 tools.

**Deps:** None — works against the existing schema.

**Bucket:** 💡 HIGH-VALUE OPPORTUNITY (§7 H1).

### Priority 5 — Loop-tester `coodra verify` (HIGH-VALUE)

**Why now:** Today's `coodra doctor` checks process health; it doesn't verify the lifecycle actually fires. The whole reason Fix F was caught during demo rehearsal (not by doctor) is that doctor doesn't simulate a real session. A `verify` command that POSTs synthetic SessionStart → PreToolUse → PostToolUse → Stop and asserts the side effects (Feature Pack returned, deny lands, run_events row written, runs.status flips, auto-pack saved, pack file materialized) would catch every defect in this audit's §3 in CI.

**Effort:** ~2 days. Builds on the harness in `/tmp/audit-2026-05-03/harness.mjs` and the synthetic-bridge approach used in this audit.

**Deps:** Priorities 1 and 2 (so `verify` tests pass on a clean install).

**Bucket:** 💡 HIGH-VALUE OPPORTUNITY (§7 H3).

---

## Appendix — methodology + provenance

- **Branch:** `feat/phase4-fix-f-policy-tool-coverage` at `a638dca` (HEAD).
- **Working dir:** `~/taskforge-demo` (no modifications during audit).
- **DB read:** `~/.coodra/data.db` (queried via `sqlite3 -readonly`-equivalent SELECTs; no writes apart from the synthetic harness's documented test rows).
- **Synthetic write rows produced (clearly attributable):**
  - `runs.id LIKE 'run:ae2b09c5-...:audit-2026-05-03-%'` (1 row)
  - `runs.id LIKE 'run:ae2b09c5-...:audit-bridge-2026-05-03:%'` (1 row)
  - `decisions WHERE description LIKE 'AUDIT 2026-05-03%'` (1 row)
  - `context_packs WHERE title LIKE 'AUDIT 2026-05-03%'` (1 row)
  - `context_packs WHERE id='cp_07271a1a-...'` (the auto-saved bridge pack)
  - `policy_decisions WHERE session_id LIKE 'audit-%'` (8 rows from Write/MultiEdit/NotebookEdit cases)
  - `~/.coodra/packs/2026-05-03-run-ae2b09c5-624.md` (manual save filesystem artifact, 121 bytes)
- **Harness output:** `/tmp/audit-2026-05-03/findings2.json` (full structured tool responses).
- **Server stderr:** `/tmp/audit-2026-05-03/server.stderr.log`, `/tmp/audit-2026-05-03/server2.stderr.log`.
- **Production logs read:** `~/.coodra/logs/{mcp-server,hooks-bridge}.log`.
- **Tools NOT modified:** every audit assertion is from observation against the unmodified code at `a638dca`. No `coodra init`, `coodra start`, `coodra stop`, `coodra doctor`, `coodra repair` was invoked during the audit (per the user's instruction). Hooks-bridge daemon was already running pre-audit (PID 71801, started 14:00).
- **Coverage limits:** I could not test (a) `feature_pack_cycle` soft-failure (would require disk mutation), (b) Cursor / Windsurf adapter behavior in production (no Cursor/Windsurf running on this machine), (c) Claude Code → bridge real-time end-to-end after a fix (would require the user opening a Claude Code session AND the matcher fix being merged AND a daemon restart).

---

# §9-§15 — Refresh pass (2026-05-03, later same day)

> The original audit (§1-§8 above) was thorough on the 9-tool surface and the lifecycle but missed several modules and code paths. This refresh corrects three findings that were partially or fully wrong AND adds seven new findings from a deeper sweep. Refresh evidence is from three Explore-agent deep-dives + targeted code reads.

## §9 Corrections to the original audit

### §9.1 [§3.4 / §5c.C3] — Auto-pack DOES include decision bodies

**Original claim:** "The auto-pack content body includes event-digest counts but does NOT enumerate the `decisions` table rows for the run."

**Correction:** `apps/hooks-bridge/src/lib/auto-context-pack.ts:137-163` (the `buildAutoSummary` function) **does** enumerate decisions under a `## Decisions` heading with each decision's `### <description>`, rationale, and alternatives. The function queries the `decisions` table (lines 216-226) joined on `run_id` and passes the rows into the body builder.

**Why my original audit missed this:** my synthetic test session (`audit-bridge-2026-05-03`) made zero `record_decision` calls within that runId, so the decision-rendering branch had nothing to render. I observed an empty section and incorrectly inferred the code path was missing.

**Net:** the only real bug in §3.4 is the **filesystem-write gap** (the bridge writes to `context_packs` DB row but does NOT materialize `~/.coodra/packs/<runId>.md`). The decision-body inclusion works correctly.

### §9.2 [§3.4 / §5c.C4] — Stop / SessionEnd phase mapping is correct by design

**Original claim:** "The bridge maps Claude Code Stop → `turn_end` (plain-ack-only). Status-flip only fires on `session_end`. The Claude Code adapter routes Stop to the wrong phase OR the dispatcher needs to flip status on either phase."

**Correction:** the adapter's mapping is intentional. `packages/shared/src/hooks/adapters/claude-code.ts:11-21` has a docblock explicitly stating "Stop is per-turn end and acks at dispatch — see event.ts docblock"; `packages/shared/src/hooks/event.ts:26-33` says "Stop fires per-turn-end; SessionEnd fires once per session-termination. The auto-Context-Pack save binds to 'session_end', not 'turn_end' — replaying Stop N times a session no longer wakes the saveAutoContextPack path." This was Phase 3 Fix A landed 2026-05-02 deliberately.

**Actual root cause:** `packages/cli/src/lib/init/claude-settings-merge.ts:96` registers only 4 hook events: `['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']`. **`SessionEnd` is not in the list.** Live `~/.claude/settings.json` confirms 4 keys only. Claude Code never fires the SessionEnd hook because no entry exists for it in settings.json. The bridge handles `session_end` correctly when it arrives (proven by my synthetic test); it just never arrives in production.

**Net:** the fix is one line + tests in `claude-settings-merge.ts`, NOT an adapter or dispatcher refactor.

### §9.3 [operational gripe] — `pending_jobs` empty is *correct*, not concerning

**Original framing:** the audit's §5b mentioned "MCP-server log is in a 42 MB EADDRINUSE crash loop" but said nothing about `pending_jobs` being empty. This refresh adds context: empty `pending_jobs` is the **healthy** quiescent state of M03.1 Durable Outbox.

`pending_jobs` is M03.1's job queue table. The `OutboxWorker` ticks every 1s + immediately on enqueue and drains rows to `policy_decisions` / `run_events` / `runs`. Empty `pending_jobs` means the worker is current, not idle. The crash-safety harness `__tests__/manual/verify-outbox-crash-safety.ts` (229 lines) explicitly tests SIGTERM + SIGKILL paths and confirms rows survive crashes.

**Net:** Module 03.1 is fully shipped + operational. The original audit's failure to mention it as a strength understold the system's actual durability story.

## §10 Module status — refreshed

| Module | Status | Evidence |
|---|---|---|
| M01 Foundation | shipped | DB schema, env loading, logging — all working in audit |
| M02 MCP Server | shipped | 9 tools, all callable, manifest tests pass |
| M03 Hooks Bridge | shipped (with 1 BROKEN integration — see §3.2) | bridge running, all hooks handled correctly when delivered |
| **M03.1 Durable Outbox** | **shipped + operational** | OutboxWorker active in both apps; crash-safety harness exists; `pending_jobs` schema correct |
| **M04a Sync Daemon** | **S0 only — blocked on OQ sign-off** | `apps/sync-daemon/src/index.ts` + `lib/dispatch.ts` scaffolds present; not running; OQ1-OQ7 in `04a-sync-daemon/spec.md` §6 await user decision |
| M04 Web App | no spec doc, unbuilt | `docs/feature-packs/04-*` does not exist |
| M05 NL Assembly | no spec doc, unbuilt | gates real semantic search; `search_packs_nl` permanently in LIKE-fallback until built |
| M06 Semantic Diff | no spec doc, unbuilt | gates "what changed?" pack enrichment |
| M07 VS Code Extension | no spec doc, unbuilt | gates the VS Code surface |
| M08a CLI | shipped | `init`, `start`, `stop`, `status`, `doctor`, `cloud-migrate`, `team login/logout` all in `packages/cli/src/commands/` |
| **M08b CLI Expansion** | **planning only — blocked on 8 OQ sign-off** | spec + impl docs in `docs/feature-packs/08b-cli-expansion/`; zero code; `kill_switches` table absent |

**Implication:** of the 11 module-numbered surfaces, 6 are shipped (01, 02, 03, 03.1, 08a — plus M03.1 newly recognized as load-bearing), 1 is partially scaffolded blocked on OQ (04a), 1 is planning-blocked on OQ (08b), and 4 have no spec at all (04, 05, 06, 07). The plan must distinguish **engineering work** (slices the user wants built) from **decisions the user owes** (OQ sign-offs unblocking 04a + 08b) from **out-of-scope** (M04/05/06/07 with no specs).

## §11 Run identity reconciliation — F9/F10 are closed

Verification finding F9 ("Bridge and MCP server mint distinct `runs` rows for the same logical session") and F10 ("MCP-minted runs have `agent_type='unknown'`") are **closed at commit `3f3eb83`**.

`apps/mcp-server/src/tools/get-run-id/schema.ts:43-56` adds two optional fields:
- `agentSessionId: runKeySegmentSchema.max(256).optional()` — caller-supplied session id; when present, MCP uses it as `runs.session_id` (matching the bridge's SessionStart `session_id`).
- `agentType: z.enum(['claude_code', 'cursor', 'windsurf', 'unknown']).optional()` — agent-type stamp.

The handler at `handler.ts:240-246` takes `effectiveSessionId = input.agentSessionId ?? ctx.sessionId`. When an agent supplies the same `session_id` to both the bridge SessionStart hook AND the MCP `get_run_id` call, the unique index `(project_id, session_id)` resolves both write-paths to the same `runs` row.

**My original audit's confused claim** that the demo's `taskforge-demo` runs were "stuck in_progress because Stop maps to turn_end" mixed two different things. The taskforge `stdio-fe70f3e9-...` rows ARE pure MCP-stdio sessions with no IDE hooks running — those should never have a bridge SessionStart row to reconcile with, because no bridge call ever fired. The "stuck in_progress" is real (no SessionEnd hook → bridge never closed them — see §9.2), but F9/F10 are not the cause.

**Net:** F9/F10 closed. The plan's lifecycle slice only needs to register SessionEnd in settings.json; no further run-identity work needed.

## §12 Feature pack inheritance — code solid, tests missing

**Implementation** at `apps/mcp-server/src/lib/feature-pack.ts:40-43, 256-300`:

- `loadOne()` loads a single pack from `docs/feature-packs/<slug>/` (spec.md, implementation.md, techstack.md, meta.json).
- `walkAncestors()` walks `parentSlug` chain leaf → parent → grandparent.
- Returns `{ pack, subPack: null, inherited }` discriminated shape; consumers render the chain (root-first).
- Cycle detection: visited-set walk; throws `feature_pack_cycle: <chain>` if a slug repeats. The error is parsed by the handler into a soft-failure response.

**Production exercise:** the Coodra repo's own `docs/feature-packs/` tree HAS inheritance:
- `04a-sync-daemon` → parent `03-hooks-bridge`
- `03.1-durable-outbox` → parent `03-hooks-bridge`
- `08a-cli` → parent `02-mcp-server`
- `08b-cli-expansion` → parent `08a-cli`

The chain `08b-cli-expansion → 08a-cli → 02-mcp-server` is a 2-hop inheritance that exercises `walkAncestors` in production every time `get_feature_pack` is called for those slugs. So this code path runs.

**Test gap:** the verification report (2026-04-27) shows no dedicated cycle-detection, inheritance-merge, or deep-chain tests. The unit test `feature-pack.test.ts` covers happy-path load only. **No test asserts:**
- A → B → A cycle is caught and produces `feature_pack_cycle` error.
- A 3-hop chain returns 3 inherited packs in root-first order.
- Missing parent slug produces `feature_pack_parent_missing`.

**Net:** code is solid, tests are missing. Low-priority but worth a defensive slice once the BROKEN bucket is empty.

## §13 Graphify integration — reader exists, producer doesn't

**Reader:** `apps/mcp-server/src/lib/graphify.ts:47-49` reads `~/.coodra/graphify/<projectSlug>/graph.json`. Format permissive (`{ nodes?: [...], edges?: [...] }`). Returns `{ nodes: [], edges: [] }` on parse failure (fail-open).

**Producer:** **NOT IN THIS REPO.** Grep for `graphify scan`, `produceGraph`, `writeGraphify`, `graphify build` returns zero matches across `apps/`, `packages/`, `docs/`. The `query_codebase_graph` tool's `howToFix` says "run \`graphify scan\` at repo root" — assuming an external CLI tool the user runs separately.

**ADR-010 promise vs reality:** ADR-010 says "Coodra imports [graphify's] output to seed initial Feature Pack content — each community becomes a Feature Pack section." This **import-for-seeding** flow is NOT implemented. `createFeaturePackStore` reads hand-authored markdown, not graph.json. The Feature Pack `upsert()` accepts pre-authored content; it doesn't generate structure from a graph.

**Implication:** `query_codebase_graph` is permanently in `codebase_graph_not_indexed` soft-failure for any user who hasn't installed and run an external `graphify` tool. The architecture has an unstated dependency on a separate tool that's out-of-band. ADR-010's seeding flow is aspirational.

**Where this should be addressed:** either (a) build a `coodra graph build` CLI command that wraps the external tool (or implements the equivalent in TS); (b) restate ADR-010 as deferred to a future module and update the `query_codebase_graph` tool's description to point at the external installation step; (c) descope `query_codebase_graph` from the 9-tool manifest until a producer exists.

## §14 Operational gaps — doctor coverage + setup.sh + orphans

### §14.1 Doctor doesn't validate hooks or end-to-end policy flow

`packages/cli/src/commands/doctor.ts` + `packages/cli/src/doctor/registry.ts` define 21+ checks. Of these, 9 are `ESSENTIAL_CHECKS`. The set covers:
- ✅ Port 3100 health (check 17 — probes `/healthz`)
- ✅ Port 3101 health (check 18)
- ✅ Daemon `/healthz` for both apps
- ✅ DB present + migrations applied
- ❌ **Settings.json hook registration: MISSING.** No check verifies that `~/.claude/settings.json` has the right hook entries (SessionStart, PreToolUse, PostToolUse, Stop, **SessionEnd**) pointing at the bridge.
- ❌ **End-to-end PreToolUse synthetic POST: MISSING.** No check fires `{ eventType: 'PreToolUse', toolName: 'Write', toolInput: { file_path: '.env' } }` at `http://127.0.0.1:3101/v1/hooks/claude-code` and asserts the response is `permissionDecision: 'deny'`.
- ❌ **End-to-end SessionEnd synthetic POST: MISSING.** Same idea — would catch the §9.2 bug class (matcher gate, hook registration gap, dispatcher routing).

**Why this matters:** the `__coodra__` matcher bug in production existed for weeks because doctor only checks process health, not lifecycle correctness. Same logic applies to the SessionEnd registration gap. Doctor extensions that exercise the full loop would catch every defect in the audit's §3 in CI / pre-deploy.

### §14.2 setup.sh raw SQL is non-idempotent (root cause confirmed)

`presentation/setup.sh:60-76` does:

```bash
sqlite3 ~/.coodra/data.db <<'SQL'
INSERT INTO policy_rules (id, policy_id, priority, match_event_type, match_tool_name, match_path_glob, decision, reason, created_at)
SELECT lower(hex(randomblob(16))), pol.id, 1, 'PreToolUse', tool, '**/.env', 'deny', ...
FROM policies pol JOIN projects proj ON pol.project_id = proj.id
CROSS JOIN (SELECT 'Edit' AS tool UNION SELECT 'MultiEdit' UNION SELECT 'NotebookEdit') tools
WHERE proj.slug = 'taskforge-demo';
SQL
```

**Root cause confirmed:** `policy_rules` table has **no UNIQUE constraint** on `(policy_id, priority, match_event_type, match_tool_name, match_path_glob)`. The only constraint is the primary key on `id` (random UUID). Each setup re-run inserts 3 fresh rows successfully. After 3 re-runs the demo DB has 9 priority-1 rows where it should have 3.

**Compare with `ensureDefaultPolicy`** (`packages/db/src/ensure-default-policy.ts:230`): it uses `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM policy_rules WHERE ...)` to enforce idempotency at the application layer. That pattern is missing from setup.sh.

**Once Fix F merges:** setup.sh's hand-rolled block becomes redundant (`ensureDefaultPolicy` post-Fix-F covers Edit/MultiEdit/NotebookEdit + nested globs). The block should be deleted.

### §14.3 Orphaned-run cleanup: no code path exists

Grep for `cancel_in_progress`, `sweep_runs`, `orphaned`, `stale_run`, `expire_run` across `apps/` and `packages/` returns zero matches. The system has no:
- Background sweep job to cancel runs older than N hours.
- Lease-based timeout (despite lease comments in the schema).
- SessionStart-time cleanup that ages out the user's prior in-progress runs.

**Behavior:** once a run enters `status='in_progress'` and never receives a SessionEnd event (agent crash, terminal kill, missing SessionEnd hook registration as in §9.2), it persists forever. The demo DB has 6 such orphans dating back to May 2.

**Implication:** the `query_run_history` tool returns these orphans as if they're current. A new agent session calling `query_run_history` sees stale `in_progress` runs and may waste a turn checking on work that's actually abandoned.

## §15 Test honesty + manifest description quality (PASS, with notes)

### §15.1 Test honesty: PASS

Across 46 mcp-server test files + 20 hooks-bridge test files (66 total examined):
- Zero `vi.mock()` calls mocking the thing under test.
- Integration tests use real `:memory:` SQLite with migrations applied (`createDbClient({ mode: 'solo', sqlite: { path: ':memory:' } }) → migrateSqlite`).
- Unit tests use stub `DbHandle` literals only for factory-contract tests; behavior assertions go against real handlers.
- Every tool unit test runs `assertManifestDescriptionValid(reg, { folderName })` from `@coodra/shared/test-utils`.
- Zero patterns of `expect(mockFn).toHaveBeenCalled()` as the only assertion.

**Net:** the `01-development-discipline.md` §1.1 banned-pattern list is genuinely respected. No shallow tests detected.

### §15.2 Manifest description quality: 8/9 PASS, 1 borderline + 1 minor gap

Per §24.3 + §9.1 recipe (imperative "Call this", return shape, why, when-NOT-to-call, 40-120 word band; enforced by `assertManifestDescriptionValid`):

| Tool | Words | Recipe parts present? |
|---|---|---|
| ping | 114 | all 5 |
| get_run_id | 99 | all 5 |
| get_feature_pack | 70 | all 5 |
| save_context_pack | 105 | all 5 |
| search_packs_nl | 96 | all 5 |
| record_decision | 97 | all 5 |
| query_run_history | 95 | all 5 |
| **check_policy** | **107** | over the 100-word soft target (within 120 hard cap) |
| query_codebase_graph | 87 | description names the soft-failure codes but doesn't tell the agent what to DO when `codebase_graph_not_indexed` returns. The `howToFix` field carries the signal but the description prepares the agent better if it includes the recovery hint inline. |

**Net:** 8/9 pass cleanly. `check_policy` is borderline (would benefit from a 7-word trim). `query_codebase_graph` could add one sentence: "When `codebase_graph_not_indexed`, surface `howToFix` to the user — they need to run `graphify scan` at the repo root before retry."

Neither is high-priority, but both are easy wins that improve agent-prompt density.
