# 01 — Development Discipline

## 1.1 No shallow implementations, no faked results, no shallow proxies

This is the single most important rule. Agents under token pressure or time pressure default to faking functionality; **you must not**. A feature is real or it is absent — there is no in-between.

**Every function must be complete and working:**

- **No `// TODO` stubs** in committed code. If you are implementing a function, implement it fully.
- **No `throw new Error("Not implemented")`** — if a function exists, it works.
- **No mock data in production code.** Mocks belong in `__tests__/` only.
- **No `console.log` for logging.** Use pino with structured context.
- If a file requires 500 lines to be correct, write 500 lines. Never truncate with "... rest similar".

**Shallow proxies — banned patterns.** If you catch yourself doing any of these, STOP and ask the user:

- Hardcoding a success response (`return { ok: true }`) because the real wire call is not yet wired.
- Generating fake data "for demo" that the UI renders as if it were real.
- Implementing a handler that swallows input and returns a canned shape matching what the client expects.
- Claiming a feature is "complete" when only the happy path hits the DB and failure paths return pretend success.
- Skipping a real external call (LLM, webhook, OAuth round-trip) with a stubbed response and not marking it as such.
- Creating a migration that inserts seed data shaped like real runtime data so demos "just work".
- Adding a passing test that asserts on the stub instead of on real behavior.
- Silently catching errors and returning a default that makes the caller think things worked.

**If a feature cannot be genuinely implemented in this session** (missing API key, cloud service, domain, paid account, GitHub App registration, etc.):

1. Do NOT ship a fake version.
2. Record the blocker in `context_memory/pending-user-actions.md` (see `02-agent-human-boundary.md`).
3. Record the blocker in `context_memory/blockers.md`.
4. STOP work on that surface. Move to something else or ask the user.

The product is evaluated on whether each feature actually works end-to-end, not on whether it looks like it does.

## 1.2 No output-token shortcuts

AI agents frequently produce incomplete code to save tokens. Do not do this.

- Never write `// ... rest of implementation similar to above`. Write every line.
- Never write `// Add remaining endpoints here`. Add them.
- Never produce a partial file and say "I'll continue in the next message". Produce the complete file.
- Every code block must compile and run without modification.
- If a test file needs 20 test cases, write 20. Not 3 with a comment saying "add more".

## 1.3 Type safety everywhere

- **Zod schemas at all service boundaries.** Every HTTP request body, every MCP tool input, every queue message payload has a Zod schema.
- **Infer TypeScript types from Zod:** `type MyType = z.infer<typeof MySchema>`. Never define a separate TypeScript interface that duplicates a Zod schema.
- **Never use `any`.** If you find yourself reaching for `any`, redesign the interface.
- **Never use `as` type assertions** unless absolutely necessary. If you must, add a comment explaining why.
- **Python:** strict type hints on every parameter and return. Use Pydantic models for all data structures.

## 1.4 Error handling is not optional

- Every function that performs I/O handles errors explicitly.
- Use specific error types, not generic `Error`. Define them in `packages/shared/src/errors/`.
- HTTP handlers return proper status codes: 400 (validation), 401/403 (auth), 404 (not found), 409 (conflict), 500 (unexpected).
- Database errors: catch constraint violations explicitly (unique, FK). Return meaningful messages.
- `catch (e) {}` is forbidden. At minimum, log the error.
- MCP tools return error content with `isError: true` — never throw from a tool handler.

## 1.5 Logging at every decision point

Use **pino** for all TypeScript logging. Use Python's **structlog** or `logging` with JSON output.

```typescript
import { logger } from '@coodra/shared';

logger.info({ projectId, packId, version }, 'Fetching feature pack');
logger.error({ err, projectId, packId }, 'Feature pack fetch failed');
logger.info({ runId, status: 'completed', durationMs }, 'Run completed');
```

Every log line MUST include:
- **Correlation ID:** `sessionId` or `runId` if available
- **Operation name:** what function/handler is executing
- **Relevant entity IDs:** projectId, packId, policyId, etc.

## 1.6 Idempotency is mandatory

Every write operation must be idempotent. Retries (network timeout, agent retry) must produce the same result, not duplicate data.

- **Run Events:** keyed by `{runId}:{eventType}:{toolName}:{timestamp}` — use `generateIdempotencyKey()` from `@coodra/shared`.
- **Runs:** keyed by `run:{projectId}:{sessionId}:{uuid}` — use `generateRunKey()`.
- **Context Packs:** one per run. If one exists for a runId, return the existing one.
- **Policy Decisions:** logged with their own idempotency key to prevent duplicate audit entries.
- Database: use `ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE` — never blind `INSERT`.

## 1.7 Database migrations are the source of truth

- **Never modify the database manually.** No `psql` commands, no Supabase SQL editor.
- All schema changes go through Drizzle: modify `packages/db/src/schema.ts`, then run `pnpm db:generate`.
- Migrations are numbered sequentially: `0000_initial.sql`, `0001_add_embeddings_index.sql`, etc.
- Every migration must be reversible in principle. Document what a rollback requires.
- Test migrations against a clean database AND a database with existing data.

## 1.8 Ask, don't assume

You are not running alone. The user is the product lead and the only source for things the agent cannot decide. Ask — do not guess — when any of these are true:

- An architectural decision is not fully covered in `system-architecture.md` and you cannot find it in `docs/context-packs/` or via `coodra__search_packs_nl`.
- A library version or API shape is ambiguous, deprecated, or newer than what's pinned in `External api and library reference.md`.
- A user action is required (see `02-agent-human-boundary.md` §2.2): API key, infra provisioning, paid account, DNS, OAuth app registration, GitHub App install.
- A destructive operation is about to happen (schema drop, force-push, mass delete, rotating a shared secret).
- The user's intent could reasonably be interpreted two or more ways.
- Acceptance criteria are ambiguous.
- You are about to introduce a design pattern not already in `system-architecture.md` §16.

**Asking costs nothing. Guessing costs rework.** The user would rather answer 3 clarifying questions than receive a feature implemented against the wrong intent.

When you ask: state the options, your recommendation and why, and what you need back.
