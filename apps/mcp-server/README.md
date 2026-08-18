# `@coodra/mcp-server`

Coodra MCP server - the process that exposes Coodra's agent-facing tools and
the `lifecycle_event` entrypoint.

Native Coodra plugins for Claude Code, Codex, Cursor, Devin, and Antigravity
call this server for memory, decisions, policy checks, Deep Wiki, Work Packs,
run history, and lifecycle event handling.

## Current Scope

- **Transports:** stdio for agent/plugin subprocesses and HTTP for local daemon
  health/runtime use.
- **Tools:** 26 registered Coodra MCP tools under `src/tools/`.
- **Lifecycle:** native plugin events enter through the `lifecycle_event` MCP
  tool.
- **Storage:** local SQLite for solo mode; team mode mirrors selected records
  through the sync daemon.
- **Policy:** DB-backed policy evaluation with audit records and idempotency
  keys around writes.

Graphify is not part of this package. Coodra wires Graphify as a separate
managed MCP server pointed at `.coodra/graphify/out/graph.json`.

## Run Locally

```bash
pnpm install
pnpm --filter @coodra/shared build
pnpm --filter @coodra/db build
pnpm --filter @coodra/mcp-server build
pnpm --filter @coodra/mcp-server start
```

For source-mode development:

```bash
pnpm --filter @coodra/mcp-server dev
```

The dev script routes logs to stderr so stdout stays reserved for JSON-RPC
frames when using stdio.

## Agent Wiring

For normal installs, do not add a repo-root `.mcp.json`.

Use:

```bash
coodra install
coodra agent add codex     # or claude, cursor, devin, antigravity, all, detected
coodra init
coodra start
```

The native plugin carries the Coodra MCP entry, lifecycle hooks, skills, and the
managed Graphify MCP entry.

For local MCP-server development, you can still register the built server
manually with an MCP client:

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

Keep project-local MCP config out of the repo unless the test explicitly needs
manual wiring.

## Critical Invariants

- **stdout is protocol.** Stdio transport uses stdout only for JSON-RPC frames.
  Logs must go to stderr.
- **Validate env once.** `src/config/env.ts` owns typed environment parsing.
- **Register-time validation matters.** Tool manifests, schemas, idempotency
  keys, and handlers are validated when the server starts.
- **Writes must be idempotent.** Agents retry. Duplicate calls must not corrupt
  memory, policy, wiki, Work Pack, or run records.

## Layout

```text
src/
  bootstrap/       stderr logging guard
  config/          zod-validated environment
  framework/       tool registry, manifest, policy, idempotency helpers
  lib/             shared server runtime helpers
  tools/           26 MCP tool implementations
  transports/      stdio and HTTP transports
  index.ts         registry and transport bootstrap
```

Public product documentation lives in `docs/index.html`.
