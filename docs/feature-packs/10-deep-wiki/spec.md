# Module 10 — Deep Wiki

> Agent-authored, DeepWiki-style hierarchical/mind-map explanation of a
> codebase. Coodra runs **no** LLM — the user's coding agent is the model.
> See **ADR-017** for the load-bearing decision.

## What it is

A **Deep Wiki** is a navigable, hierarchical explanation of a codebase — the
same idea as Cognition's DeepWiki (`github.com` → `deepwiki.com`) and the
open-source `AsyncFuncAI/deepwiki-open`. It is produced by a **two-pass,
schema-first** flow:

1. **Structure pass** — the agent reads a bounded grounding snapshot (file
   tree + README + manifests + optional Graphify graph) and plans a
   `WikiStructure`: a title/description and a list of pages, each with an
   `importance`, the source files it covers, a `parentId` (the hierarchy →
   the mind-map), cross-links, and a `wantsDiagram` flag. Pages may be grouped
   under `sections` (comprehensive mode) or left flat (concise mode).
2. **Content pass** — for each page, the agent reads its relevant files and
   authors Markdown (explanations + code citations + Mermaid diagrams).

## The Coodra adaptation

`deepwiki-open` runs its own Gemini/OpenAI pipeline + embeddings + RAG. Coodra
does not. OpenWiki-style workflows are reference inspiration for update
semantics, portable bundles, and agent instructions — not a second wiki engine.
The coding agent the user already has (Claude Code / Codex / Cursor), wired to
the Coodra MCP, **is the model.** Coodra ships:

| Layer | What |
| --- | --- |
| Schema | `@coodra/shared/wiki` — `WikiStructure`/`WikiSection`/`WikiPage`/`WikiPageContent` (Zod, referential-integrity `superRefine`). |
| Persistence | 3 MCP tools: `wiki_save_structure` (pass 1, writes a pending page skeleton), `wiki_save_page` (pass 2, authors one page), `wiki_status` (progress / resume). Manifest 17 → 20. |
| CLI | `coodra wiki build\|status\|list\|open\|clean`. `build` writes `.coodra/wiki/{grounding.md,job.json,job.md}`, scaffolds `.coodra/wiki/<slug>/` for the repo-local Markdown mirror, reserves `.coodra/wiki/okf/`, records generated artifacts in `.coodra/manifest.json`, and hands off to the bundled `deep-wiki-author` skill. `generate` remains a deprecated alias during transition. |
| Web | `/wiki` + `/wiki/[id]` — mind-map nav + Markdown (react-markdown + remark-gfm) + Mermaid. |
| Grounding | Optional Graphify graph summary (communities → sections; god-nodes → important pages). |

This mirrors ADR-012/013/015/016: **ship intelligence as records and recipes,
not as a service.** No new secrets, no embeddings infra, air-gap-friendly. The
Coodra DB/web wiki remains canonical. The Markdown under `.coodra/wiki/<slug>/`
is a mirror written only after successful MCP saves, useful for review,
diffing, and export. OKF is a portability/import-export format, not the source
of truth.

## Data model

- `wikis` — one row per generated wiki, keyed `(project_id, slug)`.
  `structure_json` holds the validated `WikiStructure` envelope. A re-plan
  (same slug) replaces the row and DELETE-then-INSERTs its page skeleton
  (mirrors `run_diffs` idempotency).
- `wiki_pages` — one row per page. `wiki_save_structure` inserts the skeleton
  (every page `state='pending'`, empty body); `wiki_save_page` flips a page to
  `state='authored'` with its Markdown + citations.

Both tables are dual-dialect (SQLite + Postgres, schema-parity-tested) and
team-synced (push dispatch `syncWikis`/`syncWikiPages` + `team-rows-puller`
`pullWikis`/`pullWikiPages` + handler enqueues guarded by `COODRA_MODE`), so a
wiki authored on the admin's machine renders cross-machine. DB-primary: the web
reads the DB (local SQLite solo / cloud Postgres team), like decisions/runs.

## Agent flow (what `coodra wiki build` sets up)

```
coodra wiki build              the agent                         coodra web /wiki/<id>
  writes .coodra/wiki/grounding.md     get_run_id                  mind-map rail
  writes .coodra/wiki/job.md  ───────▶ read grounding (+ graphify) ─▶  + page markdown
  scaffolds .coodra/wiki/<slug>/      wiki_save_structure (pass 1)     + mermaid svg
  bundles deep-wiki-author Feature    mirror structure.json after save
                                      wiki_save_page × N (pass 2)
                                      mirror <pageId>.md after save
                                      wiki_status (resume)
```

The structure pass is deliberately dynamic. Following the strongest part of
OpenWiki's approach, the recipe asks the agent to make a discovery plan before
saving structure: inspect source evidence, identify real domains/workflows,
list candidate pages with their source anchors, model concept relationships,
and only then choose sections. Following the weaker part of DeepWiki-Open, the
recipe keeps structured output (`pages`, `sections`, `importance`,
`relevantFiles`, `relatedPageIds`) but avoids seeding a fixed comprehensive
section list. Generic labels such as "Overview", "Architecture",
"Configuration", "Data Model", "Integrations", "Testing", and "Operations" are
allowed only when the codebase earns them.

Quality rules from that review are part of the generated job:

- sections represent real documentation areas, not generic buckets;
- broad pages with headings are preferred over stub pages;
- single-page sections are allowed only for strong domain boundaries;
- substantive pages should have evidence-backed relationships to other pages;
- Graphify communities are candidate domains, not automatic pages.

## OKF portability plan

Coodra Wiki remains DB-canonical. OKF support is a portability layer, inspired
by OpenWiki and Google Open Knowledge Format, and must not become a parallel
wiki store. `coodra wiki build` reserves `.coodra/wiki/okf/` for import/export
bundles and records that workspace in `.coodra/manifest.json`.

Planned commands:

- `coodra wiki export --format okf [--slug <slug>] [--out <path>]` — read
  `wikis` + `wiki_pages` from the Coodra DB and materialize an OKF-compatible
  Markdown bundle under `.coodra/wiki/okf/<slug>/` by default.
- `coodra wiki import <path> [--slug <slug>]` — parse an OKF/wiki bundle and
  persist it through the same validated Coodra wiki schema used by
  `wiki_save_structure` / `wiki_save_page`.

Both commands must preserve the invariant that `/wiki` reads from Coodra DB, not
from the Markdown mirror or exported bundle.

## Out of scope (deferred)

- DeepWiki's **"Ask the wiki" RAG chat** — a later phase; it needs the wiki to
  exist first and is a separate retrieval surface.
- Auto-minting wikis from Graphify communities — Graphify is a *grounding
  input*, not a wiki source (same lesson as ADR-015 for Feature Packs).
- Installing OpenWiki or writing root-level `openwiki/`, `AGENTS.md`, or
  provider secret files — Coodra keeps one wiki implementation.
