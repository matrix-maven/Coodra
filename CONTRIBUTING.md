# Contributing To Coodra

Thanks for thinking about contributing. Coodra is open source under the Apache
License 2.0 and is maintained by Matrix Maven.

This guide covers the public contributor loop. For the product and architecture
overview, read [`docs/index.html`](docs/index.html) locally or the published
docs at <https://matrix-maven.github.io/Coodra/>.

## Quick Start

```bash
corepack enable
pnpm install
pnpm rebuild

pnpm typecheck
pnpm test:unit
pnpm lint
```

Integration and end-to-end checks need the local services described in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Codebase Map

| Path | What lives here |
|---|---|
| `apps/mcp-server` | Coodra MCP server, lifecycle-event runtime, memory, policy, wiki, and Work Pack tools. |
| `apps/sync-daemon` | Team-mode outbox push and cloud-to-local pull. |
| `apps/web-v2` | Local/self-hosted web dashboard. |
| `packages/cli` | The `@coodra/cli` npm package. |
| `packages/db` | Drizzle schemas and migrations for SQLite and Postgres. |
| `packages/policy` | Pure policy-decision engine. |
| `packages/shared` | Shared schemas, auth helpers, utilities, and contracts. |
| `docs` | Public developer docs, deployment notes, team guides, and brand assets. |
| `.coodra` | Project-local generated context: Graphify output, wiki mirror, Work Packs, recipes, and manifest. |

## Branches And Commits

- Branch from `main`.
- Use focused branches such as `feat/work-pack-sync`, `fix/policy-audit`, or
  `docs/security-policy`.
- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
  `chore:`.
- Keep one logical change per pull request.

## What Done Looks Like

A contribution is ready for review when:

1. `pnpm typecheck` passes.
2. `pnpm test:unit` passes.
3. `pnpm lint` passes, or formatting drift is fixed with `pnpm lint:fix`.
4. Service-boundary, database, sync, lifecycle, or packaging changes have
   focused integration coverage.
5. Full runtime changes have an end-to-end check or a clear reason one was not
   practical.
6. Public behavior changes update the relevant docs in the same PR.
7. DB schema changes include new Drizzle migrations for the affected dialects.
8. User-owned files, generated state, and unrelated worktree changes are not
   rewritten.

Current CI jobs are `verify`, `integration`, `hook-adapter-smoke`,
`windows-core-smoke`, `windows-native-full-smoke`, and `e2e`. See
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) for exact commands.

## Project Guardrails

- Do not fake successful behavior with shallow stubs.
- Avoid `any` and broad type assertions. Use Zod at service and tool
  boundaries.
- Do not swallow errors silently. Log or return structured context.
- Make writes idempotent. Agent retries, network retries, and duplicate MCP calls
  should not corrupt state.
- Do not edit published migrations in place. Add a new migration.
- Keep Coodra-owned generated files tracked in `.coodra/manifest.json` when the
  CLI creates them.
- Keep provider systems authoritative for their own data. For example, Jira and
  Linear remain program-management systems of record; Coodra stores the
  agent-ready Work Pack context.

## Agent-Facing Changes

MCP tools live under `apps/mcp-server/src/tools/<tool-name>/` and should include:

```text
handler.ts    implementation
schema.ts     Zod input/output schemas
manifest.ts   name, description, input schema, idempotency metadata
```

When changing agent-facing behavior, update tests and docs for the affected
surface:

- MCP tools and lifecycle events: update `docs/index.html` when public behavior
  changes.
- CLI commands: update root `README.md`, `packages/cli/README.md`, or
  `docs/index.html` depending on audience.
- Policy behavior: document runtime implications and audit semantics.
- Work Packs, Deep Wiki, memory, or Graphify: verify the claim against the
  current implementation and generated `.coodra` artifacts.

## Pull Requests

Use the pull request template and include:

- What changed and why.
- How reviewers can verify it.
- Any limitations or intentionally deferred work.
- Related issues, Work Packs, decisions, or docs.

## Bugs, Security, And Questions

- Bugs: open a GitHub issue with reproduction steps, `coodra doctor --json`
  output, OS, Node.js version, CLI version, agent, and mode.
- Security issues: do not open a public issue. Follow [`SECURITY.md`](SECURITY.md).
- Architecture questions: start with [`docs/index.html`](docs/index.html), then
  open an issue or discussion if something is unclear.

## Maintainer

Coodra is maintained by **Matrix Maven**. Reach us at `info@matrixmaven.co`.

## License

By contributing, you agree that your contributions are licensed under the Apache
License 2.0, the same as the rest of Coodra.
