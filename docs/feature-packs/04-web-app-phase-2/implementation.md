# Module 04 Phase 2 — Web App completion — Implementation

> Slice-by-slice work breakdown for the Phase 2 portion of `feat/04-web-app`. Read `spec.md` first for scope and `techstack.md` for the new runtime/dep choices (markdown renderer + react-flow). Decisions made mid-implementation get logged in `context_memory/decisions-log.md` and mirrored to the MCP via `contextos__record_decision`.

## Prerequisites (one-time, before S1)

- ✅ Module 04 Phase 1 fully landed on `feat/04-web-app` through commit `adda4b5` (S11 closeout). Branch is up to date.
- ✅ Phase 1 tests green: web 27/27, cli 188/188, mcp-server 261/261, hooks-bridge 46/46.
- ✅ Phase 1 SETUP.md present at `docs/feature-packs/04-web-app/SETUP.md` — Phase 2 reuses the same boot procedure.
- ✅ Closeout audit + retest report available at `docs/audit/2026-05-04-purge-and-retest.md` — F1-F7 enumerated; OQ-9 added to spec.
- ⚠ **OQ lock required before S1 starts.** The user must sign off on OQs 1-9 in `spec.md §13`. No S1 code lands until each has a recorded answer in `context_memory/decisions-log.md`.

**Outstanding before S1:**
- User signs off on OQ-1 through OQ-9 (one chat turn).
- Confirm `~/.contextos/data.db` from the 2026-05-04 retest is the working state (`coodra-dev` project + 1 run + 25 policy rules + bridge running). If a fresh purge is wanted, repeat steps 1-5 of `docs/audit/2026-05-04-purge-and-retest.md`.

## Slice sequence

### S1 — Data-quality fixes (F1 + F2 + F3-root-cause + F3-backfill + F4)

**Why first.** Every later slice depends on the dashboard rendering accurate live data. As long as F1 stands, "Active runs: 3 / Denials: 546" greets every developer at every refresh — verification of S2-S11 becomes guesswork. Likewise the orphan path (F3) silently corrupts every "events per run" widget; we close it at the source before building anything new on top.

**Files modified:**

- `apps/web/app/page.tsx` — `export const dynamic = 'force-dynamic'` (per OQ-9 lock).
- `apps/web/app/packs/page.tsx` — same.
- `apps/web/app/packs/[slug]/page.tsx` — same.
- `apps/web/app/templates/page.tsx` — same.
- `apps/web/lib/queries/projects.ts::listProjects()` — add `WHERE slug != '__global__'` filter. `getProject('__global__')` still resolves (sentinel is queryable by deep-link, just not listed).
- `apps/web/lib/queries/dashboard.ts::fetchLatestEvents()` — keep the query as-is (returns 10 most recent regardless of `run_id`); the rendering layer (RunEventRow) shows an "Untracked" chip when `run_id IS NULL`. Going forward, F3-bridge ensures no NEW orphans, so this code path is purely for legacy display.
- `apps/web/components/RunEventRow.tsx` — when `run_id` is null, render the Run column as an "Untracked" `<StatusChip>` (status="neutral") instead of a link.
- `apps/hooks-bridge/src/lib/run-recorder.ts` — **root cause fix.** Wire `ensureProject({cwd, slug?: derivedFromBasename})` before run resolution. If no project row matches the session's cwd, create one (slug from `path.basename(cwd)`, sanitized to the slug regex). Then resolve / create the run row, then write the event with `run_id` populated. Per AC #25 (OQ-2 lock).

**Files added:**

- `packages/db/src/migrations/0009_run_events_orphan_backfill.sql` — one-shot data migration. For each NULL-`run_id` row in `run_events`:
  1. Heuristic resolve cwd: parse `tool_input` JSON for `cwd` field (if present); else infer from `session_id` pattern matches (sessions named like `audit-bridge-*`, `verify-fs-*` map to `__global__`).
  2. If cwd resolved → `INSERT OR IGNORE INTO projects` (slug from basename) → `INSERT OR IGNORE INTO runs` (synthetic completed run keyed by `run:<projectId>:<sessionId>:backfill-0009`) → `UPDATE run_events SET run_id = ? WHERE id = ?`.
  3. If cwd not resolved → bind to `run:__global__:orphan-backfill-0009` (created once if missing).
  4. Log per-row outcome (`resolved` | `to_global`) to `~/.contextos/logs/migration-0009.log` with the final counts.
- `apps/web/__tests__/unit/static-prerender-guards.test.ts` — asserts `dynamic === 'force-dynamic'` on the four routes (uses `import * as page from '../../app/page'` and reads the named export). One test per route; fails fast at compile time if the export disappears.
- `apps/web/__tests__/integration/projects-no-sentinel.test.ts` — seeds DB with `__global__` + a real project; asserts `/projects` rendered HTML never contains "Global Policy Rules" or "__global__".
- `apps/web/__tests__/unit/run-event-row-untracked.test.ts` — asserts the chip renders for null-run rows; the link renders for non-null.
- `apps/hooks-bridge/__tests__/integration/run-recorder-ensures-project.test.ts` — drives a PreToolUse from a brand-new `cwd` (no prior SessionStart, no project row, no run row). Asserts after the call: (a) `projects` has a new row matching the cwd basename, (b) `runs` has a new row with the right `project_id`, (c) `run_events` has the event row with non-NULL `run_id` matching the new run.

**Acceptance:**
- `pnpm --filter @coodra/contextos-web build` then `cat .next/prerender-manifest.json` — `routes` does NOT contain `/`, `/packs`, `/packs/[slug]`, or `/templates`.
- Cost note (per OQ-9 lock): force-dynamic = ~4 fresh DB queries per dashboard hit. Acceptable at 1-10 dev scale; if `/sync` queue depth or DB CPU climbs in production usage, swap to `export const revalidate = 5` (5-second ISR window). Tracked as a post-Phase-2 ops follow-up.
- After a fresh `contextos init coodra-dev-fresh` + 14-event synthetic run + dashboard reload, tile values match SQLite (`SELECT count(*) FROM runs WHERE status='in_progress'` for Active runs; `SELECT count(*) FROM policy_decisions WHERE permission_decision='deny' AND created_at > unixepoch()-86400` for Denials · 24h; `SELECT count(*) FROM kill_switches WHERE resumed_at IS NULL` for Active pauses).
- `/projects` HTML contains "coodra-dev-fresh" but NOT "__global__" or "Global Policy Rules".
- After running migration 0009: `sqlite3 ~/.contextos/data.db "SELECT count(*) FROM run_events WHERE run_id IS NULL"` returns 0.
- After migration: `sqlite3 ~/.contextos/data.db "SELECT count(*) FROM runs WHERE id LIKE 'run:%backfill-0009%'"` returns ≥1 (the synthetic backfill runs).
- New event ingress test: POST a PreToolUse to the bridge with a `cwd` for which no project row exists. Within the response: 200 OK. After the call: `SELECT count(*) FROM projects WHERE slug = <cwd-basename>` returns 1; the new event has non-NULL `run_id`.

**Single commit:** `fix(web,bridge,db): M04 Phase 2 S1 — F1 force-dynamic + F2 sentinel filter + F3 ensureProject + 0009 backfill + F4 untracked chip`.

---

### S2 — Project selector + query rescope (merged per 2026-05-04 user lock)

**Why merged.** S2 selector chrome without rescoped queries does nothing visible — switching does nothing. Rescoped queries without a selector breaks every page (the cookie they read doesn't exist yet). User pushback: ship them together. Stage as **two readable commits within one slice** if the diff readability matters at PR review time.

**Stage 1 commit (selector chrome):**

- `apps/web/lib/project-context.ts` — Server Component helper: `getActiveProjectSlug()` reads the `contextos_selected_project` cookie, returns `string | null`.
- `apps/web/components/ProjectSwitcher.tsx` — client component, renders `<select>` populated from `listProjectsForFilter()`. On change → POST to `/api/project-context`.
- `apps/web/app/api/project-context/route.ts` — POST handler: validates slug exists, sets cookie (HttpOnly, SameSite=Lax, 90d), `revalidatePath('/')` + every scoped path.
- `apps/web/components/HeaderNav.tsx` — slot the `ProjectSwitcher` between logo and nav link list.
- `apps/web/__tests__/unit/project-context.test.ts` — cookie read, default fallback, slug validation rejection.

**Stage 2 commit (rescoped queries):**

- `apps/web/lib/queries/dashboard.ts::fetchDashboardSnapshot(projectSlug?)` — pass through to count/list queries.
- `apps/web/lib/queries/runs.ts::listRuns()` + `getRun()` — when `projectSlug` is set, filter at the `runs` table.
- `apps/web/lib/queries/policies.ts::listPolicies()` — same.
- `apps/web/lib/queries/projects.ts::listProjects()` — when `projectSlug` set, return single-row scoped collapse.
- `apps/web/lib/queries/packs.ts::listPacks()` — filter by `parentSlug === projectSlug` (filesystem read, post-filter).
- `apps/web/app/{page,runs/page,policies/page,projects/page,packs/page}.tsx` — each calls `getActiveProjectSlug()` and passes through.
- `apps/web/__tests__/integration/project-rescope.test.ts` — seeds 2 projects with disjoint runs; asserts switching the cookie value flips the rendered run list.

**Acceptance (whole slice):**
- HeaderNav renders the switcher with "All projects" default + every project slug from the DB. `__global__` is excluded from the dropdown (already filtered by S1's F2 fix).
- With cookie unset: every list shows all rows (Phase 1 behavior preserved — backwards compatible).
- With cookie set to `coodra-dev`: lists scope; `/kill-switches` is unchanged (kill-switches scope to themselves).
- Deep-link to `/runs/[id]` for a run outside the active scope: still resolves (run detail is project-agnostic by id).

**Single slice, two commits:**
- `feat(web): M04 Phase 2 S2a — ProjectSwitcher chrome + cookie + Server Action`
- `feat(web): M04 Phase 2 S2b — rescope dashboard / runs / policies / projects / packs queries to active project`

---

### S3 — `/init` wizard (formerly S4)

**Files added:**

- `apps/web/app/init/page.tsx` — wizard form (Server Component scaffolding + Client Component for inline validation). Fields: project slug (regex `^[a-z0-9-]{1,64}$`), IDE selection (claude/cursor/windsurf/all checkboxes), template (dropdown of bundled templates from `packages/cli/templates/`), `--no-graphify` checkbox.
- `apps/web/lib/actions/init.ts::initProjectAction(formData)` — Server Action. Validates form, calls into `packages/cli/src/lib/init/run.ts` (the same module the CLI's `init` command uses — Phase 2 exposes its `runInit({...})` function as a library entry).
- `packages/cli/src/lib/init/index.ts` — re-export `runInit` for the web. CLI keeps its own `init` command unchanged.
- `apps/web/__tests__/integration/init-wizard.test.ts` — drives the form with valid + invalid inputs; asserts DB state + sidecar files written for valid; asserts no DB write for invalid.

**Acceptance:**
- Slug validation matches CLI's exactly (same regex; same length cap).
- Successful submit redirects to `/projects/<slug>` with a success banner.
- Failed submit (slug taken, missing IDE selection) re-renders the form with field-level error messages; no DB writes happened.
- Solo-mode path writes `~/.contextos/data.db` + `<cwd>/.contextos.json` exactly as `contextos init` does. (Wizard inherits the cwd from the Next.js process — for a hosted team-mode deploy this means the wizard creates the project in the deploy environment's cwd, which is fine because team-mode projects don't need a sidecar; the Postgres row is the source of truth.)
- Team-mode path writes only the Postgres row + Feature Pack file (no sidecar — hosted env doesn't have a "project root").

**Single commit:** `feat(web,cli): M04 Phase 2 S3 — /init wizard (web parity with contextos init)`.

---

### S4 — `/packs/[slug]` markdown renderer (read-only)

**Why split from old S5.** Per 2026-05-04 user lock: read-only markdown rendering is low-risk (no disk writes, sanitization is the only concern); pack mutations touch disk + the auto-marker contract + need OQ-7 re-lock. Different review weight → different slices.

**Files modified:**

- `apps/web/app/packs/[slug]/page.tsx` — replace raw `<pre>{markdown}</pre>` blocks with the new `<MarkdownRenderer>` component. No header action bar yet (S5 adds the mutation buttons).

**Files added:**

- `apps/web/components/MarkdownRenderer.tsx` — Server Component wrapping `react-markdown` (per techstack.md). Maps GFM elements to brand-token classes; sanitizes per `rehype-sanitize` to prevent XSS.
- `apps/web/__tests__/unit/markdown-renderer-xss.test.ts` — hostile fixtures (script tag, javascript: link, `on*=` handlers, dangerous SVG) — asserts sanitization.
- `apps/web/__tests__/__fixtures__/markdown-xss.md` — battery of hostile inputs.
- `apps/web/__tests__/integration/pack-detail-render.test.ts` — round-trip: write a pack with a real spec.md (using GFM tables + code fences), render it, assert the HTML structure matches expectations.

**Acceptance:**
- Pack detail page renders markdown as styled HTML (headings, lists, code blocks, tables) — visually consistent with brand catalog, zero rounded corners, JetBrains Mono for code.
- All XSS hostile fixtures rendered as inert (script tags stripped, `javascript:` URLs become `#`, `on*=` handlers removed).
- Bundle increase: ~28 KB gzipped (react-markdown + remark-gfm + rehype-sanitize), gated to `/packs/[slug]` route only via Next.js dynamic import.

**Single commit:** `feat(web): M04 Phase 2 S4 — /packs/[slug] markdown renderer (read-only)`.

---

### S5 — `/packs/[slug]` mutations (regenerate / delete / install-template) — RE-LOCK OQ-7 BEFORE COMMITTING

**Why a re-lock checkpoint.** Per 2026-05-04 OQ-7 user pushback: user wanted "match CLI semantics, no fork." Spot-check found the user's stated CLI behavior ("only flips `is_active=false`, file stays") is incorrect — `packages/cli/src/commands/pack.ts:415-422` does `rm(dir, {recursive: true, force: true})` AND `deactivatePackRow()`. Default lock = match real CLI (hard-delete + soft-flip). User can override to (b) "soft-flip only, files untouched" if they want the deliberate fork.

**Before any disk-write code lands in this slice:** confirm OQ-7 lock with the user one last time. The slice spec defaults to (a) below; if the user says (b), swap the implementation accordingly.

**Files modified:**

- `apps/web/app/packs/[slug]/page.tsx` — add a header action bar with three buttons: Regenerate / Delete / Install template. Each opens a typed-confirm dialog.

**Files added (default-lock path: match real CLI):**

- `apps/web/lib/actions/packs.ts::regeneratePackAction(formData)` — invokes the same regen library entry the CLI's `pack regen` uses (promote `runPackRegenerate` from `packages/cli/src/commands/pack.ts` to a library export — small refactor, one new file).
- `apps/web/lib/actions/packs.ts::deletePackAction(formData)` — invokes the same library entry the CLI's `pack delete --force` uses: `rm(dir, {recursive: true, force: true})` + `deactivatePackRow(slug)`. Promote to a library export the same way.
- `apps/web/lib/actions/packs.ts::installTemplateAction(formData)` — invokes `runInit({mode: 'default', template: <name>, projectSlug: <slug>, force: true})` to overlay a template on an existing pack.
- `packages/cli/src/lib/pack/regenerate.ts`, `packages/cli/src/lib/pack/delete.ts` — library-promoted entries; CLI commands become thin wrappers (same pattern as S3's `runInit` promotion).
- `apps/web/__tests__/integration/pack-mutations.test.ts` — round-trip: regen preserves user-edited unmanaged sections; delete removes directory + flips `feature_packs.is_active=false` (row preserved per ADR-007); install-template overlays then verifies marker contract intact.

**Files added (alternate-lock path if user picks soft-flip-only):**

- Replace `deletePackAction`'s `rm(dir, ...)` step with a no-op; only `deactivatePackRow(slug)` runs. Document the divergence at the top of `lib/actions/packs.ts` and as a doctor check (#37) that warns when `feature_packs.is_active=false` rows have on-disk directories present (since web-deletes leave the dir but CLI-deletes don't).

**Acceptance (default-lock):**
- Regenerate preserves user-edited unmanaged sections; replaces auto-managed sections — same as `contextos pack regen`.
- Delete confirms via typed-confirm dialog ("Type 'delete <slug>' to confirm"); on confirm, removes directory from disk AND flips `is_active=false` in DB — same as `contextos pack delete --force`. Row preserved per ADR-007.
- Install-template confirms via typed-confirm dialog ("Type 'install <name>' to confirm"); on confirm, applies template overlay — same as `contextos pack new --template <name> --force`.
- Integration test asserts post-delete: `existsSync(dir) === false` AND `SELECT is_active FROM feature_packs WHERE slug=?` returns `0`.

**Single commit:** `feat(web,cli): M04 Phase 2 S5 — pack mutations (regenerate / delete / install-template) matching CLI semantics`.

---

### S6 — Feature pack editor (`/packs/[slug]/edit`)

**Files added:**

- `apps/web/app/packs/[slug]/edit/page.tsx` — two-pane editor (textarea + live preview). Reads `spec.md` / `implementation.md` / `techstack.md` source from disk, parses auto-marker boundaries, renders managed sections read-only with a "Managed" badge.
- `apps/web/lib/actions/packs.ts::saveFeaturePackAction(formData)` — Server Action. Validates marker-pair integrity; checks `feature_packs.updated_at` ETag; writes file; revalidates `/packs/[slug]`.
- `apps/web/lib/feature-pack-markers.ts` — pure helper: `parseMarkers(source: string): Section[]`, `serializeMarkers(sections: Section[]): string`. Tested in isolation.
- `apps/web/__tests__/unit/feature-pack-markers.test.ts` — round-trip: parse → serialize → bytes-equal-to-input. Tampering with markers (delete close marker; nest start markers) → throws `MarkerError`.

**Acceptance:**
- Editor loads the pack source files, shows preview pane updates live (debounced 300ms).
- Saving with markers intact succeeds; saving with markers broken returns a structured error and renders an inline diff highlighting the tamper.
- Concurrent edit (another writer bumps `updated_at`) returns `409 Conflict` with a "View latest version" link.

**Single commit:** `feat(web): M04 Phase 2 S6 — section-aware feature pack editor (auto-marker preserving)`.

---

### S7 — `/packs/[slug]/runs` (FP↔CP linkage panel)

**Files added:**

- `apps/web/app/packs/[slug]/runs/page.tsx` — Server Component. For pack `<slug>`, lists Context Packs whose `featurePackId` matches + Runs whose `projectSlug` matches the pack's `parentSlug`.
- `apps/web/lib/queries/packs.ts::listRunsForPack(slug)` — joins `feature_packs` + `context_packs` + `runs` via the pack-id ↔ project-slug bridge.
- `apps/web/__tests__/unit/list-runs-for-pack.test.ts` — fixtures with a pack tied to a project + 3 runs + 2 context packs; asserts the query returns the expected shape.

**Acceptance:**
- Page renders 2 sections: "Context Packs" (sortable by `created_at`) and "Runs" (sortable by `started_at`).
- Empty states for both when the pack has no linked runs (typical when the pack is for a different project than any registered run).
- Each row links to `/runs/[id]` or to the relevant pack-detail anchor.

**Single commit:** `feat(web): M04 Phase 2 S7 — /packs/[slug]/runs FP↔CP linkage panel`.

---

### S8 — `/doctor` live page + dashboard doctor tile activation

**Files added:**

- `apps/web/app/doctor/page.tsx` — Server-Component shell + Client `DoctorLiveClient` (uses Phase 1's `usePoll` adapter at 3000ms interval).
- `apps/web/app/api/doctor/state/route.ts` — invokes `runDoctorRegistry({fullReport: true})` from `packages/cli/src/lib/doctor/registry.ts` (Phase 2 surfaces this as a library export); returns JSON `{checks: [{name, status, message, fix?, lastRunAt}]}`.
- `packages/cli/src/lib/doctor/registry.ts` — refactor: existing CLI code already enumerates 35 checks; Phase 2 promotes `runDoctorRegistry` to an exportable function the web + CLI both call.
- `apps/web/components/DoctorLiveClient.tsx` — client component, polls `/api/doctor/state`, renders rows + "Re-run all" button.
- `apps/web/lib/queries/dashboard.ts::fetchDoctorSummary()` — replace stub. Calls `runDoctorRegistry({summary: true})` and returns `{red, yellow, available: true}`.
- `apps/web/app/page.tsx` — re-render the doctor tile with live data (since `fetchDoctorSummary()` now works).
- `apps/web/__tests__/integration/doctor-page.test.ts` — boots a synthetic registry with one warn + one fail; asserts the page rows + the dashboard tile both reflect the same numbers.

**Acceptance:**
- `/doctor` page renders 35 rows in the same order as the CLI; status icons match.
- Dashboard doctor tile shows red+yellow counts (or "0 / 0" when all green).
- Polling pauses when the tab is hidden (Phase 1 `usePoll` invariant).

**Single commit:** `feat(web,cli): M04 Phase 2 S8 — /doctor live page + dashboard doctor tile activation`.

---

### S9 — `/graph` codebase-graph reader

**Files added:**

- `apps/web/app/graph/page.tsx` — Server Component. Reads `~/.contextos/graphify/<projectSlug>/graph.json` for the active project. If missing → renders `<GraphifyEmptyState>`. If present → `<GraphReader>` (client component).
- `apps/web/components/GraphifyEmptyState.tsx` — installs CTA per ADR-010 Slice 11. Markdown-formatted instructions; "Copy install command" button.
- `apps/web/components/GraphReader.tsx` — client component. Two panes: left = symbol search-table (filterable, paginated), right = react-flow canvas. Click symbol → recompute 2-hop subgraph + center.
- `apps/web/lib/queries/graph.ts::loadGraph(projectSlug)` — reads + parses `graph.json` (Zod-validated shape from M02's graphify reader).
- `apps/web/__tests__/unit/graph-empty-state.test.ts` — asserts CTA copy contains the install command.
- `apps/web/__tests__/integration/graph-subgraph.test.ts` — fixture graph with 100 nodes; asserts subgraph centered on a chosen node has the expected neighborhood.

**Acceptance:**
- No graph: empty state renders with brand-styled CTA + install command.
- Has graph: symbol table populates; clicking a symbol re-renders the subgraph in <100ms.
- React-flow canvas honors brand: zero rounded corners on nodes; brand-blue edges; Inter font.

**Single commit:** `feat(web): M04 Phase 2 S9 — /graph codebase-graph reader (empty state + symbol search + react-flow subgraph)`.

---

### S10 — `/logs/<service>` SSE log tail

**Files added:**

- `apps/web/app/logs/[service]/page.tsx` — Server Component. Validates service name (`mcp-server` | `hooks-bridge` | `sync-daemon`); reads last 200 lines on mount.
- `apps/web/app/api/logs/[service]/stream/route.ts` — SSE handler. Tails the log file via `fs.createReadStream` + custom tail-stream wrapper; emits per-line events with `data: {line, ts}`. `retry: 5000` on disconnect.
- `apps/web/components/LogTailClient.tsx` — client component. Subscribes to SSE on mount; appends incoming lines; client-side search filter; "Pause/Resume" toggle; "Download" button (snapshots current viewport to a `.log` file).
- `apps/web/lib/log-tail.ts` — pure helper: `readLastLines(path, n)`, `tailStream(path, fromOffset)`. Tested in isolation.
- `apps/web/__tests__/unit/log-tail.test.ts` — fixtures (small file, large file, partial-line at end). Asserts last-N lines match `tail -n` semantics.
- `apps/web/__tests__/integration/logs-sse.test.ts` — boots SSE handler against a temp file; appends lines via fs.write; asserts subscriber receives them in order.

**Acceptance:**
- `/logs/mcp-server` renders the last 200 lines on first paint.
- Appending a line to the underlying log file → appears in the page within ~500ms.
- Reconnect on network blip works (browser auto-reconnect + server's `retry: 5000`).
- In solo mode, only `mcp-server` and `hooks-bridge` are selectable (sync-daemon hidden); in team mode, all three.

**Single commit:** `feat(web): M04 Phase 2 S10 — /logs/<service> SSE log tail`.

---

### S11 — `/sync` (team-mode only) + Phase 2 closeout

**Files added:**

- `apps/web/app/sync/page.tsx` — Server Component. In solo mode: empty-state component with a link to SETUP.md. In team mode: queue-depth aggregation table + dead-letter section + per-row retry button.
- `apps/web/app/api/sync/state/route.ts` — JSON for the `usePoll` client. Returns `{queues: [{name, pending, failed, deadLetter}], heartbeat: {lastSeenAt}}`.
- `apps/web/lib/queries/sync.ts::aggregatePendingJobs()` — `SELECT queue, status, count(*) FROM pending_jobs GROUP BY queue, status`.
- `apps/web/lib/actions/sync.ts::retryQueueAction(formData)` — `UPDATE pending_jobs SET status='pending' WHERE queue=? AND status='failed'`.
- `apps/web/components/SyncQueueRow.tsx` — single-row component; renders chips for each status count + retry button.
- `apps/web/__tests__/integration/sync-queue.test.ts` — seeds `pending_jobs` with mixed statuses; asserts page render + retry action.

**Closeout actions** (also in S11):

- Update `docs/context-packs/2026-05-04-module-04-web-app.md` with a "Phase 2 closeout" trailer (or write a sibling `2026-MM-DD-module-04-web-app-phase-2.md` if the pack is too large).
- Flip `README.md` module-status row: `04 ✅ complete (Phase 1 + Phase 2)`.
- Update `docs/feature-packs/04-web-app/SETUP.md` with the new routes + the project selector behaviour + the `/sync` admin (team mode).
- Mark the Phase 2 OQ locks in `context_memory/decisions-log.md`.
- Save the closeout as a Context Pack via `contextos__save_context_pack`.

**Acceptance:**
- All Phase 2 ACs (spec §2 items 1-24) hold on a clean checkout against `coodra-dev` test data.
- `pnpm --filter @coodra/contextos-web typecheck && lint && test:unit && test:integration && build` — all green.
- Smoke walk: every Phase 2 route + every Phase 1 route returns HTTP 200 against the live `coodra-dev` SQLite (and the same against the Supabase Postgres in team mode after a brief data seed).

**Single commit (S11 first half):** `feat(web): M04 Phase 2 S11 — /sync (team-mode-only) + dashboard heartbeat`.
**Single commit (S11 second half — closeout):** `docs(m04-phase-2): closeout — context pack + README flip + SETUP additions; flip 04 ✅ complete`.

**Branch merge to main** happens after S11 second-half lands. Squash-merge per the existing `feat/04-web-app` PR (which now contains Phase 1 + Phase 2 ≈ 22 commits).

---

## Pre-Phase-2 fix-ups PR — NOT NEEDED

The user's brief asked for the `.strict()` Stop hook to be the first item of a fix-up PR. Per `docs/audit/2026-05-04-strict-bug-status.md`, the bug was already remediated by Phase 3 Fix A on 2026-05-02 (the schema is `.passthrough()`, not `.strict()`, and the bridge's response shape is event-aware after S11 of Phase 1). Phase 2's S1 verifies this in passing (one assertion in `run-recorder-orphan.test.ts`); no separate fix-up PR is needed.

If a regression appears during S1 verification, S1 absorbs it as an additional commit before S2 starts.

## Verification (end-to-end smoke before Phase 1 + Phase 2 squash-merge)

After S11 lands and before the squash-merge to `main`:

1. `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`. All green.
2. Stop services. Backup + purge `~/.contextos/data.db` per `docs/audit/2026-05-04-purge-and-retest.md` steps 1-4.
3. `contextos init --project-slug coodra-dev-final --no-graphify --ide claude`; `contextos start`; `contextos doctor` — green.
4. Boot web in solo mode. Walk every Phase 1 + Phase 2 route, verify HTTP 200 + sane content.
5. Use the web `/init` wizard to provision a SECOND project (`coodra-dev-2`); switch via the project selector; verify `/runs`, `/policies`, `/projects`, `/packs` rescope.
6. Drive synthetic traffic (the same 14-event script from the audit) into the bridge; refresh dashboard; confirm tile values match SQLite (i.e. F1 fix is sticking after build).
7. Edit a feature pack via `/packs/[slug]/edit`; assert auto-managed sections survived the round-trip.
8. Trigger a soft-delete on a non-essential pack; confirm `.trash/` directory appears + doctor reports the size.
9. Open `/logs/hooks-bridge`; in another terminal `echo 'manual log line' >> ~/.contextos/logs/hooks-bridge.log`; assert the line appears in <500ms.
10. Switch to team mode (`CONTEXTOS_MODE=team` env + restart); verify `/sync` renders queue depth (or empty state if `pending_jobs` is empty).

All ten steps pass → ready to squash-merge `feat/04-web-app` to `main`.

## Out of scope for this batch (flagged for later)

- **`/search` route (semantic Context-Pack search):** M05 NL Assembly. Phase 2 does not author placeholders.
- **`/runs/[id]/diff` (semantic-diff overlay):** M06 Semantic Diff. Phase 2 does not author placeholders.
- **RLS / per-org row scoping:** M10. Phase 2's project selector + cookie are visual scoping, not data-isolation; team-mode rows still leak across orgs at the SQL layer (acceptable for v1; M10 closes it).
- **WYSIWYG markdown editor:** rejected per OQ-3. May revisit if operator feedback says the textarea is insufficient.
- **Web-side Graphify producer:** rejected per ADR-010. Reader-only in `/graph`.
- **Real-time collaboration on the FP editor:** single-writer assumption + last-writer-wins. Multi-user editing is post-launch.
- **Mobile-specific layouts:** Phase 1 uses responsive Tailwind; Phase 2 inherits. No dedicated mobile pages.
- **Accessibility audit beyond keyboard-nav + brand-tokens-already-WCAG-AA:** a separate pass (M07 deliverable, since VS Code already enforces a11y).
