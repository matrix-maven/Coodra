# Module 06 — Run Diff — Techstack

## Languages

- **TypeScript only.** No Python service. ADR-013 supersedes ADR-002's "Python for tree-sitter" claim for this module — see `essentialsforclaude/11-adrs.md`.

## Runtime dependencies

- `git` (system binary) — invoked via `node:child_process::execFile`. The bridge spawns `git rev-parse HEAD`, `git diff`, `git status --porcelain`, `git diff --numstat`, and `git diff --name-status`. No new npm package required.
- `drizzle-orm` (existing) — schema, migrations, query layer.
- `zod` (existing) — input/output schemas for the MCP tool, shared file-entry shape in `packages/shared/src/run-diff.ts`.

## What is NOT used

- **No tree-sitter / web-tree-sitter / `.wasm` grammars.** Replaced by `git diff` (universal, lossless, format every consumer already speaks).
- **No external LLM (Anthropic, Gemini, OpenAI, Ollama).** The agent does narrative interpretation via its own model when calling `save_context_pack`. Server-side computation is purely deterministic.
- **No `node:child_process::spawn` with `shell: true`.** Every git invocation uses `execFile` with explicit argv, which avoids shell metacharacter surprises in user paths.
- **No new Python `services/semantic-diff/` directory.** The original M06 plan was a FastAPI service on :3201; that's removed entirely. ADR-013 records the supersede and updates `system-architecture.md` §2 service inventory.
- **No new outbox queue type.** The diff is generated inline at SessionEnd because there is no LLM call to defer.

## Versions

- Node ≥ 22 (existing requirement).
- `git` ≥ 2.18 (`-z` machine-parseable status output is universal at this version).

## Performance budgets

- Git subprocess time: ~5–15ms per `rev-parse` HEAD, ~50–200ms per `diff` for typical sessions, ~10–50ms per `numstat` / `name-status`. Four diff calls run in parallel.
- DB write: single DELETE + INSERT against SQLite WAL — sub-millisecond.
- Total SessionEnd-to-runner-completion: < 250ms p95 in solo mode; the auto-pack save runs after this, so the auto-pack's "## Diff" section reads a freshly-written row.

## Storage caps

- `MAX_UNIFIED_DIFF_BYTES = 256 KiB` — hard cap on what we keep in `run_diffs.unified_diff`. Larger diffs are truncated at a clean newline boundary; `truncated = true` flags this for consumers.
- `MAX_FILES_PER_DIFF = 200` — hard cap on the file list passed to `git diff -- <files>`. argv length is well within system limits at this size; an agent that touched > 200 files will see only the first 200 in the diff.
- Auto-pack inline diff: 16 KiB. The full diff is queryable via `query_run_diff`.

## Local-only test invocation

```
pnpm --filter @coodra/shared test:unit -- run-diff
pnpm --filter @coodra/db test:unit
pnpm --filter @coodra/hooks-bridge test:unit
pnpm --filter @coodra/mcp-server test:unit
pnpm --filter @coodra/web-v2 typecheck
```

## CI

- `lint-typecheck` job: existing pipeline catches the new files.
- `test-unit` job: existing pipeline runs the new tests.
- `test-integration` job: existing pipeline runs against testcontainers Postgres + the new schema parity assertions.
- No new CI step required — Module 06 introduces no new toolchain.
