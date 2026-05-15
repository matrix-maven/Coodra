# Context Pack Template

> Save a copy of this file as
> `docs/context-packs/YYYY-MM-DD-module-NN-<short-title>.md` at the
> end of every session and fill in the placeholders below. Once the
> markdown body is final, also call `coodra__save_context_pack`
> with the same body so the MCP server can retrieve it semantically
> from a future session.

---

## Header

- **Date:** YYYY-MM-DD
- **Module:** NN — <module title>
- **Feature Pack:** `docs/feature-packs/NN-<slug>/`
- **Session lead (human):** <name / handle>
- **Run ID:** <run-key if one was generated for this session>
- **Branch at session start:** <branch>
- **Branch at session end:** <branch>
- **Commits landed this session:** <short hashes, newest first>

## Outcome

Two or three sentences describing what changed in the product at the
end of the session. Written in the past tense, for a future
contributor who did not attend. No aspirational language — only what
is actually on `main` (or on a named feature branch).

## Scope boundary

What was **in scope** and what was explicitly **deferred**. Cite the
Feature Pack acceptance criteria (AC-*) each bullet maps to. This
section exists so the next session knows where the work stops.

## Decisions made

Bullet list of non-trivial decisions taken during the session. Each
bullet:

- **Decision:** short declarative sentence.
- **Rationale:** one line — why this was chosen over the alternative.
- **Alternatives considered:** the next best option and why it was
  not picked.
- **Cross-reference:** pointer to `context_memory/decisions-log.md`
  entry (if any) or the commit that enacts it.

If a decision revises a prior one, mark it **(supersedes <old
decision>)** and update the old decision log entry.

## Files touched

Grouped by package. For each file, one-line verb about what happened
(created / updated / removed / generated).

- `packages/shared/src/logger.ts` — created (pino singleton + createLogger)
- `packages/db/drizzle/sqlite/0000_*.sql` — generated (5-table core)
- …

## Tests

- **Added:** `path/to/new.test.ts` — one-line summary of what it asserts.
- **Modified:** `path/to/existing.test.ts` — why.
- **Removed:** none (removal requires explicit user sign-off per
  testing discipline).
- **Verification commands run locally:**

  ```bash
  pnpm lint
  pnpm typecheck
  pnpm test:unit
  pnpm test:integration   # if applicable
  ```

- **CI status at session end:** passing on `<branch>` / `<commit>`
  — link to the workflow run if possible.

## Open questions

Questions that came up during the session and are **not** yet answered.
If an answer landed before the session ended, move it to "Decisions
made" and delete the bullet here.

- Question body. Owner: <who needs to answer>. Blocks: <what it
  blocks>.

## Pending user actions

Any manual steps the user must perform outside the agent loop. These
belong here and in `context_memory/pending-user-actions.md`. Examples:
"add `GITHUB_TOKEN` secret to the repo", "accept the pgvector
extension on Supabase", "rotate the Clerk publishable key".

## Handoff to next session

The single most important section. Three sub-bullets:

- **Starting state.** One sentence. What does `pnpm install && pnpm
  test:unit` currently produce on `main`?
- **Next concrete step.** One imperative sentence. What is the
  immediate next work item? Cite the Feature Pack section.
- **Entry point.** File or function where the next change lands.

If the module is complete, this section reads:

> Module NN complete. Next session: start Module NN+1 per
> `module-wise plan.md` and the Feature Pack at
> `docs/feature-packs/<NN+1>-<slug>/`.

## References

- Feature Pack: `docs/feature-packs/NN-<slug>/spec.md` §…
- Architecture: `system-architecture.md` §…
- Style / discipline: `essentialsforclaude/…`
- External reference pins: `External api and library reference.md`
  (any version bumps this session landed in the same commit as the
  code that required them).
