# Module 04 Phase 2 — Web App completion (project scoping, missing surfaces, data-quality fixes) — Spec

> **Status:** kickoff (2026-05-04). Authored after the M04 closeout audit + clean-slate retest (`docs/audit/2026-05-04-purge-and-retest.md`). M04 itself ships unmerged on `feat/04-web-app`; Phase 2 lands on the same branch and they merge as one PR per user direction 2026-05-04.
> **Depends on:** Module 04 Phase 1 (the routes, lib helpers, brand system, polling adapter, sync-daemon kill-switch handler — see `docs/feature-packs/04-web-app/`), Module 03.1 Durable Outbox (sync queue tables for `/sync`), Module 02 MCP Server (graphify reader the `/graph` UI consumes), Module 08b CLI Expansion (`policy/project/run/pack/template/pause/export/doctor` shape — `/init`/`/doctor`/`/logs` mirror those binaries).
> **Blocks:** Module 07 VS Code Extension's session panel (it expects a stable web for deep-link previews), team-mode hosted deploy (Phase 2 closes the gaps that make a hosted M04 actually usable across an org).
> **Aware of:** Module 05 NL Assembly will eventually own a `/search` route (semantic Context-Pack search) and is **not** in Phase 2 scope. Module 06 Semantic Diff will eventually overlay `/runs/[id]/diff`; not in Phase 2. Module 10 RLS rollout will land row-level-security on the same Postgres tables Phase 2's `/sync` reads; not coupled.
> **Source of truth:** `system-architecture.md` §0 (corrections — Phase 2 honors them all), §16 patterns 1 (idempotency on every web mutation), 12 (admin authority — `/init`, pack mutations), 19 (auth — solo bypass / Clerk JWT), 20 (bridge-mediated session lifecycle — `/doctor` + `/logs` read what the bridge wrote), §17 (Graphify producer/reader split — `/graph` is the reader UI per ADR-010 Slice 11). Visual identity: `docs/brand/brand.md` + `brand.html` (Phase 1 token catalog already ported; Phase 2 adds no new tokens). User directives 2026-04-24 (no marketing site, no BYO-cloud team variant), 2026-05-03 (M04 OQ locks), 2026-05-04 (Phase 2 brief + merge plan).

## 1. What Phase 2 is

Phase 2 finishes M04. Specifically it ships **four classes of work** that Phase 1 either skipped or deferred:

1. **Architectural — project scoping.** Phase 1 has no global project context — every list (`/runs`, `/policies`, `/projects`, `/packs`) shows entities from every project at once. Phase 2 adds a project selector to `HeaderNav` (workspace-switcher pattern) so every route below it scopes to one project. The dashboard becomes per-project. The CLI's `--project-slug` flag and the `.contextos.json` sidecar both already model this concept; Phase 2 surfaces it in the UI.
2. **Surfaces moved to "follow-ups" by Phase 1's S11.** The pack detail page renders raw markdown without a renderer. The pack admin has no way to regenerate / delete / install-template. The dashboard has a doctor tile that's a stub (`available: false`). Phase 2 implements all three to spec.
3. **Surfaces never in Phase 1's spec but expected by ContextOS's actual ops vocabulary.** A web `/init` wizard (parity with `contextos init`). An inline feature-pack editor (parity with editing the markdown directly, but auto-marker-aware). A FP↔CP linkage panel (`/packs/[slug]/runs`). A graph reader (`/graph`, fail-open empty state until Graphify runs). A live doctor page (`/doctor`, the 35-check registry as a page, not a tile). A web log tail (`/logs/<service>`). A sync queue admin (`/sync`, team mode only).
4. **Data-quality bugs surfaced by the M04 closeout audit + the 2026-05-04 retest.** Three of these were on the user's brief; one was discovered during retest:
   - `__global__` sentinel leaking into `/projects` (filter at query layer).
   - `run_events.run_id` is NULL for events emitted by sessions whose project was never registered (bridge run-recorder fix; backfill migration).
   - Stop hook `.strict()` rejection — already remediated by Phase 3 Fix A 2026-05-02 per `docs/audit/2026-05-04-strict-bug-status.md`; Phase 2 verifies the fix is still live and reserves rollback if it ever regresses (no new code expected).
   - `/`, `/packs`, `/templates` are statically prerendered with build-time DB counts (Phase 2 S1 — the dashboard shows wrong tile values until the next `pnpm build`).

**Why now.** The CLI vocabulary is locked (M08b shipped 20 commands). M04 Phase 1 ships the read-shape of that vocabulary in HTML. Phase 2 closes the gap between what the CLI can do and what the web can do — the web becomes a complete thin shell over the CLI's admin surface. Without Phase 2, every operator with a phone has to keep a terminal nearby; with Phase 2, the web is the operator-grade surface ContextOS always wanted to have.

**What Phase 2 is NOT.**
- Not a marketing site (still). Not a public docs portal.
- Not `/search` (semantic Context-Pack search) — that's M05's surface.
- Not `/runs/[id]/diff` (semantic diff overlay) — that's M06.
- Not RLS / per-org row scoping at the Postgres layer — that's M10.
- Not a billing UI, not seat management — out of scope per the standing 2026-04-24 directive.
- Not a redesign — every Phase 2 surface uses the **same** brand-token catalog and visual rhythm Phase 1 already ported.

## 2. Acceptance criteria

A commit on `feat/04-web-app` is "complete (Phase 1 + Phase 2)" when **every** item below holds on a clean checkout, in addition to all 15 Phase 1 ACs:

1. **Workspace integration:** Phase 2 introduces no new workspace package; `apps/web` gains files only. `pnpm install` clean. `turbo.json` pipeline unchanged.
2. `pnpm lint` — Biome zero findings across `apps/web/**` plus the `apps/hooks-bridge/src/lib/run-recorder.ts` Phase 2 touches.
3. `pnpm typecheck` — `tsc --noEmit` clean across the workspace.
4. `pnpm test:unit` — every existing test still passes; Phase 2 adds tests for: project-scope context provider, F1 dynamic-render guards (snapshot), F2 sentinel filter, F3 orphan-event policy (locked OQ-2), markdown-renderer XSS resistance, FP-editor auto-marker round-trip, /graph empty-state CTA copy, /doctor check-row contract, /logs SSE re-subscribe on disconnect, /sync queue-depth aggregation, /init wizard form validation.
5. `pnpm test:integration` — new tests: (a) the bridge run-recorder routes orphan events per the locked OQ-2 policy; (b) the FP editor preserves auto-marker boundaries across save round-trips when the user edits unmanaged sections; (c) `/sync` reads `pending_jobs` from the live Supabase Postgres without lock contention with sync-daemon's worker.
6. `pnpm test:e2e` — extends Phase 1 e2e with a project-switching flow (create two projects via `/init`, assert `/runs` and `/packs` re-scope when switching).
7. **Schema delta:** **NONE.** Phase 2 reads + writes against the existing 11-table schema. The orphan-event backfill (Phase 2 S1) is a one-shot SQL migration emitted via Drizzle (`packages/db/src/migrations/0009_run_events_orphan_backfill.sql`) and counts as a data migration, not a schema migration; it does not need a 12th table.
8. **Backwards compatibility:** every Phase 1 route + every CLI command (M08a + M08b — 20 commands) keeps its surface verbatim. Phase 2's project-scope context defaults to "all projects" when no selector is set, so a fresh visitor sees the Phase 1 behavior on first load.
9. **Mode parity:** every Phase 2 route renders correctly in BOTH `CONTEXTOS_MODE=solo` and `CONTEXTOS_MODE=team`. `/sync` is the only team-only route — in solo it renders a "team-only" empty state with a link to the team-mode setup docs.
10. **Brand fidelity:** Phase 2 introduces zero new tokens. Phase 1's `apps/web/styles/tokens.css` is the source. The new markdown renderer (S4) maps GFM `<h1>...<h6>`, `<code>`, `<pre>`, `<table>`, `<a>`, `<img>`, `<blockquote>` to brand tokens (no rounded corners, no non-brand colors, JetBrains Mono for code).
11. **Auth model:** all Phase 2 routes inherit Phase 1's middleware. `/init` and pack mutations require an authenticated actor in team mode (Clerk session); in solo they're allowed for the synthetic `__solo__` user.
12. **Live updates contract:** `/doctor` polls per Phase 1's `usePoll` adapter at 3000ms (slower than dashboard's 1500ms because checks are longer-lived). `/logs/<service>` uses SSE per locked OQ-6. `/sync` polls at 5000ms (matches sync-daemon's pull cadence).
13. **F1 — static-prerender bug fixed.** `.next/prerender-manifest.json` after `pnpm build` does NOT contain `/`, `/packs`, `/packs/[slug]`, or `/templates` in its `routes` list. (`/_not-found` and the Clerk auth route shells stay static — those don't read mutable state.)
14. **F2 — `__global__` sentinel filter.** `/projects` rendered HTML never mentions `__global__` or "Global Policy Rules"; the test from S1 asserts this against a seeded DB that explicitly contains the sentinel.
15. **F3 — orphan `run_events` policy.** Per locked OQ-2: bridge route persists an orphan-event-policy decision per ingress, the new `events_dropped` counter is wired, and the backfill migration moves any pre-existing NULL-`run_id` rows to the locked policy outcome.
16. **F4 — dashboard "Latest events" filter.** Either `WHERE run_id IS NOT NULL` or a labeled "Untracked" badge per the locked OQ — confirmed by an e2e snapshot.
17. **Project selector contract:** the selector lives in `HeaderNav`, persists across page navigation via cookie (`contextos_selected_project`), and emits a Server Action callback that `revalidatePath('/')` so the next request renders scoped data. Switching projects rescopes `/runs`, `/policies`, `/projects` (highlights the row), `/packs` (filters by pack `parentSlug` matching the project), `/`. `/kill-switches` stays cross-project (kill-switches scope to themselves, not the active project — see also M04 Phase 1 spec §10).
18. **`/init` wizard:** wizard provisions a project sidecar (`.contextos.json`) + seeds the project row + creates the default policy with 25 baseline rules + scaffolds a feature pack — same outputs as `contextos init --project-slug X --no-graphify --ide claude` per the locked OQ-4. Invalid inputs (slug taken, IDE not selected, pack template missing) surface inline form errors before any DB write.
19. **Feature pack editor:** the editor parses the auto-marker contract from `packages/cli/src/lib/feature-pack-template.ts` (sections wrapped in `<!-- contextos:auto-start --> ... <!-- contextos:auto-end -->`). User-edited unmanaged content survives a regenerate. Managed (auto) content survives a user save (untouched by the editor; locked OQ-3 b).
20. **`/graph` empty state:** when `~/.contextos/graphify/<projectSlug>/graph.json` is missing, render a CTA per ADR-010 Slice 11 ("Install graphify with `npm i -g graphify` and run `graphify scan` in your project root"). When present, render the locked OQ-5 (c) — search-table-of-symbols + click-to-zoom subgraph.
21. **`/doctor` page:** runs the same 35-check registry as `contextos doctor --full --json` (calls the registry directly, not via subprocess shell-out — the doctor module lives in `packages/cli/src/lib/doctor/registry.ts`). Per check: status icon, name, message, fix string, last-run timestamp.
22. **`/logs/<service>`:** SSE endpoint at `/api/logs/<service>/stream` (handler tails `~/.contextos/logs/<service>.log`, line-buffered, fan-out to multiple subscribers). Web page renders the last 200 lines on mount, then streams subsequent lines. Auto-reconnects on visibility change (browser tab gains focus). Service options: `mcp-server`, `hooks-bridge`, `sync-daemon` (in team mode).
23. **`/sync`:** team-mode-only page. Reads `pending_jobs` table aggregated by `(queue, status)` (OK / failed / dead-letter). Per-row retry button calls a Server Action that flips status to `pending` and increments `attempts_remaining`. Solo-mode visitors see a one-paragraph empty state with a link to the team-setup section of `SETUP.md`.
24. **Module 04 final Context Pack** updated to cover Phase 2 closeout (per `essentialsforclaude/08-implementation-order.md §8.4`). README module-status table flips to `04 ✅ complete (incl. Phase 2)`. The Phase 1 Context Pack at `docs/context-packs/2026-05-04-module-04-web-app.md` gains a "Phase 2 closeout" trailer or a sibling pack `2026-MM-DD-module-04-web-app-phase-2.md` per the locked S11 protocol.

## 3. Non-goals

- **No new schema tables.** Phase 2 reads + writes the same 11. The orphan-event backfill is a data migration, not a schema migration.
- **No `/search` route.** Semantic Context-Pack search lives in M05.
- **No `/runs/[id]/diff` overlay.** Semantic diff lives in M06.
- **No RLS in this PR.** Row-level security on Postgres is an M10 concern.
- **No Graphify producer.** ADR-010 explicitly defers the producer to a future module; Phase 2 only ships the reader UI.
- **No realtime collaboration on the FP editor.** Single-writer assumption; the editor uses optimistic-concurrency-control via `feature_packs.updated_at` ETag-style checks. Conflict resolution is "last-writer-wins with a warning banner".
- **No marketing copy in `/init`.** Wizard text is operator-grade ("Project slug", "IDE to wire", "Template"); no onboarding flourishes.
- **No keyboard-shortcut layer.** Reserved for M07 (VS Code) where shortcuts already exist in the host editor.

## 4. Routes — the surface

**New routes** added by Phase 2:

| URL | What it does | Solo | Team |
|-----|--------------|------|------|
| `/init` | Project provisioning wizard (mirror of `contextos init`) | ✓ | ✓ |
| `/packs/[slug]/edit` | Inline feature-pack editor (auto-marker-aware) | ✓ | ✓ |
| `/packs/[slug]/runs` | Runs + Context Packs that reference this feature pack | ✓ | ✓ |
| `/graph` | Codebase-graph reader (graphify output) | ✓ | ✓ |
| `/doctor` | Live 35-check doctor registry | ✓ | ✓ |
| `/logs/[service]` | Log tail (SSE) for `mcp-server` / `hooks-bridge` / `sync-daemon` | ✓ | ✓ |
| `/sync` | `pending_jobs` queue admin + dead-letter retry | ✗ team-only | ✓ |
| `/api/logs/[service]/stream` | SSE endpoint backing `/logs/[service]` | ✓ | ✓ |
| `/api/doctor/state` | JSON for `/doctor` polling client | ✓ | ✓ |
| `/api/sync/state` | JSON for `/sync` polling client | ✗ team-only | ✓ |

**Modified routes** changed by Phase 2:

| URL | Change |
|-----|--------|
| `/` | F1 fix (force-dynamic) + F4 fix (orphan filter or Untracked badge) + doctor tile activates (calls `/api/doctor/state`) |
| `/projects` | F2 fix (sentinel filter) |
| `/packs` | F1 fix (force-dynamic) |
| `/packs/[slug]` | Markdown renderer added; pack-actions header (regenerate / delete / install-template) |
| `/templates` | F1 fix (force-dynamic) |
| `HeaderNav` | Project selector dropdown (workspace switcher) added between logo and nav links |

**Unchanged routes**: `/runs`, `/runs/[id]`, `/runs/[id]/live`, `/policies`, `/policies/[id]`, `/projects/[id]`, `/kill-switches`, `/auth/*`, `/settings/*`, `/api/healthz`, `/api/runs/[id]/state`.

**Total surface after Phase 2**: 17 pages + 5 API endpoints (Phase 1 had 12 + 2).

## 5. Schema deltas

**None for tables.** Phase 2 emits one data-migration SQL file (`packages/db/src/migrations/0009_run_events_orphan_backfill.sql`). The migration:
1. Counts NULL-`run_id` rows: `SELECT count(*) FROM run_events WHERE run_id IS NULL`.
2. Per locked OQ-2 outcome:
   - if **OQ-2a** (auto-bind): `INSERT OR IGNORE INTO runs (id, project_id, agent_type, status, session_id, started_at, ended_at) VALUES ('run:__global__:orphan-backfill', '__global__', 'unknown', 'completed', 'orphan-backfill', unixepoch(), unixepoch())`. Then `UPDATE run_events SET run_id = 'run:__global__:orphan-backfill' WHERE run_id IS NULL`.
   - if **OQ-2b** (reject going forward, keep history): `UPDATE run_events SET run_id = NULL` is a no-op; bridge change keeps new orphans out.
   - if **OQ-2c** (drop silently): `DELETE FROM run_events WHERE run_id IS NULL` + emit a one-line `INFO` log with the count.
3. Logs the action + count to a new `migration_audit_log.log` file for auditability.

Drizzle's `pnpm db:generate` will produce the SQL skeleton; we hand-finalise the body per the locked OQ.

## 6. Project-scope context (OQ-1: dropdown selector)

The selector lives in `HeaderNav`. Implementation:

- `apps/web/lib/project-context.ts` — Server Component helper that reads the `contextos_selected_project` cookie (default: empty string == "all projects").
- `apps/web/components/ProjectSwitcher.tsx` — client component, renders `<select>` populated from `listProjectsForFilter()` (already exists in Phase 1's `lib/queries/runs.ts`). On change → POST to `/api/project-context` Server Action, which sets the cookie + `revalidatePath('/')` + `revalidatePath('/runs')` + every other scoped route.
- Every scoped query (`fetchDashboardSnapshot`, `listRuns`, `listPolicies`, `listProjects`, `listPacks`) takes an optional `projectSlug` parameter. When set, it filters; when empty, it returns all (Phase 1 behavior).
- `/projects` highlights the row matching the active selector with a brand-blue left border (no shadow, no radius — brand mandate).

Cookie shape: `contextos_selected_project=<projectSlug>`, HttpOnly, SameSite=Lax, 90-day expiry. Stored URL-encoded slug, max 64 chars (matches CLI's slug validator).

## 7. Orphan `run_events` handling (OQ-2 — to be locked)

See OQ-2 in §13. Three options laid out; recommendation is (a) auto-bind to `__global__` synthetic run with full audit trail (preserves forensics value, fail-open spirit, easy rollback). The bridge change is in `apps/hooks-bridge/src/lib/run-recorder.ts` — a small `if (run === null) { runId = await ensureGlobalOrphanRun() }` wrap.

## 8. Feature-pack editor (OQ-3: section-aware, auto-marker-preserving)

The editor is a **two-pane layout**: textarea on the left (raw markdown), live preview on the right (Phase 2 markdown renderer). The textarea is plain `<textarea>`, no CodeMirror, no Monaco — operator-grade is the brand promise. Per OQ-3 (b), the editor parses the auto-marker contract:

```markdown
<!-- contextos:auto-start name="languages" generated-by="init-template" -->
- TypeScript
- Python
<!-- contextos:auto-end name="languages" -->
```

Sections inside markers are read-only in the UI (rendered with a "Managed by template" badge) and survive both save (editor never writes them) and regenerate (CLI overwrites them). Sections outside markers are user-owned. Save endpoint validates the marker contract is intact; rejects with a structured error if a marker pair was deleted or unbalanced.

Save flow: `apps/web/lib/actions/packs.ts::saveFeaturePackAction(formData)` → reads `feature_packs.updated_at` for ETag check → writes file to disk → `revalidatePath('/packs/[slug]')`.

## 9. `/graph` codebase-graph reader (OQ-5: search + click-to-zoom)

Reader-only, per ADR-010. Two modes:
- **No graph** — empty state with the install CTA (slice 11 polish): "ContextOS uses Graphify (https://github.com/safishamsi/graphify) for the codebase graph. Install with `npm i -g graphify`, then run `graphify scan` in your project root."
- **Has graph** — table of symbols (filterable) + click → SVG subgraph (centered on selected symbol, 2-hop neighborhood, force-directed layout). Implementation uses **react-flow 12** (locked in techstack.md per OQ-5).

Symbol-table columns: name, kind (function / class / type / file), language, file path. Click selects + scrolls the subgraph pane.

## 10. `/doctor` page (parity with `contextos doctor --full --json`)

The 35-check registry from `packages/cli/src/lib/doctor/registry.ts` runs in-process (no shell-out — the registry is a pure TS module). Each check renders as a row:

```
[ICON] [STATUS]  Check name                Last run: HH:mm:ss
                 Message text
                 fix: <string when not green>
```

Status palette: ✓ green / ⚠ amber / ✗ red, mapped to the brand status palette. Polls `/api/doctor/state` at 3000ms via `usePoll`. Manual "Re-run all checks" button forces an immediate poll.

The dashboard doctor tile (Phase 2 S7) calls `/api/doctor/state` with `?summary=true` and renders just `{red, yellow, available}` — the same shape Phase 1's `fetchDoctorSummary()` already returns (currently stubbed). The summary computation is `red = count(status === 'fail')`, `yellow = count(status === 'warn')`, `available = true`.

## 11. `/logs/<service>` (OQ-6: SSE)

Three services tail-able: `mcp-server`, `hooks-bridge`, `sync-daemon` (only sync-daemon in team mode unless solo also runs the daemon). Endpoint:

```
GET /api/logs/<service>/stream
Accept: text/event-stream

retry: 5000

data: {"line":"...", "ts":"2026-05-04T08:20:11.123Z"}
```

Server uses Node's `fs.createReadStream` + `tail-stream` pattern (no native `tail -f` shell-out). Client uses `EventSource`; on `error`, browser reconnects automatically. The page also renders the **last 200 lines** on initial load (server-side fetch of file tail) so the user sees recent context immediately.

Logs render with a JetBrains Mono font, line wrapping off, horizontal scroll for long lines. Search box filters client-side (no server query — live tail is faster).

## 12. `/sync` queue admin (OQ-8: per-table breakdown + dead-letter retry, team mode only)

Reads `pending_jobs` (M03.1 outbox) and aggregates by `(queue, status)`. Renders a 3-column table per queue: Pending count, Failed count, Dead-letter count. Per row there's a "Retry all" button that calls a Server Action which `UPDATE pending_jobs SET status='pending', attempts_remaining = max(attempts_remaining, 3) WHERE queue=? AND status='failed'`.

Auto-refresh every 5000ms via `usePoll`. Empty state when `pending_jobs` is empty: "Queue clear. Sync-daemon's last poll was at HH:mm:ss." (read from sync-daemon's heartbeat — a `pending_jobs` row with `queue='heartbeat'`, written every 5s).

In solo mode, renders: "Sync admin is team-mode only. See `docs/feature-packs/04-web-app/SETUP.md` step 6 to enable bidirectional sync."

## 13. Locked design decisions (signed off 2026-05-04)

User locked all 9 OQs in one chat turn (2026-05-04, post-spot-check) — 6 concurs + 3 pushbacks. Each lock recorded in `context_memory/decisions-log.md` with `dec_phase2_oq_*` keys.

### OQ-1 — Project selector UX shape — **locked: (a) dropdown in HeaderNav**
Concur with recommendation. Dropdown matches Clerk's `OrganizationSwitcher` pattern used in team-mode; users see one consistent affordance.

### OQ-2 — Orphan `run_events` — **locked: (a) backfill + bridge `ensureProject(cwd)` fix is a NON-NEGOTIABLE AC**
User pushback: auto-bind to `__global__` is a band-aid. **Root cause** is `apps/hooks-bridge/src/lib/run-recorder.ts` not calling `ensureProject(cwd)` before recording — Phase 2 must fix the cause AND backfill the 23 existing orphans. The backfill resolves each orphan's cwd via the same `ensureProject` path; rows whose cwd is unrecoverable (the heuristic fails) fall back to a `__global__` synthetic "orphan-backfill" run so audit data is preserved. **Drop** is rejected (loses audit data). The bridge fix is added as AC #25 below.

### OQ-3 — Feature-pack editor granularity — **locked: (b) section-aware, auto-marker-preserving**
Concur. `(a)` breaks the auto-marker contract on first save; `(c)` violates the operator-grade brand promise and adds ~200KB of JS.

### OQ-4 — `/init` wizard scope — **locked: (a) mirror exact `contextos init`**
Concur. `(b)` and `(c)` are scope-creep; advanced setup belongs in CLI / team admin.

### OQ-5 — `/graph` rendering layer — **locked: (c) search-table + click-to-zoom (react-flow), AND mandatory empty-state CTA**
Concur on (c). User addition: spec **must require** an empty-state CTA when `~/.contextos/graphify/<slug>/graph.json` is absent — per ADR-010 most users will have no index. Empty state prints the graphify CLI install command (`npm i -g graphify` then `graphify scan`) and links to ADR-010 Slice 11. Added as AC #26 below.

### OQ-6 — `/logs/<service>` live-tail mechanism — **locked: (a) SSE**
Concur. One-way matches log-tail; cheaper than WS; uses native `EventSource`.

### OQ-7 — Pack mutation safety — **locked: match real CLI behavior (hard-delete files + soft-flip `is_active=false` per ADR-007); RE-LOCK CHECKPOINT before S5 (pack mutations) lands**

User pushback intent was "match CLI semantics, no fork." User stated CLI behavior as "only flips `is_active=false`, file stays on disk." **Verified factually incorrect**: `packages/cli/src/commands/pack.ts:415-422` actually does BOTH — `rm(dir, {recursive: true, force: true})` then `deactivatePackRow()`. The dual operation is the real CLI contract; preserving it is what "no fork" means.

This OQ is provisionally locked to the **real CLI behavior** so Phase 2 doesn't fork by accident. Before S5 (pack mutations slice) opens, the user re-confirms either:
- (a) match real CLI (default lock) — web `pack delete` does `rm` + soft-flip.
- (b) lock to "soft-flip only, files untouched" — accept the fork; CLI follow-up tracked separately.

`.trash/` soft-delete option (the original recommendation) is **out** — neither CLI nor web ships it in Phase 2; it's reserved for a hypothetical future M08c if the user wants undo semantics in both surfaces simultaneously.

### OQ-8 — `/sync` page detail level — **locked: (b) per-table breakdown + dead-letter retry**
Concur. `(a)` is operationally insufficient; `(c)` requires shipping the BullMQ board package + peer deps (~3MB).

### OQ-9 — F1 (static-prerender) fix shape — **locked: (a) `export const dynamic = 'force-dynamic'`, with cost note**
Concur on (a). User note: force-dynamic = 4 fresh DB queries per dashboard hit. **Acceptable at 1-10 dev scale**; revisit with `revalidate: 5` if `/sync` queue depth or DB CPU climbs. Out-of-scope for Phase 2; documented in S1 slice spec for future ops.

### Notes on the user's brief

- **F1 (static prerender)** was discovered during the 2026-05-04 retest, not in the user's original brief. Locked as OQ-9 since the fix is non-trivial enough to deserve a recorded decision.
- **The `.strict()` Stop hook item** from the user's brief was confirmed already-remediated. Spot-check 1 (2026-05-04, immediately before S1 approval) verified `packages/shared/src/hooks/payloads/claude-code.ts:57` still uses `.passthrough()`. Spot-check 2 verified the Phase 3 Fix A commit hash is `19ccc1f` (`feat(shared): .passthrough() payload schemas + SessionEnd + turn_end phase (Phase 3 Fix A)`, authored 2026-05-02 17:18 IST). Phase 2 carries no fix for this — only a regression-guard test in S1.
- **Project selector** is treated as architectural, not a single OQ — its implementation cuts across §6 (cookie + rescope plumbing), AC #17 (selector contract), and §4 (modified routes). OQ-1 only picks the UX shape.

### AC additions from OQ pushbacks

Add to spec §2 (Acceptance criteria):

- **AC #25 (from OQ-2 pushback):** `apps/hooks-bridge/src/lib/run-recorder.ts` calls `ensureProject({cwd})` before persisting any event. New event ingress from an un-registered cwd auto-creates the project row + a synthetic run row, then writes the event with `run_id` populated. Integration test asserts (a) project row created, (b) run row created, (c) event row has non-NULL `run_id` — for an event with no preceding SessionStart.
- **AC #26 (from OQ-5 pushback):** `/graph` empty-state copy is a unit-tested string containing the substrings "`npm i -g graphify`", "`graphify scan`", and the ADR-010 Slice 11 anchor reference. The CTA renders whenever `loadGraph(projectSlug)` returns null.

## 14. Slice plan (S1 → S11) — locked 2026-05-04 with user pushbacks

User restructured the original plan (2026-05-04): merged S2+S3 (selector without rescoped queries does nothing visible; queries without a selector breaks every page), split old S5 into S4 (read-only viewer) + S5 (mutations) for review-weight separation, and required S1 to include the F3 backfill alongside the bridge fix.

| Slice | Scope |
|---|---|
| S1 | **Data-quality fixes — bundled.** F1 (force-dynamic on /, /packs, /packs/[slug], /templates) + F2 (sentinel filter on `/projects`) + F3 root cause (`ensureProject(cwd)` in `run-recorder.ts`) + F3 backfill (`0009_run_events_orphan_backfill.sql` rebinds 23 existing orphans through the same path; unrecoverable cwd → `__global__`-orphan-backfill run) + F4 (Untracked chip in dashboard latest-events for any historical NULL row). Single commit. |
| S2 | **Project selector + query rescope (merged).** `ProjectSwitcher` in HeaderNav + `getActiveProjectSlug()` cookie helper + Server Action + rescoped queries (`fetchDashboardSnapshot`, `listRuns`, `listPolicies`, `listProjects`, `listPacks`). Stage as readable commits within the slice. |
| S3 | `/init` wizard (form + validation + Server Action wrapping `runInit` library promotion). |
| S4 | `/packs/[slug]` **markdown renderer (read-only).** Adds `<MarkdownRenderer>` component + GFM + sanitize. No mutations yet. |
| S5 | `/packs/[slug]` **pack mutations.** Regenerate / delete / install-template Server Actions. **Re-lock OQ-7 here** before disk-touching code lands (default lock = match real CLI behavior: `rm` + soft-flip; user can override to soft-flip-only if they want the fork). |
| S6 | Feature-pack editor (`/packs/[slug]/edit`) — section-aware, auto-marker-preserving. |
| S7 | `/packs/[slug]/runs` (FP↔CP linkage panel). |
| S8 | `/doctor` live page + dashboard doctor tile activation. |
| S9 | `/graph` reader (empty state with mandatory CTA + symbol table + react-flow subgraph). |
| S10 | `/logs/<service>` SSE + page. |
| S11 | `/sync` (team-mode-only) + Phase 2 closeout (Context Pack + README flip + merge with Phase 1 in one squash to `main`). |

**Slice-count math**: still 11 slices net (S2+S3 merge saves 1; S5 split into S4+S5 adds 1; net zero).

S1 is intentionally first — it unblocks every later slice's verification by giving the dashboard accurate live data + closing the orphan loop at the source.

S11 is the merge point: Phase 1 + Phase 2 land as **one** PR `feat/04-web-app` → `main`, per the user's 2026-05-04 direction.
