# Module 04 Phase 2 — Web App completion — Implementation

> Slice-by-slice work breakdown for the Phase 2 portion of `feat/04-web-app`. Read `spec.md` first for scope and `techstack.md` for the new runtime/dep choices (markdown renderer + react-flow). Decisions made mid-implementation get logged in `context_memory/decisions-log.md` and mirrored to the MCP via `coodra__record_decision`.

> **Re-authored 2026-05-04** after user IA pivot (OQ-1 re-locked from dropdown to hub-and-spoke). The original 11-slice plan that nested route migration as a single S2 has been reshaped into 14 slices (S2-S15) with the IA migration broken into S2a/b/c sub-commits.

## Prerequisites (one-time, before S2)

- ✅ Module 04 Phase 1 fully landed on `feat/04-web-app` through commit `adda4b5` (S11 closeout).
- ✅ Phase 2 S1 landed (`4832369`): F1 force-dynamic + F2 sentinel filter + F3 root-cause + 0008 backfill + F4 Untracked chip. All workspace-wide tests green (592 / 592). Live verified.
- ✅ Phase 2 spec re-authored for hub-and-spoke IA (this turn). 9 OQs locked; OQ-1 re-locked from (a) dropdown → (c) hub-and-spoke per user direction 2026-05-04.
- ✅ User signed off on the IA pivot + URL nesting + 3 new action-layer slices + targeted project-table cleanup.

**Outstanding before S2:**
- Targeted-delete the 4 `cxos-*` test projects from SQLite (S2 prerequisite — verifying the new IA against a clean project set).

## Slice sequence

### S1 — DONE (commit `4832369`)

F1 + F2 + F3 root-cause + 0008 backfill + F4. See commit body for details.

---

### S2 — IA migration: hub-and-spoke (S2a + S2b + S2c, three readable commits within one slice)

**Why three commits.** S2a is a mass route-rename; S2b builds the new hub + project home; S2c rewires the nav. Splitting them keeps each diff scannable at PR review time. Commits land on `feat/04-web-app` in order; the slice closes when all three are green.

**Why a single slice (not three slices).** Each individual commit is a "broken intermediate state" in the URL space — only when all three land is the IA coherent. We treat the slice as one unit at the project level + three units at the git history level.

#### S2a — Route filesystem migration

**Files moved (`git mv`):**

```
apps/web/app/runs/                       → apps/web/app/projects/[slug]/runs/
apps/web/app/policies/                   → apps/web/app/projects/[slug]/policies/
apps/web/app/projects/[id]/              → apps/web/app/projects/[slug]/settings/   (rename of dynamic segment + page rename)
apps/web/app/projects/page.tsx           → DELETE (moves to / picker in S2b)
apps/web/app/packs/                      → apps/web/app/projects/[slug]/packs/
apps/web/app/templates/                  → apps/web/app/projects/[slug]/templates/
apps/web/app/kill-switches/              → apps/web/app/projects/[slug]/kill-switches/
apps/web/app/api/runs/[id]/state/        → apps/web/app/api/projects/[slug]/runs/[id]/state/
```

**Files modified (URL refs + queries):**

- `apps/web/components/HeaderNav.tsx` — defer the new two-state design to S2c; for S2a just update existing nav links to use the new URLs (we'll have a default project slug for the legacy /runs etc. — actually no, since hub-and-spoke means there IS no "default" project for top-level. Update HeaderNav to point to `/` only in S2a; project sub-nav arrives in S2c.)
- All page.tsx files in moved directories — extract `slug` from `params`, look up the project, gate to 404 if not found, pass projectId into queries.
- `apps/web/lib/queries/{dashboard,runs,policies,projects,packs,kill-switches,templates}.ts` — every list query takes `projectSlug: string` (required; throws if not provided) and filters at SQL level.
- `apps/web/lib/actions/{policies,projects,kill-switches}.ts` — Server Actions take `projectSlug` as a hidden form field; redirect targets become `/projects/[slug]/...`.
- `apps/web/__tests__/` — every test that hits a moved URL gets its path updated.

**Acceptance (S2a):**
- `pnpm typecheck` clean across the workspace.
- `pnpm test:unit` green (existing tests adapted to new URLs).
- `pnpm build` shows the new tree in `.next/server/app/projects/[slug]/...`.
- `curl http://127.0.0.1:3000/projects/coodra-dev/runs` returns 200; `curl http://127.0.0.1:3000/runs` returns 404 (clean break, no redirect).

**Single commit:** `feat(web): M04 Phase 2 S2a — migrate operational routes under /projects/[slug]/* (clean break, no redirects)`.

#### S2b — Project picker hub (`/`) + per-project home (`/projects/[slug]`)

**New files:**

- `apps/web/app/page.tsx` — replace existing dashboard with project picker. Renders cards. Reads `listProjects()` (already filters `__global__` per S1's F2 fix). Search box (client-side filter on slug+name). Sort dropdown (last-activity / name / created-at). Tile aggregates: per-project counts via a new `getProjectAggregates(slug): {activeRuns, denials24h, activePauses, doctorRedYellow, lastActivityAt}` query.
- `apps/web/app/projects/[slug]/page.tsx` — per-project dashboard. 4 tiles + latest 10 events scoped to project + project info sidebar. Replaces the cross-project dashboard from Phase 1.
- `apps/web/app/api/picker/state/route.ts` — JSON for picker polling (5000ms cadence). Returns array of `{slug, name, activeRuns, denials24h, activePauses, lastActivityAt, statusDot}`.
- `apps/web/app/api/projects/[slug]/state/route.ts` — JSON for project home polling (1500ms). Returns the snapshot the page renders.
- `apps/web/lib/queries/picker.ts` — `getPickerSnapshot()` aggregates per-project counts in a single SQLite query (LEFT JOIN runs / policy_decisions / kill_switches per project).
- `apps/web/lib/queries/project-home.ts` — `getProjectHomeSnapshot(slug)` returns the 4 tile values + latest events.
- `apps/web/components/ProjectCard.tsx` — the card UI per the spec §7.3 sketch.
- `apps/web/components/StatusDot.tsx` — small colored circle (green/amber/red/gray).
- `apps/web/components/glyphs/EmptyProjects.tsx` — SVG illustration for the picker's empty state.

**Files modified:**

- `apps/web/app/layout.tsx` — wrap children with new HeaderNav contract (S2c shapes the actual nav; S2b just stubs).

**Acceptance (S2b):**
- `/` renders cards for `coodra-dev` + `coodra` (post-cleanup state).
- `/projects/coodra-dev` renders 4 tiles + the live event stream for that project only.
- `/projects/nonexistent-slug` returns 404 (not 500).
- Both pages declare `dynamic = 'force-dynamic'`.

**Single commit:** `feat(web): M04 Phase 2 S2b — project picker hub at / + per-project home at /projects/[slug]`.

#### S2c — HeaderNav (two-state) + ProjectSubNav

**Files modified:**

- `apps/web/components/HeaderNav.tsx` — accepts `currentProjectSlug?: string`. When undefined, renders top-level nav (brand · "Projects" highlight · user menu). When set, renders project-scoped nav (brand → projects switcher button · project name + status dot · user menu).
- `apps/web/app/layout.tsx` — extract `currentProjectSlug` from the URL pathname (server-side via headers().get('x-pathname') or middleware-injected header).
- `apps/web/middleware.ts` — set `x-pathname` request header so the layout knows the active project. (Pattern: middleware can mutate request headers Next.js sees.)

**New files:**

- `apps/web/components/ProjectSubNav.tsx` — secondary nav row (Runs · Policies · Packs · Context Packs · Templates · Kill switches · Graph · Doctor · Logs · Settings). Lives in `/projects/[slug]/layout.tsx` (a new nested layout).
- `apps/web/app/projects/[slug]/layout.tsx` — wraps every project-scoped page with ProjectSubNav + project name header.
- `apps/web/components/ProjectsSwitcher.tsx` — dropdown that lists every project + "All projects (back to /)" + "+ New project (→ /init)".

**Acceptance (S2c):**
- At `/`: HeaderNav shows brand + Projects + user menu only. No sub-nav.
- At `/projects/coodra-dev/...`: HeaderNav shows brand + projects switcher + project name. ProjectSubNav row appears below with "Runs" highlighted (when at `/projects/coodra-dev/runs`).
- Switcher dropdown changes URL to `/projects/[newSlug]/<same tail>` if same tail exists, else `/projects/[newSlug]`.

**Single commit:** `feat(web): M04 Phase 2 S2c — two-state HeaderNav + ProjectSubNav + nested layout`.

**Slice S2 closes** when all three commits land + smoke walk passes.

---

### S3 — `/init` wizard

**Files added:**

- `apps/web/app/init/page.tsx` — wizard form. Fields: project slug (regex `^[a-z0-9-]{1,64}$`), IDE (claude/cursor/windsurf/all checkboxes), template (dropdown of bundled templates + "none — minimal"), `--no-graphify` checkbox.
- `apps/web/lib/actions/init.ts::initProjectAction(formData)` — Server Action. Validates form. Calls `runInit({...})` from `packages/cli/src/lib/init/run.ts`. On success, `redirect(/projects/[newSlug])`. On validation failure, re-renders with field errors.
- `packages/cli/src/lib/init/index.ts` — re-export `runInit` for the web (library promotion). CLI's existing `init` command becomes a thin wrapper.
- `apps/web/__tests__/integration/init-wizard.test.ts` — round-trip with valid + invalid inputs.

**Acceptance:**
- Successful submit redirects to `/projects/<newSlug>` with a success banner.
- Failed submit re-renders the form with field-level errors; no DB writes happened.
- Slug regex matches the CLI's validator exactly.
- The new project appears in the picker on `/`.

**Single commit:** `feat(web,cli): M04 Phase 2 S3 — /init wizard + runInit library promotion`.

---

### S4 — `/projects/[slug]/packs/[slug]` markdown renderer (read-only)

**Files modified:**

- `apps/web/app/projects/[slug]/packs/[slug]/page.tsx` — replace `<pre>{markdown}</pre>` with `<MarkdownRenderer>`. No mutations yet (S5 adds them).

**Files added:**

- `apps/web/components/MarkdownRenderer.tsx` — Server Component wrapping react-markdown + remark-gfm + rehype-sanitize. Maps GFM elements to brand-token classes.
- `apps/web/__tests__/unit/markdown-renderer-xss.test.ts` — hostile fixtures.
- `apps/web/__tests__/__fixtures__/markdown-xss.md`.

**Acceptance:**
- Pack detail renders styled HTML (headings, lists, code blocks, tables) — brand-consistent.
- All XSS hostile fixtures rendered as inert.
- Bundle increase: ~28KB gzipped, route-gated.

**Single commit:** `feat(web): M04 Phase 2 S4 — pack markdown renderer (read-only)`.

---

### S5 — `/projects/[slug]/packs/[slug]` mutations (regenerate / delete / install) — RE-LOCK OQ-7

**Re-lock checkpoint:** before any disk-write code lands in this slice, confirm OQ-7 with the user. Default = match real CLI (rm + soft-flip is_active). User can override.

**Files modified:**

- `apps/web/app/projects/[slug]/packs/[slug]/page.tsx` — add header action bar (Regenerate / Delete / Install template). Each opens a typed-confirm dialog.

**Files added:**

- `apps/web/lib/actions/packs.ts::regeneratePackAction(formData)` — wraps `runPackRegenerate` (library promotion).
- `apps/web/lib/actions/packs.ts::deletePackAction(formData)` — wraps `runPackDelete` (rm + soft-flip).
- `apps/web/lib/actions/packs.ts::installTemplateAction(formData)` — wraps `runInit({mode:'default', template:<name>, force:true, projectSlug:<slug>})`.
- `packages/cli/src/lib/pack/regenerate.ts`, `packages/cli/src/lib/pack/delete.ts` — library promotions (CLI commands become thin wrappers).
- `apps/web/__tests__/integration/pack-mutations.test.ts` — round-trip.

**Acceptance:**
- Regenerate preserves user-edited unmanaged sections; replaces auto-managed sections.
- Delete confirms via "Type 'delete <slug>' to confirm"; on confirm removes dir + flips is_active=false. Row preserved per ADR-007.
- Install confirms via "Type 'install <name>' to confirm"; applies template overlay.

**Single commit:** `feat(web,cli): M04 Phase 2 S5 — pack mutations matching CLI semantics`.

---

### S6 — `/projects/[slug]/packs/[slug]/edit` feature pack editor

**Files added:**

- `apps/web/app/projects/[slug]/packs/[slug]/edit/page.tsx` — two-pane editor (textarea + live preview).
- `apps/web/lib/actions/packs.ts::saveFeaturePackAction(formData)` — Server Action. Validates marker contract; writes file; revalidates.
- `apps/web/lib/feature-pack-markers.ts` — `parseMarkers` / `serializeMarkers` pure helpers.
- `apps/web/__tests__/unit/feature-pack-markers.test.ts` — round-trip + tamper detection.

**Acceptance:**
- Editor loads spec/implementation/techstack source files; preview updates live (debounced 300ms).
- Saving with markers intact succeeds; tampered markers return structured error + inline diff.
- Concurrent edit (updated_at bumped by another writer) returns 409 + "View latest" link.

**Single commit:** `feat(web): M04 Phase 2 S6 — section-aware feature pack editor`.

---

### S7 — `/projects/[slug]/packs/[slug]/runs` FP↔CP linkage panel

**Files added:**

- `apps/web/app/projects/[slug]/packs/[slug]/runs/page.tsx` — Server Component. Lists CPs whose `featurePackId` matches + Runs whose `projectSlug` matches the pack's project.
- `apps/web/lib/queries/pack-runs.ts::listRunsForPack(slug)` — joins feature_packs + context_packs + runs.
- `apps/web/__tests__/unit/list-runs-for-pack.test.ts`.

**Acceptance:**
- Page renders Context Packs section (sortable by `created_at`) + Runs section (sortable by `started_at`).
- Empty states for both with brand glyph + CTA.
- Each row links to `/projects/[slug]/runs/[id]` or `/projects/[slug]/context-packs/[id]`.

**Single commit:** `feat(web): M04 Phase 2 S7 — FP↔CP linkage panel`.

---

### S8 — `/projects/[slug]/doctor` + dashboard tile activation

**Files added:**

- `apps/web/app/projects/[slug]/doctor/page.tsx` — Server Component shell + `DoctorLiveClient` client child (polls 3000ms via `usePoll`).
- `apps/web/app/api/projects/[slug]/doctor/state/route.ts` — calls `runDoctorRegistry({projectScoped: true, slug})` and returns JSON.
- `apps/web/components/DoctorLiveClient.tsx` — renders rows + "Re-run all" button.
- `packages/cli/src/lib/doctor/registry.ts` — library promotion of the existing 35-check registry. `runDoctorRegistry(opts)` returns structured check report.

**Files modified:**

- `apps/web/lib/queries/project-home.ts::getProjectHomeSnapshot(slug)` — call `runDoctorRegistry({summary: true, projectScoped: true, slug})` to populate the project-home doctor tile (replaces the Phase 1 stub).

**Acceptance:**
- `/projects/[slug]/doctor` renders 35 rows; status icons match.
- Project-home doctor tile shows red+yellow counts (or "0/0" green) for THIS project's checks.
- `/settings/workspace` doctor (S12) reuses the same library entry for workspace-scoped checks.
- Polling pauses when tab hidden.

**Single commit:** `feat(web,cli): M04 Phase 2 S8 — /projects/[slug]/doctor + dashboard tile activation`.

---

### S9 — `/projects/[slug]/context-packs` list + `/projects/[slug]/context-packs/[id]` detail

**Why S9 (was implicit in Phase 1 as a tab inside `/runs/[id]`).** User pushback: CPs deserve a dedicated surface — they're project artifacts that survive runs.

**Files added:**

- `apps/web/app/projects/[slug]/context-packs/page.tsx` — list, sortable by created_at, filterable by FP.
- `apps/web/app/projects/[slug]/context-packs/[id]/page.tsx` — detail. Renders content via S4 markdown renderer.
- `apps/web/lib/queries/context-packs.ts::listContextPacks(projectSlug)`, `getContextPack(id)`.
- `apps/web/__tests__/unit/list-context-packs.test.ts`.

**Acceptance:**
- List page renders all CPs for the project, paginated.
- Detail page renders title + content + metadata (run_id, feature_pack_id, created_at) + link back to the source run.

**Single commit:** `feat(web): M04 Phase 2 S9 — /projects/[slug]/context-packs list + detail`.

---

### S10 — `/projects/[slug]/graph` codebase-graph reader

**Files added:**

- `apps/web/app/projects/[slug]/graph/page.tsx` — Server Component. Reads `~/.coodra/graphify/<slug>/graph.json`. Empty state when missing → `<GraphifyEmptyState>` per AC #26.
- `apps/web/components/GraphifyEmptyState.tsx` — install CTA copy + "Copy install command" button.
- `apps/web/components/GraphReader.tsx` — client component, react-flow canvas + symbol search-table.
- `apps/web/lib/queries/graph.ts::loadGraph(projectSlug)`.
- `apps/web/__tests__/unit/graph-empty-state.test.ts`.
- `apps/web/__tests__/integration/graph-subgraph.test.ts`.

**Acceptance:**
- No graph: empty state renders with brand-styled CTA + the install command + ADR-010 anchor reference.
- Has graph: symbol table populates; clicking a symbol re-renders the subgraph in <100ms.
- React-flow canvas honors brand: zero radius, brand-blue edges, Inter font.

**Single commit:** `feat(web): M04 Phase 2 S10 — /projects/[slug]/graph reader (empty state CTA + react-flow subgraph)`.

---

### S11 — `/projects/[slug]/logs/[service]` SSE log tail

**Files added:**

- `apps/web/app/projects/[slug]/logs/[service]/page.tsx` — Server Component validates service name; renders last 200 lines on mount.
- `apps/web/app/api/projects/[slug]/logs/[service]/stream/route.ts` — SSE handler.
- `apps/web/components/LogTailClient.tsx` — client component, EventSource subscriber + client-side filter.
- `apps/web/lib/log-tail.ts` — `readLastLines(path, n)`, `tailStream(path, fromOffset)`.
- `apps/web/__tests__/unit/log-tail.test.ts`.
- `apps/web/__tests__/integration/logs-sse.test.ts`.

**Acceptance:**
- Page renders last 200 lines on first paint.
- New lines appear within ~500ms.
- Browser auto-reconnect on network blip works.

**Single commit:** `feat(web): M04 Phase 2 S11 — /projects/[slug]/logs/[service] SSE log tail`.

---

### S12 — NEW (action layer) — `/settings/workspace` service control + workspace prefs

**Why NEW.** User pushback 2026-05-04: web should be an action layer not just a reflection. Service start/stop/status from web is the highest-value action-layer addition (currently CLI-only).

**Files added:**

- `apps/web/app/settings/workspace/page.tsx` — Server Component. 3 sections: Service control (Start/Stop/Status buttons + live status panel polling 5000ms), Workspace prefs (theme toggle, default mode), Doctor (workspace-scoped — reuses S8 library entry).
- `apps/web/app/api/settings/workspace/services/route.ts` — POST endpoint for start/stop/status server actions.
- `apps/web/lib/actions/services.ts::startServicesAction()`, `stopServicesAction()`, `statusServicesAction()` — wrap library promotions.
- `packages/cli/src/lib/{start,stop,status}/index.ts` — library promotions of `runStart` / `runStop` / `runStatus` (currently inline in `commands/{start,stop,status}.ts`).

**Files modified:**

- `apps/web/components/HeaderNav.tsx` — user menu links to `/settings/workspace`.

**Acceptance:**
- "Start services" button calls runStart and shows live PID list.
- "Stop services" calls runStop with confirm.
- Status panel polls every 5s; shows green/red dots per service.
- Theme toggle persists via `theme` cookie.

**Single commit:** `feat(web,cli): M04 Phase 2 S12 — /settings/workspace service control + theme + workspace doctor`.

---

### S13 — NEW (action layer) — `/projects/[slug]/templates` install action

**Files modified:**

- `apps/web/app/projects/[slug]/templates/page.tsx` — adds "Install from path" form (path or URL → POSTs to S13 server action).

**Files added:**

- `apps/web/lib/actions/templates.ts::installTemplateAction(formData)` — server action wrapping `runTemplateInstall` library promotion.
- `packages/cli/src/lib/template/install.ts` — library promotion.

**Acceptance:**
- Pasting a local path installs the template + appears in the templates list immediately.
- Pasting a URL fetches + installs (M08b S13 does this; we reuse the helper).
- Invalid path/URL returns inline form error.

**Single commit:** `feat(web,cli): M04 Phase 2 S13 — template install action`.

---

### S14 — NEW (action layer) — `/projects/[slug]/settings` (rename / archive / delete / export)

**Files added:**

- `apps/web/app/projects/[slug]/settings/page.tsx` — full settings surface: project metadata read-only display + actions (rename / archive / reset / delete / export).
- `apps/web/lib/actions/projects.ts` — extend with `renameProjectAction`, `archiveProjectAction`, `deleteProjectAction`, `exportProjectAction`.
- `apps/web/app/projects/[slug]/settings/export/route.ts` — GET endpoint streams JSONL archive (runs + events + decisions + CPs for the project).
- `packages/cli/src/lib/export/index.ts` — library promotion of `runExport`.

**Files modified:**

- `apps/web/lib/queries/projects.ts` — add `renameProject`, `archiveProject`, `deleteProject` helpers (DB-side).

**Acceptance:**
- Rename validates new slug regex; checks uniqueness; updates row + redirects to `/projects/[newSlug]/settings`.
- Archive sets `is_active=false` (project hidden from picker but accessible via direct URL).
- Delete confirms via typed-confirm; cascades runs / events / CPs / decisions; redirects to `/`.
- Export streams a `.jsonl.gz` file via Content-Disposition; opening locally in `jq` works.

**Single commit:** `feat(web,cli): M04 Phase 2 S14 — /projects/[slug]/settings + export action`.

---

### S15 — `/sync` (team-mode) + Phase 2 closeout

**Files added:**

- `apps/web/app/sync/page.tsx` — team-mode-only page. Solo: empty state + link to SETUP.md. Team: queue-depth aggregation + dead-letter retry button.
- `apps/web/app/api/sync/state/route.ts` — JSON for polling.
- `apps/web/lib/queries/sync.ts::aggregatePendingJobs()`.
- `apps/web/lib/actions/sync.ts::retryQueueAction(formData)`.
- `apps/web/components/SyncQueueRow.tsx`.
- `apps/web/__tests__/integration/sync-queue.test.ts`.

**Closeout actions** (also in S15):

- Update `docs/context-packs/2026-05-04-module-04-web-app.md` with a "Phase 2 closeout" trailer (or write a sibling `2026-MM-DD-module-04-web-app-phase-2.md`).
- Flip `README.md` module-status row: `04 ✅ complete (Phase 1 + Phase 2)`.
- Update `docs/feature-packs/04-web-app/SETUP.md` with new URLs + new actions.
- Mark Phase 2 OQ locks final in `context_memory/decisions-log.md`.
- Save closeout via `coodra__save_context_pack`.

**Acceptance:**
- All 27 Phase 2 ACs hold on a clean checkout.
- `pnpm typecheck && lint && test:unit && test:integration && build` — all green.
- Smoke walk per spec §12 — all 12 steps pass.

**Single commit (S15 first half):** `feat(web): M04 Phase 2 S15 — /sync (team-mode) + dashboard heartbeat`.
**Single commit (S15 closeout):** `docs(m04-phase-2): closeout — context pack + README flip + SETUP additions; flip 04 ✅ complete`.

**Branch merge to main** happens after S15 closeout. Squash-merge `feat/04-web-app` to `main` per the existing PR (Phase 1 + Phase 2 ≈ 25-30 commits).

---

## Pre-Phase-2 fix-ups PR — NOT NEEDED (still)

Per `docs/audit/2026-05-04-strict-bug-status.md` and S1's verification: `.passthrough()` is in place at `packages/shared/src/hooks/payloads/claude-code.ts:57`, Phase 3 Fix A commit `19ccc1f` (2026-05-02) shipped the schema upgrade. No fix-up PR.

## Verification (end-to-end smoke before squash-merge)

After S15 closeout lands:

1. `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`. All green.
2. Stop services. Backup + purge `~/.coodra/data.db` per `docs/audit/2026-05-04-purge-and-retest.md`.
3. `coodra init --project-slug coodra-dev --no-graphify --ide claude`; `coodra start`; `coodra doctor` — green.
4. Boot web in solo mode. `/` shows ONE project card.
5. Use `/init` to provision `alpha`. `/` now shows TWO project cards.
6. Click `coodra-dev` → land at `/projects/coodra-dev`. Sub-nav shows.
7. Project switcher → switch to `alpha`. URL becomes `/projects/alpha/...same-tail`.
8. Drive 14 hook events for `coodra-dev`. Refresh `/projects/coodra-dev` — tile values match SQLite.
9. Edit a feature pack via `/projects/coodra-dev/packs/<slug>/edit`; assert auto-managed sections survived round-trip.
10. Delete a non-essential pack; confirm dir removed + is_active=false.
11. `/projects/coodra-dev/logs/hooks-bridge`; `echo 'manual line' >> ~/.coodra/logs/hooks-bridge.log`; line appears in <500ms.
12. `/settings/workspace` → click "Stop services" → confirm → bridge + mcp-server stop.
13. Switch to team mode (`COODRA_MODE=team` env + restart); `/sync` renders queue depth.
14. Toggle dark mode in user menu; assert all routes re-render in dark.
15. Resize browser to 375px; tables collapse to cards, HeaderNav becomes hamburger.

All fifteen pass → squash-merge `feat/04-web-app` to `main`.

## Out of scope for this batch (flagged for later)

- Per spec §13.
- M05's `/projects/[slug]/search`.
- M06's `/projects/[slug]/runs/[id]/diff`.
- M10's RLS rollout.
- `.trash/` soft-delete (CLI follow-up).
- Web-side Graphify producer.
- Realtime collaborative FP editor.
- i18n / accessibility audit.
- Browser-extension auth.
