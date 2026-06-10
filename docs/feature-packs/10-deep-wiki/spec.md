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
does not. The coding agent the user already has (Claude Code / Codex / Cursor),
wired to the Coodra MCP, **is the model.** Coodra ships:

| Layer | What |
| --- | --- |
| Schema | `@coodra/shared/wiki` — `WikiStructure`/`WikiSection`/`WikiPage`/`WikiPageContent` (Zod, referential-integrity `superRefine`). |
| Persistence | 3 MCP tools: `wiki_save_structure` (pass 1, writes a pending page skeleton), `wiki_save_page` (pass 2, authors one page), `wiki_status` (progress / resume). Manifest 17 → 20. |
| CLI | `coodra wiki generate\|status\|list\|open\|clean`. `generate` writes the grounding snapshot + the authoring recipe and scaffolds a `deep-wiki-author` Feature. |
| Web | `/wiki` + `/wiki/[id]` — mind-map nav + Markdown (react-markdown + remark-gfm) + Mermaid. |
| Grounding | Optional Graphify graph summary (communities → sections; god-nodes → important pages). |

This mirrors ADR-012/013/015/016: **ship intelligence as records and recipes,
not as a service.** No new secrets, no embeddings infra, air-gap-friendly.

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

## Agent flow (what `coodra wiki generate` sets up)

```
coodra wiki generate           the agent                         coodra web /wiki/<id>
  writes .coodra/wiki-grounding.md     get_run_id                  mind-map rail
  writes .coodra/wiki-job.md  ───────▶ read grounding (+ graphify) ─▶  + page markdown
  scaffolds deep-wiki-author          wiki_save_structure (pass 1)     + mermaid svg
  Feature                             wiki_save_page × N (pass 2)
                                      wiki_status (resume)
```

## Out of scope (deferred)

- DeepWiki's **"Ask the wiki" RAG chat** — a later phase; it needs the wiki to
  exist first and is a separate retrieval surface.
- Auto-minting wikis from Graphify communities — Graphify is a *grounding
  input*, not a wiki source (same lesson as ADR-015 for Feature Packs).
