# 04 — When In Doubt (research vs. ask)

Uncertainty is normal. What matters is resolving it with the right source. Follow this order.

## 4.1 Architecture / design uncertainty

1. Re-read the relevant section of `system-architecture.md`.
2. Check `docs/context-packs/` for a prior decision on the same topic.
3. Call `coodra__search_packs_nl` with the problem description.
4. Call `coodra__query_run_history` for recent related work.
5. If **still uncertain, ask the user.** Do not guess. Record the open question in `context_memory/open-questions.md` so the resolution becomes durable.

## 4.2 Latest library or API mechanics

1. Check `External api and library reference.md` for the pinned version and snippet.
2. Run `npm view <pkg> version` (or `pip index versions <pkg>`) locally to confirm the currently-published latest.
3. Fetch the library's official docs page online and verify the API shape.
4. Update `External api and library reference.md` with any new findings (gotchas, version bumps) in the same change.
5. If the API has changed in a breaking way, flag it in `context_memory/decisions-log.md` and ask the user whether to upgrade or pin.

## 4.3 Third-party API behaviour not in the reference

1. Read the provider's official docs online (e.g., `docs.github.com`, `developer.atlassian.com`, `platform.openai.com`).
2. Check for recent deprecations or behaviour changes.
3. Record the verified behaviour back in `External api and library reference.md` as a new subsection or gotcha.
4. Never assume from a training-data snapshot. Always verify.

## 4.4 When to research online (always) vs ask the user (always)

- **Research online (no need to ask):** library versions, API shapes, doc URLs, published examples, deprecation notices, error-code semantics, rate-limit behaviours.
- **Ask the user (do not research or guess):** which provider to use when multiple are viable, which tier/paid plan to pick, whether to ship a feature now vs. defer, whether to accept a breaking change, destructive operations, anything from `02-agent-human-boundary.md` §2.2.

## 4.5 Before writing a verification or e2e plan that boots a binary against Postgres

Closes verification finding F11 (`docs/verification/2026-04-27-module-01-02-03-verification.md`).

`apps/mcp-server` and `apps/hooks-bridge` are SQLite-only by design — both unconditionally call `createDb({ kind: 'local' })`. There is no env knob, no flag, no boot path that yields a Postgres handle (M03 S4 explicitly removed `COODRA_DB_OVERRIDE_MODE`). Before authoring a verification step or test that says "boot the binary against Postgres," confirm by reading `apps/*/src/lib/db.ts`. If the apps you're targeting still pass `kind: 'local'`, the cloud-write path lives only in `@coodra/db::createDb({ kind: 'cloud' })` and is exercised through the package's own integration tests.
