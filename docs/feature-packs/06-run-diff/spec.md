# Module 06 — Run Diff — Spec

> **Status:** shipped 2026-05-09. Renamed from "Semantic Diff" mid-implementation per the user's "isn't `git diff` better" pushback. The renamed scope replaces tree-sitter AST parsing with `git diff` and removes the LLM enrichment layer entirely; the agent does all narrative interpretation.
> **Depends on:** 01 Foundation (DB schema), 02 MCP Server (tool registry), 03 Hooks Bridge (SessionStart + SessionEnd handler integration), 04 Web App Phase 3 (web-v2 surface for the diff page).
> **Supersedes:** Original M06 "Semantic Diff" plan — Python FastAPI service on :3201, tree-sitter parsing, Anthropic-call enrichment. ADR-002's Python claim for this module is overridden by ADR-013.
> **Blocks:** 07 VS Code Extension's diff overlay (consumes `query_run_diff`).

## 1. Goal

Produce a structured record of *what changed in code during each agent run* — readable by humans (web view) and agents (MCP tool) — without depending on any external LLM or new toolchain.

## 2. Why git diff and not AST

Coodra's M05 thesis ("ship intelligence as records, not as a separate service") applied to M06: the server produces deterministic structured records; the coding agent does all interpretation. For "what changed", `git diff` beats AST parsing because:

- **Universal** — every language, every file type. Markdown, YAML, configs, shell scripts work identically. AST diff doesn't help for those, git diff does.
- **Battle-tested** — most-tested diff implementation in software. The custom AST diff layer would have its own bug surface to grow.
- **Native + free** — already on the user's machine. No `web-tree-sitter`, no `.wasm` grammars to ship, no parser versioning, no native-module compatibility risk.
- **Format the agent already speaks** — every code review, every PR, every IDE shows unified diffs. AST trees aren't a natural format for an LLM to reason about.
- **Lossless** — captures whitespace, comments, import reordering. The agent decides what's noise — better than a hardcoded AST walker doing it.

The only thing AST gives over git diff is structured aggregation ("added 3 functions, removed 2 imports"). The agent can synthesize that from a unified diff trivially, with better judgment than a hardcoded walker would. So we hand the agent the diff and let it interpret.

## 3. Architecture

```
SessionStart (cwd) ─► capture-base-sha.ts ─► git rev-parse HEAD
                                              └► UPDATE runs.base_sha
                                                 (idempotent, fire-and-forget)

SessionEnd  (cwd) ─► run-diff-runner.ts ─► read runs.base_sha + run_events
                                            └► git diff baseSha -- <files>
                                            └► git status --porcelain (untracked)
                                            └► synthesize new-file diffs
                                            └► persist run_diffs row
                                              (DELETE-then-INSERT idempotency)
                          └► saveAutoContextPack ─► reads run_diffs
                                                    └► embeds "## Diff" section
                                                       in auto-pack body

Agent ─► MCP query_run_diff(runId) ─► reads run_diffs ─► structured output
                                                         (success or 5 soft-failures)

Browser ─► /runs/[id]/diff ─► reads run_diffs ─► rendered with syntax colors
```

## 4. Schema

Migration `0011_m06_run_diffs.sql`:

- `runs.base_sha TEXT` — nullable. Captured at SessionStart. NULL on non-git projects, capture failures, or pre-2026-05-09 runs.
- `run_diffs(run_id PK, base_sha, head_sha, unified_diff, files_changed (JSON), truncated, error, generated_at)` — one row per run. Always lands (success + 3 soft-failure codes). DELETE-then-INSERT idempotency.

`files_changed` is JSON-encoded `Array<{path, oldPath?, status: 'added'|'modified'|'deleted'|'renamed'|'copied'|'type_changed', additions, deletions}>`. The shape's authoritative Zod schema lives in `packages/shared/src/run-diff.ts`.

Soft-failure codes (in `run_diffs.error`):

- `no_base_sha` — SessionStart didn't capture HEAD.
- `no_edits_in_run` — agent had no Edit/Write/MultiEdit/NotebookEdit tool calls.
- `git_diff_failed` — subprocess errored; stderr in `unified_diff` for triage.

## 5. MCP tool

`query_run_diff { runId }` returns a discriminated-union output:

- Success: `{ ok: true, runId, baseSha, headSha, unifiedDiff, filesChanged, truncated, generatedAt }`
- Soft-failures: `{ ok: false, error: <code>, howToFix }` where `<code>` is one of `run_not_found | analysis_pending | no_base_sha | no_edits_in_run | git_diff_failed`.

`analysis_pending` distinguishes "the runs row exists but no run_diffs row yet" (wait or end the session) from `run_not_found` (caller passed a wrong runId).

Manifest follows the §24.3 five-part recipe; the description test asserts the canonical "Call this when..." opening, the "Returns ..." sentence, and the soft-failure list.

## 6. What the agent does with it

The intended flow when an agent writes `save_context_pack` mid-session or at session end:

1. Agent calls `query_run_diff(runId)` to get the structured diff.
2. Agent reads the unified diff + files_changed metadata.
3. Agent writes prose into `save_context_pack`'s `content` describing what changed semantically — *"this run added the `getRunDiff` query and wired the new diff page into the run-detail breadcrumb"* — using its own model's understanding.

The server never narrates. The auto-pack digest (Pattern 20) shows a "## Diff" section with the literal unified diff (truncated to 16 KB inline, with a pointer to the MCP tool for the full output) so the safety-net pack also carries the change record without needing the agent to call `save_context_pack` explicitly.

## 7. Untracked-file handling

`git diff <baseSha>` does not include files that didn't exist at `baseSha` and are still untracked at SessionEnd — meaning brand-new files the agent created (a common case) would be lost. Solution: the runner also calls `git status --porcelain -- <files>` to detect untracked (`??`) entries among the agent-touched paths and synthesizes a "new file" diff for each by reading the file content and emitting a standard `/dev/null → b/path` stanza. Same shape as `git diff --intent-to-add`, without mutating the user's index.

## 8. What was cut

- **Tree-sitter AST parsing** — replaced by `git diff`. Same correctness, simpler surface.
- **External LLM enrichment (Anthropic / Gemini)** — agent does narrative.
- **Python service on :3201** — TypeScript-in-process inside the hooks-bridge. ADR-013 records the supersede.
- **Async outbox job** — inline at SessionEnd. With no LLM call the latency budget (~50-200ms) easily fits the SessionEnd window.

## 9. Acceptance criteria

1. `pnpm typecheck` + `pnpm test:unit` + `pnpm test:integration` all pass on `feat/06-run-diff`.
2. End-to-end: open Claude Code in a git repo, edit 3 files, end the session → `select * from run_diffs where run_id = '<id>'` returns one row with `unified_diff` non-empty.
3. The run's auto-context-pack body contains a "## Diff" section.
4. Agent calls `query_run_diff` mid-session → returns structured payload.
5. Web-v2 `/runs/<id>/diff` renders the diff with syntax colors.
6. Killing the parse layer (e.g., delete `.git/`) → row inserted with `error='no_base_sha'`, tier-1 + auto-pack still succeed.
7. Zero `tree-sitter`, zero `web-tree-sitter`, zero `ANTHROPIC_API_KEY`, zero LLM-API references introduced anywhere.

## 10. Out of scope (for future modules)

- Bash-mediated edits (e.g. `sed -i`, `mv`) that don't surface as Edit/Write tool calls won't show in the diff. If this becomes a real gap, capture pre/post snapshots for shell-modifying commands.
- Cross-session diffs (e.g. "what changed across runs A, B, C combined"). Today each run gets its own row.
- Inline rendering of the diff in `apps/web/` (deprecated). The route lives in `apps/web-v2/` only.
