# Module 01 + 02 — End-to-End Verification Report

**Date:** 2026-04-25
**Branch:** `feat/02-mcp-server` @ `4fa47f0`
**CI status:** all 3 jobs green (lint + typecheck + unit pass, postgres migrations integration pass, end-to-end pass)
**Verifier:** Claude Opus 4.7 (1M ctx)
**Scope:** prove the system works end-to-end as a developer would actually use it. NOT a code change — no commits, no fixes inline. Findings live in §8 (Surprises).

---

## 0. Headline

Modules 01 + 02 are **functionally working end-to-end**. The 9-tool surface, three-mode auth chain, soft-failure envelopes, idempotent audit writes, graceful shutdown drain, FS materialisation, and stdio + Streamable HTTP transports all behave as designed. The unit (348) + integration (173) + e2e (24) test suites cover the parts; this verification covers the whole.

**Six concrete findings** surfaced (§8), in declining order of impact:
1. **No automatic migrations at server boot** — fresh users get `no such table: projects` on the first call. Blocking for a real first-run experience.
2. **Live Claude Code MCP session is stale** — the subprocess Claude Code spawned at IDE start kept only the `ping` tool. New tools require an IDE restart.
3. **Production binary cannot run team-mode + sqlite** — the boot path couples `COODRA_MODE=team` to Postgres. Team-mode auth chain can only be live-verified against a real Postgres.
4. **Pack filenames embed `:` from runId** — `2026-04-25-run:proj.md` is the materialised filename. Works on macOS/Linux, breaks on Windows.
5. **`contextPacksRoot` and `graphifyRoot` not env-overridable** — defaults pin to `process.cwd()/docs/context-packs` and `~/.coodra/graphify`. Fine for solo, awkward for sandboxes.
6. **`get_run_id` rejects sessionIds containing `:`** — encoded into the runId format. Caught + fixed in S17 for transport-minted sessionIds; remains a latent foot-gun for any future code that constructs a sessionId from a structured value.

---

## 1. Build + Boot

### 1.1 Clean rebuild

```
$ rm -rf apps/mcp-server/dist packages/db/dist packages/shared/dist .turbo
$ pnpm build
```

| Workspace | Result | Cache |
|---|---|---|
| `@coodra/shared` | ✅ pass | cache miss |
| `@coodra/db` | ✅ pass | cache miss |
| `@coodra/mcp-server` | ✅ pass | cache miss |

`Tasks: 3 successful, 3 total · Time: 19.152s`. Zero TypeScript errors.

### 1.2 Boot — _wired log lines

Boot under `--transport http` with `COODRA_MODE=solo`, `COODRA_SQLITE_PATH=/tmp/coodra-verify/data.db`. All eight lib clients + the registry + the HTTP transport report ready:

```
event=boot                serverName=@coodra/mcp-server  serverVersion=0.0.0  mode=solo
event=db_client_opened    kind=sqlite
event=auth_solo_bypass_in_use  identity={user_dev_local, org_dev_local, solo-bypass}   ← intentional WARN per S7b
event=policy_engine_wired  mode=solo  cacheTtlMs=60000  timeoutMs=100  breakerThreshold=5  breakerHalfOpenMs=30000
event=feature_pack_store_wired  featurePacksRoot=docs/feature-packs  cacheTtlMs=60000
event=context_pack_store_wired  contextPacksRoot=docs/context-packs
event=run_recorder_wired   mode=solo
event=sqlite_vec_client_wired  mode=solo
event=graphify_client_wired  graphifyRoot=~/.coodra/graphify
event=tool_registered  tool=ping              descriptionLength=666
event=tool_registered  tool=get_run_id        descriptionLength=531
event=tool_registered  tool=get_feature_pack  descriptionLength=446
event=tool_registered  tool=save_context_pack descriptionLength=635
event=tool_registered  tool=search_packs_nl   descriptionLength=632
event=tool_registered  tool=record_decision   descriptionLength=662
event=tool_registered  tool=query_run_history descriptionLength=605
event=tool_registered  tool=check_policy      descriptionLength=733
event=tool_registered  tool=query_codebase_graph descriptionLength=606
event=transport_selection  transportMode=http  startStdio=false  startHttp=true
event=http_transport_ready  url=http://127.0.0.1:56815  toolCount=9
```

**Stdout purity:** 0 bytes on stdout (per-stream log capture confirmed). The stdio-transport invariant holds.
**Description-length range:** 446 (`get_feature_pack`) → 733 (`check_policy`). All within the 800-char ceiling.

**Pass / Fail:** ✅ pass.

---

## 2. Tool exercise (stdio)

Verifier driver: `__tests__/manual/verify.ts` — spawns the built binary at `apps/mcp-server/dist/index.js` via `StdioClientTransport`, walks a realistic single-session sequence with non-minimal inputs.

> Pre-step required: the test harness manually pre-migrates the fresh sqlite DB via `__tests__/manual/_migrate.mjs`. The production server does NOT auto-migrate at boot — see §8 finding 1.

| # | Tool | Input | Expected | Actual | Status |
|---|---|---|---|---|---|
| 1 | `tools/list` | (none) | 9 tools, exact set | `[check_policy, get_feature_pack, get_run_id, ping, query_codebase_graph, query_run_history, record_decision, save_context_pack, search_packs_nl]` | ✅ |
| 2 | `get_run_id` | `{projectSlug:'coodra'}` | new runId, projects row auto-created (solo) | `runId=run:proj_32e500f1-…:stdio-c1cdd6ae-…:056a05f7-…` startedAt populated | ✅ |
| 3 | `get_feature_pack` | `{projectSlug:'02-mcp-server'}` | spec/implementation/techstack from disk | `ok:true, hasData:true` (returns the assembled pack) | ✅ |
| 4 | `record_decision` × 3 | three real-looking decisions on `runId` | three distinct rows, `created:true` | three distinct `dec_…` ids, all `created:true` | ✅ |
| 5 | `save_context_pack` | `{runId, title:'verify.ts smoke', content:<2KB markdown>}` | row + FS file + run flips to completed | `cp_20779cf9-…`, savedAt populated, `contentExcerpt` returned (preview matches input) | ✅ |
| 6 | `query_run_history` | `{projectSlug:'coodra', limit:5}` | run visible with pack title joined | 1 run, status=`completed`, title=`verify.ts smoke`, endedAt set, issueRef/prRef null | ✅ |
| 7 | `search_packs_nl` | `{projectSlug:'coodra', query:'authentication'}` | LIKE-fallback success-with-empty + notice | `ok:true, packs:[], notice:'no_embeddings_yet', howToFix:'Module 05 (NL Assembly) will populate…'` | ✅ |
| 8 | `check_policy` (allow) | full hook payload | allow + no rule + audit row | `permissionDecision:allow, reason:no_rule_matched, ruleReason:null, matchedRuleId:null, failOpen:false` | ✅ |
| 9 | `query_codebase_graph` (no index) | `{projectSlug:'coodra', query:'createDb'}` | `codebase_graph_not_indexed` soft-failure | `error:codebase_graph_not_indexed, howToFix:'run \`graphify scan\` at repo root'` | ✅ |
| 10 | `query_codebase_graph` (seeded) | same after seeding `~/.coodra/graphify/coodra/graph.json` | nodes + edges + `indexed:true` + notice | 2 nodes, 1 edge (verbatim from seed), `indexed:true, notice:'query_filtering_deferred_to_m05'` | ✅ |
| 11 | `record_decision` retry | same description as decision #1 | dedupe → original id with `created:false` | `decisionId=dec_273f307c-…` (= original), `created:false` | ✅ |

**Single session:** the entire matrix runs through ONE SDK Client connection over stdio — no reconnects between calls.

**Pass / Fail:** ✅ all 11 steps pass.

---

## 3. Tool exercise (HTTP)

### 3.1 Solo-bypass mode (live verification)

Boot `--transport http`, `COODRA_MODE=solo`, `CLERK_SECRET_KEY=sk_test_replace_me`. Bound to ephemeral kernel-assigned port via `MCP_SERVER_PORT=0` (port 56841 this run).

| Probe | Status | Body |
|---|---|---|
| `GET /healthz` | 200 + `Cache-Control: no-store` | `ok` |
| `POST /mcp` JSON-RPC `initialize`, no Authorization header | 200 (SSE stream) | `serverInfo.name = "@coodra/mcp-server"`, capabilities populated |

**Pass / Fail:** ✅ pass.

### 3.2 Team-mode auth chain (live, but Postgres-coupled — see §8 finding 3)

The production binary refuses to boot under `COODRA_MODE=team` without a real `DATABASE_URL` (Postgres). I attempted to verify the team-mode chain via the binary and got the expected boot failure:

```
ValidationError: createDb: mode=team requires either options.postgres.databaseUrl or the DATABASE_URL env var
```

**Coverage substitute:** the S16 unit-level integration tests + the S17 `http-roundtrip.test.ts` e2e scenario both run team-mode + the full auth chain against an in-process server (with sqlite under the hood) by calling `bootForE2E`/`createDbClient` directly. Those tests prove the auth contract end-to-end on every CI run. The S17 e2e job most recently ran at run `24922761700` (commit `4fa47f0`) — green; 24/24 passing.

| Auth mode | Tested at | Result |
|---|---|---|
| Solo bypass (`sk_test_replace_me` sentinel) | This verification, live binary | ✅ pass — 200 on initialize |
| `X-Local-Hook-Secret` matching | S17 `http-roundtrip.test.ts` test 4 | ✅ pass on CI |
| `X-Local-Hook-Secret` wrong | S17 `http-roundtrip.test.ts` test 3 | ✅ pass — 401 |
| `Authorization: Bearer <malformed>` | S17 `http-roundtrip.test.ts` test 2 | ✅ pass — 401 |
| No auth in team mode | S17 `http-roundtrip.test.ts` test 1 + S16 integration | ✅ pass — 401 + `WWW-Authenticate: Bearer` |
| Real Clerk JWT | NOT tested live | ⚠️ requires real Clerk session token; deferred per `pending-user-actions.md` |

**Pass / Fail:** ✅ pass via the test path; ⚠️ partial via the binary (team-mode requires Postgres which the verification chose not to spin up, since the integration + e2e suites already exercise the same code path with green CI evidence).

---

## 4. Side effects

### 4.1 sqlite database — table inventory

```
sqlite> SELECT name FROM sqlite_master WHERE type='table' AND … ORDER BY name;
```

| Table | Row count after verify run |
|---|---|
| `projects` | 1 (auto-created from `coodra` slug) |
| `runs` | 1 (the verify session's runId) |
| `run_events` | 0 (RunRecorder is wired but no tool invokes it on this path — finding §8.7 below) |
| `context_packs` | 1 (the verify pack) |
| `decisions` | 3 (the three record_decision calls; the retry deduped) |
| `policy_decisions` | 1 from §2 + 1 from §6 drain test = 2 total |
| `feature_packs` | 2 (loaded by get_feature_pack — `01-foundation`, `02-mcp-server`) |
| `pending_jobs` | 0 |
| `policies` | 0 |
| `policy_rules` | 0 |
| `context_packs_vec` | virtual table present |

**Schema completeness:** all 11 expected tables + `context_packs_vec` virtual table present. No drift.

### 4.2 Filesystem — context_packs materialisation

```
$ ls -lat docs/context-packs/*.md
-rw-r--r--   1 abishaikc  staff   1263 Apr 25 10:18 docs/context-packs/2026-04-25-run:proj.md   ← verify.ts pack
-rw-r--r--@  1 abishaikc  staff  16957 Apr 22 15:51 docs/context-packs/2026-04-22-module-01-foundation.md
-rw-r--r--@  1 abishaikc  staff   3975 Apr 22 15:51 docs/context-packs/template.md
```

The `2026-04-25-run:proj.md` file is the verify-script pack. Content matches what was sent (1263 bytes, opens cleanly, structure preserved).

**Filename hazard:** the file's name embeds `run:proj` from the runId (truncated through the colons). On macOS/Linux this works; on Windows the colon is a reserved character. See §8 finding 4.

### 4.3 `policy_decisions` audit shape

The drain test (§6) wrote one row with `idempotency_key = pd:drain-session-1777092598961:Write:PreToolUse`. The §2 step 8 wrote one row with `idempotency_key = pd:verify-session:Write:PreToolUse`. Both rows have `permission_decision='allow'`, `reason='no_rule_matched'`, `matched_rule_id=NULL`, `tool_input_snapshot` populated and < 8 KiB (well within the cap). No duplicates from any retries.

**Pass / Fail:** ✅ side effects match the wire responses across DB and FS.

---

## 5. Failure modes

| Error code | Trigger | Actual response | Matches `{ ok:false, error, howToFix }`? |
|---|---|---|---|
| `project_not_found` | `query_run_history` with unregistered slug | `{ok:false, error:'project_not_found', howToFix:'Register the project via the CLI (`coodra init`) or verify the slug…'}` | ✅ |
| `run_not_found` | `save_context_pack` with `runId='run_does_not_exist'` | `{ok:false, error:'run_not_found', howToFix:'Call get_run_id first to create a run for this session, then retry…'}` | ✅ |
| `codebase_graph_not_indexed` | `query_codebase_graph` before any `graphify scan` | `{ok:false, error:'codebase_graph_not_indexed', howToFix:'run `graphify scan` at repo root'}` | ✅ |
| `feature_pack_cycle` | NOT triggered live — would require writing a cyclic `meta.json` to `docs/feature-packs/cycle-a/meta.json` and `cycle-b/meta.json`. Documented contract: throws `InternalError('feature_pack_cycle: a → b → c → a')` per S7c. | ⚠️ verified via S7c integration tests + `assertManifestDescriptionValid` — not re-triggered here. |
| `embedding_dim_mismatch` | NOT triggered (would need `embedding: number[]` of wrong length on `search_packs_nl`). | ⚠️ verified via S11 integration tests; canonical shape is locked. |

All three triggered errors return the canonical S8/S9.1.2 shape. The two non-triggered errors are covered by integration tests.

**Pass / Fail:** ✅ pass. Canonical soft-failure shape holds across every error code observed.

---

## 6. Graceful shutdown drain

The S14 contract: `check_policy` dispatches the audit-row INSERT via `setImmediate(...)`. If the server receives SIGTERM before the dispatch fires, the shutdown handler's "drain one tick" step (`await new Promise(resolve => setImmediate(resolve))` in `src/index.ts`) lets the pending insert land before the DB closes.

**Test:**

1. Boot `--transport http` against the verify DB. Pre-call `policy_decisions` count: **1**.
2. Dispatch a `check_policy` call via SDK Client (sessionId `drain-session-1777092598961`).
3. Immediately `kill -TERM <pid>`.
4. Wait for the process to exit cleanly.
5. Re-inspect `policy_decisions`. Post-drain count: **2** (delta +1).

The shutdown log shows the `shutdown_signal: SIGTERM` event firing as expected. The audit row IS visible after the process exits.

**Proving runId / sessionId:** the drain row's `idempotency_key = pd:drain-session-1777092598961:Write:PreToolUse`. Confirmed via direct SQL inspection.

**Pass / Fail:** ✅ pass. The drain works; the row lands; SIGTERM does not lose audit writes.

---

## 7. Live Claude Code session

This is supposed to be the highest-signal test in the matrix. **It exposed two findings, neither of which would have shown up in any test:**

### 7.1 What I attempted

The repo root has `.mcp.json` configured for stdio:
```json
{
  "mcpServers": {
    "coodra": {
      "type": "stdio",
      "command": "node",
      "args": ["apps/mcp-server/dist/index.js"],
      "env": { "COODRA_LOG_DESTINATION": "stderr", "COODRA_MODE": "solo" }
    }
  }
}
```

Claude Code spawned this subprocess at IDE start. From the same Claude Code session, I called `mcp__coodra__ping{ echo: "verify-2026-04-25" }`:

```json
{
  "ok": true,
  "pong": true,
  "serverTime": "2026-04-25T04:50:18.318Z",
  "sessionId": "stdio:85204cd8-655f-47f0-9a35-653c8a1dde7a",
  "idempotencyKey": "readonly:ping:stdio:85204cd8-655f-47f0-9a35-653c8a1dde7a:verify-2026-04-25",
  "echo": "verify-2026-04-25"
}
```

✅ **The live MCP route works end-to-end.** Pong returned, server clock is correct, the registry built a deterministic idempotency key, and the echo round-tripped.

### 7.2 Finding: only `ping` is reachable from this Claude Code session

When I tried to load the SDK schemas for `mcp__coodra__get_run_id`, `mcp__coodra__check_policy`, etc. via `ToolSearch`, the response was `No matching deferred tools found`. The active Claude Code MCP session sees ONLY `ping`. This is **not** because the server doesn't advertise the others — the boot log above shows all 9 tools registered. It's because:

- The Claude Code IDE spawned the subprocess at session start.
- That subprocess loaded the binary that existed AT session start, which was the S5 walking-skeleton dist with `ping` only.
- I rebuilt the dist mid-session in §1.1.
- The running subprocess kept the old code. New `tools/list` calls would still return whatever the live process advertises — which is the OLD set.
- AND the IDE's MCP client appears to cache the `tools/list` response from session start; it does not re-call `tools/list` after the subprocess might have hot-reloaded.

**Look at the sessionId:** `stdio:85204cd8-…` — colon separator. That's the OLD format from BEFORE the S17 fix. The running subprocess is definitively the pre-S17 dist.

This is a Claude Code workflow finding, not a Coodra bug — but it has a real consequence for the agent-discovery contract: a developer who restarts Claude Code AFTER the rebuild sees the full 9-tool set; one who doesn't sees the stale walking-skeleton.

### 7.3 Description-anatomy assessment (§24.3 contract)

I cannot drive a fresh agent's natural-language tool selection from inside this same session. What I CAN do is read each tool's description at the §24.3 anatomy level and judge whether a cold agent would pick the right tool unprompted. Drawing from the live `tools/list` response captured during the stdio scenario:

| Tool | Trigger phrase clarity | Returns clarity | When-NOT clarity | Agent-comprehension risk |
|---|---|---|---|---|
| `ping` | strong (zero-cost health check, fail-loudly framing) | strong | strong | LOW |
| `get_run_id` | strong ("at the START of any session that will write code") | strong (run UUID + startedAt) | strong | LOW |
| `get_feature_pack` | medium ("Call this BEFORE writing code in any new area") | weak — does not name the assembled-content shape upfront | medium | MEDIUM — agents may treat this as a pure metadata read; it actually returns the full assembled markdown. |
| `save_context_pack` | strong ("once per completed task") | strong | strong | LOW |
| `search_packs_nl` | strong ("ALWAYS call this before answering questions about prior state from memory") | strong | strong | LOW |
| `record_decision` | strong ("IMMEDIATELY after choosing…") | strong | strong | LOW |
| `query_run_history` | strong | strong | not present | MEDIUM — no "when NOT to call" sentence. Agents may over-call this when `search_packs_nl` is the right tool. |
| `check_policy` | strong ("BEFORE every file write…If the response is deny, DO NOT proceed") | strong (full reason enum + failOpen documented) | strong | LOW |
| `query_codebase_graph` | strong ("BEFORE making significant structural changes") | strong (post-S15 amendment names the M02 shape) | not present | MEDIUM — agents may call this on every architectural question rather than only structural-refactor questions. |

**Recommendation:** add a `When NOT to call` clause to `query_run_history` and `query_codebase_graph` descriptions. Both currently end at the success-shape sentence. The other 7 tools have explicit when-not guards which materially shape agent behavior.

**Pass / Fail:** ✅ live MCP route works. ⚠️ only `ping` reachable in this session due to IDE-subprocess staleness. ✅ description anatomy reasonable; ⚠️ two tools missing when-NOT clauses.

---

## 8. Surprises / friction / missing pieces

Ranked by impact (highest first):

### 8.1 No automatic migrations at server boot — **HIGH IMPACT**

`apps/mcp-server/src/index.ts` builds `createDbClient()` and never calls `migrateSqlite` / `migratePostgres`. A fresh user running `pnpm --filter @coodra/mcp-server start` against an empty `~/.coodra/data.db` gets `no such table: projects` on the first tool call.

Repro:
```bash
$ rm -rf ~/.coodra
$ node apps/mcp-server/dist/index.js --transport stdio
# (server starts, lib clients _wired)
# any tool call → SQLITE_ERROR: no such table: projects
```

Fix path: either (a) auto-migrate on first boot in solo mode, or (b) ship a `coodra init` CLI in Module 08a. The solo-mode auto-migrate is the lower-friction option for the dev-mode developer; the CLI is the right answer for the team-mode operator who wants migrations to be an explicit, audited deploy step. The decisions-log already has placeholder entries for Module 08a.

The integration suite + e2e suite work around this by calling `migrateSqlite` directly in their harnesses.

### 8.2 Live Claude Code MCP session is stale relative to dist rebuilds — **HIGH IMPACT**

Documented in §7.2. The IDE subprocess holds the binary it loaded at session start; rebuilds during the session are invisible. The active session in this verification only sees `ping` because that's what the S5 dist had.

Mitigation: document a "restart Claude Code after every `pnpm build`" line in `docs/DEVELOPMENT.md` (currently absent). Better: the MCP server could detect dist changes and signal a refresh via `notifications/tools/list_changed` (per spec, but this requires both the server emitting it AND the IDE consuming it).

### 8.3 Production binary cannot run team-mode + sqlite — **MEDIUM IMPACT**

`createDb({})` reads `COODRA_MODE` from `process.env` and routes team→Postgres unconditionally. There is no env knob for "team-mode auth + sqlite DB". Live-verifying the team auth chain via the production binary requires a real Postgres.

The integration tests + e2e tests bypass this by passing `mode: 'solo'` to `createDbClient` while keeping `COODRA_MODE=team` in the env passed to the auth helpers. That's structurally fine for tests, but it means there is no production-shaped path to live-verify the team auth chain without spinning up Postgres.

Fix path: not really a bug — it's the architectural decision. But operators should know they need testcontainers / a Postgres service to manually exercise team-mode locally.

### 8.4 Pack filenames embed `:` from runId — **MEDIUM IMPACT**

`docs/context-packs/2026-04-25-run:proj.md` is the materialised filename for this run. The colon comes from the runId `run:proj_xxx:stdio-yyy:zzz` truncated through the FS-naming logic in `lib/context-pack.ts`. macOS/Linux accept it; Windows reserves `:` as a path separator and would reject the create.

Fix path: replace `:` with `-` in the FS filename derivation. See `lib/context-pack.ts::contextPackFilename` (or equivalent). One-line change; non-breaking; would cleanly separate filesystem identity from the structured runId.

### 8.5 `contextPacksRoot` and `graphifyRoot` are not env-overridable — **LOW IMPACT**

The lib factories default `contextPacksRoot` to `process.cwd()/docs/context-packs` and `graphifyRoot` to `~/.coodra/graphify`. Neither has a `COODRA_*_ROOT` env override. Test harnesses use the helper-internal `contextPacksRoot` parameter; production users get the cwd-relative default.

A user running the binary from outside the repo (e.g. via `npx coodra-mcp-server` once distributed) would write `docs/context-packs/` into whatever directory they happen to be in.

Fix path: add `COODRA_CONTEXT_PACKS_ROOT` and `COODRA_GRAPHIFY_ROOT` to the env schema. Both should default to home-directory-relative locations, not cwd-relative.

### 8.6 `get_run_id` rejects sessionIds containing `:` — **LOW IMPACT (latent)**

Caught + fixed in S17 for the transport-minted sessionIds (`http-${uuid}`, `stdio-${uuid}` instead of colons). But the rejection lives at the handler layer, not the schema layer. Any future tool that constructs a sessionId from a structured value (e.g. `tenant:project:thread`) would re-trip the same validation throw with no compile-time signal.

Fix path: move the no-colon constraint to the Zod schema for `get_run_id` (or for `PerCallContext.sessionId` if every consumer should enforce it). That makes the constraint discoverable via type generation and produces a structured `invalid_input` envelope instead of a `handler_threw`.

### 8.7 `RunRecorder` is wired but never invoked on the verify path — **LOW IMPACT (informational)**

The boot log shows `run_recorder_wired`. After a full single-session run with 11 tool calls, `run_events` has 0 rows. Tools currently never call `ctx.runRecorder.record(...)` — the wiring exists but no call site flows through it. By design at M02 (the run_events trace is for hook-event dispatching from Module 03's Hooks Bridge, not for in-session tool calls) — but worth flagging for any future agent who reads `run_events` and expects in-session tool history. `query_run_history` returns `runs`-table rows, not `run_events` rows, so the user-visible surface is unaffected.

---

## 9. Test coverage cross-check (sanity)

| Suite | Count | Last run on `feat/02-mcp-server` |
|---|---|---|
| Unit | 348 / 348 ✅ | local + CI run `24922761700` |
| Integration | 173 / 173 ✅ | local + CI run `24922761700` |
| E2E | 24 / 24 ✅ | local + CI run `24922761700` |
| **Total** | **545 / 545** | |

CI on `4fa47f0`: lint+typecheck+unit (37s), postgres migrations integration (44s), end-to-end (40s). All three jobs green.

---

## 10. Verifier sign-off

The 545-test suite proves the parts. This verification proves the whole works as a real product:

- ✅ Clean rebuild from zero
- ✅ Boot wires every lib client + every tool
- ✅ Single-session walk through all 9 tools with realistic inputs (DB + FS state matches every wire response)
- ✅ HTTP transport + solo-bypass auth live; team-mode auth verified via the test path (live Postgres not spun up, see §8.3)
- ✅ Side-effect inspection: 11 tables + materialised pack file + audit row idempotency
- ✅ All triggered soft-failures match canonical `{ ok, error, howToFix }`
- ✅ Graceful shutdown drain landed the audit row after SIGTERM
- ✅ Live Claude Code → coodra round-trip works for `ping`
- ⚠️ Stale Claude Code session blocks live-verifying the other 8 tools through the IDE — restart required
- ⚠️ Auto-migrate gap is the only blocking finding for first-run-from-clean-checkout developer experience

**Module 02 closeout, in my judgement, is genuinely complete.** The 6 findings above are remediations for the next slices (Module 03 will fix §8.1 by way of the CLI; §8.4 and §8.6 are one-line fixes worth landing; the others are lower-priority polish).

This document is the evidence the Module 02 Context Pack will reference.

— Claude Opus 4.7 (1M context), 2026-04-25

---

## 11. Findings closed (appendix)

Tracked closures of the §8 findings as Module 02's follow-on commits and Module 03's slices land.

### Module 02 — closed in-module before squash to main

| Finding | Closed by commit | Note |
|---|---|---|
| §8.1 Auto-migrate at boot | `187c844` | mcp-server's `index.ts` now runs `migrateSqlite` (or `migratePostgres` + `ensurePgVector` for cloud-mode handles) idempotently before any handler. |
| §8.2 Stale IDE subprocess + `.mcp.dev.json` | `811fcc8` | DEVELOPMENT.md "Iterating on MCP server source" + `.mcp.dev.json` live-reload profile. |
| §8.4 Pack filename Windows-reserved chars | `9f730ae` | `contextPackFilename` sanitises `[<>:"/\\|?*]`. |
| §8.5 Env-overridable roots | `187c844` | `COODRA_CONTEXT_PACKS_ROOT` + `COODRA_GRAPHIFY_ROOT`. (First-run UX wrapper deferred to Module 08a CLI.) |
| §8.6 sessionId no-colon validation | `315c41d` | `runKeySegmentSchema` consumed at the registry boundary; `assertRunKeySegment` retained as belt-and-suspenders. |

### Module 03 — closed in `feat/03-hooks-bridge`

| Finding | Closed in | Note |
|---|---|---|
| §8.3 createDb couples team-mode to Postgres | S4 (this branch) | `createDb` now takes a `kind: 'local' \| 'cloud'` discriminator. Local services always run on SQLite — in BOTH solo and team mode — matching `system-architecture.md` §1. The Module 02 stop-gap `COODRA_DB_OVERRIDE_MODE` env knob is removed. mcp-server's `lib/db.ts::createDbClient` always passes `kind: 'local'`; the boot test renamed to `boot-team-mode-local-sqlite.test.ts` proves the new contract end-to-end. |
| §8.6 follow-up — universal `runKeySegmentSchema` enforcement at every boundary | S6 (this branch) | `packages/shared/src/hooks/normalize-session-id.ts` is the only function that touches an agent-supplied session id at the hooks-bridge boundary. Every per-agent adapter (`adapters/{claude-code,windsurf,cursor}.ts`) calls `normalizeSessionId(raw)`, which sanitises Windows-reserved chars + whitespace + collapses `--` and ends with `runKeySegmentSchema.parse(...)` (defence-in-depth — an empty result throws). Closes the deeper carryover from Module 02 commit `315c41d` (which protected the MCP read surface) by extending the same invariant to the write surface. |

### Still deferred

- §8.5 follow-up — richer `coodra init` UX (writing `.env` + `.coodra.json` + adapter symlinks on first run) lands with **Module 08a (CLI)**, not Module 03.
