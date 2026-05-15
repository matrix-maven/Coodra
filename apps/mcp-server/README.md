# `@coodra/mcp-server`

Coodra MCP server — the process that speaks the Model Context Protocol
on behalf of the platform. This is the package that MCP clients (Claude
Code, Cursor, Windsurf) connect to in order to call the `coodra__*`
tools described in `system-architecture.md` §24.

## Current scope (Module 02, S5 walking skeleton)

S5 ships the foundations end-to-end with exactly one tool — `ping` —
whose only job is to prove every layer of the framework works before
the real tools land in S6–S15.

- **Transport:** **stdio only**. The HTTP (Streamable HTTP) transport
  is deferred to S16 of the Module 02 implementation plan.
- **Auth:** no auth in S5. `stdio` is a trusted local channel owned by
  the parent process (the MCP client). The full Clerk + solo-bypass +
  `LOCAL_HOOK_SECRET` chain lives on the HTTP transport and lands in
  S7b.
- **Tools registered:** `ping`.
- **Policy engine:** an always-allow `devNullPolicyCheck` wrapper is
  attached to the `ping` tool registration. Real policy evaluation
  lands in S7b (`lib/policy.ts`) and is wired into the registration
  framework via the same injection point, so no tool change is needed
  once it arrives.

## Run it locally

```bash
# From the repo root:
pnpm install                           # triggers `prepare` hook wiring
pnpm --filter @coodra/shared build  # @coodra/db imports the built dist
pnpm --filter @coodra/db build      # mcp-server imports the built dist
pnpm --filter @coodra/mcp-server build
pnpm --filter @coodra/mcp-server start
```

Or run against source with hot reload:

```bash
pnpm --filter @coodra/mcp-server dev
```

The `dev` script sets `COODRA_LOG_DESTINATION=stderr` for you.
Without it, the shared logger writes to stdout and corrupts every
JSON-RPC frame.

## Point an MCP client at it

After building, register the server binary with your client. The
repo-root `.mcp.json` already contains the correct entry:

```json
{
  "mcpServers": {
    "coodra": {
      "type": "stdio",
      "command": "node",
      "args": ["apps/mcp-server/dist/index.js"],
      "env": { "COODRA_LOG_DESTINATION": "stderr" }
    }
  }
}
```

Claude Code, Cursor and Windsurf all read `.mcp.json` at workspace load
time. After first build, reload the IDE to have it spawn the server.

## Critical invariants

- **stdout is a protocol channel.** The stdio MCP transport uses
  stdout exclusively for JSON-RPC frames. A single stray `console.log`
  — from this package or any transitively-imported dependency — will
  corrupt the transport and the client will disconnect. `src/index.ts`
  imports `./bootstrap/ensure-stderr-logging.js` as its very first
  statement; that module sets `COODRA_LOG_DESTINATION=stderr` before
  `@coodra/shared`'s logger is loaded, which in turn routes every
  downstream `createLogger` call (including deep inside `@coodra/db`)
  to fd 2.
- **No `process.env.X!` outside `src/config/env.ts`.** That module is
  the one place that reads `process.env` and exports a typed,
  fully-validated singleton. Any other consumer that reaches for
  `process.env.FOO` is a bug.
- **Tool registration enforces its contract at register time, not at
  call time.** `src/framework/tool-registry.ts` validates every
  registration input (name shape, description length, Zod schema,
  handler arity, idempotency-key builder presence) synchronously.
  Invalid registrations throw — the server refuses to start rather
  than degrade.

## Layout

```
src/
  bootstrap/
    ensure-stderr-logging.ts     # side-effect import, MUST be first
  config/
    env.ts                       # zod-validated, fail-fast, singleton
  framework/
    tool-registry.ts             # register-time enforcement
    policy-wrapper.ts            # automatic policy-check wrapping
    idempotency.ts               # typed IdempotencyKeyBuilder contract
    manifest-from-zod.ts         # zod v4 → JSON Schema 2020-12
  tools/
    ping/
      manifest.ts                # name, description, inputSchema
      schema.ts                  # zod input + output schemas
      handler.ts                 # typed handler (policy-wrapped)
  transports/
    stdio.ts                     # stdio server bootstrap
  index.ts                       # wires registry + transport
__tests__/
  unit/
    config/env.test.ts           # env fail-fast fixtures
    framework/tool-registry.test.ts
    framework/manifest-from-zod.test.ts
    tools/ping.test.ts
    transports/stdio-stdout-purity.test.ts
Dockerfile                        # multi-stage, pnpm deploy, digest-pinned base
.dockerignore
.env.example
```

## Pointers

- `system-architecture.md` §3.5 — transport matrix (stdio + HTTP in prod)
- `system-architecture.md` §24 — tool manifest discipline
- `essentialsforclaude/05-agent-trigger-contract.md` — what tool descriptions must teach the agent
- `docs/feature-packs/02-mcp-server/` — full Module 02 Feature Pack
