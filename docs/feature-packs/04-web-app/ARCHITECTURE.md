# `apps/web` — Complete Architectural Tour

This document maps every variable, every route, every data connection, and every design decision in the Module 04 web app. Use it to understand how the system is wired end-to-end before changing anything.

> Source: M04 closeout audit, 2026-05-04. Re-read before any Phase 2 work touches files in `apps/web/`.

---

## 1. Top-Level Entry Points

### `next.config.ts` (~26 lines)

Configures Next.js 15 App Router. Key decisions:

- **No global `runtime` declaration**. Every route defaults to Node.js. This is required because `better-sqlite3` is a native module — it cannot run on Vercel's edge runtime. Any future edge route must explicitly opt out via `export const runtime = 'edge'`.
- **`transpilePackages`**: includes `@coodra/contextos-db` and `@coodra/contextos-shared` (workspace packages shipped as TypeScript source, not compiled `dist`). Next.js transpiles them on demand.
- **`serverExternalPackages`**: pins `better-sqlite3` as Node.js-only. Prevents bundler errors.
- **`typedRoutes: true`**: enables type-safe Next.js URL routing. Catches broken `href` props at compile time.

### `middleware.ts` (~62 lines) — Auth + Mode Branching

The **critical routing fork** between solo and team modes.

**Solo mode** (`CONTEXTOS_MODE=solo`, default):
- Clerk middleware is completely short-circuited; no JWT validation.
- `/auth/*` and `/settings/team` routes are rewritten to `/not-found` (return 404).
- Every other route renders with the synthetic `__solo__` user (resolved by `getActor()` in `lib/auth.ts`).
- Middleware just checks `isSoloOnly404` and returns early if matched.

**Team mode** (`CONTEXTOS_MODE=team`):
- Wraps entire middleware stack in `clerkMiddleware()` for JWT validation.
- Public routes: `/api/healthz`, `/auth/sign-in`, `/auth/sign-up`.
- Unauthenticated requests to protected routes → `302 /auth/sign-in?redirect_url=...`.
- Middleware reads `session.userId` and redirects to sign-in if null/undefined (user gets Clerk's hosted form, not a 404).

**Both modes**: `/api/healthz` is always public (needed for process supervisors to health-check).

The `isSolo` const reads `process.env.CONTEXTOS_MODE` and drives the entire fork.

### `tsconfig.json` (~34 lines)

Extends the monorepo's `tsconfig.base.json`. Key compiler options:

- **`moduleResolution: "Bundler"`** — tells TypeScript to resolve modules like the Next.js bundler.
- **`jsx: "preserve"`** — hands JSX to Next.js (does not compile it here).
- **`paths: { "@/*": ["./*"] }`** — root alias. `@/lib/auth.ts` resolves to `apps/web/lib/auth.ts`.
- **`plugins: [{ name: "next" }]`** — Next.js plugin for type-aware route insights.

### `app/layout.tsx` (~60 lines) — Root Layout

Every route is wrapped in this tree:

```
RootLayout
├─ ClerkProvider (auth context for Clerk components; solo mode is a no-op)
├─ <html> + fonts (Inter + JetBrains Mono)
├─ HeaderNav (actor prop → shows solo/team-specific chrome)
├─ Breadcrumb (client component, tracks route hierarchy)
└─ <main max-w-[1200px]> (layout, padding)
   └─ children (page content)
```

**Actor resolution** happens here: `const actor = await getActor()` → passed to HeaderNav for UI branching (solo shows badge; team shows OrganizationSwitcher + UserButton).

### `app/page.tsx` (~194 lines) — Dashboard Home (`/`)

Server-rendered dashboard per spec M04 S9. Fetches two parallel queries:

- `fetchDashboardSnapshot()` → activeRuns count, denials24h count, activeKillSwitches count, latest 10 events
- `fetchDoctorSummary()` → doctor red/yellow counts (stubbed; returns `{ red: 0, yellow: 0, available: false }`)

Renders five tiles + event table. No client-side polling yet (deferred to S9 follow-up). HTML is static per browser refresh.

---

## 2. Route Map (Every Page + API Endpoint)

### Pages (Server Components by default)

| URL | File | Renders | Data Source | Solo | Team |
|-----|------|---------|-------------|------|------|
| `/` | `app/page.tsx` | Dashboard home (5 tiles + event list) | `fetchDashboardSnapshot()`, `fetchDoctorSummary()` | ✓ | ✓ |
| `/runs` | `app/runs/page.tsx` | List of runs, filterable by status/project | `listRuns(filter)`, `listProjectsForFilter()` | ✓ | ✓ |
| `/runs/[id]` | `app/runs/[id]/page.tsx` | Run detail (overview, events, decisions, audit, context pack) | `getRun(id)` | ✓ | ✓ |
| `/runs/[id]/live` | `app/runs/[id]/live/page.tsx` | Run detail with client-side polling (1500ms refresh) | `getRun(id)` (initial) → `/api/runs/[id]/state` (polling) | ✓ | ✓ |
| `/policies` | `app/policies/page.tsx` | Policy list, filterable by project | `listPolicies(projectId)`, `listProjectsForFilter()` | ✓ | ✓ |
| `/policies/[id]` | `app/policies/[id]/page.tsx` | Policy detail (rules, add-rule form) | `getPolicy(identifier)` | ✓ | ✓ |
| `/projects` | `app/projects/page.tsx` | Project list | `listProjects()` | ✓ | ✓ |
| `/projects/[id]` | `app/projects/[id]/page.tsx` | Project detail (reset form + confirmation) | `getProject(identifier)` | ✓ | ✓ |
| `/packs` | `app/packs/page.tsx` | Feature pack list (from disk) | `listPacks()` | ✓ | ✓ |
| `/packs/[slug]` | `app/packs/[slug]/page.tsx` | Pack detail (spec, implementation, techstack, meta) | `getPack(slug)` | ✓ | ✓ |
| `/templates` | `app/templates/page.tsx` | Template list (user + bundled) | `listTemplates()` | ✓ | ✓ |
| `/kill-switches` | `app/kill-switches/page.tsx` | Kill-switch admin (active list + pause form) | `listActive()` | ✓ | ✓ |
| `/auth/sign-in/[[...sign-in]]` | `app/auth/sign-in/page.tsx` | Clerk sign-in form | (Clerk widget) | ✗ 404 | ✓ |
| `/auth/sign-up/[[...sign-up]]` | `app/auth/sign-up/page.tsx` | Clerk sign-up form | (Clerk widget) | ✗ 404 | ✓ |
| `/settings/account` | `app/settings/account/page.tsx` | Clerk UserProfile widget | (Clerk widget) | ✗ 404 | ✓ |
| `/settings/team` | `app/settings/team/page.tsx` | Clerk OrganizationProfile widget | (Clerk widget) | ✗ 404 | ✓ |

**URL-encoding note**: dynamic route params are URL-decoded in handlers (e.g., `runs/:id` receives `run%3Aabc` and decodes to `run:abc` to match M03 run-key format).

### API Routes

| Method | Path | Returns | Auth | Notes |
|--------|------|---------|------|-------|
| `GET` | `/api/healthz` | `{ ok: true, service, mode, serverStartedAt }` | None | Always public. Used by process supervisors + doctor probe. |
| `GET` | `/api/runs/[id]/state` | `{ run, events, decisions, policyDecisions, contextPack }` with ISO dates | Inherited from middleware | 200 OK + `Last-Modified` header if fresh; 304 Not Modified if unchanged (`If-Modified-Since`); 404 if run not found. |

---

## 3. Lib Helpers (`lib/` Directory)

Every file in `lib/` is server-only (no `'use client'`); imported by Server Components and Server Actions.

### `lib/auth.ts` (~39 lines) — Actor Identity

**Exports**:
- `interface Actor`: `{ userId: string; orgId: string; mode: 'solo' | 'team' }`
- `async function getActor(): Promise<Actor>`

**Behaviour**:
- **Solo**: returns hardcoded `SOLO_ACTOR = { userId: '__solo__', orgId: '__solo__', mode: 'solo' }` (no Clerk import).
- **Team**: dynamically imports `@clerk/nextjs/server`, calls `auth()`, reads `session.userId` and `session.orgId` (falls back to `'no-org'` if orgId is null).

**Callers**: RootLayout (`app/layout.tsx`), every Server Action that needs to log the operator's identity (kill-switches, policies, projects), dashboard snapshot.

**Contract**: always returns a non-null Actor; team mode falls back to `{ userId: 'anonymous', orgId: 'anonymous', mode: 'team' }` if Clerk returns null (belt-and-suspenders fallback; middleware should have redirected already).

### `lib/db.ts` (~53 lines) — Storage Adapter

**Exports**:
- `function createWebDb(): DbHandle` — returns cached DB handle (one per Node.js process).
- `function _clearWebDbCache(): void` — test-only helper.

**Behaviour**:
- **Solo** (`CONTEXTOS_MODE !== 'team'`): calls `createDb({ kind: 'local', sqlite: { path: ~/.contextos/data.db } })` (respects `CONTEXTOS_HOME`).
- **Team** (`CONTEXTOS_MODE === 'team'`): calls `createDb({ kind: 'cloud', postgres: { databaseUrl: process.env.DATABASE_URL } })`. Throws if `DATABASE_URL` is missing.

**Module cache**: once created, the handle is cached in a module-level variable (`cached`). Every route in the same Node.js worker reuses the same handle (one Drizzle pool per worker, `max=10`).

**Callers**: every query function in `lib/queries/` and every Server Action.

**Contract**: returns a `DbHandle` typed as `{ kind: 'sqlite' | 'postgres'; db: ... }` so callers branch on schema type (uses `sqliteSchema` vs `postgresSchema`).

### `lib/poll.ts` (~149 lines) — Client-Side Polling Hook

**Exports**:
- `interface PollOptions<T>`: `{ url, intervalMs?, pauseWhenHidden?, initialData?, initialLastModified? }`
- `interface PollResult<T>`: `{ data, error, isLoading, lastModified, isPaused, nextAttemptInMs }`
- `function usePoll<T>(opts: PollOptions<T>): PollResult<T>`

**Behaviour** (all client-side):
- Interval-based GET to `url` with `If-Modified-Since` header (for 304 short-circuit).
- Pauses when `document.hidden === true` (Page Visibility API); resumes on unhide.
- Exponential backoff on error: 1500ms → 3000ms → 6000ms → 12000ms → 30000ms (capped); resets on success.
- Aborts in-flight requests on unmount.
- 200 OK + body → updates `data`, resets backoff.
- 304 Not Modified → keeps current `data`, resets backoff.
- non-2xx / network error → backoff increment, surfaces `error`.

**Callers**: `RunLiveClient` component (client-side wrapper for `/runs/[id]/live`).

**Contract**: caller provides `initialData` from server-render to seed first paint (no spinner flash); polling takes over on mount.

### `lib/clerk-appearance.ts` (~42 lines) — Brand-Styled Auth UI

**Exports**:
- `const clerkAppearance: Appearance` — Clerk appearance config object (structural type from `@clerk/types`).

**Key override**: `borderRadius: '0'` — enforces zero-radius brand mandate (Clerk defaults to rounded corners). Colours + fonts flow from CSS custom properties in `styles/tokens.css`, so theme changes propagate everywhere.

**Element overrides**:
- Buttons: `uppercase tracking-wider font-bold`
- Labels: `uppercase tracking-wider font-bold text-xs`
- Headers: `font-display font-black uppercase`

**Callers**: RootLayout (ClerkProvider), `app/auth/sign-in/page.tsx`, `app/auth/sign-up/page.tsx`, `HeaderNav` (OrganizationSwitcher + UserButton).

### `lib/clerk-issuer.ts` (~73 lines) — JWT Issuer Auto-Discovery

**Exports**:
- `class ClerkIssuerError extends Error`
- `function resolveClerkIssuer(opts: ClerkIssuerOptions): string` — returns issuer URL (e.g., `https://accounts.clerk.com`).
- `async function probeClerkJwks(issuer: string, fetcher?: typeof fetch): Promise<boolean>`

**How it works**:
1. Reads `CLERK_JWT_ISSUER` env if set; returns it immediately.
2. Otherwise parses `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (format: `pk_{test|live}_<base64-tenant>`).
3. Base64-decodes the tenant suffix (Clerk's own algorithm from `@clerk/shared/keys`).
4. Returns `https://{decoded-tenant}`.

**Callers**: bridge server (not the web app itself); web app uses Clerk SDK which handles issuer discovery internally. Kept here for future use (M04 S2 references it for live JWKS verification).

**Contract**: throws `ClerkIssuerError` if both env var and publishable key are missing, or if key format is unrecognized.

### `lib/format.ts` (~58 lines) — Pure Formatting Helpers

**Exports**:
- `function relativeTime(date: Date, now?: Date): string` — e.g., "2 minutes ago", "in 3 days", falls back to ISO date for > 30 days.
- `function compactTimestamp(date: Date, now?: Date): string` — e.g., "14:23:45" (same day) or "2026-05-03 14:23" (other day).
- `function compactDuration(startMs: number, endMs: number): string` — e.g., "1.2s", "47s", "12m 34s", "2h 18m".

**Callers**: Server Components + Client Components (no DOM deps; safe everywhere).

**Contract**: pure functions; can be tested and memoized independently.

---

### `lib/queries/` Directory — Read-Only Queries

Every file is a thin wrapper around helpers from `@coodra/contextos-db`. They centralize storage-adapter selection (SQLite vs Postgres).

#### `lib/queries/dashboard.ts` (~131 lines)

**Exports**:
- `interface DashboardSnapshot`: `{ activeRuns, denials24h, activeKillSwitches, latestEvents, mode, fetchedAt }`
- `interface DashboardEvent`: `{ id, runId, phase, toolName, toolUseId, createdAt }`
- `async function fetchDashboardSnapshot(): Promise<DashboardSnapshot>`
- `async function fetchDoctorSummary(): Promise<{ red, yellow, available }>`

**Queries** (all count/list only; no mutations):
- `countActiveRuns()` — `SELECT count(*) FROM runs WHERE status='in_progress'`
- `countDenialsLast24h()` — `SELECT count(*) FROM policy_decisions WHERE permission_decision='deny' AND createdAt > NOW - 24h`
- `fetchLatestEvents()` — `SELECT * FROM run_events ORDER BY createdAt DESC LIMIT 10`

**Tables touched** (read-only): `runs`, `policy_decisions`, `run_events`.

**Callers**: `app/page.tsx` (dashboard home).

**Contract**: returns aggregates + latest event rows. Handles both SQLite (Date objects, integer unix seconds) and Postgres (timestamptz) seamlessly.

#### `lib/queries/runs.ts` (~55 lines)

**Exports**:
- `interface ListRunsResult`: `{ runs, hasMore, limit }`
- `async function listRuns(filter: ListRunsFilter & { db? }): Promise<ListRunsResult>`
- `async function getRun(runId: string, db?: DbHandle): Promise<RunWithEverything | null>`
- `async function listProjectsForFilter(db?: DbHandle): Promise<ProjectFilterOption[]>`

**Behaviour**:
- `listRuns()` over-fetches by 1 to detect `hasMore` flag (for pagination UI).
- `getRun()` returns full `RunWithEverything` (run + events + decisions + policyDecisions + contextPack).
- `listProjectsForFilter()` returns projects for dropdown filtering on `/runs`.

**Tables touched**: `runs`, `projects`, `run_events`, `decisions`, `policy_decisions`, `context_packs`.

**Callers**: `/runs`, `/runs/[id]`, `/runs/[id]/live` pages.

**Contract**: thin wrapper around `@coodra/contextos-db` functions; caller provides filter object and optional DbHandle.

#### `lib/queries/kill-switches.ts` (~88 lines)

**Exports**:
- `const SCOPES, MODES` (re-exported from `@coodra/contextos-db`)
- `type Scope`
- `async function listActive(): Promise<KillSwitchRecord[]>`
- `async function insertKillSwitchWithSync(input): Promise<KillSwitchRecord>`
- `async function softResumeWithSync(args): Promise<KillSwitchRecord | null>`
- `function findDuplicateActive(active, candidate): KillSwitchRecord | null`

**Key feature**: `insertKillSwitchWithSync()` and `softResumeWithSync()` enqueue `sync_to_cloud` rows in team mode (so sync-daemon pulls changes within ~10s p95). Solo mode skips the enqueue.

**Tables touched** (write): `kill_switches`, `durable_writes` (sync_to_cloud queue); (read): `kill_switches`.

**Callers**: `/kill-switches` page, server actions (`lib/actions/kill-switches.ts`).

**Contract**: `isTeamMode()` check is internal; caller always goes through the `WithSync` versions.

#### `lib/queries/policies.ts` (~44 lines)

**Exports**:
- `async function listPolicies(projectId?: string): Promise<PolicyWithRules[]>`
- `async function getPolicy(identifier: string, projectId?: string): Promise<PolicyWithRules | null>`
- `async function addPolicyRule(args: AddPolicyRuleArgs): Promise<AddPolicyRuleResult>`
- `async function setPolicyActive(identifier: string, active: boolean, projectId?: string): Promise<PolicyRow | null>`

**Tables touched** (read): `policies`, `policy_rules`; (write): `policies`, `policy_rules`.

**Callers**: `/policies`, `/policies/[id]` pages; server actions (`lib/actions/policies.ts`).

**Contract**: wrappers around `@coodra/contextos-db` policy helpers; no sync-queue logic (policies are written by CLI first; web edits are secondary).

#### `lib/queries/projects.ts` (~37 lines)

**Exports**:
- `async function listProjects(): Promise<ProjectListRow[]>`
- `async function getProject(identifier: string): Promise<ProjectDetailRow | null>`
- `async function resetProject(identifier: string, options?): Promise<ResetProjectResult | null>`

**Tables touched** (read): `projects`; (write via cascade): `runs`, `run_events`, `decisions`, `policy_decisions`, `context_packs`.

**Callers**: `/projects`, `/projects/[id]` pages; server actions.

**Contract**: `resetProject()` is destructive (deletes run history); server action re-validates user confirmation client-side input before calling.

#### `lib/queries/packs.ts` (~167 lines)

**Exports**:
- `interface PackListRow`: `{ slug, dir, parentSlug, isActive, hasMeta, hasSpec, ..., fileCount }`
- `interface PackDetail extends PackListRow`: `{ spec?, implementation?, techstack?, metaRaw? }`
- `function listPacks(cwd?): PackListRow[]`
- `function getPack(slug: string, cwd?): PackDetail | null`

**Data source**: **filesystem only** (not DB). Scans `docs/feature-packs/` under repo root (walks up from `process.cwd()` up to 6 levels). Respects `CONTEXTOS_PACKS_ROOT` env override.

**File-scanning logic**:
- Walks each pack directory looking for: `meta.json`, `spec.md`, `implementation.md`, `techstack.md`.
- Missing files are tolerated; pack still lists with `hasMeta`/`hasSpec` flags.
- `meta.json` is parsed (Zod schema) for `isActive` and `parentSlug`.
- Results sorted alphabetically by slug.

**Callers**: `/packs`, `/packs/[slug]` pages.

**Contract**: returns empty list if pack root not found (graceful degradation for team mode running outside a project).

#### `lib/queries/templates.ts` (~122 lines)

**Exports**:
- `interface TemplateRow`: `{ name, source ('bundled' | 'user'), dir, description, version, languages, autoSections }`
- `function listTemplates(): TemplateRow[]`

**Data source**: **filesystem only** (two-tier). Scans:
1. User templates: `~/.contextos/templates/` (respects `CONTEXTOS_HOME`)
2. Bundled templates: `node_modules/@coodra/contextos-cli/templates/` or workspace `packages/cli/templates/`

User templates shadow bundled ones with the same name. Each template must have a `template.json` file.

**Callers**: `/templates` page.

#### `lib/queries/run-state.ts` (~84 lines)

**Exports**:
- `function runStateLastModified(snapshot: RunWithEverything): Date` — high-water-mark across all timestamps.
- `function serializeRunState(snapshot): SerializedRunState` — converts Dates to ISO strings.
- `type SerializedRunState` — JSON-serializable shape.

**Callers**: `/api/runs/[id]/state` endpoint (for `Last-Modified` header + JSON response).

**Contract**: deterministic; used for ETag/Last-Modified computation (If-Modified-Since short-circuit).

---

### `lib/actions/` Directory — Server Actions

Every file is a Server Action (top-level `'use server'`). Wrapped to `<form action={fn}>` or called directly from event handlers. Uses `redirect()` + `revalidatePath()` to mutate cache and navigate.

#### `lib/actions/kill-switches.ts` (~97 lines)

**Exports**:
- `async function pauseAction(formData): Promise<void>`
- `async function resumeAction(formData): Promise<void>`

**`pauseAction` logic**:
1. Validates form via Zod schema (scope, target, mode, reason, optional expiresAt).
2. Checks for duplicate active kill-switch (same scope + target); redirects with `?duplicate=id` if found (unless `force=true`).
3. Calls `insertKillSwitchWithSync()` with `pausedBySessionId: 'web:${actor.userId}'`.
4. Revalidates `/kill-switches` + `/` cache.
5. Redirects to `/kill-switches?paused=id`.

**`resumeAction` logic**:
1. Extracts kill-switch `id` from form.
2. Calls `softResumeWithSync()`.
3. Revalidates + redirects to `/kill-switches?resumed=id`.

**Table writes**: `kill_switches`, `durable_writes` (team mode).

**Callers**: `/kill-switches` page forms.

#### `lib/actions/policies.ts` (~82 lines)

**Exports**:
- `async function addRuleAction(formData): Promise<void>`
- `async function setActiveAction(formData): Promise<void>`

**`addRuleAction` logic**:
1. Validates form (projectId, matchToolName, decision, reason, optional fields).
2. Calls `addPolicyRule()`.
3. Revalidates `/policies` + `/policies/[identifier]`.
4. Redirects to `/policies/[policyName]?added=ruleId`.

**`setActiveAction` logic**:
1. Toggles policy active/inactive.
2. Calls `setPolicyActive()`.
3. Revalidates + redirects with `?toggled=enabled|disabled`.

**Table writes**: `policy_rules`, `policies`.

**Callers**: `/policies/[id]` page forms.

#### `lib/actions/projects.ts` (~51 lines)

**Exports**:
- `async function resetProjectAction(formData): Promise<void>`

**Logic**:
1. Validates form (identifier, confirmation slug match).
2. Calls `resetProject()` with `keepPolicies` option (defaults true; user unchecks to also delete policies).
3. Revalidates cache.
4. Redirects to `/projects?reset=slug&summary=...` (deletion counts in querystring for success banner).

**Destructive**: deletes all runs + related audit records for a project.

**Table writes**: `runs`, `run_events`, `decisions`, `policy_decisions`, `context_packs` (optionally `policies`, `policy_rules`).

**Callers**: `/projects/[id]` page "Reset project" form.

---

## 4. Environment Variables

Every `process.env.*` reference in the web app:

| Variable | Type | Mode | Scope | Purpose | Default |
|----------|------|------|-------|---------|---------|
| `CONTEXTOS_MODE` | string | Both | Server | Controls solo/team fork; read in middleware, auth.ts, db.ts, dashboard.ts, pages | `'solo'` |
| `CONTEXTOS_HOME` | string | Solo | Server | Path to solo user's data dir; used for SQLite location + template dir | `~/.contextos` (via `homedir()`) |
| `DATABASE_URL` | string | Team | Server | Postgres connection string; required in team mode, throws if missing | (none; throws if team mode) |
| `CONTEXTOS_PACKS_ROOT` | string | Both | Server | Override pack directory location | (auto-walk up to find `docs/feature-packs`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | string (`NEXT_PUBLIC_`) | Team | Client + Server | Clerk publishable key; used by `@clerk/nextjs` library | (none; required in team mode) |
| `CLERK_SECRET_KEY` | string | Team | Server (hidden from client) | Clerk secret key; used by `@clerk/nextjs/server` | (none; required in team mode) |
| `CLERK_JWT_ISSUER` | string | Team | Server | Optional override for JWT issuer URL (normally auto-discovered from publishable key) | (auto-discovered via `resolveClerkIssuer()`) |
| `NEXT_PUBLIC_SUPABASE_URL` | string (`NEXT_PUBLIC_`) | (unused) | Client | Legacy Supabase stub (in `utils/supabase/`); not used in current architecture | (none) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | string (`NEXT_PUBLIC_`) | (unused) | Client | Legacy Supabase stub | (none) |

**`NEXT_PUBLIC_` prefix** = visible in browser (included in JS bundle). Used only for `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (Clerk SDK needs it client-side for UI components).

**Server-only** (redacted from client): `CONTEXTOS_MODE`, `CONTEXTOS_HOME`, `DATABASE_URL`, `CONTEXTOS_PACKS_ROOT`, `CLERK_SECRET_KEY`, `CLERK_JWT_ISSUER`.

**Solo-only**: `CONTEXTOS_HOME`.

**Team-only**: `DATABASE_URL`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.

---

## 5. Components (`components/` Directory)

All 12 components are read-only presentational (except for `Breadcrumb`, which is a client-side hook).

| Component | Kind | Exports | Purpose |
|-----------|------|---------|---------|
| `Breadcrumb.tsx` | Client | `function Breadcrumb()` | Listens to router + renders breadcrumb trail. Uses `usePathname()`. |
| `DecisionCard.tsx` | Server | `interface DecisionCardProps`, `function DecisionCard()` | Renders decision entry (description, rationale, alternatives, timestamp). |
| `HeaderNav.tsx` | Server | `interface HeaderNavProps`, `function HeaderNav(actor)` | Top header chrome: logo, nav links (Runs, Policies, Projects, Packs, Templates, Kill switches), actor badge (solo/team switcher). |
| `PolicyDecisionRow.tsx` | Server | `interface PolicyDecisionRowProps`, `function PolicyDecisionRow()` | Table row for audit-trail entry (timestamp, decision, tool, reason, rule id). |
| `RelativeTime.tsx` | Server | `interface RelativeTimeProps`, `function RelativeTime(date, mode)` | Renders relative ("2 minutes ago") or compact ("14:23:45") time. |
| `RiskBadge.tsx` | Server | `type RiskLevel`, `interface RiskBadgeProps`, `function RiskBadge()` | Coloured badge for risk levels (low/medium/high). |
| `RunEventRow.tsx` | Server | `interface RunEventRowProps`, `function RunEventRow()` | Expandable table row for run event (tool, phase, input, outcome, timestamp). |
| `RunRow.tsx` | Server | `interface RunRowProps`, `function RunRow()` | Table row for run list (id, status, agent, started, session). |
| `RunStatusChip.tsx` | Server | `function RunStatusChip(status)` | Coloured chip for run status (in_progress, completed, cancelled, failed). |
| `SoloModeBadge.tsx` | Server | `function SoloModeBadge()` | Badge shown in header when `mode=solo`. |
| `StatusChip.tsx` | Server | `type StatusChipKind`, `interface StatusChipProps`, `function StatusChip()` | Generic coloured chip for status values (success/warning/error/info/neutral). |
| `ToolBadge.tsx` | Server | `interface ToolBadgeProps`, `function ToolBadge(name)` | Badge for tool name (e.g., "Bash", "Claude Code"). |

**All components** are fully styled with Tailwind v4 utilities (`bg-(--color-*)`, `text-(--color-*)`). No external component library (shadcn/ui, Chakra, etc.). Zero border-radius enforced.

---

## 6. Data Flow: Three Representative Routes

### Route 1: Dashboard Home (`/`)

```
browser: GET /
   │
   ▼
middleware.ts: isSolo ? soloMiddleware : clerkMiddleware()
   ├─ Solo: no-op (returns undefined)
   └─ Team: validates JWT, redirects to /auth/sign-in if null
   │
   ▼
app/layout.tsx (RootLayout)
   ├─ getActor() → { userId: '__solo__' | real user id, orgId, mode }
   ├─ ClerkProvider(appearance=clerkAppearance)
   ├─ HeaderNav(actor) → renders logo, nav, user button
   └─ children (DashboardPage)
   │
   ▼
app/page.tsx (DashboardPage, server component)
   ├─ Promise.all([
   │     fetchDashboardSnapshot() →
   │       ├─ createWebDb() → handle (SQLite if solo, Postgres if team)
   │       ├─ countActiveRuns() → query runs WHERE status='in_progress'
   │       ├─ countDenialsLast24h() → query policy_decisions WHERE ... > 24h ago
   │       ├─ listAllActiveKillSwitches() → query kill_switches
   │       └─ fetchLatestEvents() → SELECT * FROM run_events LIMIT 10
   │     fetchDoctorSummary() → { red: 0, yellow: 0, available: false } (stub)
   │   ])
   ├─ return (
   │     <div>
   │       <h1>Dashboard</h1>
   │       <Tile label="Active runs" value={snapshot.activeRuns} href="/runs?status=in_progress" />
   │       <Tile label="Denials · 24h" value={snapshot.denials24h} href="/runs" />
   │       <Tile label="Active pauses" value={snapshot.activeKillSwitches} href="/kill-switches" />
   │       <DoctorTile snapshot={doctor} />
   │       <table>{snapshot.latestEvents.map(evt => <tr><ToolBadge /><Link to>/runs/{evt.runId}</Link></tr>)}</table>
   │     </div>
   │   )
   └─ browser renders HTML
```

**Solo divergence**: no Clerk init, direct SQLite queries against `~/.contextos/data.db`.
**Team divergence**: Clerk JWT validation, Postgres queries via `DATABASE_URL`.
**Cache**: RootLayout calls `getActor()` once per request (server-side only; client doesn't know about it).

### Route 2: Runs List (`/runs?status=in_progress&project=<id>`)

```
browser: GET /runs?status=in_progress&project=<id>
   │
   ▼
middleware.ts: validates auth (solo/team branch)
   │
   ▼
RootLayout
   ├─ getActor()
   ├─ HeaderNav(actor)
   │
   ▼
app/runs/page.tsx (RunsListPage, server component)
   ├─ searchParams = { status: 'in_progress', project: '<id>' }
   ├─ filter = { status: 'in_progress', projectId: '<id>', limit: 50 }
   ├─ Promise.all([
   │     listRuns(filter) →
   │       ├─ createWebDb()
   │       ├─ listRunsForProject(handle, { status, projectId, limit: 51 })
   │       │   → SELECT * FROM runs WHERE status=... AND projectId=... LIMIT 51
   │       ├─ hasMore = rows.length > 50
   │       └─ { runs: rows.slice(0, 50), hasMore, limit: 50 }
   │     listProjectsForFilter() →
   │       ├─ createWebDb()
   │       └─ listProjects() → SELECT * FROM projects
   │   ])
   ├─ return (
   │     <div>
   │       <h1>Runs</h1>
   │       <form method="GET" action="/runs">
   │         <select name="status" defaultValue="in_progress" />
   │         <select name="project" defaultValue="<id>" />
   │         <button>Apply</button>
   │       </form>
   │       <table>
   │         {runs.map(run => <RunRow id={run.id} status={run.status} agentType={run.agentType} ... />)}
   │       </table>
   │       {hasMore ? <Link href="/runs?...&limit=100">Show more</Link> : null}
   │     </div>
   │   )
   └─ browser renders HTML
```

**URL state**: filter lives in query string (shareable, bookmarkable).
**Pagination**: "Show more" doubles the limit; server decides `hasMore` by over-fetching by 1.
**`RunRow` component**: server component; renders id (link to `/runs/[id]`), status chip, agentType, startedAt (relative time), sessionId.

### Route 3: Kill-Switches (`/kill-switches`)

```
browser: GET /kill-switches
   │
   ▼
middleware.ts: validates auth
   │
   ▼
RootLayout → getActor()
   │
   ▼
app/kill-switches/page.tsx (KillSwitchesPage, server component)
   ├─ searchParams = { paused?, resumed?, duplicate?, scope?, target?, error? }
   ├─ actor = getActor() → { userId, orgId, mode }
   ├─ active = listActive() →
   │     ├─ createWebDb()
   │     └─ listAllActiveKillSwitches(handle) → SELECT * FROM kill_switches WHERE resumedAt IS NULL
   ├─ return (
   │     <div>
   │       <h1>Kill switches</h1>
   │       <Banners paused={sp.paused} resumed={sp.resumed} duplicate={sp.duplicate} error={sp.error} />
   │       <Section title={`Active (${active.length})`}>
   │         <table>
   │           {active.map(row => (
   │             <tr>
   │               <StatusChip status={row.mode === 'hard' ? 'error' : 'warning'}>{row.mode}</StatusChip>
   │               <td>{row.scope}={row.target}</td>
   │               <td>{row.reason}</td>
   │               <td>{ageString(row.pausedAt)}</td>
   │               <td>{row.pausedBySessionId}</td>
   │               <form action={resumeAction}>
   │                 <input type="hidden" name="id" value={row.id} />
   │                 <button>Resume</button>
   │               </form>
   │             </tr>
   │           ))}
   │         </table>
   │       </Section>
   │       <Section title="Pause new">
   │         <form action={pauseAction}>
   │           <FormField name="scope" type="select" options={['global', 'project', 'tool', 'agent_type']} />
   │           <FormField name="target" placeholder="if not global" />
   │           <FormField name="mode" type="select" options={['hard', 'soft']} />
   │           <FormField name="expiresAt" placeholder="ISO 8601" />
   │           <FormField name="reason" type="textarea" required />
   │           <button>Pause</button>
   │         </form>
   │       </Section>
   │     </div>
   │   )
   └─ browser renders HTML
```

**Form submission: pause new**
```
browser: POST (form action=pauseAction)
   │
   ▼
lib/actions/kill-switches.ts::pauseAction(formData)
   ├─ Zod validation (scope, target, mode, reason, expiresAt, force)
   ├─ redirect if validation fails with ?error=...
   ├─ Check for duplicate active (same scope + target)
   │     ├─ duplicate found? → redirect with ?duplicate=id&scope=...&target=...
   │     └─ (unless force=true)
   ├─ Parse expiresAt if provided
   ├─ actor = getActor()
   ├─ inserted = insertKillSwitchWithSync({
   │     scope, target, mode, reason,
   │     pausedBySessionId: `web:${actor.userId}`,
   │     expiresAt
   │   }) →
   │     ├─ createWebDb()
   │     ├─ INSERT INTO kill_switches (scope, target, mode, reason, pausedBySessionId, expiresAt, pausedAt=NOW)
   │     ├─ if (CONTEXTOS_MODE === 'team') INSERT INTO durable_writes (queue='sync_to_cloud', payload={table: 'kill_switches', ...})
   │     │     [sync-daemon's puller will pick this up ~10s; fans out to all developers]
   │     └─ return inserted row
   ├─ revalidatePath('/kill-switches')
   ├─ revalidatePath('/')
   └─ redirect(`/kill-switches?paused=${inserted.id}`)
```

**Resume form submission**:
```
browser: POST (form action=resumeAction, input hidden id=<id>)
   │
   ▼
lib/actions/kill-switches.ts::resumeAction(formData)
   ├─ id = String(formData.get('id'))
   ├─ actor = getActor()
   ├─ row = softResumeWithSync({ id, resumedBySessionId: `web:${actor.userId}` }) →
   │     ├─ UPDATE kill_switches SET resumedAt=NOW WHERE id=<id>
   │     ├─ if (CONTEXTOS_MODE === 'team') enqueue sync_to_cloud
   │     └─ return updated row
   ├─ revalidatePath('/kill-switches')
   ├─ revalidatePath('/')
   └─ redirect(`/kill-switches?resumed=${id}`)
```

**Solo divergence**: no `sync_to_cloud` enqueue; resume is local only.
**Team divergence**: enqueue sync payload; sync-daemon pulls within ~10s, pushes to all developers' local stores.

---

## 7. Brand / Styling System (Tailwind v4 + CSS Custom Properties)

### `app/globals.css` (~79 lines)

Imports Tailwind v4 and defines the theme layer.

```css
@import 'tailwindcss';
@import '../styles/tokens.css';

@theme {
  --color-brand: var(--color-brand);
  /* ... all tokens from styles/tokens.css ... */
  --radius: 0; /* Zero radius mandate */
}

* {
  border-radius: 0 !important; /* Enforce zero radius everywhere */
}

*:focus-visible {
  outline: 2px solid var(--color-brand);
  outline-offset: 2px;
}
```

**Key decision**: `@theme` block exports CSS custom properties as Tailwind utilities. So `--color-brand: #1c69d4` becomes `bg-brand`, `text-brand`, `border-brand` utilities.

**Zero-radius enforcement**: both the `@theme` `--radius: 0` AND the `*` selector `border-radius: 0 !important` ensure no component can accidentally use Tailwind's `rounded-*` utilities.

### `styles/tokens.css` (~107 lines)

Full brand-token catalog. Every colour, font, spacing value is a CSS custom property in `:root` (light mode) and `[data-theme='dark']` (dark mode).

**Light mode** (`:root`):
- Colours: brand (#1c69d4), surfaces (white, light grays), text (dark gray shades), borders (rgba black), status (success green, warning amber, error red, info blue, neutral gray), risk (low/medium/high), shadows.
- Fonts: Inter (display + sans), JetBrains Mono (mono).
- Spacing: 4px base unit (`--space-1` through `--space-16`).
- Motion: `--motion-quick`, `--motion-section`, `--motion-route` (unused in current implementation).

**Dark mode** (`[data-theme='dark']`):
- Same structure, inverted colours (dark backgrounds, light text).
- Surfaces: very dark gray/blue (#0a0a0f, #111118, etc.).
- Borders: `rgba(255, 255, 255, ...)`.

**Portage note**: tokens were hand-ported from `docs/brand/brand.html` (source of truth). A unit test in spec.md AC-10 greps the built CSS for hardcoded `#` outside this file (catches brand drift).

**Tailwind v4 integration**: globals.css's `@theme` block maps every token to a utility:
- `--color-brand` → `bg-brand`, `text-brand`, `border-brand`, `from-brand`, `to-brand`, etc.
- `--font-mono` → `font-mono`
- `--space-4` → `p-4`, `m-4`, `gap-4`, etc.

### Usage pattern

```tsx
<div className="bg-(--color-bg-surface) border border-(--color-border-subtle) p-6">
  <h1 className="text-4xl font-display font-black text-(--color-text-primary)">Title</h1>
  <p className="text-(--color-text-secondary)">Subtitle</p>
  <button className="bg-(--color-brand) text-white hover:bg-(--color-brand-hover)">
    Submit
  </button>
</div>
```

Tailwind v4 allows `className="bg-(--color-brand)"` syntax (arbitrary value with CSS var). No `\#` escaping needed; the preprocessor handles it.

---

## 8. The Mode Switch: `CONTEXTOS_MODE`

Every concrete code branch controlled by `process.env.CONTEXTOS_MODE`:

### Middleware (`middleware.ts`, lines 25–52)

```typescript
const isSolo = (process.env.CONTEXTOS_MODE ?? 'solo') === 'solo';
export default isSolo ? soloMiddleware : clerkMiddleware(...)
```

- **Solo**: `soloMiddleware` checks `isSoloOnly404` patterns (`/auth/*`, `/settings/team/*`), rewrites to `/not-found`.
- **Team**: wraps in `clerkMiddleware()`, validates JWT, redirects unauthenticated to `/auth/sign-in`.

### Auth resolution (`lib/auth.ts`, lines 20–38)

```typescript
const mode = (process.env.CONTEXTOS_MODE ?? 'solo') as 'solo' | 'team';
if (mode === 'solo') return SOLO_ACTOR;
const { auth } = await import('@clerk/nextjs/server'); // lazy import (solo bundles don't pull Clerk)
const session = await auth();
return { userId: session.userId, orgId: session.orgId ?? 'no-org', mode: 'team' };
```

- **Solo**: no Clerk import; returns hardcoded `{ userId: '__solo__', orgId: '__solo__', mode: 'solo' }`.
- **Team**: dynamic import + Clerk auth call.

### DB adapter (`lib/db.ts`, lines 27–42)

```typescript
const mode = process.env.CONTEXTOS_MODE ?? 'solo';
if (mode === 'team') {
  const url = process.env.DATABASE_URL; // throws if missing
  cached = createDb({ kind: 'cloud', postgres: { databaseUrl: url } });
} else {
  const home = process.env.CONTEXTOS_HOME ?? resolve(homedir(), '.contextos');
  const path = resolve(home, 'data.db');
  cached = createDb({ kind: 'local', sqlite: { path } });
}
```

- **Solo**: SQLite at `~/.contextos/data.db` (or `${CONTEXTOS_HOME}/data.db`).
- **Team**: Postgres via `DATABASE_URL`.

### Dashboard snapshot (`lib/queries/dashboard.ts`, line 35)

```typescript
const mode = (process.env.CONTEXTOS_MODE === 'team' ? 'team' : 'solo') as 'solo' | 'team';
return { ..., mode, ... };
```

Snapshot includes mode flag so dashboard can render mode-specific UI hints.

### Kill-switch sync (`lib/queries/kill-switches.ts`, line 29)

```typescript
function isTeamMode(): boolean {
  return process.env.CONTEXTOS_MODE === 'team';
}
// Then in insertKillSwitchWithSync() + softResumeWithSync():
if (isTeamMode()) {
  await scheduleDurableWrite(handle, { queue: 'sync_to_cloud', ... });
}
```

- **Solo**: no `sync_to_cloud` enqueue; mutations are local only.
- **Team**: enqueue row for sync-daemon to fan out to other developers.

### Route guard pages (auth, settings)

```typescript
// app/auth/sign-in/page.tsx, app/auth/sign-up/page.tsx,
// app/settings/account/page.tsx, app/settings/team/page.tsx
if ((process.env.CONTEXTOS_MODE ?? 'solo') === 'solo') notFound();
```

- **Solo**: `notFound()` renders `/not-found` page (404 visual).
- **Team**: renders the page (Clerk components).

### API health check (`app/api/healthz/route.ts`, line 19)

```typescript
mode: process.env.CONTEXTOS_MODE ?? 'solo',
```

Returned in JSON response for monitoring/debugging.

### Dashboard (`app/page.tsx`, lines 55–58)

```tsx
<p className="text-xs text-(--color-text-tertiary)">
  {actor.mode === 'solo'
    ? 'Open Claude Code in this project to see events flow into this view.'
    : 'No events recorded across the org yet.'}
</p>
```

Mode-specific UI hint in empty state.

### Kill-switches page (`app/kill-switches/page.tsx`, lines 44–46)

```tsx
{actor.mode === 'team'
  ? 'Pauses propagate to all developers within ~10s (sync-daemon pulls every 5s, bridge cache TTL 5s).'
  : 'Solo mode — pause is local only. No cross-developer propagation.'}
```

Propagation hint.

---

## 9. Summary: The Wiring

Entire request → response cycle (simplified):

```
browser request
   │
   ▼
middleware.ts
   ├─ if CONTEXTOS_MODE=solo: soloMiddleware (404 auth routes)
   └─ if CONTEXTOS_MODE=team: clerkMiddleware (JWT validation)
   │
   ▼
RootLayout
   ├─ getActor() (synthetic vs real user)
   ├─ ClerkProvider (no-op solo, active team)
   ├─ HeaderNav (mode-specific chrome)
   │
   ▼
   page.tsx (Server Component)
     ├─ query functions (lib/queries/*)
     │     ├─ createWebDb() (SQLite or Postgres)
     │     └─ SELECT / INSERT / UPDATE
     ├─ server actions (lib/actions/*)
     │     └─ revalidatePath() + redirect()
     └─ render JSX
   │
   ▼
browser HTML + CSS (Tailwind v4)
   └─ tokens.css custom properties (brand colours, fonts)
```

Every variable is tied to this thread. The mode switch is the primary lever; everything else falls out of the architecture.

---

**Total lines of web app code** (post-M04): ~2,100 (pages), ~900 (lib helpers), ~1,200 (components) ≈ 4,200 lines. Minimal client-side JS (only `Breadcrumb`, Clerk widgets, `RunLiveClient` polling).

**Known gaps surfaced during M04 closeout audit (2026-05-04)** — see `docs/feature-packs/04-web-app-phase-2/spec.md` for the canonical Phase 2 plan:

- No global project selector — every list shows entities from every project.
- `__global__` sentinel leaks into `/projects` — needs `WHERE slug != '__global__'` filter.
- `run_events.run_id` is NULL for 99.86% of rows — root cause in `apps/hooks-bridge/src/lib/run-recorder.ts`.
- `/packs/[slug]` shows raw markdown — needs renderer.
- No pack mutation surfaces (regenerate/delete/template install).
- Doctor tile is a stub.
- No `/init`, `/graph`, `/doctor`, `/logs`, `/sync`, no FP editor.
