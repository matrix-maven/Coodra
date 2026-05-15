# Module 03 — Hooks Bridge — Tech Stack

> Every version below is verified against the npm registry on 2026-04-25 via `npm view <pkg> version` and reconciled with `External api and library reference.md`. Drift between this file and the reference means the reference is updated **in the same commit** that changes this file (amendment B, carried forward from Modules 01 + 02).

## Runtimes (carried forward from Module 02 — unchanged)

| Tool | Pin |
|---|---|
| Node.js | `22.16.0` (engines `>=22.16.0 <23`) |
| pnpm | `10.33.0` |
| Docker | host-installed ≥ 24 (required for `testcontainers` integration tests + `apps/hooks-bridge` integration suite reuses Postgres-pgvector container) |
| Python / uv | unused in Module 03 |

## Module-03 npm dependencies (installed in S5)

`apps/hooks-bridge/package.json` dependencies — most are already pinned in `External api and library reference.md` from Module 02's deferred-pins list. No new architecture-cited libraries land in this module.

| Package | Pin | Role | Reference action |
|---|---|---|---|
| `hono` | `^4.12.15` | Hono app — three `POST /v1/hooks/{agent}` routes + `GET /healthz`. Same Hono version as `apps/mcp-server` (caret pin keeps them in lockstep). | Already pinned — no change |
| `@hono/node-server` | `^2.0.0` | Node listener for Hono's `fetch` handler on `127.0.0.1:3101`. Same major as mcp-server. | Already pinned — no change |
| `@hono/zod-validator` | `^0.7.6` | Per-route Zod body validation middleware. Validates the agent payload **before** any business-logic lookup so malformed bodies fail fast (still fail-open by returning `allow` from the route, but the Zod result is the trigger to fail-open). | **NEW** — first usage in Module 03. Pin verified via `npm view`. |
| `cockatiel` | `3.2.1` exact | Reuses the policy module's existing breaker. No new instance in hooks-bridge — the breaker lives inside `@coodra/policy`. | Already pinned — no change |
| `@clerk/backend` | `3.3.0` exact | Auth chain inheritance via the `@coodra/shared/auth` middleware. No new direct dependency in hooks-bridge — pulled transitively through shared. | Already pinned — no change |
| `picomatch` | `4.0.2` exact | Used inside `@coodra/policy` for path-glob matching. Pulled transitively. | Already pinned — no change |
| `drizzle-orm` | `^0.45.2` | Used by `apps/hooks-bridge/src/lib/run-recorder.ts` to write to `runs` and `run_events`. Caret pin matches `@coodra/db`. | Already pinned — no change |
| `@coodra/shared` | workspace | Adapters, HookEvent schema, normalizeSessionId, auth, logger, env helpers. | n/a |
| `@coodra/policy` | workspace | The policy evaluator + audit-write helper. New package landed in S3. | n/a |
| `@coodra/db` | workspace | DbHandle type + createDb factory (post-§8.3 refactor). | n/a |

`apps/hooks-bridge/package.json` devDependencies:

| Package | Pin | Role | Reference action |
|---|---|---|---|
| `tsx` | `^4.20.6` | `pnpm --filter @coodra/hooks-bridge dev` watch mode. Same version as mcp-server. | Already pinned — no change |
| `vitest` | `^3.0.0` | Unit + integration test runner. Workspace-shared. | Already pinned — no change |
| `@types/node` | `^22.14.1` | Node typings. | Already pinned — no change |
| `testcontainers` | `^11.14.0` | Docker-backed Postgres for the cross-mode integration test that exercises `createDb({ kind: 'cloud' })`. | Already pinned — no change |
| `@testcontainers/postgresql` | `^11.14.0` | Postgres-pgvector convenience. | Already pinned — no change |

## Workspace dependency additions (installed in S3)

`@coodra/shared` (auth lives here):

| Package | Pin | Role |
|---|---|---|
| `@clerk/backend` | `3.3.0` exact (moved from mcp-server) | Auth chain — `verifyClerkJwt` lives under `packages/shared/src/auth/`. mcp-server now pulls it transitively. |

`@coodra/policy` (new workspace package — policy lives here):

| Package | Pin | Role |
|---|---|---|
| `cockatiel` | `3.2.1` exact (moved from mcp-server) | Policy-engine timeout + breaker fuse. |
| `picomatch` | `4.0.2` exact (moved) | Path-glob matching. |
| `drizzle-orm` | `^0.45.2` | Reads `policies`/`policy_rules`, writes `policy_decisions`. |
| `@coodra/db` | workspace | `DbHandle` + schema tables. |
| `@coodra/shared` | workspace | Logger + `IdempotencyKey` value-shape (moved here in S3). |

mcp-server keeps `picomatch` as a direct dep (still used in `tools/get-feature-pack/handler.ts`). It drops `cockatiel`, `@clerk/backend`, and `@types/picomatch` (now transitive).

## `packages/db` change (installed in S4 — closes verification §8.3)

The `createDb` factory grows a `kind: 'local' | 'cloud'` discriminator on `CreateDbOptions`:

```ts
export type CreateDbOptions =
  | { kind: 'local';                     mode?: 'solo' | 'team'; sqlitePath?: string }
  | { kind: 'cloud'; mode?: 'solo' | 'team'; postgresUrl?: string };
```

- `kind: 'local'` always returns SQLite, **regardless of `mode`**. Used by `apps/mcp-server`, `apps/hooks-bridge`, `apps/web` (when it lands).
- `kind: 'cloud'` always returns Postgres. Used by the future Sync Daemon and the future cloud-api.
- `mode` becomes purely an auth-strategy hint (solo bypass vs Clerk). It no longer dictates DB choice — that contradicts architecture §1 ("local services always write to local SQLite") and was the §8.3 finding.
- The `COODRA_DB_OVERRIDE_MODE` env var introduced in Module 02 commit `187c844` is **removed** in this slice. No callers exist outside the test suite (Module 02 just shipped); deprecation period is unnecessary. Tests that used it switch to `kind: 'local'` directly.

No new dependency — `drizzle-orm` and `better-sqlite3` versions unchanged.

## Reference updates committed in-lockstep

Every new/updated version above is amended in `External api and library reference.md` in the **same commit**. Summary of commit mapping (slices defined in `implementation.md`):

| Commit | Reference changes |
|---|---|
| S3 (`refactor(workspace): extract @coodra/policy package + @coodra/shared/auth from mcp-server`) | New "@coodra/policy package" subsection under Validation/Schemas/Resilience naming the dep set + cycle rationale; note in `cockatiel`/`picomatch` subsections that they now live under `@coodra/policy`; note in `@clerk/backend` that it lives under `@coodra/shared/auth`. No version changes. |
| S4 (`refactor(db): split createDb into local-vs-cloud kinds (closes verification §8.3)`) | `Drizzle ORM` subsection — add a "Local-vs-cloud routing" paragraph documenting the new `kind` discriminator. |
| S5 (`feat(hooks-bridge): scaffold + Hono app + healthz`) | `@hono/zod-validator` new subsection — pin `^0.7.6`, snippet showing the route validator pattern, gotcha about `c.req.valid('json')` returning the Zod-parsed value. |
| S15 (`docs(03-hooks-bridge): module-03 closeout context pack + .mcp.json hook config`) | No reference changes; closeout only. |

## Deferred / forward-looking pins (not installed in Module 03)

Carried forward from Module 02 with Module-03 adjustments:

| Package | Pin | First-used module | Notes |
|---|---|---|---|
| `bullmq` | `^5.76.0` | post-Module 03 (team-mode cloud queue) | §16 pattern 3 / §18 stays solo-mode in-process for now. |
| `ioredis` | `^5.10.1` | same as BullMQ | n/a |
| `next` / `react` / `react-dom` | `^16.2.4` / `^19.2.5` | Module 04 | Web App. |
| `jira.js` | `^5.3.1` | JIRA integration module | §22, post-04. |
| Octokit suite | various | GitHub integration module | §23, post-04. |

## Key gotchas (Module 03 additions)

- **Hooks bridge port `3101` is NOT the same as MCP `3100`.** Both are loopback-only in solo mode. CI port-conflict checks must consider both. `docs/DEVELOPMENT.md` is updated with a "ports in use" table in S5.
- **Claude Code hook payloads have a `tool_input` field that may be 100KB+.** Pre-hook latency is dominated by Zod parse time on huge bodies. The body validator caps `tool_input.content` to 1 MB (Hono's default body limit) and rejects beyond that with `permissionDecision: 'allow'` + `reason: 'hook_payload_too_large'` — fail-open, but flagged. Test fixture covers a 2 MB payload.
- **Windsurf / Cursor adapters communicate over stdin → curl → stdout.** The shell scripts must be `chmod +x` and use `#!/usr/bin/env bash` (not `/bin/bash`) for macOS compatibility. CI's smoke test runs both on `ubuntu-latest` and `macos-latest`.
- **`X-Local-Hook-Secret` is supplied by adapter scripts.** Solo bypass via `sk_test_replace_me` works only when the agent is a direct in-IDE Claude Code session; for Windsurf/Cursor adapters, the secret env var is the only viable auth. `scripts/install-hook-adapters.sh` (lands in S11) reads `LOCAL_HOOK_SECRET` from the project's `.env` and bakes it into the installed shell scripts. The user is told once: rotate the secret = re-run install.
- **`session_id` from Claude Code may contain `:`.** Real-world fixture: `claude-code-{uuid}:fork-{n}`. The `normalizeSessionId` helper turns this into `claude-code-{uuid}-fork-{n}`. **Lossy for forks!** A fork-event-detection test fixture asserts that the lossy normalization is acceptable because Claude Code's fork-id is reflected in `tool_use_id`, not `session_id`, in the hook payloads we care about. If a future Claude Code version surfaces fork lineage in a different field, revisit.
- **Hono's `app.request()` fixture is the integration-test contract.** No real port-listen in unit tests. The integration suite uses real listeners only for the cross-process e2e + adapter shell-script smoke test.
- **`@hono/zod-validator` returns 400 by default on parse failure.** This contradicts our fail-open posture. Override the default error handler via `zValidator('json', schema, (result, c) => c.json({ ok: true, hookSpecificOutput: { permissionDecision: 'allow' }, _reason: 'invalid_hook_payload' }, 200))`. Tested in S6.

## Version-bump policy (amendment B, unchanged)

Every time a `package.json` in this repo changes a pinned version, the entry in `External api and library reference.md` is updated in the same commit. Architecture-cited libraries (`@hono/node-server`, `@modelcontextprotocol/sdk`, `@clerk/backend`, Hono) also update `system-architecture.md` if behavior changes. Never a follow-up commit.
