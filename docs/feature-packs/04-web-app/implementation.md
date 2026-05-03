# Module 04 — Web App — Implementation

> Slice-by-slice work breakdown for `feat/04-web-app`. Read `spec.md` first for scope and `techstack.md` for runtime/dep choices. Decisions made mid-implementation get logged in `context_memory/decisions-log.md` (see `essentialsforclaude/03-context-memory.md`) and mirrored to the MCP via `contextos__record_decision`.

## Prerequisites (one-time, before S0.5)

These are already in place as of the S0 commit:

- ✅ Branch `feat/04-web-app` cut from `main` at `652fb05` (M08b post-S19 fixup).
- ✅ `.env` populated with `DATABASE_URL` (Supabase pooled connection — verified reachable, Postgres 17.6, `vector` extension available), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PROJECT_REF=gyopozvfmggumidptmjr`, plus the existing Clerk dev keys (`CLERK_PUBLISHABLE_KEY=pk_test_...`, `CLERK_SECRET_KEY=sk_test_...`).
- ✅ `supabase` CLI installed (v2.95.4 via `brew install supabase/tap/supabase`); `supabase init` ran at repo root → `supabase/config.toml` (project_id="Coodra"). `supabase/.temp/` gitignored.
- ✅ Auto-memory (`~/.claude/projects/-Users-abishaikc-Coodra/memory/supabase-project.md`) updated to point at the new project + `@supabase/ssr` boilerplate snippets the user prefers.
- ✅ Pending-user-actions reconciled: Clerk creds ✅, Supabase ✅, Module 03.1 ✅; remaining team-mode infra (Upstash Redis, deploy target, Clerk prod tenant) is post-M04.

**Outstanding before S2:**

- The pre-M04 fix-ups PR (`fix/pre-m04-blockers`) must merge to `main` BEFORE `feat/04-web-app/S1` opens. See `spec.md` §12. Branch off `main`, three commits in order: `.strict()` → policy seed → `seedFeaturePack`. Land on `main` via squash-merge. Rebase `feat/04-web-app` on the new `main` before continuing.
- `! supabase login` (browser-interactive — operator runs themselves). Optional for M04 — Drizzle owns migrations; CLI is only useful for `gen types typescript --linked` which `packages/db`'s `$inferSelect` supersedes.

## Slice sequence

### S0 — Feature pack docs (this commit)

**Done.** Publishes `docs/feature-packs/04-web-app/{spec,implementation,techstack,meta.json}` with the seven OQs locked + three structural decisions recorded. Mirrors the M08b S0 shape (commit `ee8ac9c`).

**Files written:**
- `docs/feature-packs/04-web-app/spec.md` (~600 lines: what M04 is, AC, non-goals, routes, first-5-min, schema deltas, storage adapter, polling, auth, kill-switch sync, brand contract, pre-M04 fix-up PR plan, locked OQs)
- `docs/feature-packs/04-web-app/implementation.md` (this file: 14 slices + verification + out-of-scope)
- `docs/feature-packs/04-web-app/techstack.md` (runtime, deps, brand-token mechanics)
- `docs/feature-packs/04-web-app/meta.json` (sourceFiles glob, parentSlug=08b)
- `context_memory/decisions-log.md` appended with M04 OQ-1…OQ-7 + STRUCT-1…STRUCT-3
- `context_memory/current-session.md` rotated (M08b session archived to `sessions/2026-05-03-*.md`; new session opens for M04 S0)

**Verification (this commit):** none beyond `pnpm lint` + `pnpm typecheck` (docs-only — neither runs against markdown). Manual review by reading the four files end-to-end.

**Single commit:** `docs(04-web-app): kickoff spec + slice plan + locked OQ answers`. Same shape as M08b S0 (`ee8ac9c`).

---

### S0.5 — IA + nav map + key-screen wireframes (UI/UX foundation)

**Why S0.5 and not S1.** The project lead's directive 2026-05-03: M04 is the UI/UX module — give the feature slices a target before scaffolding. Wireframes tie the brand catalog (brand.md / brand.html) to the route surface (spec §4) and to the polling cadence (spec §8). Without S0.5, S1 ships chrome that S5 has to redo.

**Outputs:**

- `docs/feature-packs/04-web-app/wireframes/00-information-architecture.md` — page tree with parent/child relationships, breadcrumb scheme, header/footer chrome, the Solo-vs-Team affordance differences (e.g. team gets an org switcher in the header).
- `docs/feature-packs/04-web-app/wireframes/01-nav-map.md` — global nav (top + side), per-route mini-nav, the dashboard tile grid, the run-detail timeline pattern, the kill-switch admin form pattern.
- `docs/feature-packs/04-web-app/wireframes/02-screens/` — one ASCII / textual wireframe per route (mobile + desktop breakpoints), referencing brand.md tokens by name (e.g. "header uses Inter 900 + 56/64 + Off-Black on Surface, Precision Blue dot indicator at right when ContextOS Mode = team").
  - `dashboard.md` (`/`) — five tiles + recent events list + status palette mapping
  - `runs-list.md` (`/runs`)
  - `run-detail.md` (`/runs/[id]`) + `run-live.md` (`/runs/[id]/live`)
  - `policies.md` + `policy-detail.md`
  - `projects.md` + `project-detail.md`
  - `packs.md` + `pack-detail.md`
  - `templates.md`
  - `kill-switches.md`
  - `auth.md` (sign-in / sign-up; Clerk's appearance prop usage)
  - `settings-team.md` (org members; Clerk org component embed)
- `docs/feature-packs/04-web-app/wireframes/03-component-inventory.md` — every reusable component a slice can lean on (StatusChip, RiskBadge, ToolBadge, RunEventRow, DecisionCard, TileGrid, PageHeader, EmptyState, ConfirmDialog, FormField, etc.) with brand-token-name annotations.

**Source-of-truth move:** S0.5 also moves `brand.md` and `brand.html` from repo root to `docs/brand/` and adds a `docs/brand/README.md` mapping. The user dropped them at root for the kickoff turn; they belong under `docs/`.

**Acceptance:** the wireframes render the entire route surface from spec §4. Every screen names its tokens. The component inventory is consumable by S1 to bake primitives. Reviewed by the user (sync) before S1 starts.

**Single commit:** `docs(04-web-app): S0.5 — IA + nav map + key-screen wireframes; relocate brand sources under docs/brand/`.

---

### S1 — Scaffold `apps/web` (Next.js 15 + Tailwind v4 + brand tokens + Supabase + Clerk solo bypass)

**Files created:**

- `apps/web/` — Next.js 15 app with App Router, React 19, TypeScript strict
- `apps/web/package.json` — name `@coodra/contextos-web`, `private: true`, deps from `techstack.md`
- `apps/web/next.config.ts` — `experimental.serverActions = true`, runtime config for `CONTEXTOS_MODE`, `transpilePackages: ['@coodra/contextos-shared', '@coodra/contextos-db']`
- `apps/web/tailwind.config.ts` (or `app/globals.css` Tailwind v4 CSS-first config) — `@theme` block consumes the token catalog
- `apps/web/styles/tokens.css` — **the full brand catalog** (per OQ-5 lock + spec §11): colors, typography, spacing, motion, elevation, status palette, risk-level palette
- `apps/web/styles/globals.css` — Tailwind directives + body defaults + reset
- `apps/web/app/layout.tsx` — root layout with header / chrome, mode-aware (Solo badge vs org switcher)
- `apps/web/app/page.tsx` — placeholder home that says "Module 04 S1 scaffold — dashboard lands in S9"
- `apps/web/app/api/healthz/route.ts` — `200 ok`
- `apps/web/middleware.ts` — solo bypass / team Clerk-protected (per OQ-3 + spec §9)
- `apps/web/utils/supabase/{server,client,middleware}.ts` — exact boilerplate from `~/.claude/.../memory/supabase-project.md` (the user-preferred SSR pattern)
- `apps/web/lib/db.ts` — `createWebDb()` storage adapter (per OQ-1 + spec §7) — direct better-sqlite3 in solo, Drizzle pg pool in team
- `apps/web/lib/auth.ts` — `getActor()` resolver returning `{ userId, orgId, mode }` per OQ-3
- `apps/web/lib/poll.ts` — `usePoll<T>` hook skeleton per spec §8 (full impl + tests in S4)
- `apps/web/components/{StatusChip,RiskBadge,ToolBadge}.tsx` — the three primitives from spec §11
- `apps/web/__tests__/unit/{db,auth,middleware,components}/*.test.ts` — unit coverage
- `pnpm-workspace.yaml` — `apps/web` added
- `turbo.json` — `apps/web#build`, `apps/web#dev`, `apps/web#typecheck`, `apps/web#lint` pipelines
- `apps/web/.env.local.example` — copy-template for the local dev env

**Clerk JWT issuer probe (replaces user-typed value):** S1's boot calls `https://clerk.<tenant>.accounts.dev/.well-known/jwks.json` derived from the publishable key's encoded `tenant`. If discovery returns a valid JWKS, pin the issuer URL in `apps/web/lib/clerk-issuer.ts` (computed at module load, no env round-trip). If discovery fails, the error includes the URL it tried so the operator can paste it back.

**Acceptance:**

- `pnpm --filter @coodra/contextos-web dev` boots on `:3000` in solo mode against the sandbox CONTEXTOS_HOME, renders the placeholder page using brand tokens (visible: Precision Blue interactive, Inter 900 header, JetBrains Mono badge, zero-radius). `/api/healthz` returns 200.
- Switching `CONTEXTOS_MODE=team` and pointing at the live `gyopozvfmggumidptmjr` Supabase boots and renders without DB error (the placeholder doesn't read DB yet — but the storage adapter resolves correctly).
- Clerk middleware short-circuits in solo (no sign-in screen); in team mode an unauthenticated GET 302s to Clerk-hosted sign-in.
- Lint, typecheck, unit tests pass.

**S1 explicitly does not:** apply Drizzle migrations to Supabase (S2's job), render any real data (S3+), wire SSE polling (S4), implement any admin write surface (S5+).

**Single commit:** `feat(web): M04 S1 — apps/web scaffold (Next.js 15 + Tailwind v4 + brand tokens + Supabase SSR + Clerk solo bypass)`.

---

### S2 — Apply Drizzle schema to Supabase Postgres + Clerk live-tenant smoke test

**Two work-streams in one slice** because both need the live cloud accessible and verifying both at once removes a future re-auth turn.

**Drizzle → Supabase:**

- Run `pnpm --filter @coodra/contextos-db migrate:cloud` against `DATABASE_URL` from `.env`. The existing `cloud-migrate` CLI command (already wired) walks `packages/db/drizzle/postgres/0000_*.sql` through `0007_*.sql`. The `0000` migration installs `vector` (currently available, not installed on the cloud).
- Verify: `psql $DATABASE_URL -c "\dt"` shows the 11 tables; `psql $DATABASE_URL -c "\dx vector"` shows `vector 0.8.0` installed.
- Apply RLS: a new migration `0008_rls_org_isolation.sql` adds row-level security on `projects` (filter by `org_id = current_setting('app.current_org')::text`) + cascade on `runs`, `run_events`, `policy_decisions`, etc. (read-side filter by `project_id IN (SELECT id FROM projects)`). The web's Drizzle client sets `app.current_org` per request from Clerk's `auth().orgId`.
- Update `cloud-migrate` README + acceptance test.

**Clerk live-tenant smoke:**

- New integration test at `apps/mcp-server/__tests__/integration/clerk-live-tenant.test.ts` that calls `verifyToken` from `apps/mcp-server/src/lib/auth.ts` against a real JWT minted by Clerk's dev tenant. The test is gated by `CLERK_LIVE_TEST=1` env var (off in CI; on for local + main-branch nightly). Pass criteria: valid token returns claims; expired/tampered tokens throw `TokenInvalid`.
- Closes the M02 S7b "live validation deferred to M04" gap.

**Acceptance:**

- 11 tables in cloud Postgres; `vector` extension installed; RLS enabled on every audit-trail table.
- Clerk live-tenant test passes with `CLERK_LIVE_TEST=1`.
- Web app in team mode against the live cloud renders the placeholder page (no real data yet — S3) without error.

**Single commit:** `feat(db,web): M04 S2 — apply Drizzle schema + RLS to Supabase, Clerk live-tenant smoke test`.

---

### S3 — Run list + run detail (read-only)

**Routes shipped:**

- `/runs` — server-rendered table with `status` filter + `project` filter + sort by `started_at` desc. Paginated 50 rows/page. Mobile-responsive (cards on `<sm`, table on `≥md`). Each row links to `/runs/[id]`.
- `/runs/[id]` — full timeline. Sections: header (status chip + agent + timestamps + run id in JetBrains Mono), `decisions` (rendered as `<DecisionCard>` per spec §11 inventory), `run_events` timeline (each row uses `<RunEventRow>` — pre/post phase glyph, `<ToolBadge>`, expand-to-see-input/output), `policy_decisions` (collapsible audit table; expanded by default in web), linked `<ContextPackPanel>` if present.

**Server actions:** none (pure read). All queries via `apps/web/lib/queries/{runs,events,decisions,policy-decisions,context-packs}.ts` using `createWebDb()` from S1 storage adapter. RLS in team mode (set `app.current_org` per request).

**HTML port of CLI export:** the `/runs/[id]` page is the visual equivalent of `contextos export <runId> --format markdown --include-audit`. Where the CLI emits markdown, the web emits semantic HTML with the same information density. **Audit always visible** in web (vs CLI default-exclude per OQ-7) — the web's audience is humans-reading-not-Slack-broadcasting; nothing is dropped to "fit a Slack post".

**Acceptance:**

- Seeded run shows correctly in both modes.
- Page renders < 200ms server-side for runs with up to 1000 events.
- Brand fidelity: every visible color is a token; no hardcoded hex; no border-radius > 0.
- Mobile breakpoint usable (no horizontal scroll on iPhone-13 viewport).
- Unit + integration tests for queries.

**Single commit:** `feat(web): M04 S3 — run list + run detail (read-only)`.

---

### S4 — Live run dashboard via polling

**New surface:** `/runs/[id]/live` — same shape as `/runs/[id]` but client-rendered with the polling adapter. Auto-redirects to `/runs/[id]` when status flips to terminal.

**New route handler:** `/api/runs/[id]/state` (the renamed `/api/runs/stream` per OQ-2 lock) — returns the current run snapshot (run row + last-N events + last-N decisions + last-N policy-decisions); supports `If-Modified-Since` to short-circuit unchanged ticks.

**Polling adapter** (`apps/web/lib/poll.ts` from S1's skeleton):

- Full implementation: interval, pause-when-hidden, exponential backoff on error, `If-Modified-Since` semantics.
- Hook signature `usePoll<T>({ url, intervalMs, pauseWhenHidden, signal })`.
- Per-page intervals enforced: dashboard 2000ms, run-live 1500ms, kill-switches 5000ms.
- 99-percentile latency budget: round-trip + handler ≤ 100ms server-side, ≤ 250ms wire.

**Architecture-doc update:** `system-architecture.md` §3.3 currently calls this "SSE" — that's now incorrect after the OQ-2 lock. Update §3.3 in this slice's commit: "live updates are short-poll over HTTP/2; the path-name `/api/runs/stream` was a misnomer carried over from the early SSE plan and is renamed to `/api/runs/[id]/state` in M04 S4".

**Acceptance:**

- Live page updates within ~1.5s of an event landing in the DB.
- Tab in background → polling pauses (verified via Page Visibility API spy in test).
- Network error → exponential backoff visible (1.5s → 3s → 6s → 12s → 30s capped); recovery on next success.
- Auto-redirect on terminal status works.
- Unit tests cover the adapter; integration test covers the route handler with `If-Modified-Since`.

**Single commit:** `feat(web): M04 S4 — live run dashboard via polling adapter; rename /api/runs/stream → /api/runs/[id]/state`.

---

### S5 — Policy admin (`/policies` + `/policies/[id]`)

**Routes:**

- `/policies` — list, filter by project, active/inactive toggle. CLI parity: `contextos policy list`.
- `/policies/[id]` — rules table sorted by priority asc; "Add rule" form (tool + decision + reason + path-glob + agent-type + priority); enable/disable toggle on the policy itself.

**Server actions:**

- `addPolicyRuleAction` — calls `addPolicyRule` from `@coodra/contextos-db` (the same helper M08b S9 wired into the CLI). Form validation via Zod.
- `setPolicyActiveAction` — calls `setPolicyActive` (idempotent).

**Bridge cache TTL note:** the policy client cache is 60s. The form's success banner says: "Rule added. Bridges will see it on the next cache miss (≤ 60s)."

**Acceptance:**

- Rule add → visible in `policy_rules` table immediately; visible to bridge ≤ 60s later (verified by integration test that adds a rule and waits for bridge to deny).
- Disable a policy → all rules under it stop applying within 60s.
- Form validation matches Zod schema (no client-only checks).
- Lint + typecheck + unit + integration pass.

**Single commit:** `feat(web): M04 S5 — policy admin (list, detail, add-rule, enable/disable)`.

---

### S6 — Project admin (`/projects` + `/projects/[id]`)

**Routes:**

- `/projects` — list with run-count + last-run timestamp. CLI parity: `contextos project list`.
- `/projects/[id]` — project header, recent runs, status histogram, `Reset` button.

**Reset confirmation:** destructive op (per CLI's `--force` requirement). Two-step confirm dialog: type the project slug to enable the Reset button. Default `--keep-policies` (preserves policies + policy_rules + project-scoped kill_switches).

**Acceptance:**

- Reset cascade matches CLI's order (per `packages/db/src/projects.ts::resetProject`).
- Refuses to reset `__global__` (matches F7 invariant).
- Reset shows the same return shape the CLI prints (rows deleted per table).

**Single commit:** `feat(web): M04 S6 — project admin (list, detail, reset)`.

---

### S7 — Pack browser + template list/install (`/packs` + `/packs/[slug]` + `/templates`)

**Routes:**

- `/packs` — list with active flag + parent slug + missing-file warnings (from `pack list --json`).
- `/packs/[slug]` — render `spec.md` + `implementation.md` + `techstack.md` (markdown → HTML via the same renderer M08b S12 used for export); show `meta.json` formatted; `Regenerate` + `Delete` buttons (delete = soft-flip is_active per ADR-007).
- `/templates` — list bundled (7) + user-installed; install-from-path form (path validation done server-side via `loadTemplate`).

**Server actions:**

- `regeneratePackAction` — calls `regeneratePack` helper (the M08b S16 implementation).
- `deletePackAction` — soft-flip `feature_packs.is_active=false`.
- `installTemplateAction` — calls `installTemplate` helper.

**Markdown rendering:** reuse `packages/cli/src/lib/export/render-html.ts` (port to a shared package or import directly — decided in slice). Same `__CTX_CODE_N__` sentinel pattern (per M08b S12 fix).

**Acceptance:**

- Bundled template list shows all 7 (matches `template list` CLI output).
- Pack regenerate refreshes auto-marker sections without disturbing user prose.
- Template install accepts a local path; rejects with structured error on invalid template.json (matches M08b template install validation).

**Single commit:** `feat(web): M04 S7 — pack browser + template list/install`.

---

### S8a — Sync-daemon `kill_switches` handler (backend only, no UI)

**Why split from S8b** (per STRUCT-2 lock): the bidirectional-sync surface is revertable on its own; the backend can ship + verify before any web UI exists. M04a OQ-1 explicitly restricted M04a to one-way push only — S8a is where bidirectional begins, so we want it visible as its own commit on the audit trail.

**Files modified:**

- `apps/sync-daemon/src/lib/cloud-pull.ts` — extend the pull-table list with `kill_switches`. Existing pattern: pull-on-interval, upsert by id, soft-resume by `resumed_at` timestamp.
- `apps/sync-daemon/src/handlers/kill-switches.ts` (NEW) — handler that accepts the cloud → local row, resolves conflicts (id-match upsert; never delete), writes via `insertKillSwitch`/`softResumeKillSwitch` from `@coodra/contextos-db`.
- `apps/sync-daemon/src/lib/cloud-pull-config.ts` — adds `kill_switches` to `PULLABLE_TABLES`.
- `packages/cli/src/commands/pause.ts` — add `--no-sync` flag (default: sync on). When set, the inserted row gets `paused_by_session_id='local-only:<host>'` which the sync-daemon's push-side filter excludes.
- `apps/sync-daemon/__tests__/integration/kill-switches-bidirectional.test.ts` (NEW) — testcontainers-backed: spin up cloud Postgres, insert a kill-switch via the cloud-side helper (mimicking what S8b will do), run the sync-daemon's pull tick, assert the row appears in local SQLite. Then pause locally with `--no-sync` and verify it doesn't push.

**Acceptance:**

- Cloud-side kill_switch insert is pulled and applied locally within the existing 5s daemon poll interval.
- Local pause with `--no-sync` does NOT push to cloud (verified via psql query against the cloud table).
- Local pause WITHOUT `--no-sync` (default) DOES push to cloud.
- Sync-daemon log emits `sync_daemon_kill_switches_pulled` events with `count` field.
- M04a OQ-1's one-way restriction explicitly noted as superseded — extends both `system-architecture.md` (sync-daemon section) and `essentialsforclaude/05-agent-trigger-contract.md` (if relevant) in the same commit.

**Single commit:** `feat(sync-daemon,cli): M04 S8a — sync-daemon pulls kill_switches; pause --no-sync flag (extends M04a OQ-1)`.

---

### S8b — Web admin for kill switches (`/kill-switches` + write-side server actions)

**Depends on S8a being merged.** S8a runs cloud-→local; S8b is the source-of-cloud surface.

**Routes:**

- `/kill-switches` — three sections: "Active now" (active rows, sorted by paused_at desc, with mode + scope/target + reason + age + "Resume" button), "Recent activity" (last 50 paused/resumed in descending time), "Pause new" form.

**Server actions:**

- `pauseKillSwitchAction` — calls `insertKillSwitch` from `@coodra/contextos-db` against the **cloud** Drizzle handle in team mode (writes to cloud — sync-daemon picks it up); against local SQLite in solo mode (no propagation since solo has no team).
- `resumeKillSwitchAction` — `softResumeKillSwitch` (idempotent).

**Identity stamping:** `paused_by_session_id='web:<userId>'` per spec §9.

**Duplicate-active banner:** if `(scope, target)` is already actively paused, the form shows: "This scope is already paused — id ks_..., paused 12 min ago by alice@org. Pause again with a new reason?" — submitting creates a second row (matcher's first-match-wins semantic preserves both for audit).

**Propagation latency note in UI:** below the form, a small caption: "Pauses are visible to all developers within ~10s (sync-daemon pulls every 5s, bridge cache TTL 5s)."

**Acceptance:**

- Pause from web → row in cloud `kill_switches` immediately.
- Within ~10s, the row appears on every connected developer's local SQLite (verified via integration test that runs sync-daemon + web concurrently and inserts via web).
- Resume from web → all connected developers stop denying within ~10s.
- Solo-mode pause writes locally (no cloud); web shows "Solo mode — pause is local only" caption replacing the propagation note.

**Single commit:** `feat(web): M04 S8b — kill-switch admin (pause/resume); writes through sync-daemon to all developers`.

---

### S9 — Dashboard home (`/`)

**Per STRUCT-3 lock** — its own slice, not folded into a doctor page. CLI parity is `contextos doctor` (summary) + `contextos run list` (recent) + `contextos pause` status + `policy_decisions` (denials) combined.

**Five tiles** (using the `<Tile>` component from S1's chrome + status palette tokens):

1. **Active runs:** count of `runs WHERE status='in_progress'` — Inactive grey if 0, Precision Blue if > 0. Click → `/runs?status=in_progress`.
2. **Denials (24h):** count of `policy_decisions WHERE permission_decision='deny' AND created_at > now() - interval '24 hours'` — Allowed green if 0, Denied red if > 0. Click → `/runs?denials_24h=1`.
3. **Active kill-switches:** count of `kill_switches WHERE resumed_at IS NULL` — Inactive grey if 0, Partial amber if > 0 (matches doctor check 31's YELLOW). Click → `/kill-switches`.
4. **Doctor:** RED + YELLOW counts from the last `contextos doctor --json --full` run (cached for 60s in memory). Click → expanded list of failed checks. Hardcoded RED/YELLOW lookup; no need to render all 35.
5. **Latest events:** scrollable list of last 10 `run_events` across all runs (with project slug + tool name + phase + timestamp). Each row links to the run.

**Doctor cache strategy:** the doctor runs out-of-process (`spawn('contextos', ['doctor', '--json'])` from a Node.js server action, cached 60s). Solo: shells out locally. Team: there is no shared "doctor" — the doctor concept is per-machine. In team mode, the doctor tile is grey with caption "Doctor runs per-developer locally; no cloud rollup." (Reasonable behaviour for v1; M07 / future could add a per-developer report stream.)

**Polling:** the whole dashboard polls at 2000ms (per spec §8 lock).

**Acceptance:**

- All five tiles render with correct counts against a seeded sandbox.
- Status colors match spec §11 status palette.
- Click-through to filtered subroutes works.
- Mobile breakpoint: tiles stack vertically below sm.
- Polling pauses when tab hidden.

**Single commit:** `feat(web): M04 S9 — dashboard home / (5 tiles + recent events)`.

---

### S10 — Auth flow + Clerk org/team management (`/auth/*` + `/settings/team`)

**Routes:**

- `/auth/sign-in`, `/auth/sign-up` — Clerk-hosted pages with `appearance` prop styled to brand tokens (Precision Blue interactive, Inter typography).
- `/settings/team` — Clerk's `<OrganizationProfile>` component embedded; lists members, invites, roles. Org-admin only.
- `/settings/account` — Clerk's `<UserProfile>` component embedded.

**Org switcher in header:** `<OrganizationSwitcher>` component (Clerk) wired into the team-mode header chrome.

**Solo-mode behavior:** `/auth/*` and `/settings/team` return 404 (per spec §9 + OQ-3).

**Acceptance:**

- Team-mode sign-in flows end-to-end against the live `fun-gnu-96` Clerk tenant.
- Org switcher persists choice across navigations.
- `/settings/team` shows real org members.
- Solo mode 404s on these routes.

**Single commit:** `feat(web): M04 S10 — auth flow + Clerk org/team management surfaces`.

---

### S11 — Closeout context pack + README module-status flip

**Closeout context pack:** `docs/context-packs/YYYY-MM-DD-module-04-web-app.md` per `essentialsforclaude/08-implementation-order.md §8.4` template. Same shape as M08b's closeout pack (`docs/context-packs/2026-05-03-module-08b-cli-expansion.md`). Sections: header, outcome, scope boundary, decisions made (cross-ref decisions-log), files touched (grouped by package), tests, open questions, pending user actions, handoff to next session, references.

**README flip:**

- `04 Web App` row → ✅ complete with `docs/context-packs/<date>-module-04-web-app.md` link
- Mark next module (likely `05 NL Assembly` if user picks that order; or `07 VS Code` if M07 is next) as 🔨 next

**Functional smoke:** before merging, repeat the pattern from M08b S18-end functional verification — boot the bundled web in solo + team modes; walk every route; confirm parity with the matching CLI command. Capture any gaps in a follow-up section of the closeout pack.

**Single commit:** `docs(m04): S11 closeout — Module 04 context pack + README module-status flip`.

---

## Pre-M04 fix-ups PR (separate branch — lands BEFORE S1 opens)

**Branch:** `fix/pre-m04-blockers` (off `main` at current HEAD).

**Three fixes in this order, each as its own commit:**

1. **`fix(shared): swap .strict() for .passthrough() on hook payload schemas`**
   - Files: `packages/shared/src/hooks/payloads/{claude-code,windsurf,cursor}.ts`
   - Add integration test `apps/hooks-bridge/__tests__/integration/passthrough-tolerance.test.ts` that POSTs Claude Code's actual SessionStart wire payload (with `transcript_path` + `source`) and asserts:
     - Response is `200 OK` AND `additionalContext` is populated (not just `permission_decision: allow + reason: invalid_hook_payload`)
     - The same payload mis-tagged as Stop is routed to the Stop handler (not silently failing open)
   - **Live-observed in this very session 2026-05-03** — Stop hook returned PreToolUse shape, bridge rejected.

2. **`feat(cli,db): seed default-deny policy rules on contextos init`**
   - Files: `packages/cli/src/commands/init.ts`, `packages/db/drizzle/seeds/default-deny.json` (NEW)
   - Universal-safe denies (per `context_memory/blockers.md:127-148`):
     - Write to `**/.env.production` + `**/.env.*.production`
     - Bash for `rm -rf /`-shaped commands (regex match `^rm\s+-[a-z]*r[a-z]*f.*\s\/(\s|$)`)
     - Write to `.git/**`
   - Apply after migrations during `contextos init`. Idempotent (don't re-seed if rules already exist).
   - Add unit test for the seed application; integration test that runs init then verifies `policy_rules` count > 0.

3. **`fix(mcp-server): tolerate missing implementation.md / techstack.md in feature-pack reader`**
   - Files: `apps/mcp-server/src/lib/feature-pack.ts`
   - Soften `readPackFromDisk` to make `implementation.md` + `techstack.md` optional (mirror `apps/hooks-bridge/src/lib/feature-pack-loader.ts`'s `readMaybe` helper). `spec.md` stays required.
   - Add unit test asserting `get_feature_pack` returns successfully when only spec.md exists.
   - Add integration test running the full flow against a freshly-init'd project.

**PR acceptance:**

- All three fixes ship in one PR; lint + typecheck + unit + integration all pass.
- Manual verification on a sandbox: `pnpm --filter @coodra/contextos-cli build`, init a fresh sandbox CONTEXTOS_HOME, fire Claude Code's actual SessionStart wire payload to the bridge, observe `additionalContext` returned non-empty.
- Squash-merge to `main`. **`feat/04-web-app/S1` does NOT open until this PR is on `main`.** Rebase `feat/04-web-app` on the new `main` before continuing.

---

## Verification (end-to-end smoke before squash-merge of M04)

After S11 lands and before the M04 PR squash-merges to main, run this end-to-end on a clean checkout:

1. `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration` — all green.
2. `pnpm --filter @coodra/contextos-cli build` — bundled CLI ready.
3. Sandbox solo init: fresh CONTEXTOS_HOME + CWD; `contextos init --project-slug verify-m04 --no-graphify --ide claude`; `contextos start`.
4. `pnpm --filter @coodra/contextos-web build && pnpm --filter @coodra/contextos-web start` — web on `:3000`.
5. Open `http://localhost:3000` → `/` shows the dashboard with all five tiles. Trigger a Claude Code session; watch the active-runs tile flip to 1; click into the live view; observe the timeline build event-by-event.
6. Walk every route in spec §4. Each renders without error against seeded data.
7. Switch `CONTEXTOS_MODE=team` + point at the live Supabase + sign in via Clerk → repeat the route walk against cloud.
8. Pause from web `/kill-switches` → run `contextos doctor --full --json | jq '.checks[] | select(.id==31)'` on a separate developer machine (simulated via second CONTEXTOS_HOME) → check 31 reports YELLOW within ~10s.
9. Capture each route's screenshot at desktop + mobile breakpoints; attach to closeout pack.

If any step fails, file as a follow-up issue + flag in the closeout pack's "open questions". **Do not patch to make smoke green** — capture the gap honestly.

## Out of scope for this batch (flagged for later)

- **`/search` (M05 dependency)** — semantic search over `context_packs` + `decisions` requires M05's embedding pipeline.
- **`/runs/[id]/diff` (M06 dependency)** — semantic-diff overlay requires M06's tree-sitter + Anthropic-call infrastructure.
- **VS Code webview shipping the same brand tokens** — M07 will likely extract `apps/web/styles/tokens.css` to `packages/design-tokens/`. Out-of-scope for M04; the path is documented in spec §11.
- **Org-level kill-switch governance** — who in an org is allowed to flip a global kill-switch? M04 lets any signed-in org member; per-role gating is a follow-up after Clerk org roles are scoped.
- **Doctor full-detail page (35 checks)** — operators run `contextos doctor --full --json` for that level of detail. The dashboard tile shows summary RED/YELLOW only.
- **Multi-project view in solo** — solo has one project per CONTEXTOS_HOME by default. Multi-project switching is a team-mode feature (the org switcher serves the same role).
- **Audit-export "share with non-org reviewer"** — out of scope per §3 non-goals (no public share links).
- **Web push notifications** — out of scope. Polling at 1.5s is plenty for the v1 audience; push adds infra (FCM / APN) + permission-prompt UX without proportionate value.
- **Webhook integrations from web (e.g. "post deny to Slack")** — out of scope. CLI's `export --format slack --webhook ...` covers this from the operator-script side.
- **Anything Anthropic / Gemini / Ollama in the web** — M04 does not call any LLM directly. M05 owns NL Assembly's web surface (deferred).
