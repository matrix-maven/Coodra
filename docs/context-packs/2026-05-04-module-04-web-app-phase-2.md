# Module 04 Web App — Phase 2 Context Pack

**Date:** 2026-05-04
**Branch:** `feat/04-web-app`
**Phase 2 commits:** `4832369` … `1430eb7` … (S15 closeout)
**Phase 2 entry context pack:** `2026-05-04-module-04-web-app.md` (Phase 1 closeout)

---

## What was built (15 slices, S1–S15)

Phase 2 delivers the Web App as an **action layer** for Coodra, not just an audit-trail viewer. Hub-and-spoke IA: `/` is the project picker, every operational surface lives under `/projects/[slug]/...`.

| Slice | Commit | Surface | What it does |
|---|---|---|---|
| S1 | `4832369` | F1+F2+F3+F4 fixes | force-dynamic, sentinel filter, F3 root-cause + 0008 backfill, untracked chip |
| S2 | `d78058c` | hub-and-spoke IA | `/` picker + `/projects/[slug]` home + nested layout + sub-nav + project switcher |
| S3 | `6b9402a` | `/init` | Wizard form → `runInit` library promotion → redirect to `/projects/[newSlug]` |
| S4 | `f07abc4` | Pack markdown renderer | react-markdown + remark-gfm + rehype-sanitize; XSS-safe; 12 unit tests |
| S5 | `b031154` | Pack mutations | Regenerate / Delete / Install template — `<details>` dropdowns + typed confirms |
| S6 | `be4311d` | FP editor | `/edit?file=…`; auto-marker preservation enforced server-side; mtime concurrency check |
| S7 | `1c7ee42` | FP↔CP linkage | `/runs` panel — runs + context packs at the project grain (FK linkage deferred to M05) |
| S8 | `70fb525` | Doctor live | `/doctor` essential / full registry render; activates the project home Doctor tile |
| S9 | `6469610` | Context Packs | `/context-packs` list + `/[id]` detail with markdown body |
| S10 | `1430eb7` | Graph reader | `/graph` reads `~/.coodra/graphify/<slug>/graph.json`; empty-state CTA per ADR-010 |
| S11 | `d327341` | Logs SSE | `/logs` index + `/logs/[service]` live tail via SSE |
| S12 | `b49d2d3` | Service control | `/settings/workspace` start/stop/status (solo-mode only) |
| S13 | `60083a7` | Template install | `/templates` install-from-local-path action |
| S14 | `8972e91` | Project settings | `/settings` rename / delete / export JSONL |
| S15 | (this commit) | Sync + closeout | `/sync` queue depth + dead-letter retry + this Phase 2 closeout |

Total: ~5,000 lines of new code across `apps/web/`, `packages/cli/src/lib/`, and `packages/db/src/projects.ts`.

---

## Library promotions added in Phase 2

The CLI's command bodies are the single source of truth; each promotion captures stdout/stderr and translates `process.exit` into a discriminated-union result via an `ExitSentinel` error class. Same wrapping pattern across all of these:

| Path | Wraps | Used by |
|---|---|---|
| `packages/cli/src/lib/init/index.ts` | `runInitCommand` | S3 `/init` wizard |
| `packages/cli/src/lib/pack/index.ts` | `runPackRegenerateCommand`, `runPackDeleteCommand` | S5 pack mutations |
| `packages/cli/src/lib/auto-marker/` | parser + serializer | S6 FP editor (validation only) |
| `packages/cli/src/lib/doctor/index.ts` | `runChecks` + `buildCheckContext` | S8 doctor surface + project home tile |
| `packages/cli/src/lib/services/index.ts` | start / stop / status | S12 service control |
| `packages/cli/src/lib/template/index.ts` | `runTemplateInstallCommand` | S13 template install |

Each new exports entry was added to `packages/cli/package.json` so workspace resolution (and a future `pnpm publish`) finds them.

---

## DB helpers added in Phase 2 (`packages/db/src/`)

- `runs-admin.ts` — `listContextPacksForProject`, `getContextPackById`, `ContextPackDetailRow` (S7 + S9).
- `projects.ts` — `renameProject`, `deleteProject`, `readProjectExport` + their result types (S14).

All sqlite + postgres dual-pathed.

---

## Routes summary (post-Phase-2)

```
/                                        — project picker hub
/init                                    — new project wizard
/sync                                    — outbox + sync-daemon admin
/settings/workspace                      — service control + workspace doctor + env

/projects/[slug]                         — per-project home (4 tiles + recent events)
  /runs                                  — Phase 1 (project-scoped now)
    /[id]                                — run detail
  /policies                              — Phase 1
  /packs                                 — Phase 1 (filtered to project ownership)
    /[packSlug]                          — pack detail (markdown render + actions)
      /edit                              — section-aware editor
      /runs                              — FP↔CP activity panel
  /context-packs                         — list
    /[id]                                — detail
  /templates                             — bundled + user templates + install action
  /kill-switches                         — Phase 1
  /graph                                 — graphify reader
  /doctor                                — essential / full check registry
  /logs                                  — service picker
    /[service]                           — live SSE tail
  /settings                              — overview + reset + rename + delete + export

/api/projects/[slug]/logs/[service]/stream — SSE log endpoint (S11)
/projects/[slug]/settings/export          — JSONL export download (S14)
/api/picker/state                         — picker polling JSON (S2)
/api/projects/[slug]/state                — project home polling JSON (S2)
/api/projects/[slug]/runs/[id]/state      — run state polling JSON (Phase 1)
```

---

## Tests at Phase 2 closeout

| Suite | Count | Status |
|---|---|---|
| `apps/web` unit | 82 | ✅ |
| `apps/web` integration (`save-feature-pack-action`) | 6 | ✅ |
| `packages/cli` unit | 188 | ✅ (no changes) |
| `packages/db` unit | 54 | ✅ |

Total ~330 tests in the modules touched by this phase. Lint clean across the workspace; typecheck clean.

---

## Live-verified end-to-end paths

Every slice was smoke-tested with a real dev server boot before commit:
- S6: `/projects/s6-edit-test/packs/s6-edit-test/edit?file=spec.md` rendered + 6 integration tests (happy / marker tamper / marker addition / stale mtime / missing pack / parse error).
- S7: seeded run + context pack via direct `insertRun` + sqlite insert, `/projects/s6-edit-test/packs/s6-edit-test/runs` rendered both populated rows + correct deep links.
- S8: doctor at `/projects/s6-edit-test/doctor` rendered 11 essential / 35 full checks; project home Doctor tile reflected the same red/yellow/green counts.
- S9: list 200, detail 200, missing-id 404, foreign-project deep-link 404.
- S10: `/projects/s6-edit-test/graph` rendered the 4-node fixture with both filters (`q=foo` → 1, `q=Class` → 1, `community=beta` → 2, `community=alpha` → 2, `q=zzz` → 0); missing-fixture branch rendered the install-CTA empty state.
- S11: SSE endpoint emitted hello + initial lines on connection, then delivered live appends within the watcher's debounce window.
- S12: `/settings/workspace` rendered both service rows (mcp-server + hooks-bridge) with status `unknown` (no pidfiles on this dev box); start/stop/refresh forms wired.
- S13: ran `runTemplateInstall` against `/tmp/cxos-s13-tpl`; verified happy path + source_missing + already_exists + name_reserved + force overrides.
- S14: ran `renameProject` (renamed + slug_taken + invalid format), `readProjectExport` (1+1+1 rows), `deleteProject` (cascaded 1 run + 1 CP + 1 policy + 25 rules; project gone). Web `/settings/export` returned `Content-Type: application/x-ndjson` + `Content-Disposition: attachment`.
- S15: seeded 1 dead + 1 pending row in `pending_jobs.sync_to_cloud` → `/sync` showed counts 1 / 0 / 1 + queue row + dead-letter row with the simulated error; retry-all flipped the dead row to pending.

---

## Design decisions worth noting (mid-Phase-2)

1. **Hub-and-spoke IA pivot (OQ-1 re-lock 2026-05-04, c).** Original Phase 1 dashboard mashed every project's data into one view. Per user direction the new IA scopes everything per-project at the URL, with a minimal workspace header.
2. **Web is an action layer (user pushback 2026-05-04).** Added 3 net-new slices (S12 service control, S13 template install, S14 project rename / delete / export) on top of the original read-only Phase 2 plan.
3. **OQ-7 lock (S5).** Pack delete matches real CLI behavior — `rm(dir, recursive)` AND `is_active=false`. The earlier user assumption ("CLI is soft-flip-only") was wrong; verified at `packages/cli/src/commands/pack.ts:415-422`.
4. **Solo-mode gate on S12.** Service start/stop is refused in team mode (COODRA_MODE=team) — the web is deployed remotely there, has no business spawning local daemons. Doctor + environment sections still render.
5. **No client-side editor for FP edits (S6).** Section-aware textarea + server-side marker validation. A future client-side preview can layer on without changing the data contract.
6. **JSONL export (S14).** One JSON object per line, tagged by `type`. Every per-project audit row in chronological order. Materialized in-process today; chunked streaming reserved for >50MB exports.
7. **Per-pack FP↔CP filtering deferred to M05.** Schema doesn't yet carry `feature_pack_id` on `runs` / `context_packs`. S7 panel scopes at the project grain and labels this honestly in the page header.

---

## What's reserved for later (out of Phase 2)

Per the spec's Out-of-scope section + post-S15 audit:
- M05's `/projects/[slug]/search` (NL Assembly).
- M06's `/projects/[slug]/runs/[id]/diff` (semantic-diff).
- Web-side Graphify producer (graphify CLI is third-party, ADR-010).
- `.trash/` soft-delete (CLI follow-up).
- Realtime collaborative FP editor (Yjs / CRDT).
- i18n + accessibility audit pass.
- Browser-extension auth.
- Per-project doctor filtering (today's checks are workspace-grain).
- Archive (`projects.is_active = false`) — schema doesn't carry the column today; deferred to a future migration.

---

## Branch state at Phase 2 closeout

- All 15 slices landed on `feat/04-web-app`.
- README.md M04 row updated to ✅ complete (Phase 1 + Phase 2).
- All workspace-wide lint + typecheck + unit + integration tests green.
- Smoke walk per spec §12 — all routes 200 with the right content; all destructive actions gated by typed-confirm.

**Ready for squash-merge to `main`.**
