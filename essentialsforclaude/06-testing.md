# 06 — Testing Requirements

**Every function gets a test. No exceptions.**

| Test Type | Framework | Runs On | What It Tests |
|-----------|-----------|---------|---------------|
| Unit | Vitest (TS), pytest (Python) | Every push | Individual functions in isolation |
| Integration | Vitest + testcontainers | Every PR | Service + real database/Redis |
| E2E | Vitest + MCP SDK client | Main branch | Full lifecycle: session → tools → context pack |

## 6.1 Unit tests

- Cover all public functions. Private functions tested through public API.
- Test success paths AND error paths. A function with 3 error cases needs 3 error tests.
- Use factory functions for test data, not inline objects.
- No `sleep()` calls. Use `vi.useFakeTimers()` or proper async patterns.

## 6.2 Integration tests

- Use `testcontainers` for PostgreSQL (image: `pgvector/pgvector:pg16`).
- Use Hono's `app.request()` for HTTP handler tests — no running server needed.
- Use `@modelcontextprotocol/sdk` Client for MCP server tests — connect in-process.
- Test with real Drizzle queries against a real (containerized) database.

## 6.3 E2E tests

- Full lifecycle: SessionStart hook → Feature Pack injection → tool use → PreToolUse policy check → PostToolUse trace → Stop → Context Pack generation.
- Run against real services (containerized), not mocks.
- Assert on database state, not just HTTP responses.

## 6.4 Coverage

**Minimum: 80% line coverage.** Check with:

```bash
pnpm test:unit -- --coverage
```

## 6.5 Running tests locally

```bash
pnpm test:unit                              # Vitest unit tests (TS)
pnpm test:integration                       # Integration tests (needs Docker)
pnpm --filter @coodra/nl-assembly test   # Python tests (pytest)
pnpm test:e2e                               # E2E — main branch only in CI, runnable locally
```

## 6.6 MCP tool manifest test (required)

Per `system-architecture.md` §24.9, the integration suite includes a **synthetic agent test**: a headless MCP client connects, calls `tools/list`, and asserts:

- Exactly the expected set of tools is advertised (no extras, no missing).
- Each description is shorter than 800 characters.
- Each input schema is valid JSON Schema and round-trips through Ajv.
- Calling each tool with a minimal valid input returns a shape compatible with the advertised output schema — or a structured error with `ok: false`.

This runs on every push and catches "added a tool but never wired it into `index.ts`".

## 6.7 Test file location

```
apps/<app>/__tests__/unit/<matching-path>.test.ts
apps/<app>/__tests__/integration/<matching-path>.test.ts
__tests__/e2e/<scenario>.test.ts                              # at repo root
```

Mirror the source tree inside `__tests__/unit/` and `__tests__/integration/`.
