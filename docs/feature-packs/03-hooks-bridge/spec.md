# Module 03 — Hooks Bridge — Spec

> **Status:** planned (2026-04-25)
> **Depends on:** Module 01 (Foundation, merged), Module 02 (MCP Server, merged at PR #1 squash on `main`).
> **Blocks:** Module 04 (Web App), Module 06 (Semantic Diff), Module 07 (VS Code Extension), Module 08a (CLI). Hook ingress is the only path by which `runs` and `run_events` get populated; every downstream feature that reads run history reads what this module writes.
> **Source of truth:** `system-architecture.md` §3.2–§3.4 (hook payloads + normalized `HookEvent`), §3.5 (port 3101), §4.3 (idempotency keys), §7 (fail-open + breakers), §16 patterns 1/2/3/4/12/17/19, §19 (auth chain inheritance), `essentialsforclaude/05-agent-trigger-contract.md` (the agent-side trigger taxonomy this server services), `essentialsforclaude/11-adrs.md` ADR-009 (Cursor adapter); `External api and library reference.md` → Web Frameworks (Hono), Validation/Schemas/Resilience.

## 1. What the Hooks Bridge is

The Hooks Bridge is the Coodra **write surface**. It receives raw hook payloads from IDE-hosted agents (Claude Code over HTTP, Windsurf and Cursor over shell-adapter → HTTP), normalizes them through a per-agent adapter into the canonical `HookEvent` shape (§3.4), and either:

- **Pre-tool events** — calls the policy engine and translates the structured decision back into the agent's native deny/allow shape. Returns within p95 < 50ms (solo) so the agent never times out (§8 budget).
- **Post-tool / SessionStart / Stop events** — appends to `run_events` (and updates `runs`) via the outbox pattern (§16 pattern 3). The HTTP response returns before the DB write completes; failure to write is logged at WARN, never surfaced to the agent.

Module 03 ships:

- A Node process at `apps/hooks-bridge/` that exposes a Hono app on **`127.0.0.1:3101`** with three agent-specific HTTP routes (`POST /v1/hooks/claude-code`, `POST /v1/hooks/windsurf`, `POST /v1/hooks/cursor`), one shared `GET /healthz`, and the same three-layer auth chain as the MCP server (§19).
- A **per-agent adapter** package under `packages/shared/src/hooks/` (one normalizer function per agent → `HookEvent`). Adding a new agent in the future is one new adapter file + one shell script. Zero agent-specific code downstream of the adapter (§16 pattern 12).
- A **shared policy engine** extracted from `apps/mcp-server/src/lib/policy.ts` into a new workspace package `@coodra/policy` (`packages/policy/`) so both `check_policy` (MCP read surface) and the pre-hook handler (Hooks Bridge write surface) call exactly the same evaluator. The new-package layout (instead of `packages/shared/src/policy/` as the original plan stated) is forced by the workspace dependency graph — the policy code imports `@coodra/db` and `@coodra/db` already depends on `@coodra/shared`, so putting policy in shared would create a cycle. **Auth** has no DB dependency and lives in `packages/shared/src/auth/` as planned. The cache, breaker, fail-open, and `policy_decisions` audit-write semantics are unchanged.
- A **RunRecorder** in `apps/hooks-bridge/src/lib/run-recorder.ts` that owns SessionStart-opens-a-run, PostToolUse-appends-an-event, Stop-closes-a-run. Idempotency keys per §4.3 (`run:{projectId}:{sessionId}:{uuid}`, `{sessionId}-{toolUseId}-{phase}`).
- **Adapter shell scripts** for Windsurf (`scripts/hook-adapters/windsurf-coodra.sh`) and Cursor (`scripts/hook-adapters/cursor-coodra.sh`), both producing the same `HookEvent` after normalization.
- The verification-deferred carryover fixes from Module 02:
  - **§8.3 deeper** — `createDb` is refactored to discriminate `local` (always SQLite, used by hooks-bridge + mcp-server + web on the developer's machine in BOTH solo and team mode) vs `cloud` (Postgres, used by Sync Daemon + future cloud-api). Closes the contradiction between architecture §1 and the previous routing.
  - **§8.6 follow-up** — `runKeySegmentSchema` from `@coodra/shared` is consumed at every external boundary that takes a sessionId. Hook adapters normalize agent-supplied `session_id` / `trajectory_id` / `conversation_id` (which may legally contain colons in some agents) into the run-key-safe shape via a single `normalizeSessionId(raw)` helper. Validated at ingress, not buried deep in the call stack.

Items deferred to other modules (per Module 02 verification report):

- **§8.5 follow-up** — richer `coodra init` UX (writing `.env` + `.coodra.json` + adapter symlinks) is **Module 08a (CLI)**, not Module 03. Module 03 ships the shell scripts; Module 08a wires their installation.

## 2. Acceptance criteria

A commit on `feat/03-hooks-bridge` is only "complete" when **every** item below holds on a clean checkout:

1. `pnpm install` clean, no peer-dependency warnings escalated to errors.
2. `pnpm lint` — zero Biome findings across new `apps/hooks-bridge`, modified `packages/shared` (new `hooks/` + `policy/` subdirs), modified `packages/db` (createDb local/cloud refactor).
3. `pnpm typecheck` — `tsc --noEmit` clean across every workspace package.
4. `pnpm test:unit` — every unit test passes. ≥ 80% line coverage on `apps/hooks-bridge` per `essentialsforclaude/06-testing.md §6.4`.
5. `pnpm test:integration` — five new integration tests pass: (a) Claude Code happy path (PreToolUse allow/deny + PostToolUse audit write), (b) Windsurf happy path via shell adapter, (c) Cursor happy path via shell adapter, (d) policy fail-open under simulated DB outage, (e) RunRecorder idempotency under retry storm.
6. `pnpm test:e2e` — extended e2e adds **full session lifecycle** with hooks-bridge in the loop: SessionStart hook → MCP `get_run_id` → PreToolUse hook (denies a write) → PreToolUse hook (allows another) → PostToolUse hook → Stop hook → MCP `save_context_pack`. The pack contains the recorded events.
7. **`createDb` local-vs-cloud test** — calling `createDb({ kind: 'local', mode: 'team' })` returns SQLite; `createDb({ kind: 'cloud', mode: 'team' })` returns Postgres. The MCP server's existing `COODRA_DB_OVERRIDE_MODE` env knob is replaced by the cleaner `kind` discriminator (the override knob's intent is now native), and the env var is removed without a deprecation period since Module 02 just shipped (no callers in the wild).
8. **The §24.4 `check_policy` MCP tool's behavior is unchanged.** A regression test loads the same project + rules and calls `check_policy` directly against the MCP server; it must still return the same `permissionDecision` for the same input. The policy module was moved, not rewritten.
9. **Hook payload Zod schemas live in `packages/shared/src/hooks/payloads/`** with one file per agent (`claude-code.ts`, `windsurf.ts`, `cursor.ts`). Each schema is exhaustive against the documented payload (§3.2, §3.3, ADR-009) and rejects unknown top-level fields with `.strict()`. Invalid bodies fail-open per §7 — return `{ permissionDecision: 'allow' }` with `reason: 'invalid_hook_payload'`, log at WARN with the parse issues.
10. **`HookEvent` Zod schema lives in `packages/shared/src/hooks/event.ts`** and is the single source of truth for the normalized internal shape. All three adapters output a `HookEvent` and all downstream handlers consume one.
11. **`normalizeSessionId(raw: string): string`** is the only function that touches incoming session IDs. It strips `:` (Claude Code session IDs may contain colons), strips Windows-reserved `<>"/\\|?*`, collapses runs of `-`, and asserts the result against `runKeySegmentSchema`. Tested with seven concrete fixtures (vanilla UUID, Claude Code `:`-bearing ID, Windsurf `traj-` ID, Cursor `conv-` ID, ID with `/`, ID with whitespace, empty string → throws).
12. **Pre-hook latency budget is enforced.** A unit test wraps the pre-hook handler in `performance.now()` instrumentation; running 1000 in-process invocations against a populated SQLite has p95 < 50ms (solo target from §8). CI runs this with `--retries=0`; flake = real regression.
13. **Pre-hook fail-open works on every error path.** Tests inject: (a) DB throws, (b) policy cache miss + DB unreachable (breaker open), (c) Zod parse fails on malformed body, (d) projectSlug not registered, (e) handler throws unexpectedly. All five paths return `permissionDecision: 'allow'` with a structured reason and write a `policy_decisions` row with `matched_rule_id = null` (when reachable).
14. **Post-hook write is async and idempotent.** A `PostToolUse` for the same `(sessionId, toolUseId, phase)` triplet sent ten times in a tight loop produces exactly one `run_events` row. The HTTP response returns within 10ms of receipt regardless of DB latency (`setImmediate` dispatch).
15. **SessionStart / Stop are idempotent.** Sending `SessionStart` twice for the same `(projectId, sessionId)` writes exactly one `runs` row. Sending `Stop` after `Stop` updates `ended_at` once and is a no-op the second time. `runs.status` transitions: `pending → in_progress` (first PostToolUse) → `completed` (Stop). No `pending → completed` skip; the implementation must observe that ordering is never strictly guaranteed by the agent and must handle out-of-order events without losing data.
16. **Three-agent adapters output identical `HookEvent` for identical semantic input.** A test fixture set under `apps/hooks-bridge/__tests__/fixtures/parity/` provides one "Write to src/auth.ts" event in each agent's native shape; the adapters must produce three byte-identical `HookEvent`s after normalization (modulo `agentType`).
17. **Auth chain inheritance is verbatim.** The Hono middleware in `apps/hooks-bridge/src/lib/auth.ts` is a thin re-export of the same chain helper from `apps/mcp-server/src/lib/auth.ts` — extracted to `packages/shared/src/auth/` in this module so neither service "owns" it. Three-layer order is unchanged: solo-bypass (sentinel `sk_test_replace_me`) → `X-Local-Hook-Secret` (timing-safe equality) → Clerk JWT → 401. Tested with the same four fixtures from Module 02's `auth.test.ts` plus one new fixture: shell adapter sends `X-Local-Hook-Secret` and is accepted.
18. **Adapter shell scripts pass a smoke test on macOS + Linux.** A CI job script-shells `windsurf-coodra.sh` with a sample stdin payload and asserts: (a) exit code is 0 for an allow response, 2 for a deny response with the reason on stderr, (b) the script POSTs to `127.0.0.1:3101` with `Content-Type: application/json` and `X-Local-Hook-Secret`. Same for `cursor-coodra.sh`.
19. **`createDb` env knob removal is documented in `docs/DEVELOPMENT.md`.** The line "Use `COODRA_DB_OVERRIDE_MODE=solo` to dev team-mode auth on SQLite" is replaced by "Local services always run on SQLite — set `COODRA_MODE=team` to opt into team-mode auth + Clerk; the DB layer is unchanged."
20. **`@coodra/policy` (`packages/policy/`) is the canonical policy module.** `apps/mcp-server/src/lib/policy.ts` becomes a thin re-export. New consumers (hooks-bridge, future web) import from `@coodra/policy`, never from a peer app. Auth lives in `@coodra/shared/auth` (no db dep, no new package needed).
21. **`docs/context-packs/2026-04-25-module-03-hooks-bridge.md`** exists, matches `docs/context-packs/template.md`, documents every decision, every file touched, every test added, and the carryover fixes (§8.3 + §8.6).
22. **`.mcp.json` updated** so Claude Code's hook config now points at the live hooks-bridge endpoints. The new shape includes a `hooks` section per Claude Code's hook spec, listing `PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`, `UserPromptSubmit`, each pointing at `http://127.0.0.1:3101/v1/hooks/claude-code` with the local-hook-secret header.
23. **CI green on the new repo (`Abishai95141/Coodra-matrx-maven`)** for every commit on `feat/03-hooks-bridge` before squash-merge to `main`. The `lint+typecheck+unit`, `integration`, and `e2e` jobs all pass.
24. Git: `feat/03-hooks-bridge` has one commit per logical slice; every commit that adds or bumps a package version amends `External api and library reference.md` in the same commit (amendment B, carried forward).

## 3. Non-goals

Explicitly excluded from Module 03 and **not** stubbed (per `01-development-discipline.md §1.1`):

- **No JIRA hooks.** §22 ships in a separate integration module after Module 03 lands.
- **No GitHub webhooks.** §23 / §16 pattern 17 is a separate integration module — `POST /v1/webhooks/github` does not land here.
- **No Sync Daemon.** The local→cloud REST batch sync (§3.7) is a Module 04 / cloud-api concern. Hooks-bridge writes only to local SQLite; there is no `synced_at` plumbing in this module beyond the schema column already present.
- **No BullMQ.** Solo-mode in-process queue is the only queue this module touches. Team-mode BullMQ work is post-Module 03.
- **No `pending_jobs` outbox refactor.** Per Module 02's deferral, `policy_decisions` and `run_events` are still written via `setImmediate` + `ON CONFLICT DO NOTHING`, not through `pending_jobs`. Revisit if DB downtime becomes visible after live traffic.
- **No new MCP tools.** Module 02 shipped the eight `coodra__*` tools; Module 03 adds zero. Hook ingestion is HTTP-only, off the MCP surface.
- **No Web App, no VS Code extension, no NL Assembly, no Semantic Diff, no CLI.** All separate modules.
- **No `coodra init` / install UX.** Adapter shell scripts ship as static files; their installation into `~/.windsurf/hooks/` and `.cursor/hooks/` is documented in `docs/DEVELOPMENT.md` for Module 03 and automated by Module 08a (CLI).
- **No live Clerk validation against a real tenant.** Same posture as Module 02 — wired and unit-tested with mocks; first live test happens whenever Module 04 or a real team-mode flip lands.

## 4. Schema deltas

Module 03 adds **zero new tables**. The Module 01 + 02 nine-table schema is sufficient. Specifically:

| Need | Existing table satisfies it |
|---|---|
| Open a session-scoped run | `runs` (M01) |
| Append a tool-use trace | `run_events` (M01) |
| Audit a pre-hook policy decision | `policy_decisions` (M02) |
| Look up the policy + rules to evaluate | `policies` + `policy_rules` (M02) |
| Identify the project for a `projectSlug` | `projects` (M01) |

Migration `0004_*` is therefore reserved but **may end up empty** if no schema changes surface during implementation. If the createDb `kind` refactor (§8.3 closure) reveals a column-level inconsistency between the SQLite and Postgres schemas it lands here.

## 5. Transport contract

One transport, one server process. Hono on `@hono/node-server`, port `127.0.0.1:3101`.

### Routes

| Method | Path | Body | Response | Auth |
|---|---|---|---|---|
| POST | `/v1/hooks/claude-code` | Claude Code hook payload (§3.2) | `{ hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason? } }` for PreToolUse; `{ ok: true }` for others. | Three-layer auth chain (§19). |
| POST | `/v1/hooks/windsurf` | Windsurf hook payload (§3.3) | `{ decision: 'allow'\|'deny', reason?: string }` — the shell adapter translates `decision === 'deny'` into `exit 2` with `reason` on stderr. | Same. |
| POST | `/v1/hooks/cursor` | Cursor hook payload (ADR-009) | Same JSON shape as Windsurf. | Same. |
| GET | `/healthz` | — | `{ ok: true, port: 3101, mode: 'solo'\|'team', serverStartedAt: ISO8601 }` | None. |

### Wire-level invariants

- **Pre-tool events return within p95 < 50ms** (solo, §8). Server process must not perform any synchronous I/O outside the policy cache lookup + a `setImmediate`-dispatched audit write.
- **Post-tool events return within p95 < 10ms.** The HTTP response returns immediately after Zod-parsing + queueing the `setImmediate` callback.
- **No event payload is logged at INFO.** Tool inputs may contain user code or secrets. Inputs are logged at DEBUG only; INFO records `eventType + toolName + projectId + sessionId + runId + decision + matchedRuleId`. Same redaction posture as MCP server.
- **Stdio is not used.** Hooks Bridge is HTTP-only by design; agents that prefer stdio MCP (Claude Code) still use HTTP for hooks because hooks predate MCP and the wire is locked by the IDE.

## 6. Fail-open and circuit-breaker discipline

Per §7 and §16 pattern 4:

- The shared policy module already wraps DB reads in `cockatiel` `retry(2) + circuitBreaker(5 consecutive, 30s halfOpen) + timeout(100ms)` (Module 02 S7b). The Hooks Bridge inherits these directly — no new breaker config.
- On any throw, timeout, or open-breaker in pre-hook handling: return `permissionDecision: 'allow'`, `reason: 'policy_check_unavailable'`. Audit write is best-effort; if the audit write also fails, log at WARN with the full decision context (sessionId, toolName, eventType, agentType) and proceed.
- On Zod parse failure of an inbound payload: return `permissionDecision: 'allow'`, `reason: 'invalid_hook_payload'`, log at WARN with `issues`.
- **The only intentional block is an explicit policy `deny`.** Everything else allows.
- Post-hook handlers **never** affect the response shape on DB failure. The agent always sees `{ ok: true }` (Claude Code) or `{ decision: 'allow' }` (Windsurf/Cursor); failures are logged.

## 7. What "done" hands off to Module 04

- A clean `main` pointing at the squash-merged Module 03 commit.
- The same nine-table schema (no new tables) with a possibly-empty migration `0004_*.sql` reserved.
- `@coodra/hooks-bridge` binary at `apps/hooks-bridge/dist/index.js`, runnable via `pnpm --filter @coodra/hooks-bridge dev` (tsx watch) or `node dist/index.js` (compiled).
- Three working agent adapters (Claude Code over HTTP, Windsurf over shell adapter, Cursor over shell adapter), all producing identical `HookEvent`s.
- The shared policy module under `@coodra/policy` (separate workspace package due to the shared←→db cycle that would otherwise form); both `check_policy` (MCP) and `POST /v1/hooks/{agent}` (Hooks Bridge) call it.
- Carryover §8.3 closed: `createDb` discriminates `local` (always SQLite) vs `cloud` (Postgres). Carryover §8.6 closed: every external sessionId boundary calls `normalizeSessionId` + `runKeySegmentSchema`.
- A Module 03 Context Pack documenting everything above.
- An updated `.mcp.json` and `docs/DEVELOPMENT.md` so the next session running Claude Code in this repo is observed end-to-end by Coodra.
