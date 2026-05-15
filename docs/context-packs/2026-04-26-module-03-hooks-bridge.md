# Module 03 — Hooks Bridge — Context Pack

## Header

- **Date:** 2026-04-26
- **Module:** 03 — Hooks Bridge
- **Feature Pack:** `docs/feature-packs/03-hooks-bridge/`
- **Session lead (human):** Abishai
- **Run ID:** `run:proj_0513a96a-abec-4e85-94ce-9c75d9aa65a1:stdio-174c17ad-bfdb-4317-8f59-f3f26c7bbddb:a7af7b08-4423-4460-8475-1168a2b19b42`
- **Branch at session start:** `main` (`f496cc5`)
- **Branch at session end:** `feat/03-hooks-bridge` (`1a65797`, awaiting squash)
- **Commits landed this session (newest first):**
  - `1a65797` test(e2e): full session lifecycle through hooks-bridge + mcp-server
  - `9eae39a` test(db): cloud-mode-write integration test for createDb({kind:'cloud'})
  - `dd6c515` chore(repo): wire Claude Code hooks to hooks-bridge in .mcp.json
  - `01fbd77` feat(scripts): windsurf + cursor hook adapter shell scripts
  - `fa9907c` feat(hooks-bridge): UserPromptSubmit recorded as run_event
  - `9c6f475` feat(hooks-bridge): SessionStart + Stop run lifecycle
  - `2e7feff` feat(hooks-bridge): post-tool RunRecorder + policy_decisions audit
  - `b126928` feat(hooks-bridge): pre-tool policy enforcement + project resolver
  - `9e88f14` feat(shared,hooks-bridge): per-agent adapters + HookEvent + normalizeSessionId
  - `01982a0` feat(hooks-bridge): scaffold @coodra/hooks-bridge — Hono + auth chain
  - `48275f7` refactor(db,mcp-server): createDb takes kind: local|cloud
  - `85ee536` refactor(workspace): extract @coodra/policy + @coodra/shared/auth
  - `128fe8a` chore(context-memory): archive module-02 closeout, begin module-03
  - `3a76f23` docs(03-hooks-bridge): spec, implementation plan, techstack, meta
  - `5b6b13d` chore(scope): apply 2026-04-24 user-directive scope updates + Module 08a placeholder

## Outcome

Coodra now has a working write surface paired with the Module 02 read surface. The new `apps/hooks-bridge` Hono service on `127.0.0.1:3101` ingests Claude Code (HTTP), Windsurf (shell adapter), and Cursor (shell adapter) hook events, normalizes them through per-agent adapters into the canonical `HookEvent`, runs pre-tool policy enforcement (fail-open + cockatiel-wrapped + cache-first), and audits to `policy_decisions` + `runs` + `run_events` via `setImmediate` outbox writes. Together with mcp-server they form the full Modules 01 + 02 + 03 closed loop verified by the new `__tests__/e2e/full-session-with-hooks-bridge.test.ts` (8 cases: SessionStart → PreToolUse(deny) → PreToolUse(allow) → PostToolUse → UserPromptSubmit → Stop → MCP get_run_id → MCP save_context_pack → file on disk).

Both verification carryovers from Module 02 are closed: §8.3 (`createDb` discriminates `kind: 'local' | 'cloud'`; local services always run on SQLite; the M02 `COODRA_DB_OVERRIDE_MODE` env knob is removed) and §8.6 (`normalizeSessionId` + `runKeySegmentSchema.parse(...)` enforced at every external session-id boundary).

## Scope boundary

**In scope:**

- AC-1..AC-9, AC-11..AC-17, AC-21, AC-22, AC-24 from `docs/feature-packs/03-hooks-bridge/spec.md`. Slices S1..S15 landed exactly as planned (with one structural deviation — see Decisions).
- New workspace package `@coodra/policy` (deviation from spec.md's "policy lives in shared" — necessary because of the shared←→db cycle that would form).
- `@coodra/shared/auth` subdirectory (no DB dependency, lives in shared as planned).
- Cross-package types `Identity`, `AuthClient`, `PolicyClient`, `PolicyInput`, `IdempotencyKey` moved to shared/auth or shared/idempotency or @coodra/policy; original mcp-server paths preserved as thin re-exports.
- `apps/hooks-bridge` complete: env + auth-chain middleware + per-agent routes + adapters + dispatch + handlers (pre / post / session_start / session_end / user_prompt) + RunRecorder + 32 integration tests + 12 unit tests.
- Adapter shell scripts: `scripts/hook-adapters/{windsurf,cursor}-coodra.sh` + `install.sh` + `__tests__/smoke.sh` + matrix CI job (ubuntu + macos).
- `.mcp.json` + `.mcp.dev.json` updated with `hooks` block (Claude Code POSTs all 5 events to the bridge).
- Module 02 verification carryover §8.3 closed in S4; §8.6 closed in S6.
- Cloud-mode integration test for the future Sync Daemon (`packages/db/__tests__/integration/cloud-mode-write.test.ts`).

**Explicitly deferred:**

- AC-23 (CI green on the new repo) — verified locally + CI workflow updated; user re-runs CI on the squash-merge to `main`.
- §8.5 follow-up (richer `coodra init` UX) — Module 08a CLI scope per the verification report's appendix and the original spec.md.
- `pending_jobs` durable outbox — still on the deferred list per Module 02 spec §3 non-goals; revisit if DB downtime becomes visible after live use.
- JIRA / GitHub webhook handlers — separate post-Module-04 integration modules.
- Live Clerk JWT validation against a real tenant — same posture as Module 02; pairs with Module 04's auth UX.
- Backfilling `run_events.run_id` from the SessionStart-created `runs` row — currently always `null` for hooks-bridge writes; `ON DELETE SET NULL` schema column was designed for this; Module 04's context-pack assembly joins on `(project_id, session_id)` chronologically anyway.

## Decisions made

- **Decision:** Create new workspace package `@coodra/policy` (`packages/policy/`) for the policy evaluator. (supersedes spec.md's "policy moves to `packages/shared/src/policy/`")
  **Rationale:** `@coodra/db` already depends on `@coodra/shared`. Putting policy in shared would force shared to depend on `@coodra/db` (for `DbHandle` + the schema tables policy queries), creating a workspace cycle. Auth has no DB dep and lives in shared as planned.
  **Alternatives considered:** Break `@coodra/db`'s shared dependency by inlining `createLogger`/`InternalError`/`ValidationError` (rejected — duplicates error types). Type-only db imports (rejected — policy uses `postgresSchema`/`sqliteSchema` as runtime values). Lazy import db (rejected — async lazy adds latency to the hot path). Put policy in `@coodra/db` (rejected — conflates schema with domain logic).
  **Cross-reference:** `context_memory/decisions-log.md` 2026-04-25 15:00; commit `85ee536`.

- **Decision:** `createDb` takes a `kind: 'local' | 'cloud'` discriminator; `mode` is now an auth-strategy hint that does NOT change DB choice. Removes the M02 `COODRA_DB_OVERRIDE_MODE` env knob.
  **Rationale:** `system-architecture.md §1` is unambiguous — local services always write to local SQLite, in BOTH solo and team mode. The M02 `mode → DB` coupling contradicted that. The new `kind` discriminator makes the dispatch axis explicit and the override knob unnecessary.
  **Alternatives considered:** Keep `mode → DB` coupling and document the contradiction (rejected — directly contradicts §1). Auto-derive `kind` from `mode` (rejected — same coupling, same problem).
  **Cross-reference:** `context_memory/decisions-log.md` 2026-04-25 15:18; commit `48275f7`. Closes verification finding §8.3.

- **Decision:** `normalizeSessionId(raw)` is the only function that touches an agent-supplied session id at the hooks-bridge boundary. Sanitises `[<>:"/\\|?*\s]+` → `-`, collapses `--`, runtime-validates via `runKeySegmentSchema.parse`. Lossy for Claude Code's `:fork-N` notation (collapses to `-fork-N`) but the fork-id is also surfaced in `tool_use_id`, so no fork lineage is lost.
  **Rationale:** Module 02 `runKeySegmentSchema` (commit `315c41d`) protects the read surface (MCP registry boundary). Module 03 extends the same invariant to the write surface so neither side can ever land a colon-bearing sessionId in a run-key.
  **Alternatives considered:** Reject colon-bearing sessions outright (rejected — Claude Code session ids legitimately contain colons; we'd lose every session). Encode colons (rejected — round-trip fragility; lossy normalize is safer + traceable).
  **Cross-reference:** `context_memory/decisions-log.md` 2026-04-25 16:30; commit `9e88f14`. Closes verification finding §8.6.

- **Decision:** `run_events.id` for hooks-bridge writes is `re_` + sha256(sessionId + '|' + toolUseId + '|' + phase).slice(0, 32). Architecture's stated SHAPE `{sessionId}-{toolUseId}-{phase}` (per `system-architecture.md §4.3`) is preserved in spirit (deterministic per-event triple); wire form differs.
  **Rationale:** `@coodra/shared::generateRunEventKey` rejects hyphens in segments (`assertRunEventKeySegment`), but `normalizeSessionId` produces hyphen-rich sessionIds by design. The hash captures the same uniqueness contract while accepting any input.
  **Alternatives considered:** Relax shared/idempotency::generateRunEventKey to accept hyphens (rejected — that validator protects future parseable-key consumers; relaxing it silently changes the parse contract for them). Add a separate composite unique index on (session_id, tool_use_id, phase) (rejected — schema change for a contract the local recorder owns just as cleanly).
  **Cross-reference:** `context_memory/decisions-log.md` 2026-04-25 17:00; commit `2e7feff`.

- **Decision:** Pre-tool handler is the project resolver's only DB-dependent caller. Resolver does cwd → slug (read `.coodra.json`) → projects.id (DB SELECT) with separate 60s caches. Hooks-bridge mirrors mcp-server's `resolveProjectId` precedent.
  **Rationale:** Policy evaluator filters `policies.project_id` against UUID, but `.coodra.json` and tools speak in slugs. The resolver bridges that gap; the existing precedent in `apps/mcp-server/src/tools/check-policy/handler.ts::resolveProjectId` validates the pattern.
  **Alternatives considered:** Filter rules by slug (rejected — schema mismatch, would require JOIN with projects on every policy evaluation). Compute projectId client-side (rejected — agent doesn't know the UUID).
  **Cross-reference:** `context_memory/decisions-log.md` 2026-04-25 16:45; commit `b126928`.

- **Decision:** Test-injectable `RunRecorder.schedule` accepts `(cb: () => Promise<void>) => void`. Production default is `setImmediate(cb)`; test override pushes the returned promise into a tracked array and exposes `drain()` for deterministic assertions.
  **Rationale:** Production setImmediate is proven idempotent by the SQL layer (ON CONFLICT DO NOTHING). Sync drain just removes timing flakiness from integration tests. Without it, the suite would have to `await new Promise(setImmediate)` between every POST and every read assertion.
  **Alternatives considered:** Use a real subprocess and let setImmediate fire naturally (rejected — wall-clock cost balloons + flake risk). Make the recorder methods async-await (rejected — defeats the §8 < 10ms response budget).
  **Cross-reference:** Implementation in `apps/hooks-bridge/src/lib/run-recorder.ts`; usage in `apps/hooks-bridge/__tests__/integration/handlers/post-tool-use.test.ts` + the e2e file.

- **Decision:** Clerk JWT is mocked at the `@coodra/shared/auth` package boundary, not at hooks-bridge's. Hooks-bridge's auth-chain integration test stays at chain-order granularity (solo-bypass → X-Local-Hook-Secret → 401 fall-through); the SDK's verifyToken internals are exercised by the dedicated unit test in `packages/shared/__tests__/unit/auth/auth.test.ts`.
  **Rationale:** `vi.mock('@clerk/backend')` only intercepts when test + impl share a vitest run / module resolution context. Hooks-bridge's tests run in apps/hooks-bridge's vitest; the dist of `@coodra/shared/auth` imports `@clerk/backend` through a different resolution path that bypasses the mock. Same pattern caught Module 03 S3 (auth-chain.test.ts moved from mcp-server to shared for the same reason).
  **Alternatives considered:** Use vitest deps.inline gymnastics (tried — didn't reliably work). Spawn a real Clerk-mock service (rejected — infra cost for a chain-order test).
  **Cross-reference:** S5 + S6 commit messages; same pattern as decisions-log 2026-04-25 15:00.

## Files touched

Grouped by package. Counts the 14 commits that landed on `feat/03-hooks-bridge`.

**`packages/shared/`:**

- `src/auth/{index,auth,types}.ts` — created (moved from mcp-server)
- `src/hooks/{event,normalize-session-id,index}.ts` — created
- `src/hooks/payloads/{claude-code,windsurf,cursor}.ts` — created
- `src/hooks/adapters/{claude-code,windsurf,cursor}.ts` — created
- `src/idempotency.ts` — extended with `IdempotencyKey` type re-export
- `src/index.ts` — barrel updated with `IdempotencyKey` export
- `package.json` — `@clerk/backend@3.3.0` added; `./auth` + `./hooks` subpath exports
- `__tests__/unit/auth/auth.test.ts` — created (moved from mcp-server)
- `__tests__/unit/hooks/{normalize-session-id, adapter-parity, claude-code-adapter, windsurf-adapter, cursor-adapter}.test.ts` — created (24 tests)

**`packages/policy/` (NEW):**

- `package.json` + `tsconfig.json` + `tsconfig.typecheck.json` + `vitest.config.ts` — created
- `src/{index,types,policy}.ts` — created (moved from mcp-server)
- `__tests__/unit/exports.test.ts` — created (7 tests)

**`packages/db/`:**

- `src/client.ts` — `CreateDbOptions` refactored to `kind: 'local' | 'cloud'` discriminated union
- `__tests__/unit/client.test.ts` — `describe('createDb (mode dispatch)')` replaced with `describe('createDb (kind discriminator — Module 03 S4)')`
- `__tests__/integration/cloud-mode-write.test.ts` — created (CI-only; gated on DATABASE_URL)

**`apps/mcp-server/`:**

- `src/lib/{policy,auth}.ts` — converted to thin re-export shims
- `src/lib/db.ts` — `createDbClient` always passes `kind: 'local'`; `CreateDbClientOptions` no longer extends the db-package CreateDbOptions
- `src/framework/{policy-wrapper,idempotency,tool-context}.ts` — re-export shims for the moved types
- `src/index.ts` — boot path always-local; defensive `kind !== 'sqlite'` throw; `COODRA_DB_OVERRIDE_MODE` wiring removed
- `src/config/env.ts` — `COODRA_DB_OVERRIDE_MODE` removed
- `package.json` — drops `cockatiel`, `@clerk/backend`, `@types/picomatch` (now transitive); adds `@coodra/policy`
- `__tests__/integration/boot-team-mode-local-sqlite.test.ts` — renamed + rewritten (was boot-db-override.test.ts)
- `__tests__/unit/lib/auth-chain.test.ts` — deleted (moved to shared)
- `vitest.config.ts` — temporary deps.inline workaround removed

**`apps/hooks-bridge/` (NEW):**

- `package.json` + `tsconfig.json` + `tsconfig.typecheck.json` + `vitest.config.ts` + `vitest.integration.config.ts` — created
- `README.md` + `.env.example` + `.dockerignore` — created
- `src/bootstrap/ensure-stderr-logging.ts` — created
- `src/config/env.ts` — created (HOOKS_BRIDGE_HOST, HOOKS_BRIDGE_PORT default 3101, Clerk strictness mirroring mcp-server)
- `src/lib/{auth-middleware,db,dispatch,resolve-project-slug,run-recorder}.ts` — created
- `src/handlers/{pre-tool-use,post-tool-use,session-start,session-end,user-prompt-submit}.ts` — created
- `src/app.ts` — buildApp(deps) returning Hono app with healthz + 3 POST routes
- `src/index.ts` — boot entry wiring everything
- `__tests__/unit/{config/env, handlers/post-tool-use, handlers/pre-tool-use}.test.ts` — created
- `__tests__/integration/{healthz, auth-chain, adapters}.test.ts` + `__tests__/integration/handlers/{pre-tool-use, post-tool-use, session-lifecycle, user-prompt-submit}.test.ts` — created (29 tests)

**`scripts/hook-adapters/` (NEW):**

- `windsurf-coodra.sh` + `cursor-coodra.sh` + `install.sh` — created
- `__tests__/smoke.sh` — created (6 assertions, runs in CI on ubuntu + macos)

**Repo root:**

- `package.json` — added `@coodra/{hooks-bridge,policy}` workspace deps for the e2e test imports
- `.mcp.json` + `.mcp.dev.json` — added `hooks` block routing all 5 events to `127.0.0.1:3101/v1/hooks/claude-code`
- `.gitignore` — added `.claude/` (per-machine IDE state)
- `.github/workflows/ci.yml` — integration job builds shared → db → policy → mcp-server → hooks-bridge in dependency order; e2e job adds the same; new `hook-adapter-smoke` matrix job (ubuntu + macos)
- `__tests__/e2e/full-session-with-hooks-bridge.test.ts` — created (8 tests)
- `system-architecture.md` + `essentialsforclaude/08-implementation-order.md` — applied 2026-04-24 user-directive scope updates (orphan from prior session)
- `docs/feature-packs/03-hooks-bridge/{spec, implementation, techstack}.md` + `meta.json` — created
- `docs/feature-packs/08a-cli/{spec, implementation, techstack}.md` + `meta.json` — created (placeholder for the next module after 03 per the new build order)
- `docs/DEVELOPMENT.md` — added "Iterating on Module 03 (Hooks Bridge)" section
- `docs/verification/2026-04-25-module-01-02-verification.md` — §11 "Findings closed" appendix marks §8.3 + §8.6 closed
- `External api and library reference.md` — `@coodra/policy` subsection added; module-location notes on cockatiel/@clerk/backend/picomatch
- `context_memory/{current-session.md, decisions-log.md, pending-user-actions.md, sessions/2026-04-25-module-02-closeout.md}` — archived M02, opened M03 with running log

## Tests

Test counts at end of session:

| Package | Unit | Integration | Notes |
|---|---|---|---|
| `@coodra/shared` | **117** (was 75 pre-M03; +42 for `auth/` and `hooks/`) | n/a | |
| `@coodra/policy` | **7** | n/a | smoke + pure-logic; the cache+breaker is integration-tested through mcp-server |
| `@coodra/db` | **42** unit (was reported as "6+9 skipped"; verification 2026-04-27 F2 caught the count drift — actual local pass count was already 42 at M03 closeout) | **15 in CI / 9 locally + 6 skipped without DATABASE_URL** | the 9 local cover postgres-migrate when DATABASE_URL is set; cloud-mode-write needs DATABASE_URL too |
| `@coodra/mcp-server` | **223** (unchanged from M02) | **178** (was 177; +1 for the renamed boot-team-mode-local-sqlite.test.ts) | |
| `@coodra/hooks-bridge` | **12** | **29** | covers healthz, auth chain order, per-agent adapter dispatch, pre-tool policy enforcement (4 happy + fail-open), post-tool RunRecorder idempotency, full session lifecycle, UserPromptSubmit |
| `__tests__/e2e/` (root) | n/a | **31 + 1 skipped locally / 32 in CI** | one new file: full-session-with-hooks-bridge (8 tests) |
| `scripts/hook-adapters/` | n/a | **6 smoke assertions** (matrix on ubuntu + macos) | |

**Total new tests this module: ~89** across all packages.

> **Correction note (verification 2026-04-27, F2):** the original
> `@coodra/db` row reported "6 unit + 15 in CI" which understated
> the actual local count. A fresh `pnpm --filter @coodra/db run
> test:unit` against this branch yields 42 passing (12 across two
> files including the schema-parity + run-key tests). The integration
> count "15" referred to test-cases inside `postgres-migrate.test.ts`
> + `cloud-mode-write.test.ts` runnable when `DATABASE_URL` is set.
> Subsequent verification fix commits added more tests (+5 lookup-run,
> +3 ensure-global-project, +5 postgres-clean) bringing the
> integration total to 28 with the F3 cleanup helper landed.

## How integration was verified

- **Unit + integration green** on every commit. Lint + typecheck + 8/8 packages clean before each push.
- **Full session e2e** (`__tests__/e2e/full-session-with-hooks-bridge.test.ts`) walks SessionStart → PreToolUse(deny) → PreToolUse(allow) → PostToolUse → UserPromptSubmit → Stop → MCP get_run_id → MCP save_context_pack → file on disk. All side effects checked against real SQLite tables.
- **Adapter smoke test** runs the actual shell scripts against a Python mock bridge — exit codes 0/2/0 (allow/deny/bridge-down) verified on local macOS; matrix CI runs ubuntu + macos.
- **Verification carryovers from Module 02**: §8.3 closed in S4 (boot-team-mode-local-sqlite.test.ts proves COODRA_MODE=team boots on SQLite without override env); §8.6 closed in S6 (normalizeSessionId test fixtures + the boundary-level Zod parse on every adapter).

## Known issues or limitations

- **`run_events.run_id` is always null for hooks-bridge writes today.** SessionStart creates the `runs` row, but the recorder's `lookupRunId(undefined, sessionId)` is currently called without threading a project slug — so it always returns null. Module 04's context-pack assembly joins on `(project_id, session_id)` chronologically anyway, so no data is lost; the `run_id` FK is reserved for future joins. Followup: thread `projectSlug` through `RunRecorder.recordPostToolUse` so the recorder can look up the run. **🆕 Update (2026-04-27): closed.** The hardcoded `lookupRunId(undefined, sessionId)` was elevated from "known limitation" to bug **F8** during post-merge integration testing and fixed in commit `900e55c`. See **§Post-merge integration findings** below for the seam-level analysis.
- **Cursor's payload schema reflects today's observed shape.** Cursor's hook system is newer + less stable than Claude Code's or Windsurf's; the schema has `.strict()` so any drift surfaces as a Zod parse failure (route fails open with `permissionDecision: 'allow'` + WARN). First live Cursor session may need to widen one or two optional fields.
- **Clerk JWT live validation still pending.** Same posture as Module 02 — wired + unit-tested with mocks; live Clerk tenant validation pairs with Module 04's auth UX or a dedicated team-mode dry-run.
- **No `pending_jobs` durable outbox.** `policy_decisions`, `run_events`, and `runs` writes use `setImmediate` + ON CONFLICT DO NOTHING. If DB downtime becomes visible after live use, schedule a slice in Module 04 or earlier.
- **Cursor adapter shell script normalizes field names server-side, not in the script.** `cursor-coodra.sh` posts the raw payload to `/v1/hooks/cursor`; the route's adapter (in `packages/shared/src/hooks/adapters/cursor.ts`) handles `conversation_id` → `sessionId`. This keeps the shell scripts uniform across the two agents.

## Post-merge integration findings (2026-04-27)

Post-M03-squash-merge integration testing of the agent → bridge → MCP → DB chain (the closed-loop scenario that no per-module test suite exercised) surfaced three bugs at the bridge ↔ MCP seam. All three were closed by follow-up commits before any further module landed; the M03 module itself was technically passing every unit + integration test it shipped with, but the test suites were measuring the wrong things at the seam — each module's tests verified its own surface in isolation, and none asserted the cross-surface invariants that the architecture's NHI / SOC2-style governance queries depend on.

### F7 — Bridge audit gap when no `.coodra.json`

**What broke:** PreToolUse from a cwd without a `.coodra.json` correctly denied via the policy evaluator's `__global__` rule cache, but no audit row landed in `policy_decisions` because the bridge's `recordPolicyDecision` (and `recordSessionStart` / `recordSessionEnd`) early-returned to avoid violating the `policy_decisions.project_id NOT NULL` FK.

**Why per-module tests missed it:** every hooks-bridge integration test seeded a project explicitly and provided a `.coodra.json`, so the `projectId === undefined` branch was never exercised — the test suite assumed "if we test the resolved-projectId path, the unresolved path falls out for free." The architecture's "every decision is audited" guarantee was specified at the design layer but never asserted in code.

**Fix commit:** `7c7350d` — new `ensureGlobalProject(db)` boot helper inserts a `__global__` sentinel `projects` row at boot; recorder methods compute `effectiveProjectId = projectId ?? GLOBAL_PROJECT_ID` instead of skipping.

**Test that locks it now:** `apps/hooks-bridge/__tests__/integration/handlers/global-audit.test.ts`

### F8 — `run_events.run_id` and `policy_decisions.run_id` always NULL

**What broke:** every audit row written by the bridge — both `run_events` (PostToolUse, UserPromptSubmit) and `policy_decisions` (PreToolUse) — landed with `run_id IS NULL`, breaking the `runs ↔ run_events ↔ policy_decisions` join that the architecture's NHI governance and SOC2-style "all events for run X" queries depend on. Root cause: `apps/hooks-bridge/src/lib/run-recorder.ts:199` called `lookupRunId(undefined, sessionId)` with `projectSlug` hardcoded to `undefined`, and line 364 hardcoded `runId: null` on policy-decision INSERTs.

**Why per-module tests missed it:** integration tests asserted "row exists" via `tool_use_id` lookups but never wrote a JOIN assertion across the three tables — the suite assumed presence-of-row implied correctness-of-FK, which was wrong because the bug was in the FK column itself, not the row's existence. The "Known issues or limitations" entry above accepted this state as a deferred limitation rather than recognising it as a broken governance invariant.

**Fix commit:** `900e55c` — new shared `packages/db/src/lookup-run.ts::lookupRunId(db, projectId, sessionId)` helper; bridge handlers (`pre-tool-use`, `post-tool-use`, `user-prompt-submit`) all resolve `projectId` via the existing slug resolver and thread it through to the recorder, which fills the FK at INSERT time.

**Test that locks it now:** `apps/hooks-bridge/__tests__/integration/handlers/run-id-linkage.test.ts` + `packages/db/__tests__/integration/lookup-run.test.ts` + JOIN assertion in `__tests__/e2e/full-session-with-hooks-bridge.test.ts` (test 4).

### F9 — Bridge and MCP server mint distinct `runs` rows for one logical session

**What broke:** the bridge's SessionStart wrote `runs.session_id` using the agent's hook `session_id`; MCP `get_run_id` wrote `runs.session_id` using its transport-generated `stdio-…`/`http-…` id. The unique index `(project_id, session_id)` enforced uniqueness per pair, so each surface created its own row — one logical agent session produced two distinct `runs` rows. `query_run_history` joins and "current run" semantics fragmented across both surfaces.

**Why per-module tests missed it:** bridge integration tests verified bridge-side `runs` rows in isolation; MCP integration tests verified MCP-side `runs` rows in isolation. No test crossed the seam to check that `query_run_history` after a bridge SessionStart + MCP `get_run_id` returns ONE row — the suite assumed the architecture's "run = 1:1 with agent session" intent was enforced when it was actually convention.

**Fix commit:** `3f3eb83` — `get_run_id` schema accepts optional `agentSessionId` + `agentType`; agents pass their hook `session_id` and MCP find/inserts the same `runs` row the bridge created from SessionStart.

**Test that locks it now:** `apps/mcp-server/__tests__/unit/tools/get-run-id-agent-session.test.ts` + e2e test 7b in `__tests__/e2e/full-session-with-hooks-bridge.test.ts` ("MCP get_run_id with agentSessionId=HOOK_SESSION_ID resolves to the bridge runs row").

### F14 — `policy_decisions` idempotency key collapsed distinct invocations within a session ⚠ STRUCTURAL

**What broke:** the architecture-spec'd idempotency-key formula `pd:{sessionId}:{toolName}:{eventType}` collapsed legitimately distinct tool invocations within a session into one audit row. Same-session Write to `/tmp/forbidden/a.ts` (deny) and Write to `/tmp/safe/b.ts` (allow) shared the key; the second row dropped on the UNIQUE index, and the audit trail lost the second decision. Confirmed live by driving 3 distinct PreToolUse events with the same toolName + eventType but different `tool_use_id`s — only 1 row landed pre-fix.

**Why per-module tests missed it:** tests for `recordPolicyDecision` verified RETRY DEDUPE (same key fires twice → 1 row) but never tested DISTINCT INVOCATIONS (different `tool_use_id`s with same toolName+eventType → 2 rows). The mental model was "the (sessionId, toolName, eventType) triple is the retry-dedupe key," but the agent's per-invocation `tool_use_id` (`tool_call_id` for Cursor, `execution_id` for Windsurf) is what actually distinguishes "retry of one invocation" from "second distinct invocation of the same kind." `run_events` already had `toolUseId` in its idempotency key (`{sessionId}-{toolUseId}-{phase}`); `policy_decisions` did not. Comment in the existing `run-id-linkage.test.ts` explicitly noted "Same toolName + same session collapses into a single audit row by design" — the bug masquerading as design.

**Fix commit:** `ca6f521` — `buildPolicyDecisionIdempotencyKey` formula extended to `pd:{sessionId}:{toolUseId}:{toolName}:{eventType}`; `RecordPolicyDecisionArgs` gains optional `toolUseId`; bridge recorder threads `event.turnId` through; MCP `check_policy` gains optional `toolUseId` input field; `system-architecture.md §4.3 + §24` updated; legacy callers fall back to `'no-turn'` sentinel. Retry dedupe (same `tool_use_id` repeated) still collapses to one row.

**Test that locks it now:** `apps/hooks-bridge/__tests__/integration/handlers/distinct-tool-uses.test.ts` (NEW) — drives same-session + same-tool + DIFFERENT `tool_use_id`s → 2 audit rows, plus same-session + same-tool + SAME `tool_use_id` fired 5× → 1 row (retry dedupe preserved). Plus 4 new unit assertions in `apps/mcp-server/__tests__/unit/tools/check-policy.test.ts` and 3 new in `packages/policy/__tests__/unit/exports.test.ts`.

### F15 — Bridge handler INFO logs missing `runId` (F12 partial closure)

**What broke:** F12 (commit `900e55c`) closed the runId-in-bridge-logs gap only at DEBUG level, inside the recorder's `setImmediate` callback. The Phase 7 of the original verification brief asks "grep for the runId, every line touching that run carries it" — INFO level. In production, debug-level lines aren't on by default, so SOC2 / NHI auditors who grep for a runId across bridge + MCP service streams find lines from MCP (which logs runId at INFO) but not from the bridge.

**Why per-module tests missed it:** the post-merge fix-batch tests asserted `policy_decisions.run_id` and `run_events.run_id` were populated (DB-state assertion), not "the handler's INFO log line includes runId." The two are correlated through correct code, but distinct testable invariants. The F12 commit message claimed "bridge logs include runId" but only added DEBUG-level lines; verifying log-level wasn't part of the test suite.

**Fix commit:** `1cc7bbb` — pre-tool-use and post-tool-use handlers now run `lookupRunId(db, projectId|__global__, sessionId)` synchronously on the hot path (~1ms SQLite roundtrip, well within the §6 / §16-pattern-4 50ms PreToolUse latency budget) and include the resolved value as `runId` in the existing INFO log lines. Throw paths fall through with `runId: 'unresolved'` and a WARN-level lookup-failed line; the handler's primary decision still returns successfully (audit-only path). `SessionStart` hook_ingress lines deliberately exclude runId — the runs row is minted INSIDE the SessionStart handler, so at hook_ingress log-emit time there is no run to look up; these are 1 of 6 lines per session and the architectural reality is documented.

**Test that locks it now:** `apps/hooks-bridge/__tests__/unit/handlers/handler-log-runid.test.ts` (NEW) — mocks `lookupRunId` and asserts both handlers call it synchronously with `(db, projectId|'__global__', sessionId)`, that throw paths are non-fatal, and that `event_phase_mismatch` early-return paths skip the lookup. Pino's sonic-boom destination bypasses `process.stdout.write`, so asserting on log content directly is impractical in vitest; mocking the underlying call site is the cleanest equivalent.

Verification report: `docs/verification/2026-04-27-module-01-02-03-verification.md`

## What should be built next

**Module 04 (Web App)** per `essentialsforclaude/08-implementation-order.md`. Hooks-bridge unblocks Module 04's onboarding flow, which assumes a working write surface. Key Module 04 acceptance points likely impacted by Module 03's deliverables:

- Module 04's first acceptance test should include a smoke test against a real Clerk dev project that calls the MCP server over HTTP with a real Bearer token. This is the live-Clerk-validation gate Module 02 + 03 deferred.
- Module 04's run-detail UI reads from `runs` + `run_events` + `context_packs` + `policy_decisions` — all four tables are now populated via the hooks-bridge audit path landed here.
- The `.coodra.json` pattern landed here (cwd → projectSlug → projectId) is the same lookup Module 04's project picker should use.

**Carryover items for future modules:**

- §8.5 follow-up (`coodra init` UX) → **Module 08a (CLI)**
- `pending_jobs` durable outbox → revisit if DB downtime becomes visible (any module)
- Live Clerk validation → Module 04 or first team-mode flip
- Backfilling `run_events.run_id` from SessionStart-created `runs` row → can land standalone any time. **🆕 Update (2026-04-27):** the *forward* path (filling `run_events.run_id` at INSERT time) is now closed via F8 fix `900e55c`. A historical-data backfill would still be needed for any `run_events` rows written before that commit landed; for dev-only DBs the rows are throw-away, for production deploys (none yet) it's a one-line UPDATE.

Module status table after Module 03 squash-merge:

| Module | Status | Notes |
|---|---|---|
| 01 Foundation | ✅ complete | merged on main |
| 02 MCP Server | ✅ complete | 9 tools, 2 transports, all verification carryovers closed |
| 03 Hooks Bridge | ✅ complete | this pack; both verification carryovers closed |
| 08a CLI | 🔨 next | placeholder feature pack exists; lands before Module 04 per the build order |
| 04 Web App | ⏳ blocked on 08a | |
| 05 NL Assembly | ⏳ blocked on 03 | |
| 06 Semantic Diff | ⏳ blocked on 03 | |
| 07 VS Code Extension | ⏳ blocked on 04 + 08a | |
