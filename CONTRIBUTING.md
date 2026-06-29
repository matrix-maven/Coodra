# Contributing to Coodra

Thanks for thinking about contributing — Coodra is open source under MIT and we welcome both human and AI-assisted contributions.

This guide covers the dev loop, commit conventions, and a few project-specific guardrails. For the full architectural picture read [`system-architecture.md`](system-architecture.md).

---

## Quick start (contributor dev loop)

```bash
# Prerequisites: Node 22.16+, pnpm 10.33+, Docker (for integration/E2E)
pnpm install
pnpm rebuild              # build better-sqlite3 + sqlite-vec native modules

# Pick a workspace and iterate
pnpm --filter @coodra/cli dev
pnpm --filter @coodra/mcp-server test:unit --watch

# Before pushing
pnpm typecheck
pnpm test:unit
pnpm lint
```

Detailed service commands and troubleshooting live in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

---

## How the codebase is organised

| Path | What lives here | When to touch it |
|---|---|---|
| `apps/mcp-server` | The MCP server — 20 tools agents call | Adding/changing an agent-facing tool |
| `apps/hooks-bridge` | Hono HTTP service that receives Claude Code / Cursor hooks | Adding a hook event handler, policy in-line behaviour |
| `apps/sync-daemon` | Team-mode cloud sync (outbox + pullers) | Cloud-sync logic for a new table type |
| `apps/web-v2` | Next.js admin/audit UI | UI changes for solo + team views |
| `apps/web` | **Deprecated.** Kept only for team-mode Clerk auth surfaces not yet ported to web-v2 | Fixing team auth bugs (until v2 catches up) |
| `packages/cli` | The `@coodra/cli` npm package | Anything users invoke from the shell |
| `packages/db` | Drizzle schema + migrations (SQLite + Postgres) | DB schema changes — always via `pnpm db:generate`, never by hand |
| `packages/shared` | Cross-cutting Zod schemas, auth helpers, logger | Anything imported by more than one app |
| `packages/policy` | Pure policy-decision engine | New policy match types |
| `docs/feature-packs/<NN>-<slug>/` | Per-module specs (spec, implementation, techstack) | Designing a new module |

---

## Branch + commit conventions

- **Feature branches off `main`.** Names: `feat/<area>-<slug>`, `fix/<area>-<slug>`, `docs/<topic>`, `chore/<thing>`.
- **Conventional Commits.** Use `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`. Scope is optional but encouraged: `feat(cli): add agents command`.
- **One logical change per PR.** Bundle related cleanups, but don't ride a refactor on top of an unrelated bug fix.
- **Squash merge to main.** History stays linear.

Example: `feat(mcp-server): add list_features tool with description-quality hint`.

---

## What "done" looks like

A change is ready to merge when:

1. **Types**: `pnpm typecheck` passes across the whole workspace.
2. **Tests**: every public function in the change has a unit test, and `pnpm test:unit` passes.
3. **Lint**: `pnpm lint` passes (or, if you added auto-fixable formatting drift, run `pnpm lint:fix`).
4. **Integration / E2E**: if your change touches a service boundary or migration, `pnpm test:integration` (and `pnpm test:e2e` for full-lifecycle changes) is green locally.
5. **Documentation**: if you changed an architectural decision, public CLI flag, or MCP tool surface, the relevant `docs/feature-packs/<module>/` files are updated in the same PR. Note any new architectural decision in the PR description.

CI runs all of the above on every PR — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

---

## Project-specific guardrails

A few rules the project enforces beyond standard OSS hygiene:

1. **No shallow proxies.** Don't ship a function that returns a hardcoded success because the real wire call isn't wired yet. If a feature can't be fully implemented in your PR, either complete it or split it; never fake it.
2. **No `any`, no `as`.** Use Zod schemas at every service boundary and infer TypeScript types from them. If you reach for `any`, redesign the interface.
3. **No silent error swallowing.** `catch (e) {}` is banned. At minimum log the error with structured context.
4. **Idempotency at every write.** Retries (network timeout, agent retry) must produce the same result. See `generateIdempotencyKey()` in `@coodra/shared`.
5. **Migrations are the source of truth.** Schema changes go through Drizzle (`pnpm db:generate`). Never modify a published migration in place; add a new one.

---

## Adding a new MCP tool

Tools live in `apps/mcp-server/src/tools/<name>/` with three files:

```
handler.ts    # implementation
schema.ts     # Zod input/output schemas
manifest.ts   # { name, description, inputSchema } registered in src/tools/index.ts
```

The `manifest.ts` description follows a five-part recipe (trigger phrase → return shape → why the agent needs it → when NOT to call → 40-80 words). A test in `__tests__/unit/.../manifest.test.ts` enforces the shape.

---

## Reporting bugs / asking questions

- **Bugs**: open a GitHub Issue. Include `coodra doctor --json` output and your OS / Node version.
- **Security issues**: please *don't* file a public issue — email `abishai95141@gmail.com` directly.
- **Architecture questions**: open a Discussion, or skim `system-architecture.md` first (it's long but indexed).

---

## License

By contributing you agree your contributions are licensed under MIT, the same as the rest of the project.
