# Context Pack — Module 10: Deep Wiki

**Date:** 2026-06-06
**Module:** 10 — Deep Wiki (agent-authored codebase wiki)
**Decision of record:** ADR-017
**CLI version:** `0.2.0-beta.21`
**MCP manifest:** 17 → **20 tools**

## What was built

A DeepWiki-style hierarchical/mind-map explanation of a codebase, where the
user's coding agent (Claude Code / Codex / Cursor) **is the model** and Coodra
ships the schema + persistence + render. Coodra runs no LLM/embeddings
(ADR-017; same thesis as ADR-012/013/015/016). Two-pass, schema-first flow:
structure pass → per-page content pass, with Mermaid diagrams + code citations.

### Phase 1 — Schema (`@coodra/shared/wiki`)
- `packages/shared/src/wiki/schema.ts` — `WikiStructure` / `WikiSection` /
  `WikiPage` / `WikiPageContent` (Zod). A `superRefine` enforces referential
  integrity (unique page/section ids; `parentId` / `relatedPageIds` / section
  `pageIds` / `subsectionIds` must reference existing ids; no self-parenting),
  so a malformed plan is rejected at the MCP boundary.
- `packages/shared/src/wiki/paths.ts` — disk-path helpers (`docs/wiki/<slug>/`,
  `.coodra/wiki-job.json`).
- `packages/shared/src/wiki/index.ts` + new `./wiki` subpath export.
- Tests: `__tests__/unit/wiki/{schema,paths}.test.ts` (25 tests).

### Phase 2 — DB (`@coodra/db`)
- `wikis` (structure envelope) + `wiki_pages` (per-page content/state) added to
  `schema/sqlite.ts` + `schema/postgres.ts` (dual-dialect, column-for-column).
- Migrations `drizzle/sqlite/0017_wikis.sql` + `drizzle/postgres/0019_wikis.sql`.
  **Note:** the drizzle generator re-emitted the hand-written 0014–0018 objects
  (its snapshots were stale); the generated SQL was hand-cleaned to wiki-only,
  and the new snapshots now capture all 16 tables — fixing the drift for future
  `db:generate`.
- Schema-parity 14→16; client logical-table-count 15→17.
- `packages/db/src/wikis.ts` — read helpers `listWikisDetailed` /
  `getWikiDetail` (for the web), exported from the package index.
- Tests: `__tests__/unit/wiki-roundtrip.test.ts` (5 — insert, author, uniqueness,
  cascade, project-slug uniqueness). 74 db tests green.

### Phase 3 — MCP tools (`apps/mcp-server`)
- `wiki_save_structure` (pass 1; upsert by project+slug, writes pending page
  skeleton), `wiki_save_page` (pass 2; authors one page), `wiki_status`
  (read-only progress / resume). `lib/wiki-store.ts` holds the shared
  dialect-dispatch DB logic.
- Output schemas use `z.union` (not `discriminatedUnion`) because Zod v4 rejects
  multiple `ok:false` branches sharing the discriminator.
- Registered in the barrel; inventory tests updated 17→20 (boot.test.ts,
  manifest-e2e, stdio-roundtrip).
- Tests: `__tests__/unit/tools/wiki-tools.test.ts` (manifest + schema) +
  `__tests__/integration/tools/wiki-flow.test.ts` (7 — full structure→author→
  status flow, re-plan, all soft-failures, and the team-mode sync enqueue).

### Phase 4 — CLI (`@coodra/cli`)
- `commands/wiki.ts` — `coodra wiki generate|status|list|open|clean`.
- `lib/wiki/grounding.ts` — bounded snapshot (file tree + README + manifests +
  optional Graphify graph summary). `lib/wiki/recipe.ts` — the two-pass
  authoring recipe + `deep-wiki-author` Feature frontmatter/body.
- `generate` writes `.coodra/wiki-grounding.md` + `.coodra/wiki-job.{json,md}`
  and scaffolds `docs/features/deep-wiki-author/feature.md`.
- Registered in `program.ts`; `program.test.ts` + help snapshot updated.
- Tests: `__tests__/unit/commands/wiki.test.ts` (grounding, recipe, generate,
  DB-backed status/list/clean). 523 cli tests green.

### Phase 5 — Web (`apps/web-v2`)
- `lib/queries/wiki.ts` (validates `structure_json` via the shared schema).
- `app/wiki/page.tsx` (list grouped by project) + `app/wiki/[wikiId]/page.tsx`.
- `components/wiki/WikiReader.tsx` (client; mind-map nav + react-markdown +
  remark-gfm + Mermaid code override) + `components/wiki/Mermaid.tsx` (client;
  dynamic-import mermaid, dark theme, raw-fallback) + `WikiReader.module.css`.
- Added deps: `react-markdown@10`, `remark-gfm@4`, `mermaid@11`.
- `Sidebar.tsx` — "Deep Wiki" in the Knowledge group. `next build`: both routes
  compile (`/wiki/[wikiId]` 45.5 kB incl. the Mermaid client bundle). 43 web
  tests green.

### Phase 6 — Team-mode cloud sync
- `SyncTableName` (+`wikis`, `wiki_pages`); dispatch push `syncWikis` /
  `syncWikiPages` (ON CONFLICT DO UPDATE, parent-ensure chain); team-rows-puller
  `pullWikis` / `pullWikiPages` (cloud-newer-wins). Handler enqueues guarded by
  `COODRA_MODE==='team'`. `authorWikiPage` now returns the page row id (the
  sync key).

### Phase 7 — Verify + docs + artifact
- **Verify:** typecheck 13/13, lint clean, `pnpm test:unit` 13/13 packages green.
- **Docs:** ADR-017; decisions-log entry; system-architecture §24 (17→20) + §22
  cross-ref; README (×2); implementation-order Module 10 row; trigger-contract
  §5.10b; this feature-pack `docs/feature-packs/10-deep-wiki/{spec.md,meta.json}`.
- **Artifact:** bumped `0.2.0-beta.21`; rebuilt web standalone + CLI bundle;
  `prepublish-assert` ok; bundled-binary smoke (`coodra wiki generate` writes
  all artifacts; `0017_wikis`/`0019_wikis` ship in `dist/runtime/drizzle`).

## Decisions made
- Agent is the model; Coodra runs no LLM (ADR-017). Rejected the deepwiki-open
  shape (own LLM + embeddings + RAG).
- `z.union` for multi-soft-failure MCP outputs (Zod v4 constraint).
- DB-primary; the web reads the DB. Re-plan replaces the wiki (DELETE-then-
  INSERT skeleton).
- "Ask the wiki" RAG chat deferred to a later phase.

## Known limitations / follow-ups
- **Team cloud round-trip needs live Postgres validation.** The push dispatch +
  puller mirror the proven features/decisions sync and are typechecked + unit-
  tested at the enqueue level, but the full laptop-team round-trip needs the
  sync-daemon integration tests (testcontainers Postgres) — run them against a
  live DB to confirm end-to-end.
- A re-plan leaves orphan `wiki_pages` rows in cloud for pages dropped from the
  new structure; they are invisible to the render (nav is built from
  `structure_json`). Harmless; a cloud GC pass is a possible follow-up.
- "Ask the wiki" Q&A (deferred).

## Pending user action
- **Publish the CLI:** `cd packages/cli && npm publish --tag beta --access public
  --otp=<code>` to ship `@coodra/cli@0.2.0-beta.21` (agent must not run this —
  npm account + 2FA OTP is a user action).
- (Optional) Run the sync-daemon integration tests against a live Postgres to
  validate the team round-trip.
