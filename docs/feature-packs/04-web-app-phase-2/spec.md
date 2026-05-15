# Module 04 Phase 2 — Web App completion (hub-and-spoke IA, visual rework, action-layer, data-quality fixes) — Spec

> **Status:** S1 complete (commit `4832369`); spec re-authored 2026-05-04 after user IA pushback. M04 itself ships unmerged on `feat/04-web-app`; Phase 2 lands on the same branch and they merge as one PR per user direction 2026-05-04.
> **Depends on:** Module 04 Phase 1 (the routes, lib helpers, brand system, polling adapter, sync-daemon kill-switch handler — see `docs/feature-packs/04-web-app/`), Module 03.1 Durable Outbox (sync queue tables for `/sync`), Module 02 MCP Server (graphify reader the `/projects/[slug]/graph` UI consumes), Module 08b CLI Expansion (the 20-command vocabulary `/init`/`/projects/[slug]/doctor`/`/projects/[slug]/logs` mirrors).
> **Blocks:** Module 07 VS Code Extension's session panel (it expects a stable web for deep-link previews to `/projects/[slug]/runs/[id]`), team-mode hosted deploy (Phase 2 closes the gaps that make a hosted M04 actually usable across an org).
> **Aware of:** Module 05 NL Assembly will eventually own a `/projects/[slug]/search` route (semantic Context-Pack search) — out of Phase 2 scope. Module 06 Semantic Diff will eventually overlay `/projects/[slug]/runs/[id]/diff` — not in Phase 2. Module 10 RLS rollout will land row-level-security on the same Postgres tables — not coupled.
> **Source of truth:** `system-architecture.md` §0 (corrections), §16 patterns 1 (idempotency on every web mutation), 12 (admin authority — `/init`, pack mutations, service control), 19 (auth — solo bypass / Clerk JWT), 20 (bridge-mediated session lifecycle — doctor + logs read what the bridge wrote), §17 (Graphify producer/reader split). Visual identity: `docs/brand/brand.md` + `brand.html` (Phase 1 token catalog already ported; Phase 2 adds spacing scale + dark-mode toggle + revised layout grid). User directives 2026-04-24 (no marketing site, no BYO-cloud team variant), 2026-05-03 (M04 OQ locks), 2026-05-04 (Phase 2 brief + IA pivot + merge plan).

## 1. What Phase 2 is

Phase 2 finishes M04 with **four overlapping classes of work**:

1. **IA pivot — hub-and-spoke project model.** Phase 1 left every list flat at the top level (`/runs`, `/policies`, `/projects`, `/packs`); the user could see all entities from all projects at once. Phase 2 flips this to a **hub-and-spoke model**: `/` becomes a project picker (cards), and every operational surface lives under `/projects/[slug]/...`. The user picks a project, then operates inside it.
2. **Visual rework.** Phase 1 used the brand-token catalog correctly but laid pages out operator-tight (16px gutters, single-column tables, italic empty states). Phase 2 doubles spacing, introduces card layouts on the picker, enforces typography rhythm, colorizes metric tiles per status palette, ships dark-mode toggle, and makes mobile responsive.
3. **Action-layer parity with the CLI.** Phase 1 was 80% read-only; only kill-switches, policy add-rule, policy active-toggle, and project reset had write surfaces. Phase 2 closes the gap so every CLI verb has a web equivalent — including `init`, `start/stop/status`, `pack new/regen/delete`, `template install`, `export`, and the doctor + logs surfaces that previously only existed in the terminal.
4. **Data-quality bugs (S1 already shipped).** F1 (force-dynamic), F2 (`__global__` sentinel filter), F3 root-cause + 0008 backfill (run-recorder `ensureProject` + `ensureSessionOpenInflight`), F4 (Untracked chip) — all landed in commit `4832369` on this branch.

**Why now.** M08b shipped the CLI vocabulary (20 commands) and Phase 1 shipped the data-display shell of that vocabulary in HTML. Phase 2 makes the web equal-power with the CLI, organized around how operators actually think about Coodra (per-project), and pretty enough that the Stage demo isn't embarrassing.

**What Phase 2 is NOT.**
- Not a marketing site / public docs portal.
- Not `/projects/[slug]/search` — semantic Context-Pack search is M05.
- Not `/projects/[slug]/runs/[id]/diff` — semantic diff is M06.
- Not RLS — M10 owns row-level-security on the Postgres tables.
- Not a billing UI / seat management — out of scope per the standing 2026-04-24 directive.
- Not a token-catalog rewrite — the existing tokens stay; only the layout grid + spacing scale change.

## 2. Acceptance criteria

A commit on `feat/04-web-app` is "complete (Phase 1 + Phase 2)" when **every** item below holds on a clean checkout, in addition to all 15 Phase 1 ACs:

1. **Workspace integration:** Phase 2 introduces no new workspace package; `apps/web` gains files only. `pnpm install` clean. `turbo.json` pipeline unchanged.
2. `pnpm lint` — Biome zero findings across `apps/web/**` plus the `apps/hooks-bridge/src/lib/run-recorder.ts` Phase 2 touches (S1 only).
3. `pnpm typecheck` — `tsc --noEmit` clean across the workspace.
4. `pnpm test:unit` — every existing test still passes; Phase 2 adds tests for: project-slug URL extraction, project picker filtering, scoped query plumbing, S1 guards (already done), markdown renderer XSS, FP editor marker round-trip, graph empty-state CTA, doctor row contract, logs SSE re-subscribe, sync queue aggregation, init wizard validation, service control, template install action, export action.
5. `pnpm test:integration` — new tests: (a) every scoped query returns rows only for the URL-bound project, (b) creating a project via `/init` lands at `/projects/[newSlug]` not at the top-level dashboard, (c) `/sync` reads `pending_jobs` from live Supabase Postgres without daemon contention.
6. `pnpm test:e2e` — extended to: load `/`, click into a project, switch via the project switcher, return to `/`, create a new project via `/init`, assert it appears in the picker.
7. **Schema delta:** **NONE.** Phase 2 reads + writes the existing 11-table schema. The orphan-event backfill (S1) is the only data migration (`0008_run_events_orphan_backfill.sql`).
8. **Backwards compatibility:** every CLI command (M08a + M08b — 20 commands) keeps its surface verbatim. The web's URL changes are clean-break (no redirect from old `/runs` to `/projects/[slug]/runs`) — acceptable because M04 hasn't shipped publicly.
9. **Mode parity:** every Phase 2 route renders correctly in BOTH `COODRA_MODE=solo` and `COODRA_MODE=team`. `/sync` is the only team-only top-level route. `/settings/team` already team-only from Phase 1.
10. **Brand fidelity (Phase 2 visual contract):**
    - **Spacing scale**: 8px base; section padding `--space-6` (24px), tile gap `--space-8` (32px), row padding `--space-4` (16px), card padding `--space-6` (24px). New `--space-12` (48px) and `--space-16` (64px) for hero whitespace.
    - **Typography rhythm**: H1 56/64 font-display font-black uppercase, H2 32/40 font-display font-bold uppercase, H3 20/28 font-display font-bold uppercase, body 14/22 font-sans, mono 13/20 font-mono.
    - **Status palette colorizes counts**: every metric tile uses the right status color (info / success / warning / error / neutral); never hardcoded.
    - **Zero rounded corners** still enforced via the `* { border-radius: 0 }` rule.
    - **Mobile**: tables collapse to stacked cards below 768px; HeaderNav becomes hamburger below 640px.
    - **Dark-mode toggle**: lives in the user menu; persists via cookie; tokens already exist for both modes.
11. **Auth model:** every project-scoped route inherits Phase 1's middleware. `/init` and all mutating server actions require an authenticated actor in team mode; solo bypass works the same way.
12. **Live updates contract:** project picker tiles poll at 5000ms (slower than per-project data because cross-project aggregates are cheaper to refresh). `/projects/[slug]` dashboard tiles poll at 1500ms (Phase 1 contract preserved). `/projects/[slug]/doctor` polls at 3000ms. `/projects/[slug]/logs/<service>` uses SSE. `/sync` polls at 5000ms.
13. **S1 fixes hold** (commit `4832369`): force-dynamic on `/`, `/projects/[slug]`, `/projects/[slug]/packs`, `/projects/[slug]/packs/[slug]`, `/projects/[slug]/templates`. `__global__` filter in `listProjects()`. Bridge `resolveAndEnsure` + `ensureSessionOpenInflight`. Migration 0008 idempotent. Untracked chip on dashboard. **Verified live 2026-05-04**.
14. **IA migration:** every Phase 1 top-level operational route (`/runs`, `/policies`, `/projects`, `/packs`, `/templates`, `/kill-switches`) is gone from the URL space. Their replacements live under `/projects/[slug]/...`. The only top-level routes are: `/`, `/init`, `/sync` (team-mode), `/settings/{account,team,workspace}`, `/auth/*`. (See §4.)
15. **Project picker UX:** `/` renders cards (not a table) with: project name, last-activity timestamp, active runs count, denials-24h count, active pauses count, status dot. Searchable. Sortable by name / last-activity. Has a "+ Create project" CTA linking to `/init`.
16. **Per-project home:** `/projects/[slug]` shows 4 tiles (Active runs / Denials · 24h / Active pauses / Doctor) scoped to the project, plus the latest 10 events for THIS project, plus a project-info sidebar (slug, org, mode, registered date, sidecar path).
17. **Project sub-nav:** the secondary navigation row (Runs · Policies · Packs · Context Packs · Templates · Kill switches · Graph · Doctor · Logs · Settings) appears on every `/projects/[slug]/*` route, with the active section underlined.
18. **Context Packs surface** (NEW vs Phase 1): `/projects/[slug]/context-packs` lists every CP for the project; `/projects/[slug]/context-packs/[id]` renders the full markdown body via the S4 markdown renderer. (Currently CPs are only visible inside `/runs/[id]` as a tab.)
19. **Project Settings surface** (NEW vs Phase 1): `/projects/[slug]/settings` shows project metadata and admin actions: rename (slug regex-validated), archive (sets is_active=false), reset (deletes runs + events; S1's existing `resetProject()`), delete (cascades), export (JSON + JSONL of runs/events/decisions/CPs).
20. **`/init` wizard** (per Phase 1's planned S3): web parity with `coodra init --project-slug X --no-graphify --ide claude`. On submit, redirects to `/projects/[newSlug]` (not back to `/`).
21. **Action-layer parity table** (§16) is fully implemented: every CLI verb in M08a/M08b has a web equivalent in this Phase 2.
22. **Service control surface** (NEW vs Phase 1): `/settings/workspace` exposes `start`/`stop`/`status` for the bridge + mcp-server + sync-daemon; calls into the same library entry the CLI uses.
23. **Template install action** (NEW vs Phase 1): `/projects/[slug]/templates` has an "Install from path" button → server action wraps `coodra template install <path>`.
24. **Export action** (NEW vs Phase 1): `/projects/[slug]/settings/export` button generates a downloadable archive (JSONL of runs/events/CPs/decisions for the project).
25. **AC #25 (S1 already shipped):** `apps/hooks-bridge/src/lib/run-recorder.ts::ensureSessionOpenInflight` + `resolveAndEnsure(cwd)` — verified live; new orphan ingress impossible.
26. **AC #26 (S10):** `/projects/[slug]/graph` empty-state CTA copy contains the install command + ADR-010 Slice 11 anchor reference.
27. **Module 04 final Context Pack** updated to cover Phase 2 closeout. README module-status table flips `04 ✅ complete (Phase 1 + Phase 2)`.

## 3. Non-goals

- **No new schema tables.** Phase 2 reads + writes the same 11.
- **No `/projects/[slug]/search` route** — semantic CP search lives in M05.
- **No `/projects/[slug]/runs/[id]/diff` overlay** — semantic diff lives in M06.
- **No RLS in this PR** — row-level security on Postgres is M10.
- **No Graphify producer** — ADR-010 defers to a future module; Phase 2 only ships the reader UI.
- **No realtime collaboration on the FP editor** — single-writer assumption; last-writer-wins with ETag warning banner.
- **No keyboard-shortcut layer** — reserved for M07 (VS Code).
- **No marketing copy in `/init`** — operator-grade strings only.
- **No CLI bundle changes for service control** — `/settings/workspace` shells out to the bundled CLI's `runStart`/`runStop`/`runStatus` library exports (S12 promotes these).
- **No "soft-delete to .trash/" for packs** — Phase 2 matches the real CLI behavior (rm + soft-flip is_active), per OQ-7 reconciliation.

## 4. Routes — the surface (after IA migration)

**Project-picker hub** (top-level home):

| URL | What | Solo | Team |
|-----|------|------|------|
| `/` | Project picker — cards per project, search, "+ Create" CTA, recent activity tray | ✓ | ✓ |
| `/init` | Project provisioning wizard | ✓ | ✓ |

**Project-scoped surfaces** (everything operational):

| URL | What | Phase | Notes |
|-----|------|-------|-------|
| `/projects/[slug]` | Project home — 4 tiles + latest events + project-info sidebar | S2b | replaces Phase 1 `/` content, scoped |
| `/projects/[slug]/runs` | Runs list, filterable by status | S2a | moved from `/runs` |
| `/projects/[slug]/runs/[id]` | Run detail | S2a | moved from `/runs/[id]` |
| `/projects/[slug]/runs/[id]/live` | Run detail w/ polling | S2a | moved from `/runs/[id]/live` |
| `/projects/[slug]/policies` | Policy list | S2a | moved from `/policies` |
| `/projects/[slug]/policies/[name]` | Policy detail + add-rule | S2a | moved from `/policies/[id]` |
| `/projects/[slug]/packs` | Feature pack list (filtered by parentSlug) | S2a | moved from `/packs` |
| `/projects/[slug]/packs/[slug]` | Pack detail (markdown viewer in S4) | S2a → S4 | moved from `/packs/[slug]` |
| `/projects/[slug]/packs/[slug]/edit` | Pack editor (auto-marker preserving) | S6 | NEW |
| `/projects/[slug]/packs/[slug]/runs` | FP↔CP linkage panel | S7 | NEW |
| `/projects/[slug]/context-packs` | Context Packs list | S9 | NEW (was buried in /runs/[id] tab) |
| `/projects/[slug]/context-packs/[id]` | Context Pack detail | S9 | NEW |
| `/projects/[slug]/templates` | Templates available + install action | S2a + S13 | moved from `/templates` |
| `/projects/[slug]/kill-switches` | Kill-switch admin (scoped) + workspace tab | S2a | moved from `/kill-switches` |
| `/projects/[slug]/graph` | Codebase graph reader (empty state with CTA when index missing) | S10 | NEW |
| `/projects/[slug]/doctor` | Project-scoped doctor checks | S8 | NEW |
| `/projects/[slug]/logs/[service]` | Log tail SSE | S11 | NEW |
| `/projects/[slug]/settings` | Project settings — rename / archive / reset / delete / export | S14 | NEW |

**Workspace-scoped surfaces** (cross-project):

| URL | What | Phase | Notes |
|-----|------|-------|-------|
| `/sync` | Pending-jobs queue admin (team mode only) | S15 | (was Phase 1's planned S11) |
| `/settings/workspace` | Service control + workspace prefs (theme, default mode) | S12 | NEW |
| `/settings/account` | Clerk UserProfile widget | M04 | unchanged |
| `/settings/team` | Clerk OrganizationProfile (team-mode) | M04 | unchanged |
| `/auth/sign-in/[[...sign-in]]` | Clerk sign-in | M04 | unchanged |
| `/auth/sign-up/[[...sign-up]]` | Clerk sign-up | M04 | unchanged |

**API endpoints**:

| Method | Path | Returns | Phase |
|--------|------|---------|-------|
| `GET` | `/api/healthz` | `{ok, service, mode, serverStartedAt}` | M04 |
| `GET` | `/api/projects/[slug]/state` | dashboard JSON for project-home polling | S2b |
| `GET` | `/api/projects/[slug]/runs/[id]/state` | run state JSON (moved from `/api/runs/[id]/state`) | S2a |
| `GET` | `/api/projects/[slug]/doctor/state` | doctor JSON for `/projects/[slug]/doctor` polling | S8 |
| `GET` | `/api/projects/[slug]/logs/[service]/stream` | SSE log tail | S11 |
| `GET` | `/api/sync/state` | sync queue JSON (team-mode) | S15 |
| `GET` | `/api/picker/state` | aggregated picker tiles JSON for `/` polling | S2b |

**Total surface after Phase 2**: 22 page routes + 7 API endpoints (Phase 1 had 12 + 2 — net +10 pages, +5 endpoints).

## 5. Schema deltas

**None for tables.** Phase 2 reads + writes the existing 11. S1 already shipped the only data migration (`0008_run_events_orphan_backfill.sql`).

## 6. Project context — URL-based, not cookie-based

The pre-pivot Phase 2 spec used a cookie (`coodra_selected_project`) to remember the active project across navigation. The IA pivot drops the cookie entirely — the URL itself carries the project slug via `[slug]` segment. Benefits:

- **Deep-linkable.** Sharing `/projects/coodra-dev/runs/run:xyz` works; cookie-based scoping required the recipient to also have set the cookie.
- **No cross-tab leakage.** Two browser tabs can sit on different projects; a cookie would tie them together.
- **Browser back/forward = project switching.** Native UX, no JS state to manage.
- **Bookmarks land where the user expects.**

The active project slug comes from `params.slug` in every route under `/projects/[slug]/*`. A small helper `apps/web/lib/project-context.ts::getProjectFromParams(params)` resolves slug → projects row, throws 404 if not found, returns the row. Every server action takes `projectSlug` as a form field.

The project switcher button in `HeaderNav` (when inside a project) is just a `<select>` that does a hard-navigation to `/projects/[newSlug]/...same-tail`, OR shows "Back to all projects" linking to `/`.

## 7. Visual rework — concrete deltas (per AC #10)

These ride inside the relevant slices (no separate "visual" slice — too easy to skip).

### 7.1 Spacing scale (extends `apps/web/styles/tokens.css`)

```css
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;     /* row padding */
  --space-6: 24px;     /* section padding, card padding */
  --space-8: 32px;     /* tile gap */
  --space-12: 48px;    /* hero spacing */
  --space-16: 64px;    /* very large gaps (page top) */
}
```

(Phase 1 has `--space-1` through `--space-8`; Phase 2 adds 12 + 16.)

### 7.2 Typography utilities (no new tokens — just consistent application)

```tsx
// H1 — pages titles
<h1 className="font-display text-[56px] leading-[64px] font-black uppercase">

// H2 — section headings
<h2 className="font-display text-[32px] leading-[40px] font-bold uppercase">

// H3 — sub-section / card titles
<h3 className="font-display text-[20px] leading-[28px] font-bold uppercase">

// Body
<p className="font-sans text-[14px] leading-[22px]">

// Mono / IDs / paths / code
<span className="font-mono text-[13px] leading-[20px]">
```

A `lib/typography.ts` exports these as `H1`, `H2`, `H3`, `Body`, `Mono` components for consistency. Every page uses these — no ad-hoc `text-4xl font-black uppercase`.

### 7.3 Card layout (project picker)

```
┌─────────────────────────────────────────────────────┐
│ COODRA-DEV                              [● active]  │
│ ─────────────────────────────────────────────────── │
│  4         2          0          ✓                  │
│  ACTIVE    DENIES     PAUSES     DOCTOR             │
│  RUNS      24H                                      │
│ ─────────────────────────────────────────────────── │
│  Last activity 2 min ago · /Users/abishaikc/Coodra  │
└─────────────────────────────────────────────────────┘
```

12-column grid, cards are 4 columns wide (3 per row at desktop, 2 at tablet, 1 at mobile). Whole card is a clickable `<Link>` to `/projects/[slug]`. `Last activity` reads from the most-recent `runs.started_at` for that project. Status dot color: green (running, healthy), amber (warnings), red (active denials trending), gray (idle).

### 7.4 Status palette colorization

Counts on tiles use the brand status palette per value:

- 0 active runs → `--color-text-tertiary` (gray)
- ≥1 active runs → `--color-status-info` (blue)
- 0 denials → `--color-status-success` (green)
- ≥1 denials → `--color-status-error` (red)
- 0 pauses → `--color-text-tertiary`
- ≥1 pauses → `--color-status-warning` (amber)
- doctor 0/0 → `--color-status-success`
- doctor any-yellow → `--color-status-warning`
- doctor any-red → `--color-status-error`

Phase 1 colorized SOMETIMES; Phase 2 makes it consistent everywhere.

### 7.5 Empty states

Pre-Phase-2 empty state pattern:
```
"No activity yet."
"Open Claude Code in this project to see events flow into this view."
```

Phase 2 pattern:
```
[ illustration glyph ]
NOTHING HERE YET
A short, operator-tone explanation in 1-2 sentences.
[ Primary CTA button ]   [ Tertiary "learn more" link ]
```

Glyphs are 64x64 SVGs in `apps/web/components/glyphs/` (5-6 of them: `empty-runs`, `empty-policies`, `empty-packs`, `empty-graph`, `empty-logs`, `empty-pauses`). Hand-drawn line-art in brand-blue.

### 7.6 Mobile breakpoints

- `< 640px`: HeaderNav becomes hamburger; project sub-nav becomes scrollable horizontal pill bar.
- `< 768px`: tables collapse to vertical card lists (each row becomes a card with stacked label/value pairs).
- `< 1024px`: grid drops from 4-col to 2-col; project-picker cards drop from 3-per-row to 2.

Tested in Chrome DevTools mobile simulator + a real phone.

### 7.7 Dark-mode toggle

Lives in the user menu (top-right). Persists via `theme` cookie (HttpOnly: false so client can also read). On change, the `<html data-theme="dark">` attribute flips — tokens.css already defines both modes, so it's instant.

## 8. The 9 OQs — locked (post-pivot reconciliation)

All locks recorded in `context_memory/decisions-log.md`.

### OQ-1 — Project IA — **RE-LOCKED 2026-05-04 to (c) hub-and-spoke**
Originally locked (a) dropdown. User pushback 2026-05-04: dropdown forces every page to do its own scoping, the URL doesn't carry project context, deep-links don't scope. Hub-and-spoke = one project picker + nested URL paths. Cleaner, more native, fits how the CLI thinks about projects.

### OQ-2 — Orphan `run_events` — **locked (a) backfill + bridge `ensureProject(cwd)` mandatory** — DONE in S1
Already shipped commit `4832369`.

### OQ-3 — FP editor — **locked (b) section-aware**
S6 implements.

### OQ-4 — `/init` wizard — **locked (a) mirror exact `coodra init`**
S3 implements.

### OQ-5 — `/graph` — **locked (c) react-flow + symbol search; AND mandatory empty-state CTA**
S10 implements.

### OQ-6 — `/logs/<service>` — **locked (a) SSE**
S11 implements.

### OQ-7 — Pack mutations — **locked: match real CLI (rm + soft-flip is_active)**
S5 implements. Re-lock checkpoint reserved before S5 starts to give user one last call.

### OQ-8 — `/sync` — **locked (b) per-table breakdown + dead-letter retry**
S15 implements.

### OQ-9 — F1 fix — **locked (a) force-dynamic** — DONE in S1
Already shipped.

## 9. Action-layer parity table (per AC #21)

Every CLI verb in M08a + M08b → a web equivalent. Status as of S1:

| CLI command | Web equivalent | Slice |
|---|---|---|
| `coodra init` | `/init` | S3 |
| `coodra start` | `/settings/workspace` → "Start services" button | **S12** |
| `coodra stop` | `/settings/workspace` → "Stop services" button | **S12** |
| `coodra status` | `/settings/workspace` → live service status panel | **S12** |
| `coodra doctor` | `/projects/[slug]/doctor` (project-scoped) + `/settings/workspace` (workspace) | S8 |
| `coodra doctor --full --json` | API endpoint `/api/projects/[slug]/doctor/state?full=true` | S8 |
| `coodra policy add-rule` | `/projects/[slug]/policies/[name]` form | M04 ✓ |
| `coodra policy list/show` | `/projects/[slug]/policies` + `/projects/[slug]/policies/[name]` | M04 ✓ |
| `coodra policy active` | `/projects/[slug]/policies/[name]` toggle | M04 ✓ |
| `coodra project list` | `/` picker | **S2b** |
| `coodra project show` | `/projects/[slug]` + `/projects/[slug]/settings` | **S2b + S14** |
| `coodra project reset` | `/projects/[slug]/settings` reset form | M04 ✓ |
| `coodra run list` | `/projects/[slug]/runs` | M04 (moved in S2a) |
| `coodra run show` | `/projects/[slug]/runs/[id]` | M04 (moved in S2a) |
| `coodra pack new` | `/projects/[slug]/packs` "+ New pack" → uses S5 install action | **S5** |
| `coodra pack list/show` | `/projects/[slug]/packs` + `/projects/[slug]/packs/[slug]` | M04 + S4 |
| `coodra pack regenerate` | `/projects/[slug]/packs/[slug]` action bar | **S5** |
| `coodra pack delete` | `/projects/[slug]/packs/[slug]` action bar | **S5** |
| `coodra template list` | `/projects/[slug]/templates` | M04 (moved in S2a) |
| `coodra template install` | `/projects/[slug]/templates` "Install from path" form | **S13** |
| `coodra pause new` | `/projects/[slug]/kill-switches` form | M04 ✓ |
| `coodra pause list` | `/projects/[slug]/kill-switches` table | M04 ✓ |
| `coodra pause resume` | `/projects/[slug]/kill-switches` row action | M04 ✓ |
| `coodra export` | `/projects/[slug]/settings` "Export project" button | **S14** |
| `coodra logs <service>` | `/projects/[slug]/logs/<service>` | S11 |

20 commands → 20 web surfaces. Net new for Phase 2 to fill the gap: `init` (S3), `start/stop/status` (S12), `template install` (S13), `export` (S14), `pack new/regen/delete` (S5).

## 10. Slice plan — 14 slices (S2 → S15)

Per user direction 2026-05-04, post-pivot:

| Slice | Scope |
|---|---|
| **S1** | DONE — F1 + F2 + F3 root-cause + 0008 backfill + F4. Commit `4832369`. |
| **S2** | **IA migration.** Three-phase commit: (S2a) move every operational route under `/projects/[slug]/*`; (S2b) build `/` project picker hub + `/projects/[slug]` project home; (S2c) new HeaderNav + ProjectSubNav components. Visuals stay simple — visual rework lands per-slice. |
| **S3** | `/init` wizard (form + Server Action wrapping `runInit` library promotion). On success, redirect to `/projects/[newSlug]`. |
| **S4** | `/projects/[slug]/packs/[slug]` markdown renderer (read-only). React-markdown + GFM + sanitize. |
| **S5** | `/projects/[slug]/packs/[slug]` mutations: regenerate / delete / install-template. **Re-lock OQ-7 here.** Match CLI semantics (rm + soft-flip is_active). |
| **S6** | `/projects/[slug]/packs/[slug]/edit` feature pack editor (section-aware, auto-marker-preserving). |
| **S7** | `/projects/[slug]/packs/[slug]/runs` FP↔CP linkage panel. |
| **S8** | `/projects/[slug]/doctor` live page + dashboard doctor tile activation (project-scoped + workspace-scoped). |
| **S9** | `/projects/[slug]/context-packs` list + `/projects/[slug]/context-packs/[id]` detail. NEW surface; CPs were previously only inside `/runs/[id]` tab. |
| **S10** | `/projects/[slug]/graph` codebase-graph reader (empty state with mandatory CTA + symbol table + react-flow subgraph). |
| **S11** | `/projects/[slug]/logs/[service]` SSE log tail. |
| **S12** | **NEW (action layer):** `/settings/workspace` — service control buttons (start/stop/status) + workspace prefs (theme toggle, default mode). Library promotion of `runStart` / `runStop` / `runStatus` from `packages/cli/src/commands/{start,stop,status}.ts`. |
| **S13** | **NEW (action layer):** `/projects/[slug]/templates` "Install from path" form (Server Action wraps `runTemplateInstall` library promotion). |
| **S14** | **NEW (action layer):** `/projects/[slug]/settings` — full settings surface incl. rename / archive / delete. Plus `/projects/[slug]/settings/export` button → JSONL archive download. Library promotion of `runExport`. |
| **S15** | `/sync` (team-mode workspace queue admin) + Phase 2 closeout (Context Pack + README flip + merge with Phase 1 in one squash to `main`). |

Net 14 active slices (S2-S15). With S1 already done = Phase 2's full envelope.

## 11. Pre-Phase-2 fix-ups PR — NOT NEEDED (still)

The user's original 2026-05-04 brief asked for the `.strict()` Stop hook to be the first item of a fix-up PR. Per `docs/audit/2026-05-04-strict-bug-status.md`, the bug was already remediated by Phase 3 Fix A on 2026-05-02 (commit `19ccc1f`). S1 verified `.passthrough()` is in place at `packages/shared/src/hooks/payloads/claude-code.ts:57`. No fix-up PR needed.

## 12. Verification checklist (squash-merge of `feat/04-web-app` to `main`)

After S15 lands, before squash-merge:

1. `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:integration`. All green.
2. Stop services. Backup + purge `~/.coodra/data.db`.
3. `coodra init --project-slug coodra-dev-final --no-graphify --ide claude`; `coodra start`; `coodra doctor` — green.
4. Boot web in solo mode. Open `/`. Should see ONE project (`coodra-dev-final`) as a card.
5. Use `/init` wizard to provision a SECOND project (`alpha`); switch via picker; verify `/projects/alpha/runs`, `/projects/alpha/policies`, etc. scope correctly.
6. Drive synthetic traffic (the same 14-event script from the audit) into the bridge for `coodra-dev-final`; refresh `/projects/coodra-dev-final`; tile values match SQLite.
7. Edit a feature pack via `/projects/.../packs/coodra-dev-final/edit`; assert auto-managed sections survived round-trip.
8. Trigger pack delete on a non-essential pack; confirm the disk dir is gone AND `feature_packs.is_active=false`.
9. Open `/projects/.../logs/hooks-bridge`; in another terminal `echo 'manual line' >> ~/.coodra/logs/hooks-bridge.log`; assert the line appears in <500ms.
10. Switch to team mode (`COODRA_MODE=team` env + restart); verify `/sync` renders queue depth (or empty state).
11. Toggle dark mode in user menu; assert all routes re-render in dark.
12. Resize browser to 375px; assert tables collapse to cards, HeaderNav becomes hamburger.

All twelve pass → ready to squash-merge.

## 13. Out of scope for Phase 2 (deferred)

- **`/projects/[slug]/search`** (semantic CP search) — M05 NL Assembly.
- **`/projects/[slug]/runs/[id]/diff`** (semantic diff overlay) — M06.
- **RLS / per-org row scoping** — M10.
- **`.trash/` soft-delete for packs** — out per OQ-7 reconciliation. CLI follow-up if both surfaces want undo semantics.
- **Web-side Graphify producer** — out per ADR-010. Reader-only.
- **Realtime collaborative FP editor** — single-writer, last-writer-wins.
- **Mobile-specific layouts beyond responsive breakpoints** — Phase 2 is responsive; native mobile shell is out.
- **Accessibility audit beyond keyboard-nav + WCAG-AA tokens** — separate pass via M07.
- **i18n / translations** — English-only.
- **Browser-extension auth** — solo-bypass + Clerk only.
