# 10 — Troubleshooting

Common local-dev errors and their fixes. When a problem is not in this table, check `docs/DEVELOPMENT.md` and `context_memory/blockers.md`.

| Problem | Solution |
|---------|----------|
| `pnpm install` fails | Check Node.js version (`node -v` must be ≥22). Delete `node_modules` and `pnpm-lock.yaml`, re-run. |
| `pnpm typecheck` fails | Run `pnpm build` first — typecheck depends on built packages for type resolution. |
| `pnpm test:integration` fails | Ensure Docker is running. Tests use testcontainers which starts Postgres automatically. |
| `pgvector` extension not found | Use `pgvector/pgvector:pg16` Docker image, not plain `postgres:16`. |
| Python service won't start | Run `uv sync` in the service directory. Check `pyproject.toml` for correct Python version. |
| MCP client can't connect | Check `MCP_SERVER_PORT` in `.env`. Ensure the server is running (`pnpm --filter @coodra/mcp-server dev`). |
| Hooks bridge returns 500 | Check logs with `pino-pretty`: `pnpm --filter @coodra/hooks-bridge dev \| npx pino-pretty`. |
| `tools/list` returns empty | A tool's `manifest.ts` was not wired into `apps/mcp-server/src/tools/index.ts`. See `09-common-patterns.md` §9.1. |
| Agent says "no such tool" | The name in the agent's call does not match a registered tool name. Verify against `system-architecture.md` §24.4 / §24.5. |
| Policy check always returns `deny` | Inspect `policy_decisions` table. Likely the `agent_type` field on the rule doesn't match the caller's `agentType`. |
| Claude Code doesn't load rules | Confirm `CLAUDE.md` is at repo root and the `@essentialsforclaude/*.md` imports resolve. Run `/memory` in Claude Code to inspect what loaded. |
