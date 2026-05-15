# Module 03 — Hooks Bridge — Implementation Plan

> Follow top-to-bottom. Each slice is one commit on `feat/03-hooks-bridge`. Each commit that bumps a package version amends `External api and library reference.md` in the same commit (amendment B). Slice count: **15** total. Carryover fixes from the Module 02 verification report land in S3 (auth/policy extract), S4 (createDb local/cloud — closes §8.3), and S6 (sessionId normalization — closes §8.6).

## Prerequisites (one-time, before S1)

- Module 02 squash-merged on `main` at the SHA recorded in the Module 02 closeout context pack. CI green on `Abishai95141/Coodra-matrx-maven`.
- Node ≥ 22.16.0, pnpm ≥ 10.33.0, Docker Desktop running locally (for the `testcontainers` integration tests in S13).
- `LOCAL_HOOK_SECRET` already exists in `.env` from Module 02. If not, generate via `openssl rand -hex 24`.
- A working Coodra MCP server reachable from Claude Code (`mcp__coodra__ping` returns ok). This is the read surface; Module 03 builds the write surface alongside it.

## Slice sequence

### S1 — Module 03 Feature Pack docs (this commit)

**Files:** `docs/feature-packs/03-hooks-bridge/spec.md`, `docs/feature-packs/03-hooks-bridge/implementation.md` (this file), `docs/feature-packs/03-hooks-bridge/techstack.md`, `docs/feature-packs/03-hooks-bridge/meta.json`.

**Commit:** `docs(03-hooks-bridge): spec, implementation plan, techstack, meta`.

### S2 — Context memory handover

Archive `context_memory/current-session.md` (final Module 02 entries) to `context_memory/sessions/2026-04-25-module-02-closeout.md`. Open a fresh `current-session.md` for Module 03 with the goal-line, the four files loaded (spec/impl/techstack + system-architecture §3/§7/§16), and the next-action pointing at S3. Append two entries to `decisions-log.md`: (a) "Module 03 begins, scope and slice plan approved per `docs/feature-packs/03-hooks-bridge/`," (b) "Module 02 verification carryover items §8.3 and §8.6 absorbed into M03 slices S3/S4/S6; §8.5 explicitly deferred to Module 08a." Update `pending-user-actions.md` — Module 02 actions that are now resolved are moved out; Clerk live-tenant validation stays open.

**Files:** `context_memory/sessions/2026-04-25-module-02-closeout.md` (new archive), `context_memory/current-session.md` (rewritten), `context_memory/decisions-log.md` (appended), `context_memory/pending-user-actions.md` (edited).

**Commit:** `chore(context-memory): archive module-02 closeout, begin module-03`.

### S3 — Extract policy + auth modules from `apps/mcp-server`

**Deviation from plan:** spec.md originally said both modules move to `packages/shared/src/{policy,auth}/`. Auth has no DB dependency and lives there as planned. **Policy cannot.** `@coodra/db` already depends on `@coodra/shared`; if `shared/policy` imports `@coodra/db` (for `DbHandle` + the schema tables), the workspace forms a cycle. Resolved by creating a new workspace package `@coodra/policy` (`packages/policy/`) that depends on both `shared` and `db`. Decision recorded in `context_memory/decisions-log.md` 2026-04-25 in the same commit.

**What actually lands:**

- New workspace package `packages/policy/` with `package.json` (deps: `@coodra/shared`, `@coodra/db`, `cockatiel@3.2.1`, `drizzle-orm@^0.45.2`, `picomatch@4.0.2`), `tsconfig.json`, `tsconfig.typecheck.json`, `vitest.config.ts`, `src/{index,policy,types}.ts`, `__tests__/unit/exports.test.ts` (smoke + pure-logic for the no-DB surface). Subpath exports: `.` + `./types`.
- `packages/shared/src/auth/` — new subdirectory: `index.ts` (barrel), `auth.ts` (factories + `verifyClerkJwt` + `verifyLocalHookSecret`), `types.ts` (`Identity` + `AuthClient` + structural `AuthEnv` subset replacing the app-specific `McpServerEnv` parameter type). `@clerk/backend@3.3.0` added to `packages/shared/package.json` deps. New subpath export `./auth`.
- `packages/shared/src/idempotency.ts` — `IdempotencyKey` discriminated value-shape moved here so the cross-package `PolicyInput.idempotencyKey` field can reference it without depending on the mcp-server framework. Framework-only `IdempotencyKeyBuilder` + `IdempotencyContext` + `assertIdempotencyKeyBuilder` stay in mcp-server's `framework/idempotency.ts` (those are tool-registration concerns). The shared `index.ts` barrel re-exports the new type.
- `apps/mcp-server/src/lib/{policy,auth}.ts` — now thin re-export shims pointing at `@coodra/policy` and `@coodra/shared/auth` respectively. Existing import sites (handlers, tests, `framework/tool-context.ts`) keep working unchanged.
- `apps/mcp-server/src/framework/policy-wrapper.ts` — re-export shim for the moved types.
- `apps/mcp-server/src/framework/tool-context.ts` — `Identity` / `AuthClient` interfaces now imported from `@coodra/shared/auth`; `PolicyClient` from `@coodra/policy`. Re-exported so existing `import type { Identity } from '../framework/tool-context.js'` keeps working.
- `apps/mcp-server/src/framework/idempotency.ts` — `IdempotencyKey` is now `import type` from `@coodra/shared` plus a re-export.
- `apps/mcp-server/package.json` — drop `cockatiel`, `@clerk/backend`, `@types/picomatch` (now transitive through shared/policy). Add `@coodra/policy` workspace dep. Keep `picomatch` (still used directly in `tools/get-feature-pack/handler.ts` + a unit test).
- `apps/mcp-server/__tests__/unit/lib/auth-chain.test.ts` — moved to `packages/shared/__tests__/unit/auth/auth.test.ts`. `vi.mock('@clerk/backend')` only intercepts when the test runs in the same package as the implementation; in mcp-server it bound only to the test file's own resolution context and the dist's transitive import bypassed it. Switch the type cast from `McpServerEnv` to `AuthEnv` (structural subset). 18 tests intact, all green.

`pnpm install` re-links the workspace. The full gate (lint + typecheck + unit + integration on mcp-server, unit on shared + policy) is green at this commit.

**Reference updates in the same commit (amendment B):** Module 03 adds `@coodra/policy` as a new workspace package — call out the package's role + dep set in `External api and library reference.md` (new subsection under Validation/Schemas/Resilience).

**Commit:** `refactor(workspace): extract @coodra/policy package + @coodra/shared/auth from mcp-server (closes the workspace cycle implied by the original plan)`.

### S4 — `createDb` local-vs-cloud refactor (closes verification §8.3)

Per the Module 02 verification report's deferred §8.3: `system-architecture.md §1` says "local services always write to local SQLite," but `packages/db/src/client.ts::createDb` previously routed `mode === 'team'` to Postgres unconditionally. The Module 02 stopgap was the `COODRA_DB_OVERRIDE_MODE` env knob. Module 03 closes the door properly.

Refactor `packages/db/src/client.ts::CreateDbOptions` into a discriminated union on `kind: 'local' | 'cloud'`. Update `createDb`:

```ts
export type CreateDbOptions =
  | { kind: 'local'; mode?: 'solo' | 'team'; sqlitePath?: string; loadVecExtension?: boolean }
  | { kind: 'cloud'; mode?: 'solo' | 'team'; postgresUrl?: string };

export function createDb(opts: CreateDbOptions): DbHandle {
  if (opts.kind === 'local') return createSqliteDb(opts.sqlitePath ?? defaultSqlitePath(), opts.loadVecExtension !== false);
  return createPostgresDb(opts.postgresUrl ?? requiredEnv('DATABASE_URL'));
}
```

Update `apps/mcp-server/src/lib/db.ts::createDbClient` so it always passes `kind: 'local'`. The `mode` arg becomes purely an auth-strategy hint; downstream `apps/mcp-server/src/index.ts` no longer needs `COODRA_DB_OVERRIDE_MODE` — remove the env entry from `apps/mcp-server/src/config/env.ts`, remove the boot-time wiring, remove the integration test `boot-db-override.test.ts` (or repurpose it to assert that `kind: 'local'` always wins regardless of `COODRA_MODE`).

Update existing tests that asserted Postgres routing for `mode: 'team'`: pass `kind: 'cloud'` explicitly. The cross-mode integration test in `__tests__/integration/cross-mode.test.ts` (if it exists) becomes the single source of truth that local services + team mode = SQLite.

**Files:** `packages/db/src/client.ts`, `packages/db/src/index.ts` (re-export shape), `packages/db/__tests__/unit/client-options.test.ts` (new — 6 fixtures), `apps/mcp-server/src/lib/db.ts`, `apps/mcp-server/src/config/env.ts` (remove `COODRA_DB_OVERRIDE_MODE`), `apps/mcp-server/src/index.ts` (remove the wiring), `apps/mcp-server/__tests__/integration/boot.test.ts` (update — assert local-mode-always), `apps/mcp-server/__tests__/integration/boot-db-override.test.ts` (delete or rewrite), `docs/DEVELOPMENT.md` (update "Local team-mode auth dev" section — remove `COODRA_DB_OVERRIDE_MODE` reference, replace with the simpler explanation), `docs/verification/2026-04-25-module-01-02-verification.md` (append "Findings closed" subsection marking §8.3 closed in M03 S4 with this commit's SHA — TBD at squash).

**Reference updates in the same commit:** `External api and library reference.md` → Drizzle ORM subsection — add a "Local-vs-cloud routing" paragraph noting the `kind` discriminator and that `mode` no longer dictates DB choice. `system-architecture.md §1` confirmation note (no edit needed; the doc was always correct, the code is finally aligned).

**Commit:** `refactor(db): createDb takes kind: local|cloud, decouple from mode (closes verification §8.3)`.

### S5 — Bootstrap `apps/hooks-bridge` (Hono + listener + healthz + auth chain)

Scaffold `apps/hooks-bridge/`:

- `package.json` — private workspace package, `"type": "module"`, `bin` points at `dist/index.js`. Deps: `@hono/node-server@^2.0.0`, `hono@^4.12.15`, `@hono/zod-validator@^0.7.6`, `drizzle-orm@^0.45.2`, `@coodra/shared@workspace:*`, `@coodra/db@workspace:*`. devDeps: `tsx`, `vitest`, `@types/node`.
- `tsconfig.json` + `tsconfig.typecheck.json` (extends `../../tsconfig.base.json`).
- `vitest.config.ts` — same config shape as `apps/mcp-server`'s.
- `README.md`, `.env.example` (HOOKS_BRIDGE_PORT, LOCAL_HOOK_SECRET, COODRA_LOG_DESTINATION, COODRA_MODE, CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, COODRA_SQLITE_PATH).
- `.dockerignore`.

Source layout (mirror mcp-server's conventions):

- `src/index.ts` — boot entry. Calls `ensureStderrLogging()` first (imported from `@coodra/shared`), parses env, builds `dbHandle = createDb({ kind: 'local', mode: env.COODRA_MODE, sqlitePath: env.COODRA_SQLITE_PATH })`, runs migrations idempotently (`migrateSqlite(dbHandle.db)` — same auto-migrate stance as mcp-server post-Module-02 `187c844`), constructs the Hono app, starts the listener on `127.0.0.1:${env.HOOKS_BRIDGE_PORT}` (default 3101), wires `process.on('SIGTERM' | 'SIGINT')` for graceful shutdown.
- `src/bootstrap/ensure-stderr-logging.ts` — re-exported from shared if it lives there now; otherwise a thin local copy.
- `src/config/env.ts` — Zod-validated env with the same strictness rules as mcp-server's. New shape adds `HOOKS_BRIDGE_PORT` (default 3101, range 1024–65535).
- `src/lib/auth.ts` — re-exports `createAuthChainMiddleware` from `@coodra/shared/auth`.
- `src/app.ts` — exported builder `buildApp(deps): Hono`. Wires `GET /healthz` (no auth) and the three `POST /v1/hooks/{agent}` routes (the routes themselves are stubbed with `c.json({ ok: true })` until S6; the auth middleware + zValidator wiring lands here).
- `src/lib/db.ts` — re-exports `createDbClient` and the same `DbHandle`-typed factory from mcp-server's `lib/db.ts`. Hooks bridge does NOT depend on apps/mcp-server; both apps independently call the shared factory in `@coodra/db`.

Tests:

- `__tests__/integration/healthz.test.ts` — `app.request('/healthz')` returns 200 + correct shape.
- `__tests__/integration/auth-chain.test.ts` — five fixtures (no auth, valid X-Local-Hook-Secret, invalid X-Local-Hook-Secret, valid Clerk JWT mock, invalid Clerk JWT mock) — verifies the chain order via the shared module.
- `__tests__/unit/config/env.test.ts` — six fixtures covering port-range, sentinel-Clerk-acceptance, etc.

**Files:** new under `apps/hooks-bridge/` per the layout above; `pnpm-workspace.yaml` already includes `apps/*`; `turbo.json` may need a `hooks-bridge` task entry — check and add.

**Reference updates in the same commit:** `External api and library reference.md` → `@hono/zod-validator` new subsection at `^0.7.6` with the route-validator pattern + the "default 400-on-parse-failure must be overridden" gotcha.

**Commit:** `feat(hooks-bridge): scaffold + Hono app + healthz + auth chain`.

### S6 — Per-agent adapters + `HookEvent` schema + sessionId normalization (closes verification §8.6)

This is the largest single slice — it lays the per-agent normalization layer that is the entire point of §16 pattern 12.

`packages/shared/src/hooks/event.ts`:

```ts
export const HookEventSchema = z.object({
  agentType: z.enum(['claude_code', 'windsurf', 'cursor', 'unknown']),
  eventPhase: z.enum(['pre', 'post', 'session_start', 'session_end', 'user_prompt']),
  sessionId: runKeySegmentSchema,        // already enforces no-colon shape
  turnId: z.string().optional(),
  toolName: z.string(),
  filePath: z.string().optional(),
  toolInput: z.unknown(),
  cwd: z.string().optional(),
  projectSlug: z.string().optional(),
  rawAt: z.string().datetime(),
}).strict();
export type HookEvent = z.infer<typeof HookEventSchema>;
```

`packages/shared/src/hooks/normalize-session-id.ts`:

```ts
export function normalizeSessionId(raw: string): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return runKeySegmentSchema.parse(cleaned);
}
```

`packages/shared/src/hooks/payloads/claude-code.ts`, `windsurf.ts`, `cursor.ts` — three Zod schemas matching the wire formats in `system-architecture.md §3.2`, `§3.3`, and ADR-009 respectively. Each ends with `.strict()` so unknown top-level fields are flagged (logged, not rejected — fail-open).

`packages/shared/src/hooks/adapters/claude-code.ts`:

```ts
export function adaptClaudeCode(payload: ClaudeCodeHookPayload): HookEvent {
  const phase = mapClaudeEventToPhase(payload.hook_event_name);
  return {
    agentType: 'claude_code',
    eventPhase: phase,
    sessionId: normalizeSessionId(payload.session_id),
    turnId: payload.tool_use_id,
    toolName: payload.tool_name ?? '',
    filePath: extractFilePath(payload.tool_input),
    toolInput: payload.tool_input,
    cwd: payload.cwd,
    projectSlug: undefined,                // hooks-bridge looks this up later from cwd
    rawAt: new Date().toISOString(),
  };
}
```

`adapters/windsurf.ts` and `adapters/cursor.ts` — analogous, mapping `trajectory_id` / `conversation_id` → `sessionId`, `execution_id` → `turnId`. The Cursor adapter additionally renames `tool_info` → `toolInput`. Each adapter has its own translator for event-name → eventPhase per the ADR-009 / §3.3 mapping tables.

Tests in `packages/shared/__tests__/unit/hooks/`:

- `normalize-session-id.test.ts` — seven fixtures (vanilla UUID, `:` in middle, `:` at start/end, Windows-reserved, whitespace, empty → throws, `\\` in middle).
- `adapter-parity.test.ts` — three semantically-equivalent fixtures (one per agent representing "Write to src/auth.ts"), the three adapters produce byte-identical `HookEvent`s modulo `agentType` and `turnId` (which are agent-shape facts).
- One per-adapter test for happy + unknown-field + missing-required-field paths.

Wire the adapters into the Hono routes in `apps/hooks-bridge/src/app.ts` (still stub-handler — the `pre`/`post` business logic lands in S7/S8). The `zValidator('json', payloadSchema, fallbackToAllow)` runs first; on success the handler calls `adaptXxx(payload)` and forwards the `HookEvent` to a placeholder `dispatch(event)` function that just logs at INFO.

**Verification §8.6 closure:** the constructive Zod parse at `HookEventSchema.parse({ ..., sessionId: normalizeSessionId(raw), ... })` is now the boundary-level check. Module 02's `runKeySegmentSchema` (introduced in commit `315c41d`) is the same schema; it gets called at every hook ingress. Add a "Findings closed" entry to `docs/verification/2026-04-25-module-01-02-verification.md` for §8.6.

**Files:** `packages/shared/src/hooks/event.ts`, `normalize-session-id.ts`, `payloads/{claude-code,windsurf,cursor}.ts`, `adapters/{claude-code,windsurf,cursor}.ts`, `index.ts` (barrel), 5 unit tests under `packages/shared/__tests__/unit/hooks/`, `apps/hooks-bridge/src/app.ts` (route handlers wired through validator + adapter), `apps/hooks-bridge/__tests__/integration/adapters.test.ts` (3 routes × happy path), `docs/verification/2026-04-25-module-01-02-verification.md` (findings-closed §8.6).

**Commit:** `feat(shared,hooks-bridge): per-agent hook adapters + HookEvent schema + sessionId normalization (closes verification §8.6)`.

### S7 — Pre-tool policy enforcement

`apps/hooks-bridge/src/handlers/pre-tool-use.ts`:

```ts
export function createPreToolUseHandler(deps: { db: DbHandle; mode: 'solo'|'team' }) {
  const evaluator = createPolicyClient(deps);  // from @coodra/policy
  return async function handle(event: HookEvent): Promise<PolicyDecisionEnvelope> {
    if (event.eventPhase !== 'pre') return { permissionDecision: 'allow', reason: 'event_phase_mismatch' };
    try {
      return await evaluator.evaluate({
        projectSlug: await resolveProjectSlug(event.cwd),
        agentType: event.agentType,
        eventType: 'PreToolUse',
        toolName: event.toolName,
        toolInput: event.toolInput,
        sessionId: event.sessionId,
      });
    } catch (err) {
      logger.warn({ err, sessionId: event.sessionId, toolName: event.toolName }, 'pre_tool_use evaluator threw — failing open');
      return { permissionDecision: 'allow', reason: 'policy_check_unavailable' };
    }
  };
}
```

`apps/hooks-bridge/src/lib/translate-decision.ts`:

```ts
export function toClaudeCodeResponse(d: PolicyDecisionEnvelope, hookEventName: string) {
  return { hookSpecificOutput: { hookEventName, permissionDecision: d.permissionDecision, ...(d.permissionDecisionReason ? { permissionDecisionReason: d.permissionDecisionReason } : {}) } };
}
export function toWindsurfCursorResponse(d: PolicyDecisionEnvelope) {
  return { decision: d.permissionDecision === 'deny' ? 'deny' : 'allow', ...(d.permissionDecisionReason ? { reason: d.permissionDecisionReason } : {}) };
}
```

Wire into the three `POST /v1/hooks/{agent}` routes in `app.ts`. For `pre_*` events the route calls `preToolUseHandler(event)` then translates and returns. For all other events the route hands off to a stubbed `dispatch(event)` (lands in S8/S9).

`resolveProjectSlug(cwd: string): Promise<string|undefined>` reads `${cwd}/.coodra.json` once, caches by cwd for 60s. On miss, returns undefined; the policy evaluator handles missing projectSlug by returning `permissionDecision: 'allow'` + `reason: 'project_not_registered'` (already the existing behavior in shared/policy).

Tests:

- `__tests__/unit/handlers/pre-tool-use.test.ts` — five fail-open paths from spec §6 acceptance #13.
- `__tests__/integration/pre-tool-use-claude-code.test.ts` — `app.request('POST /v1/hooks/claude-code', { body })` with a real SQLite + a deny-rule loaded via fixture; assert response is the Claude Code `hookSpecificOutput` shape with `permissionDecision: 'deny'`.
- `__tests__/integration/pre-tool-use-windsurf.test.ts` — same, asserts `{ decision: 'deny', reason: '...' }`.
- `__tests__/integration/pre-tool-use-cursor.test.ts` — same.
- Latency test under `__tests__/integration/pre-tool-use-latency.test.ts` — 1000 iterations, p95 < 50ms.

**Files:** `apps/hooks-bridge/src/handlers/pre-tool-use.ts`, `src/lib/translate-decision.ts`, `src/lib/resolve-project-slug.ts`, 4 integration tests, 1 unit test, `app.ts` (wire routes).

**Commit:** `feat(hooks-bridge): pre-tool-use policy enforcement + per-agent decision translation`.

### S8 — Post-tool RunRecorder

`apps/hooks-bridge/src/lib/run-recorder.ts`:

```ts
export function createRunRecorder(deps: { db: DbHandle }) {
  return {
    recordPostToolUse(event: HookEvent): void {                  // sync return; setImmediate write
      const idempotencyKey = `${event.sessionId}-${event.turnId ?? 'no-turn'}-${event.eventPhase}`;
      setImmediate(async () => {
        try {
          await deps.db.db.insert(runEvents).values({
            id: randomUUID(),
            run_id: await ensureRunId(event),                    // resolves runs.id from (project,session) or opens one
            event_type: 'post_tool_use',
            tool_name: event.toolName,
            tool_input_snapshot: truncateToolInput(event.toolInput, 8 * 1024),
            file_path: event.filePath ?? null,
            agent_type: event.agentType,
            idempotency_key: idempotencyKey,
            created_at: new Date(),
          }).onConflictDoNothing({ target: runEvents.idempotency_key });
        } catch (err) {
          logger.warn({ err, sessionId: event.sessionId, toolName: event.toolName }, 'post_tool_use audit write failed');
        }
      });
    },
  };
}
```

`apps/hooks-bridge/src/handlers/post-tool-use.ts` — calls `recorder.recordPostToolUse(event)`, returns `{ ok: true }` (Claude Code) or `{ decision: 'allow' }` (Windsurf/Cursor) immediately. Per spec acceptance #14 the response returns within 10ms regardless of DB latency.

Idempotency test in `__tests__/integration/post-tool-use-idempotency.test.ts`: send the same `{sessionId, toolUseId, phase}` post payload ten times in tight loop; assert `SELECT count(*) FROM run_events WHERE idempotency_key = ?` returns 1.

Truncation test for `tool_input_snapshot`: payload with 100KB `content`, snapshot rows clamp to 8KB Unicode-code-point safe (same shape as Module 02's `policy_decisions.tool_input_snapshot`).

**Files:** `src/lib/run-recorder.ts`, `src/handlers/post-tool-use.ts`, `app.ts` (wire post routes), 3 integration tests, 1 unit test.

**Commit:** `feat(hooks-bridge): RunRecorder for post-tool-use events with idempotent async writes`.

### S9 — SessionStart / Stop run lifecycle

`apps/hooks-bridge/src/handlers/session-start.ts` and `session-stop.ts`. The RunRecorder grows `openRun(event)` and `closeRun(event)` methods.

`runs` lifecycle observed:
- `SessionStart` → `INSERT INTO runs (id, project_id, session_id, status, started_at) VALUES (...) ON CONFLICT (run_key) DO NOTHING`. Returns 200 + `{ ok: true, runId }` for Claude Code (the agent uses this to seed the runId for subsequent MCP `get_run_id` calls if it asks for the same session).
- First `PostToolUse` for that session → `UPDATE runs SET status = 'in_progress' WHERE id = ? AND status = 'pending'`.
- `Stop` → `UPDATE runs SET status = 'completed', ended_at = now() WHERE id = ? AND status != 'completed'`. Idempotent — second Stop is a no-op.

Out-of-order resilience: if `PostToolUse` arrives before `SessionStart` (rare but possible — agent-side ordering not guaranteed), the recorder calls `openRun` defensively first (ON CONFLICT DO NOTHING). The `runs` row exists when the event row is inserted.

The `runs.run_key` idempotency-key column already exists from Module 01; key shape per §4.3 is `run:{projectId}:{sessionId}:{uuid}`. Hooks-bridge generates the uuid once per (project, session) pair, cached in-process for the session's lifetime.

Tests:
- `__tests__/integration/session-lifecycle.test.ts` — full sequence (SessionStart → 3× PostToolUse → Stop) + idempotency (each event sent twice).
- `__tests__/unit/lib/run-recorder.test.ts` — out-of-order resilience.

**Files:** `src/handlers/session-start.ts`, `src/handlers/session-stop.ts`, `src/lib/run-recorder.ts` (extended), `app.ts` (wire), 1 integration test, 1 unit test.

**Commit:** `feat(hooks-bridge): SessionStart + Stop run lifecycle with idempotent open/close`.

### S10 — UserPromptSubmit handler (Claude Code only)

Claude Code's `UserPromptSubmit` event carries the user's prompt text. Per `system-architecture.md §3.2` and the trigger contract this is recorded as a `run_events` row with `event_type = 'user_prompt'` so context-pack assembly can reconstruct the conversation later.

`apps/hooks-bridge/src/handlers/user-prompt-submit.ts` — calls `recorder.recordUserPrompt(event)` which inserts to `run_events` with the prompt text in `tool_input_snapshot` (still 8KB-clamped), `tool_name = 'user_prompt'`. Idempotency key shape: `${sessionId}-${promptId}-user_prompt` where promptId is from the Claude Code payload's `prompt_id` field.

This event has no analog in Windsurf or Cursor today — both adapters return `{ decision: 'allow' }` for any `user_prompt` event the agent surfaces (Windsurf's `pre_user_prompt` is mapped to phase `user_prompt` per §3.3 but is non-blockable).

Test: `__tests__/integration/user-prompt-submit.test.ts` — POST to claude-code route with a `UserPromptSubmit` body; assert one row in run_events with the prompt clamped to 8KB.

**Files:** `src/handlers/user-prompt-submit.ts`, `src/lib/run-recorder.ts` (extended), `app.ts` (wire), 1 integration test.

**Commit:** `feat(hooks-bridge): UserPromptSubmit recorded as run_event for Claude Code`.

### S11 — Adapter shell scripts (Windsurf + Cursor)

Two scripts under `scripts/hook-adapters/`:

`scripts/hook-adapters/windsurf-coodra.sh`:

```bash
#!/usr/bin/env bash
set -eu
PAYLOAD=$(cat)
RESPONSE=$(echo "$PAYLOAD" | curl -sS -X POST \
  "http://127.0.0.1:${HOOKS_BRIDGE_PORT:-3101}/v1/hooks/windsurf" \
  -H "Content-Type: application/json" \
  -H "X-Local-Hook-Secret: ${LOCAL_HOOK_SECRET:?LOCAL_HOOK_SECRET not set}" \
  --data-binary @-)
DECISION=$(printf '%s' "$RESPONSE" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("decision","allow"))')
if [ "$DECISION" = "deny" ]; then
  printf '%s\n' "$RESPONSE" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("reason","Blocked by Coodra policy"), file=sys.stderr)'
  exit 2
fi
exit 0
```

`scripts/hook-adapters/cursor-coodra.sh` — same logic, posts to `/v1/hooks/cursor`, normalizes Cursor's `conversation_id` → `session_id` field-name in a `jq`-or-`python3` reshape step before posting (the server-side adapter could also accept the raw shape — design point: server accepts both shapes, so the adapter is byte-identical to windsurf's modulo URL).

`scripts/hook-adapters/install.sh` — interactive script that (a) detects whether `~/.windsurf/hooks/` and `.cursor/hooks/` exist locally, (b) symlinks the adapter scripts into them, (c) reads `LOCAL_HOOK_SECRET` from the project root `.env` and writes a small wrapper that exports it before invoking the adapter (the wrapper is what gets symlinked, so the secret stays out of the agent's shell environment). Module 08a's `coodra init` will invoke this script automatically; for Module 03 the user runs it manually after `pnpm install`.

CI smoke test (`.github/workflows/ci.yml` job: `hook-adapter-smoke`):
- Spins up `apps/hooks-bridge` in a background process on `127.0.0.1:3101`.
- Pipes a fixture payload (allow case + deny case) into each shell adapter via stdin.
- Asserts: allow → exit 0 + empty stderr; deny → exit 2 + reason on stderr.
- Runs on `ubuntu-latest` and `macos-latest`.

**Files:** `scripts/hook-adapters/windsurf-coodra.sh`, `cursor-coodra.sh`, `install.sh`, `__tests__/fixtures/adapters/{allow,deny}.json`, `.github/workflows/ci.yml` (new job).

**Reference updates in the same commit:** `External api and library reference.md` → small new "Hook adapter shell scripts" subsection with the script contract.

**Commit:** `feat(scripts): windsurf + cursor hook adapter shell scripts + install helper`.

### S12 — `.mcp.json` updated to wire Claude Code hooks at the bridge

Update the repo root `.mcp.json` so Claude Code, when running in this repo, fires hooks to the live hooks-bridge in addition to having access to the MCP server.

```json
{
  "mcpServers": {
    "coodra": { "type": "stdio", "command": "node", "args": ["apps/mcp-server/dist/index.js", "--transport", "stdio"], "env": { ... } }
  },
  "hooks": {
    "PreToolUse":   [{ "type": "http", "url": "http://127.0.0.1:3101/v1/hooks/claude-code", "headers": { "X-Local-Hook-Secret": "${LOCAL_HOOK_SECRET}" } }],
    "PostToolUse":  [{ "type": "http", "url": "http://127.0.0.1:3101/v1/hooks/claude-code", "headers": { "X-Local-Hook-Secret": "${LOCAL_HOOK_SECRET}" } }],
    "SessionStart": [{ "type": "http", "url": "http://127.0.0.1:3101/v1/hooks/claude-code", "headers": { "X-Local-Hook-Secret": "${LOCAL_HOOK_SECRET}" } }],
    "Stop":         [{ "type": "http", "url": "http://127.0.0.1:3101/v1/hooks/claude-code", "headers": { "X-Local-Hook-Secret": "${LOCAL_HOOK_SECRET}" } }],
    "UserPromptSubmit": [{ "type": "http", "url": "http://127.0.0.1:3101/v1/hooks/claude-code", "headers": { "X-Local-Hook-Secret": "${LOCAL_HOOK_SECRET}" } }]
  }
}
```

`.mcp.dev.json` (introduced in Module 02 commit `811fcc8`) gets the same `hooks` block so the live-reload dev profile observes hooks too.

`docs/DEVELOPMENT.md` "Iterating on Module 03" section explains: (a) the IDE must be restarted once after this commit lands so Claude Code re-reads `.mcp.json`, (b) hooks-bridge must be running (`pnpm --filter @coodra/hooks-bridge dev`), (c) verify via `tail -f` on the hooks-bridge stderr while running an agent turn in Claude Code.

**Files:** `.mcp.json`, `.mcp.dev.json`, `docs/DEVELOPMENT.md`.

**Commit:** `chore(repo): wire Claude Code hooks to hooks-bridge in .mcp.json`.

### S13 — Integration tests (cross-mode + Postgres)

Add the cross-mode integration test that exercises team-mode auth + local SQLite (the §8.3 fix's positive test):

`apps/hooks-bridge/__tests__/integration/cross-mode.test.ts` — boots the app with `COODRA_MODE=team`, asserts (a) auth chain rejects no-creds with 401, (b) DB writes go to SQLite (no Postgres connection attempted), (c) full Claude Code lifecycle works.

Add a Postgres integration test for the cloud-side path that the future Sync Daemon will use:

`packages/db/__tests__/integration/cloud-mode-write.test.ts` — testcontainers Postgres, calls `createDb({ kind: 'cloud' })`, writes a `runs` row, reads it back. This test does not boot hooks-bridge — it only verifies the createDb cloud branch since hooks-bridge is local-only by design.

The Module 02 manifest-e2e test gets one new assertion: the eight tools list is unchanged (Module 03 adds zero MCP tools).

**Files:** `apps/hooks-bridge/__tests__/integration/cross-mode.test.ts`, `packages/db/__tests__/integration/cloud-mode-write.test.ts`, `apps/mcp-server/__tests__/integration/manifest-e2e.test.ts` (extended).

**Commit:** `test(hooks-bridge,db): cross-mode integration + cloud-mode write coverage`.

### S14 — E2E: full session lifecycle through hooks-bridge + MCP

Extend `__tests__/e2e/full-session.test.ts`:

```
1. Start hooks-bridge child process on 127.0.0.1:3101 with COODRA_SQLITE_PATH=/tmp/e2e-{uuid}.db
2. Start mcp-server child process pointing at the same SQLite path, both auto-migrate.
3. MCP Client (sdk) calls get_run_id → returns runId.
4. POST /v1/hooks/claude-code SessionStart with the same sessionId → run row 'pending'.
5. POST PreToolUse with a deny-fixture rule loaded → response: hookSpecificOutput.permissionDecision = 'deny'.
6. POST PreToolUse with a different toolInput (allow path) → permissionDecision = 'allow'.
7. POST PostToolUse → run_events row written, status flips to 'in_progress'.
8. POST Stop → status 'completed', ended_at set.
9. MCP Client calls save_context_pack with the runId.
10. Read context pack file from disk; assert it lists the recorded events.
11. Tear down both child processes.
```

This test runs only in CI's main-branch `e2e` job and locally via `pnpm test:e2e`. It is the proof that Modules 01 + 02 + 03 form a working closed loop — agent → hook → policy → audit → run-event → context-pack.

**Files:** `__tests__/e2e/full-session.test.ts` (extended), `__tests__/e2e/_helpers/spawn-hooks-bridge.ts` (new), `__tests__/e2e/fixtures/policy-deny-write.json` (new).

**Commit:** `test(e2e): full session lifecycle through hooks-bridge + mcp-server`.

### S15 — Module 03 closeout context pack

Write `docs/context-packs/2026-04-25-module-03-hooks-bridge.md` matching `docs/context-packs/template.md`:

- What was built (apps/hooks-bridge, packages/shared/{hooks,policy,auth} extracts, createDb refactor).
- Decisions made (createDb kind discriminator, normalize-session-id helper, shell-adapter location).
- Files created or modified (complete list — extracted from `git diff main...feat/03-hooks-bridge --stat`).
- Tests written (count by type: unit, integration, e2e).
- How integration was verified (S14 e2e + manual Claude Code session through Module 03).
- Carryover items closed: §8.3 (S4 SHA), §8.6 (S6 SHA).
- Carryover items still deferred: §8.5 (Module 08a), live Clerk validation (Module 04 / first team-mode flip), pending_jobs durable outbox (post-Module 03 if DB downtime becomes visible).
- What should be built next: Module 04 (Web App) per the implementation order.

Update `README.md` module status table — Module 03 ✅ complete, Module 04 🔨 next, Module 05 / 06 / 07 / 08a ⏳ blocked-on-04 (for 04, 07, 08a) or ⏳ blocked-on-03 (for 05, 06).

Update `docs/verification/2026-04-25-module-01-02-verification.md` "Findings closed" appendix with the closing SHAs for §8.3 (S4) and §8.6 (S6), and a note that §8.5 remains open and is now scoped to Module 08a.

**Files:** `docs/context-packs/2026-04-25-module-03-hooks-bridge.md`, `README.md`, `docs/verification/2026-04-25-module-01-02-verification.md`.

**Commit:** `docs(03-hooks-bridge): module-03 closeout context pack + module status update`.

## Verification (end-to-end smoke before squash-merge)

After all 15 slices land:

1. `pnpm build` — clean compile, all packages green.
2. `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration && pnpm test:e2e` — full repo green.
3. **Manual Claude Code session test:**
   - Run `pnpm --filter @coodra/hooks-bridge dev` in one terminal.
   - Run `pnpm --filter @coodra/mcp-server dev` in another (or use the IDE's stdio launch).
   - Restart Claude Code so it re-reads `.mcp.json` with the new `hooks` block.
   - Open a test repo with a `.coodra.json` registered, ask Claude to make a small edit.
   - Verify hooks-bridge stderr shows `pre_tool_use` + `post_tool_use` log lines for that edit.
   - Verify `SELECT * FROM run_events ORDER BY created_at DESC LIMIT 5` shows the events.
   - Verify a deny rule in the project's `policies` table actually blocks the next edit attempt.
4. **Cross-mode test:** boot with `COODRA_MODE=team` + valid Clerk keys, confirm SQLite is used, auth chain rejects unauthenticated requests, the same session lifecycle works.
5. CI green on `feat/03-hooks-bridge` for every commit on the branch on `Abishai95141/Coodra-matrx-maven`.
6. Squash-merge the branch to `main` via `gh pr create` then `gh pr merge --squash --delete-branch`. Final `main` HEAD documented in the closeout pack.

## Out of scope for this batch (flagged for later)

- **`pending_jobs` outbox refactor.** Module 02 deferred this; Module 03 inherits the deferral. If post-merge live use surfaces DB-downtime user-visible artifacts, schedule a slice in Module 04 or earlier.
- **Live Clerk JWT validation against a real tenant.** Module 03 ships wired-but-mock-tested. Live validation pairs with Module 04's auth UX or a dedicated team-mode dry-run, whichever lands first.
- **JIRA / GitHub webhook handlers.** Separate integration modules after Module 03. The `POST /v1/webhooks/{provider}` path is reserved but not implemented here.
- **Sync Daemon.** Local→cloud REST batch sync is a Module-04-or-cloud-api concern. Hooks-bridge writes to local SQLite only.
- **Adapter for new agents.** Adding a fourth agent (e.g., Aider, Continue.dev) is an additive task: one new payload schema, one new adapter, one new shell script, one new route. Slot into a maintenance slice when needed.
