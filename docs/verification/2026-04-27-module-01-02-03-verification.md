# Whole-Product Verification — Modules 01 + 02 + 03

**Date:** 2026-04-27
**Tester:** Claude Code (read-only verification harness)
**Verification runId:** `run:proj_0513a96a-abec-4e85-94ce-9c75d9aa65a1:stdio-95e34d8d-0c7d-4de6-bcdd-4ad63931c072:df45fb79-43ae-4cac-9855-11c44a9aa074`
**Branch verified:** `feat/03-hooks-bridge` @ `f41a01b` (16 commits ahead of `main`)
**Scope:** Treat M01 (Foundation) + M02 (MCP Server) + M03 (Hooks Bridge) as one shipped product. Exercise the closed loop the project exists for: agent → Hooks Bridge → MCP server → DB+FS → context retrieved on next run. **Read-only — no source edits, no commits.**

> **Premise correction.** The verification brief assumed `feat/03-hooks-bridge` had already been squash-merged to `main`. As of 2026-04-27 09:36 IST it had not — `main` is at `f496cc5` (post-M02, pre-M03). All Phase-1+ work was therefore exercised against the branch HEAD, which is what would land on `main` after the squash. The MCP server Claude Code is currently running was spawned by the IDE from the prior dist; verification used a freshly-built `apps/mcp-server/dist/index.js` (sha `0d64ac7…`) and `apps/hooks-bridge/dist/index.js` (sha `bac8dcc…`).

---

## Headline outcome

**The closed loop works.** A SessionStart fired at the bridge opens a `runs` row; a PreToolUse on a forbidden path is denied via the policy engine; a PostToolUse appends a `run_events` row; a record_decision through the MCP HTTP transport persists; a Stop hook closes the run; and a follow-up `query_run_history` retrieves all of it. State survives a full kill+restart of both services.

But the verification surfaced **13 distinct findings** — including 2 high-severity bugs that break foundational query/audit invariants, plus 4 documentation/closeout inaccuracies and 4 architectural design gaps the brief uncovered before the next module is built.

| # | Severity | Title | Phase |
|---|----------|------|------|
| F1 | LOW | `lint/complexity/useOptionalChain` warning since S5 commit `01982a00` | 1 |
| F2 | LOW (doc) | M03 closeout test counts inaccurate (`db` off by ~21 unit tests) | 1 |
| F3 | **HIGH** | DB integration tests' `beforeAll` cleanup missing `decisions` — local-dev workflow broken | 1 |
| F4 | LOW | Vitest config DOES disable parallelism; F4 was a side-effect of F3, not a separate bug — keep merged into F3 | 1 |
| F5 | MEDIUM | `check_policy.input.sessionId` not validated against `runKeySegmentSchema` (§8.6 closure incomplete at MCP-input layer) | 2 |
| F6 | n/a | Initial Claude Code + Windsurf adapter fixtures were wrong — fail-open with `invalid_hook_payload` is correct §7 behavior; no bridge bug | 4 |
| F7 | MEDIUM | Bridge `recordPolicyDecision` skips audit when `projectId` unresolved (no `.coodra.json`) — deny still works via `__global__` rule cache, but no audit trail | 4 |
| F8 | **HIGH** | `run_events.run_id` is **always NULL** because `scheduleRunEventInsert` calls `lookupRunId(undefined, sessionId)` and `recordPolicyDecision` hardcodes `runId: null` | 4 |
| F9 | MEDIUM | Bridge and MCP server disagree on what "the run" is — bridge uses agent's `session_id`, MCP uses transport-generated `http-…` ID; one logical session creates **two** `runs` rows | 5 |
| F10 | LOW | MCP-minted `runs` rows have `agent_type='unknown'` (`get_run_id` schema has no agentType field) | 5 |
| F11 | MEDIUM (doc) | Phase 6 as scoped is impossible by design — `apps/{mcp-server,hooks-bridge}` only pass `kind: 'local'`; no boot path against Postgres | 6 |
| F12 | LOW | Bridge logs never carry `runId` (downstream effect of F8) — cross-service log correlation requires DB join | 7 |
| F13 | LOW (process) | M03 closeout left `docs/context-packs/2026-04-26-run-proj_0513a96.md` untracked alongside the hand-named pack | 0/7 |

The two HIGH findings (F3, F8) are the ones to fix before another module lands. F5, F7, F9, F11 are architectural gaps the user should weigh in on before they propagate further.

---

## Per-phase results

Each phase row is PASS / FAIL / BLOCKED with evidence and the finding(s) it surfaced.

### Phase 0 — Session setup

| Step | Result | Evidence |
|---|---|---|
| 0.1 archive prior session | PASS | `context_memory/sessions/2026-04-26-module-03-closeout.md` written. |
| 0.2 fresh `current-session.md` | PASS | rewritten with this session's goal. |
| 0.3 git baseline | PASS w/ note | branch `feat/03-hooks-bridge` 16 commits ahead of `main`; squash-merge not yet done. F13 surfaced (untracked auto-pack). |
| 0.4 `pnpm install --frozen-lockfile` | PASS | `Lockfile is up to date, resolution step is skipped`. |

### Phase 1 — Foundation surface

| Step | Result | Evidence |
|---|---|---|
| 1.1 `pnpm lint` | PASS w/ warning (F1) | `Checked 209 files`, 1 fixable warning at `apps/hooks-bridge/src/lib/auth-middleware.ts:67`. Exit 0 (warnings don't fail biome). |
| 1.2 `pnpm typecheck` | PASS | `8 successful, 8 cached, FULL TURBO`. |
| 1.3 migration-lock | PASS | `migration-lock: ok (2 blocks verified)`. SHA256 mechanism confirmed by reading `scripts/check-migration-lock.mjs` (lines 192–196). Intentional-drift mutate-and-restore verification SKIPPED to honor read-only constraint; mechanism inspection was sufficient. |
| 1.4 `pnpm test:unit` | PASS | per-package: `shared 117/117`, `db 42/42`, `policy 7/7`, `mcp-server 223/223`, `hooks-bridge 12/12` — total **401/401**. F2 surfaced: M03 closeout said "db 6 unit + 15 in CI"; actual local unit count is 42. |
| 1.5 `createDb` kind shape | PASS | `packages/db/src/client.ts:241–251` discriminated union exactly per S4; comment block explicitly cites verification §8.3 closure. `mode` is hint-only. |
| 1.6 docker compose up | PASS | postgres healthy on 127.0.0.1:5432; redis port 6379 already bound by an unrelated daemon — not blocking. |
| 1.7 `@coodra/db` integration | PARTIAL — F3 | Each test file passes individually (`postgres-migrate.test.ts` 7/7; `cloud-mode-write.test.ts` 2/2). The suite as a whole fails because both files' `beforeAll` DROP lists omit `decisions` (added by Module 02). Whichever file runs second crashes on `CREATE TABLE "decisions" already exists`. CI passes only because GitHub Actions provisions a fresh service container per job. **The documented local developer test workflow (`pnpm test:integration` against `pnpm -w docker:up`) is broken.** |

### Phase 2 — MCP server stdio + 9-tool walk

| Step | Result | Evidence |
|---|---|---|
| 2.1 build dist | PASS | `apps/mcp-server/dist/index.js` sha `0d64ac74827bd01c4755dc7883c19489f9ec91d1`. |
| 2.2 boot + auto-migrate | PASS | Fresh sqlite at `/tmp/coodra-verify-m1-m3/data.db`, no "no such table" errors. |
| 2.3 `tools/list` | PASS | Exactly 9 tools: `check_policy, get_feature_pack, get_run_id, ping, query_codebase_graph, query_run_history, record_decision, save_context_pack, search_packs_nl`. All description lengths between 446 and 733 chars (≤800 contract). |
| 2.4 ping | PASS | `{ok:true, pong:true, sessionId:"stdio-1c150d9e-…", idempotencyKey:"readonly:ping:stdio-…:verify-m1-m3", echo:"verify-m1-m3"}`. SessionId colon-free. |
| 2.4 get_run_id | PASS | runId `run:proj_cf4abd75-50d1-4974-8caa-b7d7c291a1e0:stdio-1c150d9e-…:334fa3e7-…` matches the §24.4 `run:{projectId}:{sessionId}:{uuid}` shape. Project auto-created in solo mode. |
| 2.4 get_feature_pack(unknown) | PASS | Soft-failure: `{ok:false, error:"pack_not_found", howToFix:"Register the pack via …"}`. Outer `ok:true`, inner `ok:false`, both fields present per §9.1.2 contract. |
| 2.4 record_decision A | PASS | `{ok:true, decisionId:"dec_a74ad1bf-…", created:true}`. |
| 2.4 record_decision B | PASS | distinct `decisionId:"dec_fe577652-…"`, `created:true`. |
| 2.4 record_decision A retry | PASS | **Idempotent** — same `decisionId:"dec_a74ad1bf-…"`, `created:false`. |
| 2.4 check_policy(Write) | PASS | `{ok:true, permissionDecision:"allow", reason:"no_rule_matched", failOpen:false}`. |
| 2.4 check_policy("has:colon") | **F5** | Server accepted colon-bearing sessionId. Returned `allow / no_rule_matched` instead of `invalid_input`. The §8.6 closure (M02 commit per verification §11) only enforces `runKeySegmentSchema` at the framework `PerCallContext` layer; tools that take sessionId as an explicit input argument bypass it. The bridge's `normalizeSessionId` covers hook ingress, but a direct MCP caller still gets in. |
| 2.4 query_codebase_graph | PASS | Soft-failure: `{ok:false, error:"codebase_graph_not_indexed", howToFix:"run \`graphify scan\` at repo root"}`. |
| 2.4 save_context_pack | PASS | `{ok:true, contextPackId:"cp_2e2cb970-…", savedAt, contentExcerpt}`. Note response field is `contextPackId`, not `packId` (caught at S14 of M03). |
| 2.4 query_run_history | PASS | Returns the run with `title:"verify-m1-m3 context pack"` joined from the saved pack; `status:"completed"`, `endedAt` set. |
| 2.4 search_packs_nl | PASS | LIKE fallback returns the pack with `notice:"no_embeddings_yet"` + howToFix. Both `ok` levels honored. |
| 2.5 soft-failure contract | PASS | Every soft-failure tested above carries both `error` and `howToFix`. The discriminated-union shape per `essentialsforclaude/09-common-patterns.md §9.1.2` is honored. |
| 2.6 graceful-shutdown drain | PASS | `policy_decisions` count 0 → 1 after fire-then-close + 1.5s wait. Audit row contained `permission_decision='allow', reason='no_rule_matched'`. The setImmediate-scheduled write completes during shutdown. |

### Phase 3 — MCP HTTP + auth chain

| Layer | Result | Evidence |
|---|---|---|
| solo bypass (no auth) | PASS | initialize → 200 + SSE-framed JSON-RPC response. |
| team + no auth → 401 | PASS | `{"error":"unauthorized","reason":"no_valid_auth_layer"}` |
| team + valid X-Local-Hook-Secret → 200 | PASS | initialize → 200 |
| team + wrong X-Local-Hook-Secret → 401 | PASS | same `no_valid_auth_layer` response (timing-safe miss) |
| team + bad Bearer JWT → 401 | PASS | falls through to `no_valid_auth_layer` after Clerk SDK rejects |
| `/healthz` always unauthed | PASS | 200 in both modes |
| `MCP_SERVER_PORT=3199` honored | PASS | `http_transport_ready` event reports `boundPort:3199` |
| live Clerk JWT happy-path | BLOCKED | Requires real Clerk creds — pending user action `2026-04-22 20:58` (still open). |

### Phase 4 — Hooks Bridge

| Step | Result | Evidence |
|---|---|---|
| 4.1 build + boot + /healthz | PASS | dist sha `bac8dcc…`; `/healthz` → `{"ok":true,"service":"hooks-bridge","mode":"solo","serverStartedAt":…}` |
| 4.2 per-agent payloads (corrected fixtures) | PASS | All three routes parse and dispatch. **`normalizeSessionId` verified at boundary** — `verify-cc:has:colon:and-spaces 1` → `verify-cc-has-colon-and-spaces-1`; `traj-ws:hasColons:1` → `traj-ws-hasColons-1`; tool-name normalization `pre_write_code` → `Write` confirmed. |
| 4.2 fail-open on Zod parse failure | PASS | F6 — initial fixtures had wrong field names. The `.strict()` rejection produced `invalid_hook_payload` + 200 + `decision:"allow"` per §7 fail-open, with WARN log. **Correct behavior, not a bug.** |
| 4.2 Cursor + Windsurf adapter shells as subprocesses | PASS | `scripts/hook-adapters/{cursor,windsurf}-coodra.sh` exit 0 (allow) when fed JSON on stdin. ADR-009 round-trip verified. |
| 4.3 PreToolUse → policy deny | PASS conditional | Deny rule seeded; `permissionDecision:"deny", permissionDecisionReason:"forbidden by verify rule"` returned. **F7**: when no `.coodra.json` resolves the cwd, `recordPolicyDecision` skips the audit row to avoid the `policy_decisions.project_id NOT NULL FK` violation. The deny still works via `__global__` rule cache. With a proper `.coodra.json` pointing at a registered slug, the audit row IS written (`permission_decision=deny, matched_rule_id=rule_5fdc8e26-…`). |
| 4.4 PostToolUse → run_events | PARTIAL — F8 | Row inserted with sha256-prefixed id (`re_3a79aee8…`). **`run_id` is NULL** even when a `runs` row exists for the same session. Closes M02 verification §8.7's deferral textually but the linkage is broken. |
| 4.5 full lifecycle | PARTIAL — F8 | SessionStart opens runs row (status `in_progress`); UserPromptSubmit + Pre×2 + Post×2 + Stop fire; runs row closes to `completed` with `ended_at` set. But all 5 generated `run_events` rows have `run_id IS NULL` even though `runs.id` exists for the same `(project_id, session_id)`. The recorder's `lookupRunId(undefined, sessionId)` short-circuits to null because `projectSlug` is hardcoded to `undefined` at the call site. |
| 4.6 idempotent replay 5× | PASS | `tu-idem` PostToolUse replayed 5×; `run_events WHERE tool_use_id='tu-idem'` count = 1. ON CONFLICT DO NOTHING + sha256 id keying works as designed. |

### Phase 5 — Whole-product loop

| Step | Result | Evidence |
|---|---|---|
| 5.1 boot both, shared DB | PASS | Both running against `/tmp/coodra-verify-bridge/data.db`. SQLite WAL mode permits the topology. |
| 5.2 `.mcp.dev.json` shape | INSPECTED | The committed `.mcp.dev.json` includes the `hooks` block routing all 5 events to `http://127.0.0.1:3101/v1/hooks/claude-code`. Matches what Module 03 S12 landed. |
| 5.3 closed loop walk | PASS w/ F9 | SessionStart → MCP get_run_id → Pre/Post → record_decision → Stop → query_run_history all returned 200 / OK. **F9 surfaced**: `query_run_history` returns 5 distinct runs because the bridge's SessionStart created `runs[session_id='phase5-ts-1777276516460']` and MCP's `get_run_id` created a *separate* `runs[session_id='http-4216a2ac-…']`. The architecture's "run = 1:1 with agent session" intent is not enforced — both surfaces mint their own runs row from their own view of "session id". |
| 5.4 DB invariants | PASS partial | 0 orphan `run_events` (none with non-null run_id pointing nowhere); 0 orphan `policy_decisions`. **But 7/7 `run_events` have NULL `run_id`** — F8. |
| 5.5 restart → state survives | PASS | Pre-restart 5 runs; after kill+restart of both services, 5 runs unchanged; replayed PostToolUse with the same key still produces exactly 1 row in `run_events` for `tu-idem`. |
| F10 noted | — | The MCP-minted run carries `agent_type='unknown'` because `get_run_id` schema has no agentType input. Visible in `runs.agent_type` for the `http-…` row. |

### Phase 6 — Cloud-mode parity

| Step | Result | Evidence |
|---|---|---|
| 6.1 boot bridge / mcp-server with `kind:'cloud'` | **BLOCKED — F11** | Both apps' `lib/db.ts` only ever pass `kind: 'local'` to `createDb`. There is no env knob, no override, no flag. M03 S4 explicitly removed `COODRA_DB_OVERRIDE_MODE`. Per `system-architecture.md §1`: "local services always write to local SQLite." Cloud DB is reserved for the future Sync Daemon. **The Phase 6 plan was authored against a pre-S4 mental model.** |
| 6.2 + 6.3 cloud write + HNSW | PASS via narrow integration | `@coodra/db`'s `cloud-mode-write.test.ts` 2/2 PASS against the live Postgres. `pg_indexes`: `context_packs_embedding_hnsw_idx` exists, `USING hnsw (summary_embedding vector_cosine_ops) WITH (m='16', ef_construction='64')`. Synthetic 384-dim search ordering through `search_packs_nl` is impossible to test against Postgres because mcp-server is SQLite-only by design (F11). |

### Phase 7 — Cross-cutting

| Step | Result | Evidence |
|---|---|---|
| 7.1 `tools/list` description anatomy | PASS | Spot-checked 5 tools (`ping, get_run_id, check_policy, save_context_pack, search_packs_nl`). Every description starts with imperative trigger phrase, mentions return shape, and (where applicable) lists soft-failures with `howToFix`. The `assertManifestDescriptionValid` helper in `packages/shared/src/test-utils/manifest-assertions.ts` is reused across every tool's unit test, plus `__tests__/e2e/manifest-e2e.test.ts`. **§24.3 + §24.9 contract held.** During my walk-through I never picked the wrong tool because of an unclear description. |
| 7.2 stdout / stderr purity | PASS | spawned `dist/index.js --transport stdio` with a single `initialize` on stdin. **stdout** had exactly 1 line, the JSON-RPC initialize response. **stderr** had 21 lines, all pino-JSON `{"level":"…","time":…,"pid":…,…}` shape. Zero contamination either direction. The bootstrap-stderr-logging contract holds. |
| 7.3 logger correlation | PARTIAL — F12 | Bridge log: 62/74 lines carry `sessionId`; the 12 without are pre-listener boot/migrations lines. **0/74 lines carry `runId`.** Downstream of F8 — bridge's recorder can't look up the runId so it never logs one. Cross-service correlation by runId requires an extra DB join through `runs.session_id` rather than a direct grep. |
| 7.4 architectural pattern alignment | PASS | §16 pattern 4 (cockatiel breaker on policy) — confirmed in `packages/policy/src/policy.ts`. §16 pattern 3 (idempotency keys + ON CONFLICT) — confirmed in `apps/hooks-bridge/src/lib/run-recorder.ts`. §16 pattern 19 (descriptions as agent prompts) — confirmed via `assertManifestDescriptionValid` reuse + e2e manifest test. §16 pattern 1 (CQRS-shaped bridge writes / mcp-server reads) — implicit in the topology, but F9 reveals the two surfaces don't agree on the run identity that should bind them. §1 ↔ code drift: closed by S4 (createDb kind), evidenced by §8.3 closure. |

---

## Findings — full text

### F1 — `lint/complexity/useOptionalChain` warning since S5 (LOW)

`pnpm lint` reports 1 fixable warning at `apps/hooks-bridge/src/lib/auth-middleware.ts:67`:
```
if (authHeader && authHeader.startsWith('Bearer ')) {
```
should be `if (authHeader?.startsWith('Bearer ')) {`. `git blame` shows the line entered with commit `01982a00` (S5, 2026-04-25). The M03 closeout log claimed "lint clean" at every gate from S5 onward — that claim is inaccurate. Biome's exit code is 0 because warnings don't fail the gate, so CI is unaffected. Fix is `pnpm lint:fix`; one line.

### F2 — Closeout test counts inaccurate (LOW, doc-only)

The M03 closeout context pack reports test counts that don't match a fresh local run:
- Closeout: "db 6 unit + 15 in CI (9 skipped locally without DATABASE_URL)"
- Actual: `pnpm --filter @coodra/db run test:unit` → **42/42 passed**

Likely the closeout was written using a stale memory of an earlier test layout. Other counts (shared 117, policy 7, hooks-bridge 12, mcp-server 223) match.

### F3 — DB integration tests' cleanup misses `decisions` (HIGH)

Both `packages/db/__tests__/integration/postgres-migrate.test.ts:40-50` and `packages/db/__tests__/integration/cloud-mode-write.test.ts:39-50` execute a manual `DROP TABLE IF EXISTS …` block in `beforeAll`. The list:

```sql
DROP TABLE IF EXISTS run_events CASCADE;
DROP TABLE IF EXISTS context_packs CASCADE;
DROP TABLE IF EXISTS pending_jobs CASCADE;
DROP TABLE IF EXISTS policy_decisions CASCADE;
DROP TABLE IF EXISTS policy_rules CASCADE;
DROP TABLE IF EXISTS policies CASCADE;
DROP TABLE IF EXISTS feature_packs CASCADE;
DROP TABLE IF EXISTS runs CASCADE;
DROP TABLE IF EXISTS projects CASCADE;
DROP TABLE IF EXISTS __drizzle_migrations CASCADE;
```

**Module 02 added `decisions` (the record_decision table) but neither test was updated.** Locally:
1. File 1's `beforeAll` runs migrations — succeeds, leaves `decisions` populated.
2. File 2's `beforeAll` drops the 9 listed tables — `decisions` survives.
3. File 2's migrations run — `CREATE TABLE "decisions"` fails with `relation "decisions" already exists` (Postgres 42P07).

Result: `pnpm --filter @coodra/db test:integration` reports `1 failed | 14 passed (15)` against a long-running compose Postgres. CI is green only because every CI job spins up a fresh service container. **The documented local-dev workflow (`pnpm -w docker:up && pnpm test:integration`) is broken.**

I confirmed each file passes individually after a manual full DROP (`postgres-migrate.test.ts` 7/7; `cloud-mode-write.test.ts` 2/2). Fix: add `DROP TABLE IF EXISTS decisions CASCADE;` to both DROP blocks. Or factor the cleanup to a shared helper that introspects `__drizzle_migrations` to discover all created tables.

Severity HIGH because: (a) every developer following `docs/DEVELOPMENT.md` will hit this on first run, (b) the failure modes are confusing (a "create" error suggests the wrong fix), (c) the fix is one line per file.

### F5 — `check_policy.input.sessionId` accepts colons (MEDIUM)

`runKeySegmentSchema` from `@coodra/shared/idempotency` is enforced at:
- The framework's `PerCallContext.sessionId` (M02 verification §8.6 closure).
- The bridge's `normalizeSessionId` (M03 S6 closure).

But the `check_policy` tool exposes `sessionId` as an *input argument*, separate from `PerCallContext.sessionId`. A direct MCP caller passing `sessionId: "has:colon"` is accepted and produces a normal `permissionDecision: 'allow'` response. Test evidence:

```json
{"label":"check_policy(invalid sessionId)","payload":{"ok":true,"data":{"ok":true,"permissionDecision":"allow","reason":"no_rule_matched","ruleReason":null,"matchedRuleId":null,"failOpen":false}}}
```

In production the bridge always normalizes before calling `check_policy`, so this is defense-in-depth, not a live agent vector. But the M03 closeout's claim that §8.6 was "closed at every external boundary" understates the gap. Fix: add a Zod refine on the `check_policy` schema's `sessionId` field. (Module 02 verification's planned Fix 6 noted this exact forward-compat concern but scoped the fix only to `get-run-id`.)

### F7 — Bridge audit-skip when projectId unresolved (MEDIUM)

`apps/hooks-bridge/src/lib/run-recorder.ts:346–352`: `recordPolicyDecision` early-returns when `projectId === undefined`, with a DEBUG log line `policy_decision_audit_skipped`. Same pattern for `recordSessionStart` (line 248) and `recordSessionEnd` (line 304).

This is *deliberate* (the schema's NOT NULL FK on `policy_decisions.project_id` would crash a write with `null`). And the deny decision still works correctly via the `__global__` rule cache — agents working in unregistered cwds are still policed. But:

- The "auditable agent governance" value prop assumes every decision is in the audit log.
- Many real agent sessions will run in directories without `.coodra.json` (a fresh repo, a non-Coodra project, a scratchpad).
- A SOC2-style compliance review of the audit table would show no record of decisions made in those sessions.

Two design choices to weigh:
- (a) Make `policy_decisions.project_id` nullable for global-rule decisions — straightforward schema migration.
- (b) Always create a `__global__` sentinel project row at boot, and audit global-rule decisions against it. Single row, no schema change.
- (c) Accept the gap and document it as a known governance scope boundary. Cheapest, but undermines a load-bearing claim.

This is a user-decision moment, not a "fix it now" item.

### F8 — `run_events.run_id` is always NULL (HIGH)

Two co-located bugs:

**(a)** `apps/hooks-bridge/src/lib/run-recorder.ts:199` — `scheduleRunEventInsert` calls:
```ts
const runId = await lookupRunId(undefined, args.event.sessionId);
```
`lookupRunId(projectSlug, sessionId)` short-circuits to `null` at line 134 when `projectSlug === undefined`. The call site hardcodes `undefined`. The handler comment at line 38 says "the recorder looks up `(project_id, session_id)`" — but no project_id is being passed in. Should plumb `event.projectSlug` (set by the resolver, returned alongside `projectId`) or pass through the resolved `projectId` from the handler.

**(b)** `apps/hooks-bridge/src/lib/run-recorder.ts:364` — `recordPolicyDecision` writes:
```ts
runId: null,
```
Hardcoded null even when a `runs` row exists for the same `(project_id, session_id)`. The pre-tool handler already has `projectId` resolved (it's plumbed in line 113), so a second lookup keyed by `(projectId, event.sessionId)` against the runs table would yield the live `runs.id` for the in-progress run.

**Impact** verified in this session's DB:
- 7/7 `run_events` rows have `run_id IS NULL`.
- 5/5 `policy_decisions` rows have `run_id IS NULL`.
- The join `runs → run_events` returns 0 rows for any session.
- The query "all events for run X" — fundamental to NHI governance — is broken.

The M03 closeout's "Deferred: backfilling run_events.run_id from SessionStart-created runs row" hinted at this but was scoped as a future-tense "backfill", as if backfill mechanics existed and just weren't running. The actual state is that the linkage is never written at INSERT time and no backfill mechanism exists.

Severity HIGH because: (a) the runs ↔ events linkage is foundational, (b) the architecture's audit query story breaks today, (c) the fix is small (~30 LOC total) and isolated to the recorder.

### F9 — Bridge and MCP server mint distinct `runs` rows for the same logical session (MEDIUM, architectural)

In Phase 5 the closed loop produced two `runs` rows for one walkthrough:

| `runs.session_id` | `runs.status` | `runs.agent_type` | source |
|---|---|---|---|
| `phase5-ts-1777276516460` | `completed` | `claude_code` | bridge SessionStart → Stop |
| `http-4216a2ac-3488-4d91-b2eb-f14b30dd0790` | `in_progress` | `unknown` | MCP `get_run_id` (via HTTP transport) |

The bridge uses the agent-supplied `session_id` (already `normalizeSessionId`-cleaned). The MCP server uses its own transport-generated session id (`stdio-…` or `http-…`) and treats that as `runs.session_id`. There is no field that ties the two together — the architecture's "run = 1:1 with agent session" intent is convention, not enforcement.

Possible resolutions:
- (a) The MCP server's `get_run_id` accepts an optional `agentSessionId` parameter; when present, it overrides the transport sessionId for the runs row.
- (b) The bridge becomes the only writer of `runs` rows; MCP `get_run_id` becomes a *read* of an existing row keyed by `(projectId, agentSessionId)`. Splits the CQRS responsibilities cleanly but requires the agent (or agent harness) to fire SessionStart at the bridge before calling MCP.
- (c) Live with two parallel run notions. Make the data model explicit about it (e.g., `bridge_runs` and `mcp_runs` as separate tables).

Option (b) aligns best with §16 pattern 1 (CQRS) and the bridge-as-write-side / MCP-as-read-side split. (a) is cheaper and more backward-compatible.

### F10 — MCP-minted runs have `agent_type='unknown'` (LOW)

The `get_run_id` tool's input schema has no `agentType` field. The MCP framework's `PerCallContext` does carry an `agentType` set by the transport (`claude_code` for stdio, `unknown` for default), but the value depends on transport-specific request parsing and is not propagated reliably. Combined with F9: when MCP creates the runs row, `agent_type` is whatever the transport guessed — usually `unknown`.

If `get_run_id` accepted an explicit `agentType` parameter and threaded it into the runs INSERT, this resolves cleanly. Fold into F9's resolution.

### F11 — Phase 6 plan is impossible by design (MEDIUM, doc/scope)

`apps/mcp-server/src/lib/db.ts` and `apps/hooks-bridge/src/lib/db.ts` always pass `{ kind: 'local' }` to `createDb`. M03 S4's commit message explicitly says "local services always write to local SQLite" and removed the prior `COODRA_DB_OVERRIDE_MODE` knob. The cloud-mode-write test directly constructs a `kind: 'cloud'` handle through `@coodra/db::createDb`, but the apps cannot.

This is **deliberate** per architecture §1, but the verification brief (and any future "boot the binary against Postgres" plans) should be edited to reflect it. Possible cloud users in v1: (a) the future Sync Daemon (Module 03+); (b) Module 05 NL Assembly's embeddings ingest path (for embedding writes that flow team-wide). Neither exists yet.

### F12 — Bridge logs lack runId (LOW, downstream of F8)

The bridge's structured logs carry `sessionId, agentType, toolName, projectId, projectSlug` but never `runId`. Direct consequence of F8: the recorder doesn't look it up, so the handler can't log it. Fixing F8 fixes F12 transparently — once `lookupRunId` actually resolves, the handler can include `runId` in the `pre_tool_use_decision` and equivalent log lines.

### F13 — Untracked auto-saved context-pack (LOW, process)

`docs/context-packs/2026-04-26-run-proj_0513a96.md` is untracked. M03 closeout (S15) committed the hand-curated `2026-04-26-module-03-hooks-bridge.md` (225 lines) but didn't add the auto-saved sibling (the markdown produced by `save_context_pack`'s FS materialize step). The M02 era committed both. Process gap, not a code bug. Two paths:
- (a) `save_context_pack` writes to a non-tracked directory (e.g., `~/.coodra/packs/`) and the agent only commits the hand-curated file.
- (b) `save_context_pack` writes the runId-named file as the canonical artifact, and the agent renames/commits that file at closeout time.

Currently neither convention is documented, leaving the agent to figure it out — which is what produced this orphan.

---

## Closure of prior verification findings

`docs/verification/2026-04-25-module-01-02-verification.md` had 6 findings. Status as of 2026-04-27:

| # | Title | Status | Evidence |
|---|---|---|---|
| §8.1 | No auto-migrations at server boot | ✅ closed in M02 commit | Both mcp-server boot (Phase 2.2 — fresh DB, no `no such table`) and hooks-bridge boot (Phase 4.1 — same) auto-migrate cleanly. |
| §8.2 | Live Claude Code MCP session is stale | ✅ closed | `.mcp.dev.json` profile with `tsx watch` exists at repo root; documented in `docs/DEVELOPMENT.md`. |
| §8.3 | `createDb` couples team-mode to Postgres | ✅ closed in M03 S4 | `kind: 'local' \| 'cloud'` discriminator confirmed in `packages/db/src/client.ts:241–251` with explicit "Closes verification finding §8.3" comment. F11 is the dual side of this — apps can ONLY use kind:local. |
| §8.4 | Pack filenames embed `:` from runId | ✅ closed | The auto-saved file `2026-04-26-run-proj_0513a96.md` shows the sanitization: colons → underscore; no Windows-reserved chars in any of the 5 packs in `docs/context-packs/`. |
| §8.5 | `contextPacksRoot` / `graphifyRoot` not env-overridable | ✅ closed | Phase 2 harness used `COODRA_CONTEXT_PACKS_ROOT` and `COODRA_GRAPHIFY_ROOT` env vars and they were honored; the saved pack landed under the override path. |
| §8.6 | sessionId no-colon validation lives at handler layer | ⚠️ **partially** closed | Closed at framework `PerCallContext` (M02) and at hooks-bridge `normalizeSessionId` (M03 S6). **F5** shows the MCP tool input layer still accepts colons — direct callers bypass the boundary normalizer. |

---

## What's actually shippable today

A confident yes:
- The 9 MCP tools work, return well-shaped data, honor soft-failure contracts.
- The HTTP three-layer auth chain is correct (modulo live Clerk happy-path validation pending real keys).
- The hooks bridge accepts payloads from all three agents, normalizes them at the boundary, fails-open per §7, and writes audit rows when projectId resolves.
- Idempotency holds across restarts (5× replay → 1 row, post-kill+restart).
- §16 patterns 3, 4, 19 all in place; CQRS split is clean.
- The closed loop runs end-to-end.

Yes with reservations (need decisions, not just code fixes):
- F7 (audit gap when no `.coodra.json`) and F11 (apps are SQLite-only by design) reflect deliberate architecture choices that the user should explicitly buy into before more modules build on top of them. F9 is a CQRS run-identity question.
- F5 is a defense-in-depth gap; production attack surface is small (the bridge guards external traffic).

No, fix before merging Module 04 / 08a:
- **F3** — broken local-dev integration test workflow. Two-line fix.
- **F8** — `run_events.run_id` always NULL breaks "events for run X" queries. ~30 LOC fix.

Process / hygiene:
- **F1** — one auto-fixable lint warning. `pnpm lint:fix`.
- **F2** — update closeout test counts.
- **F13** — decide the canonical pack-naming convention; document.

---

## Pending user actions still open

(none of these were resolved during this session; they remain in `context_memory/pending-user-actions.md`)

- Live Clerk dev tenant validation (blocks the Phase 3 happy-path JWT test).
- GitHub App registration (blocks the planned post-M03 GitHub integration module).
- Atlassian OAuth app (blocks JIRA module).
- npm scope `@coodra` claim (blocks Module 08a publish).

The verification brief honored the agent/human boundary throughout — no fake API keys, no destructive ops, no commits. Source code was not edited. The only files written this session: this verification report; `context_memory/current-session.md`; `__tests__/manual/verify-m1-m3.ts`, `verify-sigterm-drain.ts`, `verify-phase5-loop.ts` (manual harnesses, not picked up by vitest).

---

## Verification artifacts

| Artifact | Path |
|---|---|
| This report | `docs/verification/2026-04-27-module-01-02-03-verification.md` |
| Manual stdio walk-through | `__tests__/manual/verify-m1-m3.ts` |
| SIGTERM drain test | `__tests__/manual/verify-sigterm-drain.ts` |
| Phase 5 closed-loop harness | `__tests__/manual/verify-phase5-loop.ts` |
| Server log captures | `/tmp/bridge.log`, `/tmp/mcp-shared-http.log`, `/tmp/stderr.txt`, `/tmp/stdout.txt` (ephemeral) |

The `__tests__/manual/*.ts` harnesses were left in place rather than deleted — they're useful for spot-checks during fix work and follow the same convention as `verify.ts` from the prior verification round.

---

## §11 — Findings closed (appendix)

The 13 findings above were addressed across 7 commits on `feat/03-hooks-bridge` (2026-04-27). Each commit closes one or more findings; verification ran clean after the final commit (lint 0/0, typecheck FULL TURBO, 416/416 unit, 178/178 mcp-server integration, 33/33 hooks-bridge integration, 28/28 db integration, 32/33 e2e — the 1 e2e failure is the pre-existing F11-adjacent `policy-decisions-idempotency.test.ts` which calls `createDbClient({mode:'team', postgres})` and was broken independently by M03 S4; documented at the F11 row below).

| # | Severity | Title | Closed in | SHA |
|---|---|---|---|---|
| F1 | LOW | `lint/complexity/useOptionalChain` warning since S5 commit | Commit 6 | `6edeafe` |
| F2 | LOW (doc) | M03 closeout test counts inaccurate (`db` off by ~21 unit tests) | Commit 7 | _this commit_ |
| F3 | **HIGH** | DB integration tests' `beforeAll` cleanup missing `decisions` | Commit 1 | `8f0f02b` |
| F5 | MEDIUM | `check_policy.input.sessionId` not validated against `runKeySegmentSchema` | Commit 2 | `b2f37fb` |
| F7 | MEDIUM | Bridge `recordPolicyDecision` skips audit when `projectId` unresolved | Commit 5 | `7c7350d` |
| F8 | **HIGH** | `run_events.run_id` always NULL — `lookupRunId(undefined,…)` + `runId: null` hardcoded | Commit 3 | `900e55c` |
| F9 | MEDIUM | Bridge and MCP server mint distinct `runs` rows for one logical session | Commit 4 | `3f3eb83` |
| F10 | LOW | MCP-minted `runs` rows have `agent_type='unknown'` | Commit 4 | `3f3eb83` |
| F11 | MEDIUM (doc) | Phase 6 plan impossible by design — apps are SQLite-only | Commit 7 | _this commit_ |
| F12 | LOW | Bridge logs never carry `runId` (downstream of F8) | Commit 3 | `900e55c` |
| F13 | LOW (process) | M03 closeout left `2026-04-26-run-proj_0513a96.md` untracked | Commit 6 | `6edeafe` |
| F4 | (merged into F3) | Vitest fileParallelism — was a side-effect of F3, not a separate bug | n/a | n/a |
| F6 | (n/a) | Verification harness fixture mismatch — fail-open behaviour was correct §7 | n/a | n/a |

**Carried forward — not addressed in this batch (tracked for follow-ups):**

- The `policy-decisions-idempotency.test.ts` e2e helper at `__tests__/e2e/_helpers/postgres.ts:40-44` calls `createDbClient({ mode: 'team', postgres: { databaseUrl } })`. M03 S4 changed `createDbClient` to always pass `kind: 'local'` to `@coodra/db::createDb`, so the helper now opens a sqlite handle regardless of the `mode` parameter and trips the `expected postgres handle` guard. This is a separate clean-up (the e2e helper should call `createDb({ kind: 'cloud', postgres: { databaseUrl } })` directly rather than route through `createDbClient`). Tracked here so future verification briefs don't re-discover it; not bundled into F11's commit because it's a pure helper-shape change rather than a doc-clarification.
- runs.id format unification — bridge mints via `randomUUID()`, MCP via `generateRunKey()`. F9's contract is "both surfaces resolve to the SAME row," not "same id format"; the format mismatch is internal (agents pass `runId` opaquely). Unification is a future tidy.
- Backfill of historical `run_events.run_id IS NULL` rows in pre-fix dev DBs — these are dev-only artefacts; the SQL clause is one UPDATE if anyone needs it.

**Verification harness re-run after Commit 6 landed** (re-run details in §"Verification artifacts" above; the 4 manual harnesses still execute clean against fresh DBs).

---

## F1–F7 fix register

The seven fix commits in `54c95ab..0c38b63` closed eleven distinct findings (F1–F3, F5, F7–F13). Several commits closed multiple findings; the table below is keyed on commit, with the **Fix ID** column listing the F-numbers each commit addressed. F4 and F6 do not appear as standalone rows: F4 (vitest fileParallelism) was confirmed during Phase 1.7 to be a side-effect of F3's incomplete cleanup, not a separate bug — vitest's `fileParallelism: false` config IS correctly serializing test files; F3's stale state is what poisoned the second run, so F4 is documented inside F3's row. F6 (Claude Code + Windsurf adapter `invalid_hook_payload`) was a verification-harness fixture mismatch — initial JSON payloads used wrong field names; the bridge's `.strict()` Zod schemas correctly rejected them and failed open per `system-architecture.md §7`; no bridge-side bug, no commit. **⚠ STRUCTURAL** flags below mark fixes that touched schema, idempotency-key shape, or the auth chain — those three categories never go quiet.

| Fix ID | Commit SHA (short) | Files touched (top 3) | What was wrong | What the fix changes | Severity | Surfaced by which phase |
|---|---|---|---|---|---|---|
| **F3** (and F4 as merged side-effect) | `8f0f02b` | `packages/db/__tests__/integration/_helpers/postgres-clean.ts` (NEW), `…/postgres-migrate.test.ts` (M), `…/cloud-mode-write.test.ts` (M) | Both DB-integration test files' `beforeAll` hand-rolled a 9–10-line list of `DROP TABLE IF EXISTS …` statements that did not include `decisions` (the table M02 added in migration `0003_slow_meteorite.sql`). Vitest with `fileParallelism: false` ran them serially, so whichever file's migrations completed first left `decisions` populated; the other file's `beforeAll` then dropped only the listed 9 tables, ran migrate, and crashed on `CREATE TABLE "decisions" already exists` (Postgres 42P07). CI was green only because GitHub Actions provisions a fresh service container per job — the documented `pnpm -w docker:up && pnpm test:integration` workflow was broken locally. | New `dropAllPublicTables(sql)` helper queries `information_schema.tables` at runtime to enumerate every public table and DROP each with CASCADE. Both test files now call the helper instead of hand-rolling. The helper also drops the `drizzle` schema (where Drizzle stores `__drizzle_migrations`) and recreates the `vector` extension that migrate-0000 depends on. Future modules adding tables don't need to update the test files. | **major** | Read-only verification Phase 1.7 (DB integration suite re-run against the long-running compose Postgres) |
| **F5** | `b2f37fb` | `apps/mcp-server/src/tools/check-policy/schema.ts` (M), `apps/mcp-server/__tests__/unit/tools/check-policy-session-validation.test.ts` (NEW) | `check_policy.input.sessionId` was declared `z.string().min(1).max(256)` — accepted any string. The shared `runKeySegmentSchema` enforced "no `:` (run-key separator)" everywhere else (framework `PerCallContext.sessionId`; bridge `normalizeSessionId`), but the explicit MCP tool input bypassed that gate. A direct caller passing `sessionId: "has:colon"` reached the policy evaluator and returned a normal `permissionDecision`. The M02 §8.6 closure note claimed boundary normalization closed this everywhere — true at the framework layer, false at the tool-input layer. | Replace the field with `runKeySegmentSchema.max(256, …).describe(…)` — same shape as the framework gate. The bridge's `normalizeSessionId` still pre-sanitises hook ingress, so production traffic doesn't trip; this fix only affects direct MCP callers (or a regression in the bridge boundary). New 5-case unit test locks the contract. | **minor** **⚠ STRUCTURAL** (idempotency-key shape) | Read-only verification Phase 2.4 (MCP tool walk with deliberate `sessionId: "has:colon"`) |
| **F8 + F12** | `900e55c` | `packages/db/src/lookup-run.ts` (NEW), `apps/hooks-bridge/src/lib/run-recorder.ts` (M), `apps/hooks-bridge/__tests__/integration/handlers/run-id-linkage.test.ts` (NEW) | F8 — `run-recorder.ts:199` called `lookupRunId(undefined, sessionId)` with `projectSlug` hardcoded to `undefined`. The in-file `lookupRunId(projectSlug, sessionId)` short-circuited at line 134 (`if (projectSlug === undefined) return null;`), so every `run_events.run_id` was NULL. Same defect at line 364: `recordPolicyDecision` built `RecordPolicyDecisionArgs` with `runId: null` hardcoded even though the calling pre-tool handler had `projectId` resolved and in scope. The architecture's `runs ↔ run_events ↔ policy_decisions` join returned 0 rows for any session — the foundational NHI / SOC2-style "all events for run X" governance query was broken. F12 — direct downstream: bridge log fields included `sessionId, agentType, toolName, projectId, projectSlug` but never `runId` because the recorder couldn't resolve it. | Lift the working `selectLatestRun` from `apps/mcp-server/src/tools/get-run-id/handler.ts` into a shared `packages/db/src/lookup-run.ts::lookupRunId(db, projectId, sessionId): Promise<string \| null>`. Recorder methods (`recordPostToolUse`, `recordUserPromptSubmit`, `recordPolicyDecision`) now take `projectId` from the calling handler; both writers call `lookupRunId(deps.db, projectId, event.sessionId)` and fill the FK at INSERT time. Handlers (`pre-tool-use`, `post-tool-use`, `user-prompt-submit`) all resolve `projectId` via `projectSlugResolver.resolve(event.cwd, deps.db)`. Bridge `policy_decision_recorded` and `run_event_recorded` debug logs now carry `runId` (closes F12). New `lookup-run.test.ts` (5 cases) + `run-id-linkage.test.ts` (the integration test that asserts the JOIN — would have caught F8 directly). | **blocker** **⚠ STRUCTURAL** (idempotency-key shape; audit-row FK semantics) | Read-only verification Phase 5.4 (DB inspection: `SELECT COUNT(*) FROM run_events WHERE run_id IS NULL` returned 7/7 after closed-loop walk) |
| **F9 + F10** | `3f3eb83` | `apps/mcp-server/src/tools/get-run-id/{schema,handler,manifest}.ts` (M), `apps/mcp-server/__tests__/unit/tools/get-run-id-agent-session.test.ts` (NEW), `essentialsforclaude/05-agent-trigger-contract.md` (M) | F9 — bridge's `recordSessionStart` wrote `runs.session_id = event.session_id` (the agent's id, e.g. `phase5-ts-1777276516460`) while MCP `get_run_id` wrote `runs.session_id = ctx.sessionId` (transport-generated `stdio-…`/`http-…`). The unique index `(project_id, session_id)` enforced uniqueness per pair, so each surface created its own row. One logical agent session → two `runs` rows. The architecture's "run = 1:1 with agent session" intent was convention, not enforcement. F10 — `get_run_id`'s schema had no `agentType` field; the MCP framework's `PerCallContext.agentType` defaulted to `'unknown'` for HTTP, so MCP-minted rows always carried `agent_type='unknown'` regardless of which agent was active. | Schema adds optional `agentSessionId` (validated by `runKeySegmentSchema.max(256)`) + `agentType` enum (`claude_code \| cursor \| windsurf \| unknown`). Handler uses `input.agentSessionId ?? ctx.sessionId` and `input.agentType ?? ctx.agentType` for both `selectLatestRun` lookup and `insertRun` row construction. When the agent passes its hook `session_id` as `agentSessionId`, MCP find/inserts the SAME row the bridge created from SessionStart. Idempotency-key formula in `manifest.ts` keys on `agentSessionId` when present so registry-layer dedupe matches `runs.id` resolution. Backward-compatible: callers omitting both fields get legacy behaviour. `essentialsforclaude/05-agent-trigger-contract.md §5.1` updated to direct agents to pass both. New `get-run-id-agent-session.test.ts` (7 cases). | **blocker** **⚠ STRUCTURAL** (idempotency-key shape; agent-identity propagation) | Read-only verification Phase 5.3 (`query_run_history` returned 5 rows for what should have been 2–3 logical sessions) + Phase 5.4 (`runs.agent_type='unknown'` on MCP-minted rows) |
| **F7** | `7c7350d` | `packages/db/src/ensure-global-project.ts` (NEW), `apps/hooks-bridge/src/lib/run-recorder.ts` (M), `apps/{mcp-server,hooks-bridge}/src/index.ts` (M) | When the bridge's `projectSlugResolver.resolve(event.cwd, db)` returned `undefined` (no `.coodra.json` in cwd, or `.coodra.json` exists but its `projectSlug` doesn't match a registered project), three audit writers — `recordPolicyDecision`, `recordSessionStart`, `recordSessionEnd` — early-returned with a DEBUG log to avoid violating the `policy_decisions.project_id NOT NULL` FK + `runs.project_id NOT NULL` FK. Result: agents working in an unregistered cwd had their PreToolUse decisions correctly evaluated (via the policy evaluator's `__global__` cache slot which loads all rules across all projects), but ZERO audit rows landed. The architecture's "every decision is audited" governance guarantee was broken for an entire common case (agents in repos that haven't onboarded to Coodra, agents in scratchpads, agents in non-Coodra-registered project trees). | New `packages/db/src/ensure-global-project.ts::ensureGlobalProject(db)` idempotently inserts a sentinel `projects` row with `id='__global__', slug='__global__', org_id='__global__', name='Global Policy Rules'` using `ON CONFLICT (id) DO NOTHING`. Both `apps/{mcp-server,hooks-bridge}/src/index.ts` call it after `migrateSqlite(...)`. Recorder's three audit methods now compute `effectiveProjectId = projectId ?? GLOBAL_PROJECT_ID` instead of skipping. Per-method log fields gain a `fallbackToGlobal: boolean` flag for ops visibility. The policy evaluator's existing in-memory `__global__` cache slot now has a real backing project — rules attached to `project_id='__global__'` apply at evaluation time when no specific project is bound. New `ensure-global-project.test.ts` (3 cases) + `global-audit.test.ts` (drives PreToolUse from a tempdir without `.coodra.json` and asserts deny + audit-row-with-project_id=__global__). | **major** **⚠ STRUCTURAL** (schema — sentinel projects row + FK fallback semantics) | Read-only verification Phase 4.3 (PreToolUse from `cwd` without `.coodra.json` returned `deny` correctly but `SELECT COUNT(*) FROM policy_decisions WHERE session_id=…` was 0) |
| **F13 + F1** | `6edeafe` | `apps/mcp-server/src/lib/context-pack.ts` (M), `apps/hooks-bridge/src/lib/auth-middleware.ts` (M), `.coodra.json` (NEW), `.gitignore` (M), `docs/context-packs/2026-04-25-run-proj_bd33622.md` (DELETED) | F13 — `apps/mcp-server/src/lib/context-pack.ts::defaultContextPacksRoot()` returned `resolve(process.cwd(), 'docs', 'context-packs')`. Every `save_context_pack` call dropped a runId-named markdown file into the running process's cwd's `docs/context-packs/` directory. M03 closeout committed the hand-curated `2026-04-26-module-03-hooks-bridge.md` but forgot the auto-saved sibling left behind; M02 closeout had committed both. Convention undocumented — the agent had to figure out which files belonged in git on its own. F1 — `apps/hooks-bridge/src/lib/auth-middleware.ts:67` had a `lint/complexity/useOptionalChain` warning since commit `01982a0` (M03 S5 scaffold). Functionally equivalent (`authHeader && authHeader.startsWith('Bearer ')` returns the same boolean as `authHeader?.startsWith('Bearer ')`), but Biome's autofix was tagged `unsafe` so prior `lint:fix` runs left it. Each M03 slice's "lint clean" claim was inaccurate. | F13 — `defaultContextPacksRoot()` returns `resolve(homedir(), '.coodra', 'packs')` instead. Auto-saved files now land in `~/.coodra/packs/` (out of any repo, gitignored via the existing `.coodra/` rule). `COODRA_CONTEXT_PACKS_ROOT` env knob still overrides. Defensive `.gitignore` entry `docs/context-packs/*-run-*.md` catches any agent that overrides the root to point at the repo. Removed orphan tracked pack `2026-04-25-run-proj_bd33622.md`. New `.coodra.json` at repo root declares `projectSlug='coodra'` so the bridge resolves a real project (not the F7 `__global__` fallback) when run inside this repo. New unit test `context-pack-default-root.test.ts` locks the new default. F1 — `pnpm exec biome check --write --unsafe apps/hooks-bridge/src/lib/auth-middleware.ts` applies the optional-chain shorthand: `if (authHeader?.startsWith('Bearer ')) {`. Lint is now 0 errors / 0 warnings. | **nit** **⚠ STRUCTURAL** (F1 touches the auth-middleware file even though semantically equivalent — flagged per the never-quiet rule) | F13 — read-only verification Phase 0 (git status on session start showed untracked auto-saved pack); F1 — read-only verification Phase 1.1 (first `pnpm lint` run) |
| **F2 + F11** | `b829e5a` | `docs/context-packs/2026-04-26-module-03-hooks-bridge.md` (M), `system-architecture.md` (M), `docs/DEVELOPMENT.md` (M), `docs/verification/2026-04-27-module-01-02-03-verification.md` (M), `essentialsforclaude/04-when-in-doubt.md` (M) | F2 — M03 closeout context pack reported `@coodra/db: 6 unit + 15 in CI`. A fresh `pnpm --filter @coodra/db run test:unit` against the same branch yielded 42 passing; the 6+15 number was a stale snapshot. Documentation drift, no behavioural impact. F11 — verification Phase 6 plan asked to "boot the bridge against Postgres with `kind:'cloud'`". That's impossible by design: `apps/{mcp-server,hooks-bridge}/src/lib/db.ts` both unconditionally pass `kind: 'local'` to `@coodra/db::createDb`. M03 S4 explicitly removed the `COODRA_DB_OVERRIDE_MODE` knob. The architecture's §1 callout said "local services always write to local SQLite" but the M03 closeout marked §8.3 as "closed" without spelling out the implication — the verification author's plan reflected pre-S4 expectations. | F2 — corrected the closeout's test-count table with the right number (42) plus a one-paragraph correction note explaining the original drift and the subsequent fix-commit additions (+5 lookup-run, +3 ensure-global-project, +5 postgres-clean → 28 db integration today). F11 — strengthened `system-architecture.md §1`'s "local services always write to local SQLite" callout to name `apps/{mcp-server,hooks-bridge}/src/lib/db.ts` directly and cite M03 S4's removal of the override knob, naming the future cloud-write owners (Sync Daemon, Module 05 NL Assembly's embeddings-ingest worker). New `docs/DEVELOPMENT.md` "Why I can't boot the binaries against Postgres" subsection. New `essentialsforclaude/04-when-in-doubt.md §4.5`. Verification report §11 closure-log appendix added (above this section). | **minor** | F2 — read-only verification Phase 1.4 (per-package count check); F11 — read-only verification Phase 6 (architectural alignment review) |
