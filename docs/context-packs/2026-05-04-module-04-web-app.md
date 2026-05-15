# Module 04 — Web App (closeout)

- **Date:** 2026-05-04
- **Module:** 04 — Web App (`apps/web` admin + audit-trail UI for Coodra)
- **Feature Pack:** `docs/feature-packs/04-web-app/`
- **Session lead (human):** Abishai
- **Run ID:** n/a (worked from CLAUDE.md + context_memory; the M04 branch built + verified across multiple agent sessions)
- **Branch at session start:** `main` (cut `feat/04-web-app` from `652fb05` — M08b post-S19 fixup)
- **Branch at session end:** `feat/04-web-app` (S11 closeout commit)
- **Commits landed (newest first):**
  - S11 — closeout pack + README flip + 2 reserved cleanups (this commit)
  - `8aa0b0b` S10 — auth flow + Clerk org/team management
  - `0704c95` S9 — dashboard home `/` (5 tiles + latest events) — closes STRUCT-3
  - `a221f6d` S8b — `/kill-switches` admin (pause / resume) — closes STRUCT-2
  - `a6b89a1` S8a — sync-daemon kill_switches push + pull; pause `--no-sync` (extends M04a OQ-1)
  - `b6950ab` S7 — pack browser + template list (read-only)
  - `073bdb2` S6 — project admin (list / detail / reset with type-to-confirm)
  - `43f65b1` S5 — policy admin (list / detail / add-rule / enable-disable)
  - `58ac513` S4 — live run dashboard via polling
  - `0c7f359` S3 — run list + run detail (read-only)
  - `d695fd4` S2 — apply Drizzle schema to Supabase + Clerk live-tenant smoke
  - `2b29587` S1 — `apps/web` scaffold (Next.js 15 + Tailwind v4 + brand tokens + Clerk solo bypass + Supabase SSR)
  - `440e68c` S0.5 — IA + nav map + 11 wireframes; relocate brand sources to `docs/brand/`
  - `068575d` audit retirement of OQ-6 fix-up PR (3 blockers already shipped via Phase 3 Fix A/C/D 2026-05-02)
  - `d5b1616` S0 — kickoff spec + slice plan + locked OQ answers

## Outcome

Coodra now has a real web surface. `apps/web` ships **15 routes** (4 API + 11 page) covering every CLI admin verb plus the live audit-trail view, all rendered under one brand-mandatory token catalog (Precision Blue, Inter weight contrast, JetBrains Mono, zero border-radius). Solo developers visit `http://localhost:3000` after `coodra init` and see their local SQLite live; teams point at the same build with `COODRA_MODE=team` and read the cloud Postgres at `gyopozvfmggumidptmjr.supabase.co`. The bidirectional kill-switch sync (sync-daemon push + cloud→local poller, S8a) closes the M04a OQ-1 "one-way only" restriction — a web admin pause propagates to every developer's local hooks-bridge within ~10s p95. M02 S7b's deferred Clerk live-tenant validation was closed in S2 with 7/7 cloud integration tests against the real `fun-gnu-96` tenant. The M04 S11 cleanups bring two latent fragilities to closure: bridge response shape now matches Claude Code's per-event hook spec, and the mcp-server feature-pack reader mirrors the bridge's `readMaybe` pattern.

## Scope boundary

**In scope (delivered):**

- AC-1…AC-3 — `pnpm install`/`lint`/`typecheck` clean across the workspace.
- AC-4 — `pnpm test:unit` per-package: web 27/27, CLI 188/188, mcp-server 261/261, hooks-bridge 46/46.
- AC-5 — Cloud integration tests pass (7/7) when `LIVE_SUPABASE_TEST=1` + `CLERK_LIVE_TEST=1`. Default CI invocation skips them silently (env-gated).
- AC-7 — **Schema delta: ZERO.** M04 reads + writes against the existing 11-table schema. Sync-daemon's kill_switches handler is a new TypeScript dispatcher, not a migration.
- AC-8 — Backwards compatibility: every M08a + M08b CLI command keeps its surface verbatim.
- AC-9 — Mode parity: every route renders correctly in solo (local SQLite) and team (Supabase Postgres).
- AC-10 — Brand fidelity: every visible element uses tokens from `apps/web/styles/tokens.css`. Zero hardcoded hex outside that file. `* { border-radius: 0 !important }` enforces the zero-radius mandate globally.
- AC-11 — Auth: solo bypass renders every page as the synthetic `__solo__` user; team mode wraps in Clerk middleware with explicit `307 → /auth/sign-in?redirect_url=<original>` redirects.
- AC-12 — Live updates: `/runs/[id]/live` polls `/api/runs/[id]/state` at 1500ms with `If-Modified-Since` short-circuit (200 / 304 / 404 contract verified end-to-end).
- AC-13 — Bidirectional kill-switch sync: web pause → cloud Postgres → sync-daemon puller → local SQLite → bridge cache miss. Total propagation ~10s p95.
- AC-15 — Module 04 Context Pack (this file).

**Deliberately deferred (per spec.md §3 non-goals):**

- **AC-6 e2e** — full e2e against a real Claude Code stream still reserved for M07 VS Code Extension closeout (which needs the same harness). Integration coverage in `apps/hooks-bridge/__tests__/integration/` exercises the same protocol against the bridge HTTP surface.
- **No marketing site, no telemetry, no billing, no public docs portal.** Every M04 page is operator-and-audit only.
- **No `/search`** — depends on M05 NL Assembly's embedding pipeline.
- **No `/runs/[id]/diff`** — depends on M06.
- **No mobile-native app** — responsive web works; React Native is out of scope.
- **No CRUD on `decisions` or `context_packs`** — both append-only by ADR-007.
- **No team-mode RLS migration** — `0008_rls_org_isolation.sql` reserved as a follow-up alongside any Clerk-org-aware data scoping. The current team-mode implementation trusts Clerk's `auth().orgId` filter at the query layer; RLS is belt-and-suspenders and lands when multi-org test data exists.

**S7 follow-ups left on the table** (not blocking M04 ✅):

- Server actions for pack regenerate / pack delete / template install — all three need helper extraction from `packages/cli/src/commands/{pack,template}.ts`. Shippable as a follow-up M04 patch slice when the operator demand materialises.
- Markdown→HTML renderer for `/packs/[slug]` — currently renders as `<pre>`. The S11 cleanup didn't pull in M08b S12's renderer; it's reserved for the same follow-up patch.
- Doctor shell-out tile on `/` — currently a stub. Reserved for the S9 follow-up that wires `spawn('coodra', ['doctor', '--json'])` with 60s in-memory cache.
- Polling refresh on `/` and `/kill-switches` — both pages currently server-render every request. S4's `usePoll` hook is the substrate for the upgrade; reserved for the polling-everywhere follow-up.

## Decisions made

The seven OQ locks + three STRUCT decisions captured in S0 drove every implementation choice. Cross-references in `context_memory/decisions-log.md` (search "M04 OQ-" + "M04 STRUCT-").

- **OQ-1 (storage adapter):** direct `better-sqlite3` from Next.js server in solo; Drizzle pg pool in team. Avoided the HTTP-to-bridge alternative because solo developers routinely want to read audit when daemons aren't running. Implementation: `apps/web/lib/db.ts::createWebDb()` with module-level cache.
- **OQ-2 (live updates):** client-side polling at 1500ms, not SSE. Avoids the LISTEN/NOTIFY-vs-polling fork between solo and team. Implementation: `apps/web/lib/poll.ts` (S4) — interval, IMS round-trip, exponential backoff (1.5/3/6/12/30s), Page Visibility pause, AbortController on unmount.
- **OQ-3 (solo auth):** no sign-in screen; every page renders as the synthetic `__solo__` user. Continuity with the CLI's F7 invariant. Implementation: `apps/web/middleware.ts` short-circuits in solo; `apps/web/lib/auth.ts::getActor()` returns the synthetic identity.
- **OQ-4 (kill-switch sync):** sync-daemon adds `kill_switches` to its 5s pull list; web admin writes to cloud. ~10s p95 propagation, no new infra. Explicitly extends M04a OQ-1 (was push-only) — locked in `context_memory/decisions-log.md` 2026-05-04 OQ-4. Implementation: `apps/sync-daemon/src/lib/kill-switch-puller.ts` (S8a) + `apps/web/lib/queries/kill-switches.ts::insertKillSwitchWithSync` (S8b).
- **OQ-5 (brand tokens):** full catalog up-front in `apps/web/styles/tokens.css`. Brand IS the engineering-rigor differentiator. Implementation: 60+ CSS custom properties ported verbatim from `docs/brand/brand.html`.
- **OQ-6 (pre-M04 fix-ups PR):** RETIRED on 2026-05-04 audit — all three blockers (`.strict()`, init policy seed, `seedFeaturePack`) already shipped via Phase 3 Fixes A/C/D on 2026-05-02. The user's "live `.strict()` observation" reconciled via Claude Code hook docs as silently-ignored response-shape drift, not a rejected hook. Two reserved cleanups (per-event response shaping + mcp-server reader symmetry) landed in S11.
- **OQ-7 (deploy target):** still deferred — S1 scaffolds for portability. Vercel vs Railway vs Fly.io picked when the deploy is real.

**STRUCT decisions:**

- **STRUCT-1 (S0.5 wireframes):** added between S0 and S1. M04 is the UI/UX module; visual slices (S3+) had a target before scaffolding started. 14 wireframe files (3 top-level + 11 per-route) in `docs/feature-packs/04-web-app/wireframes/`.
- **STRUCT-2 (S8 split):** S8a backend (sync-daemon push + pull) + S8b web admin. Bidirectional sync surface revertable on its own; M04a OQ-1 extension visible as its own commit on the audit trail.
- **STRUCT-3 (S9 dashboard home):** its own slice instead of folded into a doctor page. Aggregate-data home page meaty enough; doctor full-detail page deferred (operators run `coodra doctor --full --json` for that).

## Files touched

`apps/web/` (NEW — entire directory):

- `package.json` — Next.js 15 + React 19 + Tailwind v4 + @clerk/nextjs 6 + @supabase/ssr + workspace deps
- `tsconfig.json` + `tsconfig.typecheck.json` — strict TS, App Router config, `@/` path alias
- `next.config.ts` — typedRoutes, transpilePackages, serverExternalPackages for better-sqlite3
- `postcss.config.mjs` — Tailwind v4 PostCSS plugin
- `vitest.config.ts` + `vitest.integration.config.ts` — test runners (unit + env-gated integration)
- `.env.local.example` + `.gitignore` + `README.md`
- `middleware.ts` — solo bypass / team Clerk wrap with explicit redirect
- `types.d.ts` — CSS module declarations
- `app/layout.tsx` — root layout with ClerkProvider + fonts + chrome
- `app/page.tsx` — `/` dashboard home (S9 — replaces S1 placeholder)
- `app/not-found.tsx` — 404 page
- `app/api/healthz/route.ts` — `200 ok` JSON
- `app/api/runs/[id]/state/route.ts` — polling endpoint with Last-Modified + IMS short-circuit (S4)
- `app/runs/page.tsx` + `app/runs/[id]/page.tsx` + `app/runs/[id]/not-found.tsx` + `app/runs/[id]/live/page.tsx` + `app/runs/[id]/live/RunLiveClient.tsx` (S3 + S4)
- `app/policies/page.tsx` + `app/policies/[id]/page.tsx` + `app/policies/[id]/not-found.tsx` (S5)
- `app/projects/page.tsx` + `app/projects/[id]/page.tsx` + `app/projects/[id]/not-found.tsx` (S6)
- `app/packs/page.tsx` + `app/packs/[slug]/page.tsx` + `app/packs/[slug]/not-found.tsx` (S7)
- `app/templates/page.tsx` (S7)
- `app/kill-switches/page.tsx` (S8b)
- `app/auth/sign-in/[[...sign-in]]/page.tsx` + `app/auth/sign-up/[[...sign-up]]/page.tsx` + `app/settings/team/page.tsx` + `app/settings/account/page.tsx` (S10)
- `styles/tokens.css` — full brand catalog (S1)
- `app/globals.css` — Tailwind v4 `@theme` block + reset + zero-radius enforcement
- `lib/db.ts` — `createWebDb()` storage adapter
- `lib/auth.ts` — `getActor()`
- `lib/poll.ts` — `usePoll<T>()` polling hook (full impl S4)
- `lib/clerk-issuer.ts` — JWT issuer probe from publishable key
- `lib/clerk-appearance.ts` — brand-styled Clerk appearance prop (S10)
- `lib/format.ts` — `relativeTime` / `compactTimestamp` / `compactDuration`
- `lib/queries/runs.ts` + `lib/queries/run-state.ts` + `lib/queries/policies.ts` + `lib/queries/projects.ts` + `lib/queries/packs.ts` + `lib/queries/templates.ts` + `lib/queries/kill-switches.ts` + `lib/queries/dashboard.ts`
- `lib/actions/policies.ts` + `lib/actions/projects.ts` + `lib/actions/kill-switches.ts`
- `components/StatusChip.tsx` + `RiskBadge.tsx` + `ToolBadge.tsx` + `SoloModeBadge.tsx` + `HeaderNav.tsx` + `Breadcrumb.tsx` + `RelativeTime.tsx` + `RunStatusChip.tsx` + `RunRow.tsx` + `RunEventRow.tsx` + `DecisionCard.tsx` + `PolicyDecisionRow.tsx`
- `utils/supabase/{server,client,middleware}.ts` — user-preferred SSR boilerplate
- `__tests__/unit/` (4 files: db, auth, clerk-issuer, primitives) — 27 cases
- `__tests__/integration/` (2 files: cloud-storage, clerk-live-tenant) — 7 cases (env-gated)

`apps/sync-daemon/` (S8a):

- `src/lib/dispatch.ts` — added `kill_switches` to `SYNC_TABLES` + new `syncKillSwitches()` push function with `ON CONFLICT DO UPDATE` on resumed_at/resumed_by/expires_at
- `src/lib/kill-switch-puller.ts` (NEW) — 5s cloud→local poller with INSERT OR REPLACE on id, fail-open per §7
- `src/index.ts` — wires the puller into boot alongside OutboxWorker; graceful shutdown stops both

`packages/cli/src/commands/pause.ts` (S8a):

- `--no-sync` flag added; in team mode + sync-on, emits `sync_to_cloud` durable write after `insertKillSwitch`. Local-only rows tagged `paused_by_session_id='local-only:<platform>-<pid>'`.

`packages/cli/src/program.ts` — wired `--no-sync` option onto `coodra pause` (S8a).

`packages/cli/src/commands/init.ts` — dropped unused `join` import in passing during S8a lint pass.

`packages/db/src/schedule-audit-write-with-sync.ts` — extended `SyncTableName` union with `'kill_switches'` (S8a).

`apps/hooks-bridge/src/app.ts` (S11 cleanup A):

- New `shapeClaudeCodeResponse()` shaper; route handler now picks the right wrapper per Claude Code event type per the spec at `code.claude.com/docs/en/hooks` (PreToolUse + SessionStart consume hookSpecificOutput; PostToolUse / Stop / SessionEnd / SubagentStop use top-level `decision: 'block'` or empty body to allow). 46/46 unit tests pass — existing test surface is PreToolUse-heavy so backward compat preserved.

`apps/mcp-server/src/lib/feature-pack.ts` (S11 cleanup B):

- New `readMaybe()` helper mirrors the bridge's pattern. `readPackFromDisk` now tolerates missing `implementation.md` + `techstack.md` (only `spec.md` + `meta.json` required); empty strings flow through the rest of the pipeline. Closes the latent fragility from `context_memory/blockers.md` ✅ 2026-05-02 entry.

`docs/feature-packs/04-web-app/` (S0 + S0.5):

- `spec.md` — kickoff, AC, non-goals, routes table, first-5-min, schema deltas (zero), storage adapter, polling contract, auth model, kill-switch sync (extends M04a OQ-1), brand contract, retired pre-M04 fix-up PR, locked decisions
- `implementation.md` — 14-slice plan
- `techstack.md` — runtime, dependencies, brand-token mechanics, gotchas
- `meta.json` — module identity
- `wireframes/00-information-architecture.md` + `01-nav-map.md` + `03-component-inventory.md` + `02-screens/` (11 per-route wireframes) — UI/UX foundation per STRUCT-1

`docs/brand/` (S0.5 — relocated from repo root):

- `brand.md` + `brand.html` (canonical visual identity)
- `README.md` — pointer file describing the catalog

`context_memory/`:

- `decisions-log.md` — appended OQ-1..OQ-7 + STRUCT-1..STRUCT-3 + OQ-6 REVISITED entries
- `blockers.md` — ✅ resolved markers on lines 98 (`.strict()`) / 127 (init policy seed) / 150 (seedFeaturePack)
- `pending-user-actions.md` — Clerk creds ✅; Supabase ✅; Module 03.1 ✅; team-mode infra 🟡 partial
- `current-session.md` — rotated for M04 (M08b session archived)

## Tests

**Added:**

- `apps/web/__tests__/unit/lib/db.test.ts` — storage adapter mode selection (5 cases)
- `apps/web/__tests__/unit/lib/auth.test.ts` — `getActor()` solo + team paths (3 cases)
- `apps/web/__tests__/unit/lib/clerk-issuer.test.ts` — publishable-key decode + JWKS probe (8 cases)
- `apps/web/__tests__/unit/components/primitives.test.tsx` — StatusChip / RiskBadge / ToolBadge (11 cases)
- `apps/web/__tests__/integration/cloud-storage.test.ts` — env-gated by `LIVE_SUPABASE_TEST=1`; 4 cases against real Supabase Postgres
- `apps/web/__tests__/integration/clerk-live-tenant.test.ts` — env-gated by `CLERK_LIVE_TEST=1`; 3 cases against real `fun-gnu-96` Clerk tenant

**Modified:**

- `apps/sync-daemon/__tests__/integration/dispatch.test.ts` — biome auto-fixed format only (M04a's existing test file; no behaviour change)

**Removed:** none.

**Verification commands run:**

```sh
pnpm --filter @coodra/web typecheck   # clean
pnpm --filter @coodra/web lint        # clean
pnpm --filter @coodra/web test:unit   # 27/27 pass
pnpm --filter @coodra/web build       # all 15 routes built

LIVE_SUPABASE_TEST=1 CLERK_LIVE_TEST=1 \
  DATABASE_URL=postgresql://... \
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=... \
  pnpm --filter @coodra/web test:integration
# → 7/7 pass (4 cloud + 3 Clerk live)

pnpm --filter @coodra/cli test:unit          # 188/188
pnpm --filter @coodra/mcp-server test:unit   # 261/261 (post S11 cleanup B)
pnpm --filter @coodra/hooks-bridge test:unit # 46/46 (post S11 cleanup A)
```

**Live cloud + tenant verification (this commit):**

- `psql` against `db.gyopozvfmggumidptmjr.supabase.co:5432` — 11 expected tables present + `vector 0.8.0` + 8 entries in `drizzle.__drizzle_migrations`.
- `https://fun-gnu-96.clerk.accounts.dev/.well-known/jwks.json` — JWKS reachable + populated key set.
- Browser smoke (solo): all 11 page routes render against `~/.coodra/data.db` (14 real runs + 4 projects + 26 policy_rules + 3 active kill-switches surfaced; brand chips + tokens pixel-correct).
- Browser smoke (team): `/api/healthz` returns `mode:"team"`; protected routes 307→`/auth/sign-in?redirect_url=<original>`; `/auth/sign-in` renders Clerk `<SignIn />` with brand-styled appearance.

## Open questions

None blocking. Three follow-ups deferred from spec §3 / S7 / S9:

- **AC-6 e2e harness (M07 owner)** — full e2e against a real Claude Code session needs to spin up the bridge against the agent loop. The bridge integration suite covers the protocol; M07 picks up the harness.
- **`/packs/[slug]` mutating actions + markdown renderer (M04 patch slice owner)** — pack regenerate / delete / template install server actions need helper extraction from `packages/cli`. Markdown renderer port from `packages/cli/src/lib/export/render-html.ts`. Estimate: half a day.
- **Doctor tile shell-out + dashboard polling (M04 patch slice owner)** — `spawn('coodra', ['doctor', '--json'])` + 60s cache + the polling hook wrapped around the dashboard. Estimate: half a day.

## Pending user actions

No new items. Three pre-existing items in `context_memory/pending-user-actions.md` remain:

- **Upstash Redis** — required for team-mode BullMQ jobs (sync-daemon, NL Assembly enrichment, semantic-diff). Not blocking M04 (sync-daemon uses pending_jobs in SQLite).
- **Deploy target** — Vercel vs Railway vs Fly.io for the team-mode hosted web. Reserved per OQ-7.
- **Clerk production tenant** — current setup uses the dev `fun-gnu-96` tenant. Production cutover needs a separate Clerk app with prod-tier SSO providers.

## Handoff to next session

- **Starting state:** on `feat/04-web-app` post-S11. `pnpm install && pnpm typecheck && pnpm test:unit` clean across the workspace. Branch unmerged; ready for PR or fast-forward to main.
- **Next concrete step:** open the PR `feat/04-web-app` → `main`. Once green + reviewed + merged, kick off **Module 05 — NL Assembly (Python)** per `essentialsforclaude/08-implementation-order.md §8.1`. M05 unlocks `/search` + Context Pack semantic search in the web (a future M04 patch).
- **Entry point for M05:** `docs/feature-packs/05-nl-assembly/spec.md` — needs to be authored from the kickoff template per the M08b S0 / M04 S0 precedent.

Module 04 complete. Next session: open the PR for review, merge, then start Module 05 per `module-wise plan.md` and `docs/feature-packs/05-nl-assembly/`.

## References

- Feature Pack: `docs/feature-packs/04-web-app/{spec,implementation,techstack}.md` + `wireframes/`
- Architecture: `system-architecture.md` §1 (modes), §2 (services), §13 (web boots in solo + team), §15 (scaling), §19 (auth — Clerk JWT + solo bypass)
- Style / discipline: `essentialsforclaude/02-agent-human-boundary.md` §2.2; `essentialsforclaude/08-implementation-order.md §8.4`
- Brand: `docs/brand/brand.md` + `docs/brand/brand.html` + `docs/brand/README.md`
- Decisions log: `context_memory/decisions-log.md` (search "M04 OQ-" + "M04 STRUCT-")
- Setup guide: `docs/feature-packs/04-web-app/SETUP.md` (NEW — shipped this commit)
