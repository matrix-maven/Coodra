# Module 04 — Web App (`apps/web` admin + audit-trail UI for Coodra) — Spec

> **Status:** kickoff (2026-05-03). No implementation slice has landed yet. This spec is the kickoff document; open questions in §13 were locked by the project lead in the same session it was authored.
> **Depends on:** 01 Foundation (DB), 02 MCP Server, 03 Hooks Bridge, 03.1 Durable Outbox (audit-trail integrity), 04a Sync Daemon (one-way push baseline; M04 extends to bidirectional — see §10), 08a CLI (operational install/lifecycle), 08b CLI Expansion (admin surfaces — `policy/project/run/pack/template/pause/export/doctor` shape the web's contract).
> **Blocks:** 07 VS Code Extension's session-panel and admin-surface webview consumers — they target the M04 routes once they exist. Team-mode hosted deploy in production also blocks on M04 (web is the user-visible surface that justifies the cloud bill).
> **Aware of:** 05 NL Assembly will eventually own a `/search` route + Context-Pack semantic-search UI; 06 Semantic Diff will eventually own a `/runs/[id]/diff` overlay. Neither lands in M04.
> **Source of truth:** `system-architecture.md` §1 (modes), §2 (service inventory; web is item 4 on `:3000`), §3.1 (HTTP versions — Next.js 15 ships HTTP/2 ready), §4 (data-at-rest — M04 reads from the same 11-table schema; no deltas), §7 (fail-open — web inherits this for live updates), §13 (`coodra start` provisions web in solo dev), §15 (web scaling — solo single-process, team standard Vercel-style hosting), §16 patterns 1–4 (idempotency carries through to web mutations) + 12 (admin authority) + 19 (auth) + 20 (bridge-mediated session lifecycle — M04 reads the run state the bridge persists), §19 (auth — solo bypass + team Clerk JWT). Visual identity: `brand.md` + `brand.html` (Precision Blue, Inter weight contrast, JetBrains Mono, zero-radius). User directives 2026-04-24 (no marketing site, no BYO-cloud team variant, Gemini for managed LLM) and 2026-05-03 (M04 OQ locks).

## 1. What M04 is

M04 ships **`apps/web`** — a Next.js 15 + React 19 application that exposes Coodra's operational and audit surfaces over a browser. It is the first read surface for end-users that is not the CLI. The web app is **the same build in solo and team mode**; the storage adapter chooses local SQLite or cloud Postgres at boot, and the auth middleware chooses bypass or Clerk JWT validation.

**Why now.** The 20-command CLI from M08b proved that Coodra has the right admin-surface vocabulary (policy / project / run / pack / template / pause / export / doctor); the web app makes that vocabulary visible to people who don't live in a terminal — code reviewers asking "what did the agent decide on PR #482", security reviewers asking "show me every deny in the last 7 days", team admins who need to flip a global kill-switch from a phone. The CLI gates the agent loop in real time; the web reveals what happened.

**Why also "the UI/UX module".** Coodra has been backend-only for eleven modules. M04 is the first time the brand lives in pixels. We treat it as the visual-identity grounding event: every M04 surface uses the canonical brand (Precision Blue interactive-only, Inter weight contrast, JetBrains Mono for IDs/paths/code, zero-radius rectangles, dark hero / light content rhythm, the status palette already mapping to enforcement vocabulary). M07 (VS Code) and any future surface (e.g. a marketplace listing webview) will inherit from M04's token catalog — so we port the **full** brand catalog up-front (OQ-5 lock), not the load-bearing minimum. This is the one place in the project where over-investing in design system pays compound interest.

**What M04 is NOT.** Not a marketing site. Not a landing page. Not a public docs portal. Not billing. Not seat management. M04 is operator-and-audit-only — every page is for someone already inside a project (solo: themselves; team: a member of an org). Marketing/distribution stays out per the standing 2026-04-24 directive.

## 2. Acceptance criteria

A commit on `feat/04-web-app` is "complete" when **every** item below holds on a clean checkout:

1. **Workspace integration:** `pnpm install` clean across the monorepo with `apps/web` added to `pnpm-workspace.yaml`. No new peer-dependency warnings escalated to errors. `turbo.json` pipeline includes `apps/web#build`, `apps/web#dev`, `apps/web#typecheck`, `apps/web#lint`.
2. `pnpm lint` — Biome zero findings across `apps/web/**` and any `packages/*` files M04 touched (notably `apps/sync-daemon/src/handlers/kill-switches.ts` for the S8a backend extension).
3. `pnpm typecheck` — `tsc --noEmit` clean for every workspace package, including the new `apps/web`.
4. `pnpm test:unit` — every unit test passes; ≥ 80% line coverage on touched files per `essentialsforclaude/06-testing.md §6.4`. New unit tests cover: storage-adapter mode selection, polling-loop pacing, brand-token CSS variable surface, route-guard middleware (solo bypass vs Clerk-validated), the M04a→M04 bidirectional sync extension's pull handler, the dashboard aggregation queries.
5. `pnpm test:integration` — new integration tests pass: (a) Drizzle-Postgres schema applies cleanly to a fresh Supabase Postgres (S2's smoke test runs against testcontainers `pgvector/pgvector:pg16` in CI; against the live `gyopozvfmggumidptmjr` project on demand), (b) Clerk JWT validation against a real dev tenant returns 200 for a valid Bearer and 401 for an invalid one (closes the M02 S7b-deferred Clerk live-tenant gap), (c) Sync-daemon's new `kill_switches` handler pulls cloud rows and applies them locally without conflicting with locally-paused switches.
6. `pnpm test:e2e` — extended e2e adds the **dashboard-home contract:** boot a synthetic project with seeded runs + decisions + an active kill-switch + a doctor warning, fetch `/`, assert each tile renders the right number with the right colour from the status palette.
7. **Schema delta:** **NONE.** M04 reads + writes against the existing 11-table schema (`projects`, `runs`, `run_events`, `context_packs`, `pending_jobs`, `policies`, `policy_rules`, `policy_decisions`, `feature_packs`, `decisions`, `kill_switches`). No new migrations. The sync-daemon's `kill_switches` handler is a new dispatcher, not a schema change.
8. **Backwards compatibility:** every CLI command (M08a + M08b — 20 commands) keeps its surface verbatim. The web reads from the same SQLite/Postgres tables the CLI writes to; no shadow tables, no derived caches that could drift.
9. **Mode parity:** every M04 route renders correctly in BOTH `COODRA_MODE=solo` (against `~/.coodra/data.db`) and `COODRA_MODE=team` (against the Supabase Postgres at `gyopozvfmggumidptmjr.supabase.co`). The storage adapter (§7) selects the read path; nothing else differs.
10. **Brand fidelity:** every M04 surface uses tokens from `apps/web/styles/tokens.css` (the full ported catalog from `brand.md`/`brand.html`); zero hardcoded hex colors, zero hardcoded font sizes, zero non-brand typefaces, zero rounded corners. One unit test enforces this (greps the built CSS for hardcoded `#` outside the tokens file and `border-radius` values > 0).
11. **Auth model:** in solo, every route renders without sign-in as the synthetic `__solo__` user (matches CLI's existing `__solo__` org-default). In team, every route except the auth callback is protected by Clerk JWT middleware; unauthenticated GETs return a 302 to the Clerk-hosted sign-in.
12. **Live updates contract:** every page that surfaces real-time data (dashboard home, run detail, kill-switch admin) uses the **polling adapter** at the cadence locked in §8 (1500ms default, configurable). Optimistic UI is allowed for explicit user actions; passive page state polls.
13. **Bidirectional kill-switch sync:** a switch flipped in the web admin (S8b) lands in cloud Postgres and is pulled by every developer's sync-daemon (S8a's new handler) within ~10s p95, then visible to the local hooks-bridge on its next 5s cache miss. A switch flipped locally via `coodra pause` is pushed up to cloud by the existing M04a one-way path, made visible to the web admin and to other developers' sync-daemons via the same pull. **This explicitly extends M04a OQ-1**, which restricted M04a to one-way push.
14. **Pre-M04 fix-ups PR landed first** (§12): the three blockers from `context_memory/blockers.md` (`.strict()` hook payload, init policy seeding, `seedFeaturePack` only writes spec.md) ship on a separate `fix/pre-m04-blockers` PR that merges to `main` BEFORE `feat/04-web-app/S1` opens. The `.strict()` fix is item one — it is the highest-priority item on that PR because it's been observed firing live (Stop hook returning the PreToolUse shape was rejected by the bridge during this very session, 2026-05-03).
15. **Module 04 Context Pack** saved to `docs/context-packs/YYYY-MM-DD-module-04-web-app.md` per `essentialsforclaude/08-implementation-order.md §8.4`. The README module-status table flips 04 → ✅ in the same commit.

## 3. Non-goals

These are deliberately excluded from M04 and are **not** stubbed (per `01-development-discipline.md §1.1`):

- **No marketing site, no public landing page, no public docs portal.** Standing directive 2026-04-24. M04 is operator-and-audit-only — every page is gated behind a project context.
- **No billing, Stripe, seat management, usage metering, paid plans surface.** Standing directive 2026-04-24 — "forget about monetary setup, only focus on building the working product." The web app may eventually grow these surfaces; M04 does not.
- **No BYO-cloud team deploy.** Team mode runs against the single managed stack (Supabase + future Upstash + Railway/Fly.io/Vercel). The user is the owner. BYO-Enterprise is post-launch.
- **No Atlassian / GitHub / JIRA web surfaces.** Those integrations have their own MCP-tool surfaces (§22, §23) but the web visualisation of issue/PR linking is a follow-up.
- **No `/search` semantic-search route.** Depends on M05 NL Assembly's embedding pipeline. Until M05 ships, search would be `LIKE '%term%'` only — a "search that doesn't find anything useful" is worse than no search.
- **No `/runs/[id]/diff` semantic-diff overlay.** Depends on M06.
- **No notebooks / playground / "try Coodra" sandbox.** Out of scope. Real-data only.
- **No public-facing share links** (e.g. "share this run with a reviewer who isn't in the org"). Auth requirement applies to every audit row in team mode.
- **No mobile-native app.** Responsive web that works on phones is in-scope per the brand spec's responsive guidance; a React Native shell is not.
- **No live editor for `decisions` or `context_packs`.** Both tables are append-only by ADR-007. M04 reads them everywhere; M04 never lets the user edit them. The `record_decision` action is via the agent / MCP, not the web UI.
- **No telemetry from the web app to Anthropic / our own backend.** Same posture as the CLI. Server-side logs only.
- **No npm marketplace pages, no Anthropic MCP marketplace listing automation.** Standing directive.

## 4. Routes — the surface

The web's URL surface, mapped to CLI parity and to which mode each route is meaningful in. **Solo mode** = current developer's local SQLite. **Team mode** = cloud Postgres + Clerk-verified org context.

| Route | What it shows | CLI parity | Modes | Slice |
|---|---|---|---|---|
| `/` | Dashboard home — active runs count, recent denials (last 24h), active kill-switches, doctor RED/YELLOW summary, latest 10 events. The CLI parity is `coodra doctor` + `coodra run list` + `coodra pause` status combined into one read | combined | solo + team | S9 |
| `/runs` | Run list with filter by status / project / agent type. Sortable by `started_at` desc | `coodra run list` | solo + team | S3 |
| `/runs/[id]` | Run detail — full timeline of `run_events` + `policy_decisions` + `decisions` + linked `context_packs`. HTML port of `coodra export <runId> --format markdown --include-audit` (audit always visible in web, since the audience is human-reading not Slack-broadcasting) | `coodra run show` + `coodra export` | solo + team | S3 |
| `/runs/[id]/live` | Live view — same shape as `/runs/[id]` but with the polling adapter wired so a session in progress updates ~1.5s. Auto-redirects to `/runs/[id]` when `status` flips to `completed` / `cancelled` / `failed` | (no direct CLI parity; CLI is request-response) | solo + team | S4 |
| `/policies` | Policy list with row count + active/inactive | `coodra policy list` | solo + team | S5 |
| `/policies/[id]` | Policy detail — rules table, add-rule form, enable/disable toggle on the policy itself | `coodra policy show / add / enable / disable` | solo + team | S5 |
| `/projects` | Project list with run count + last-run timestamp | `coodra project list` | solo + team | S6 |
| `/projects/[id]` | Project detail — recent runs, status histogram, reset button (destructive — confirmation required) | `coodra project show / reset` | solo + team | S6 |
| `/packs` | Feature pack list with active flag + parent slug + missing-file warnings | `coodra pack list` | solo + team | S7 |
| `/packs/[slug]` | Pack detail — contents of `spec.md` / `implementation.md` / `techstack.md` / `meta.json`, last-modified per file, isActive toggle | `coodra pack show / regenerate / delete` | solo + team | S7 |
| `/templates` | Template browser — bundled (7) + user-installed templates with detect rules + autoSections | `coodra template list / install` | solo + team | S7 |
| `/kill-switches` | Active + recent kill-switches; pause-new form (scope=global/project/tool/agent_type, mode=hard/soft, optional expiry); resume buttons | `coodra pause / resume` | **solo + team — but team-mode-only writes propagate to all developers via S8a sync** | S8b |
| `/auth/sign-in` | Clerk-hosted sign-in (team only; redirected away in solo) | (no CLI parity) | team only | S10 |
| `/auth/sign-up` | Clerk-hosted sign-up | (no CLI parity) | team only | S10 |
| `/settings/team` | Org members + invites (Clerk org management) | (no CLI parity) | team only | S10 |
| `/api/healthz` | `200 ok` for monitoring | (no CLI parity; equivalent to bridge `/healthz`) | solo + team | S1 |
| `/api/runs/stream?runId=X` | SSE-style polling endpoint that returns the latest run state on each tick (server long-poll → fast 304/200 with delta JSON) | (no CLI parity; underpins `/runs/[id]/live`) | solo + team | S4 |
| `/api/kill-switches` | POST to insert; PATCH to soft-resume | `coodra pause / resume` | solo + team | S8b |

**Routes deliberately NOT in M04** (per §3 non-goals): `/search`, `/runs/[id]/diff`, `/billing`, `/marketing/*`, `/docs/*`, any marketplace surface, any "share" route.

## 5. The "first 5 minutes" — the experience this spec is buying

**Solo developer onboarding** (after `pnpm install` + `coodra init` + `coodra start`):

1. Open `http://localhost:3000` → instantly land on `/` with no sign-in. Header reads `[CTX]OS` in Inter 900 + `verify-m08b` (their project slug) in Inter 300 uppercase next to it. Below: five tiles in the status palette.
2. Top-left tile: "Active runs: 0" (Inactive grey). Adjacent: "Denials (24h): 0" (Allowed green if zero, Denied red if non-zero). "Active kill-switches: 0". "Doctor: 11/11 essential green". Latest events: empty state with hint `Open Claude Code in this project to see events flow.`
3. Open Claude Code. Trigger an Edit. Within ~1.5s the dashboard's "Active runs" tile flips to 1 with a Precision Blue dot. The events list shows the PreToolUse event.
4. Click into `/runs/[id]/live`. Watch the timeline build event-by-event. When the session ends, the page auto-routes to the static `/runs/[id]` view.

**Team operator onboarding** (the stack is deployed; the user has their Clerk org URL):

1. Open the team URL → 302 to Clerk sign-in (the Clerk-hosted page styled to match brand tokens via Clerk's appearance prop). Sign in with Google.
2. Land on `/` for the org. Same five tiles. Now the dashboard aggregates across every developer in the org. Click "Denials (24h): 47" → drill to a filtered `/runs?denials=24h`.
3. Spot a tool the agent shouldn't use → click Pause. Form pops: scope=tool, target=Bash, mode=hard, reason="2026-Q2 incident review". Submit → the row lands in cloud Postgres immediately. Within ~10s every developer's sync-daemon pulls it; within +5s their bridge cache misses and refreshes; the next Bash call any agent in the org makes is denied with `kill_switch_paused:<id>`.
4. Drill into a run. See the agent's decisions (from `decisions` table) with rationale + alternatives, the policy decisions audit (with `permission_decision` + `reason`), the context pack. Hand the URL to a code reviewer who is also in the org — they sign in once, see the same page.

Both flows are CLI-parity-first: anything the dashboard shows is something `coodra <command>` already prints. The web doesn't invent new state; it makes the existing state navigable.

## 6. Schema deltas

**ZERO.** M04 ships no migration. The web app is a read-and-write client of the existing 11-table schema:

- **Reads from:** `projects`, `runs`, `run_events`, `context_packs`, `decisions`, `policy_decisions`, `policies`, `policy_rules`, `feature_packs`, `kill_switches`.
- **Writes to:** `policies` (S5 add-rule), `policy_rules` (S5 add-rule, S5 enable/disable), `kill_switches` (S8b pause/resume — same helpers `packages/db/src/kill-switches.ts` the CLI uses, no new DB code).
- **Never writes to:** `runs`, `run_events`, `decisions`, `context_packs`, `policy_decisions` (all append-only per ADR-007 — the web reveals them, never mutates them).

The sync-daemon's new `kill_switches` handler (S8a) is a new TypeScript module, not a schema change — it joins the existing dispatch loop in `apps/sync-daemon/src/lib/cloud-pull.ts`.

If the web app ever needs a derived table (e.g. a `dashboard_aggregates_cache` row updated by a worker), that would be M05 or M07's concern, not M04. The dashboard query in S9 runs aggregates on demand — at solo's data volume that's microseconds; at team's expected v1 volume (single org, 5–20 developers, ≤ 10k runs/day) it's still a sub-100ms query against an indexed Postgres.

## 7. Storage adapter contract (OQ-1: direct better-sqlite3 in solo)

The web app's data layer is a single function `createWebDb(): DbHandle` (re-using the `DbHandle` type from `@coodra/db`). It reads `COODRA_MODE`:

- **`solo`** → returns `createDb({ kind: 'local', sqlite: { path: resolveCoodraDataDb(...) } })`. This is the SAME constructor the CLI and bridge use; better-sqlite3 is loaded as a Next.js server-runtime dependency (it's already a workspace dependency via `@coodra/db`).
- **`team`** → returns `createDb({ kind: 'cloud', postgres: { url: env.DATABASE_URL } })` — a Drizzle pg pool. Pool config: `max=10` (Vercel/Railway hosting can scale horizontally; we don't need 100 conns per instance), `idle_timeout=30s`, `connect_timeout=5s`.

**Why direct, not HTTP-to-services (OQ-1 alternative):** The HTTP path adds a hop (web → bridge → DB) and forces the daemons to be running just to view the dashboard. Solo developers will routinely want to read the audit trail when Coodra isn't actively running (e.g., reviewing yesterday's session). Direct read is simpler, removes the operational surface, and matches how the CLI already works. The native-module coupling cost (`better-sqlite3` is a native dep) is acceptable because it's already in the workspace and the CLI bundles it.

**The bridge / MCP server are still authoritative WRITERS** — the web never bypasses the bridge to write a `policy_decision` row directly. The web only writes to tables the CLI already writes to with the same helpers (`addPolicyRule`, `setPolicyActive`, `insertKillSwitch`, `softResumeKillSwitch`, `softResumeAllKillSwitches`).

**Server Component contract:** every read happens in a React Server Component or a Route Handler — never in a client component. Client components receive serialized data and never directly hold a DbHandle.

**Connection lifecycle:** in solo, the SQLite handle is opened lazily on first request and closed in Next.js's graceful-shutdown hook. In team, the Drizzle pool is opened at boot and reused.

## 8. Live updates contract (OQ-2: polling)

Every "live" surface (dashboard home, `/runs/[id]/live`, kill-switches admin) uses **client-side polling** at a default cadence of **1500ms**. The decision is locked here so individual slices don't reinvent the wheel.

**Why polling, not LISTEN/NOTIFY or webhooks (OQ-2 alternatives):**

- LISTEN/NOTIFY only works against Postgres — solo SQLite has no equivalent, so we'd need a polling fallback anyway (and now we'd have two code paths).
- Webhook-from-bridge requires the web to expose an inbound port the bridge can reach (trivial in solo, complicated in any cloud topology where web and bridge are in different deploy targets — and the bridge runs on the developer's machine in M04 era, while the web could be on Vercel; firewall traversal is not free).
- Polling at 1.5s buys "feels live" without any of those costs. The dashboard polling for ~10 connected operators against Postgres is ~6 RPS; trivial.

**Polling adapter contract:**

```ts
// apps/web/lib/poll.ts (skeleton — actual impl lands in S4)
export interface PollOptions<T> {
  url: string;          // a Next.js route handler URL, never a raw DB query
  intervalMs?: number;  // default 1500
  pauseWhenHidden?: boolean;  // default true — uses Page Visibility API
  signal?: AbortSignal;
}
export function usePoll<T>(opts: PollOptions<T>): { data: T | undefined; error: Error | undefined; isLoading: boolean };
```

- **Pause when tab hidden** by default. Saves ~99% of polls when the user has the tab in the background.
- **Backoff on error.** Exponential 1.5s → 3s → 6s → 12s, max 30s. Returns to baseline on next success.
- **`If-Modified-Since` semantics.** The route handlers return `304 Not Modified` with no body when the underlying state hasn't changed; the client preserves its current data.
- **Per-page intervals.** Dashboard home: 2000ms (cheaper aggregate). `/runs/[id]/live`: 1500ms. Kill-switches: 5000ms (low change frequency). All overridable in `apps/web/config.ts`.

**No SSE wire format.** Despite the OQ wording referencing SSE, the locked answer is polling — we're using ordinary HTTP GETs. The route handler at `/api/runs/stream` is a misnomer carried over from the early architecture (system-architecture.md §3.3 still calls it SSE); rename to `/api/runs/[id]/state` in S4 and update §3.3 in the same commit.

## 9. Auth model (OQ-3: solo bypass = synthetic `__solo__` user)

**Solo mode** (`COODRA_MODE=solo`):

- The web app skips the Clerk middleware entirely. The middleware checks `env.COODRA_MODE === 'solo'` first and short-circuits with `next()`.
- Every server component that needs an "authenticated user" gets a synthetic identity:
  ```ts
  { userId: '__solo__', orgId: '__solo__', mode: 'solo' }
  ```
- The header chrome shows "Solo mode" badge (Inactive grey) instead of an avatar.
- No sign-in page. No `/auth/*` routes are reachable in solo (returning 404).
- The `__solo__` userId matches the CLI's `__solo__` org-default already used in `projects.org` and the F7 invariant for unregistered cwds. Continuity across surfaces.

**Team mode** (`COODRA_MODE=team`):

- Middleware wraps every route except `/auth/*` and `/api/healthz` in `clerkMiddleware()` from `@clerk/nextjs`. Unauthenticated → 302 to `/auth/sign-in`.
- Server components extract `auth()` to get `userId` + `orgId`. Every DB query is filtered by `orgId` (RLS-style filter — the cloud Postgres also enforces row-level security on `projects.org_id` as belt-and-suspenders).
- Clerk JWKS is fetched at boot from `https://clerk.<tenant>.accounts.dev/.well-known/jwks.json`. `CLERK_JWT_ISSUER` is auto-discovered from the publishable key (the issuer URL is encoded in the key per Clerk's spec). S1 verifies this and pins the value in env if discovery fails.
- The MCP server's `lib/auth.ts::verifyToken` integration (M02 S7b) gets its first live exercise in S2 — same Clerk tenant, same JWKS endpoint, same Bearer.

**Identity propagation to writes:** every web-side write records the actor identity. For policy/kill-switch mutations, we add an actor field to the existing helpers' input — `pausedBySessionId` already accepts a free-form string, so we use `web:<userId>` for web-originated rows. No schema delta needed.

## 10. Cross-developer kill-switch sync (OQ-4: sync-daemon pull, ~10s p95)

**This explicitly extends M04a OQ-1, which restricted M04a to one-way push only.** M04a was the right scope for that module — push the local audit trail to the cloud. M04 is where we acknowledge the cloud is now also a source of truth that local installations must observe.

**The new cycle:**

1. **Team admin pauses globally from the web** (S8b). Web POSTs to `/api/kill-switches` → server action calls `insertKillSwitch(cloudDb, {...})` against Postgres. Row lands in `kill_switches` with `paused_by_session_id='web:<userId>'` and `(scope, target, mode, reason)` from the form.
2. **Sync-daemon on every developer's machine pulls that row.** S8a adds `kill_switches` to the daemon's pull table list. The daemon polls cloud → local every 5s (existing cadence). On finding new rows (`paused_at > local_max_paused_at`), it inserts them into the local SQLite. Rows already present locally (matched by `id`) are upserted.
3. **Local hooks-bridge sees the new switch on its next 5s cache miss.** The kill-switch evaluator's existing 5s in-process cache (`apps/hooks-bridge/src/lib/kill-switch-evaluator.ts`) is unchanged.
4. **Total propagation budget: ~10s p95.** 5s sync-daemon worst-case + 5s bridge-cache worst-case. p50 is ~5s.

**Conflict semantics:** if developer A pauses globally locally at the same moment team admin pauses globally from web, both rows land in cloud. The matcher's first-match-wins (oldest unresumed by `paused_at` ASC) means whichever was earlier wins; both are visible in the audit. No row is lost. Resume of either clears that switch only — the other stays active. This is intentional per ADR-007's append-only spirit.

**Local-only switches stay local.** A switch flipped via `coodra pause` with `--no-sync` (S8a adds this flag) does not push to cloud. Useful for a developer testing locally without affecting the team. Default is sync-on.

**Sync-daemon scope additions** (S8a):

- New table in the pull list: `kill_switches`
- New conflict resolver: matches rows by `id` (UUID — globally unique), upserts on conflict, never deletes (resumed rows are soft-flipped via `resumed_at`)
- New backoff posture: if the cloud is unreachable, the daemon retries with the existing exponential backoff; locally-paused switches still apply (the bridge reads local SQLite, not cloud)
- Telemetry: a new `sync_daemon_kill_switches_pulled` log event per pull cycle with `count` field

**Web-side write contract** (S8b):

- POST `/api/kill-switches` body: `{ scope, target, mode, reason, expiresAt? }` (zod-validated, same shape as `InsertKillSwitchInput` from `@coodra/db`)
- PATCH `/api/kill-switches?id=<id>` for soft-resume
- All writes idempotent by-design (the underlying helpers handle this); the web shows a duplicate-active banner ("This scope is already paused — id ks_..., paused 12 min ago by alice@org")

## 11. Brand contract (OQ-5: full token catalog up-front)

**Source of truth:** `brand.md` (the design system narrative) + `brand.html` (the canonical reference page). Both live at repo root for now; M04 S0.5 will move them to `docs/brand/` and add a `README.md` mapping them.

**Token catalog port:** S1 ships `apps/web/styles/tokens.css` with the **complete** brand catalog as CSS custom properties. Tailwind v4's CSS-first config (the `@theme` block) consumes them. Tokens include:

- **Colors:** Precision Blue (`#1C69D4`), full status palette (Allowed `#22C55E`, Partial `#F59E0B`, Denied `#EF4444`, Info/PreToolUse `#1C69D4`, Inactive `#6B7280`), neutrals (Black `#0A0A0A`, Off-Black `#1A1A1A`, Surface, etc.), every dark-mode and light-mode variant.
- **Typography:** Inter (300, 400, 700, 900) for body + display + nav + CTA; JetBrains Mono (400, 500, 700) for IDs / paths / code / metrics.
- **Type scale:** the brand's specific scale — display 56/64, h1 36/44, h2 24/32, h3 18/28, body 14/22, caption 12/18, mono 13/20, with line heights tuned to the brand's tight 1.15–1.30 instruction.
- **Spacing:** 8px base + the 8-step scale (4, 8, 12, 16, 24, 32, 48, 64).
- **Shape:** zero border-radius everywhere. Tailwind's `rounded-*` utilities are overridden to no-op (the unit test in §2 acceptance criterion 10 enforces this).
- **Motion:** the brand's specified durations (120ms hover, 200ms section, 320ms route) and easings (ease-out for enter, ease-in for exit, custom cubic-bezier for emphasized).
- **Elevation:** flat (no shadows in the default state); a single sharp 1px solid border for separation. Hover states get a 1px Precision Blue border.
- **Status chip / badge / risk-level component primitives** as documented in brand.md.

**Why full catalog up-front (vs minimal grow-as-needed, OQ-5 alternative):** the brand IS the differentiator for the engineering-rigor positioning — under-investing here invites a "looks like every other dev tool" outcome. The catalog is bounded (one designer wrote it, ~200 tokens total); porting it once is one S1 effort. Growing it slice-by-slice means every feature slice re-litigates a design question that's already been answered in brand.md.

**Where tokens live (vs `packages/design-tokens`, OQ-5 third option):** the user picked option (b) — full catalog, in `apps/web/styles/`. Consequence: M07 VS Code Extension will need to consume the same tokens when its webview lands, and at that point we may extract to a `packages/design-tokens/` workspace (mirroring the `packages/db` extraction pattern). We're choosing to defer that abstraction until M07 actually needs it — premature workspace extraction is a cost we'd pay before the ROI.

**Accessibility:** every interactive element passes WCAG AA contrast (4.5:1 for body, 3:1 for large). The brand's Precision Blue on white is 4.97:1, on Off-Black is 6.95:1 — both pass. The Allowed green and Denied red on white pass at large; on body they are paired with an icon to satisfy non-color-dependent perception.

**Component primitives shipped in S1's brand-tokens commit:**

- `<StatusChip status="allowed|partial|denied|info|inactive">{label}</StatusChip>` — 24px height, mono caption, palette-driven
- `<RiskBadge level="low|medium|high|critical">{label}</RiskBadge>` — same sizing, with the brand's risk-level palette
- `<ToolBadge name="Write">` — JetBrains Mono, sharp rectangle, neutral surface

These three primitives (and only these) ship as components in S1. Larger composites (run-event row, decision card, dashboard tile) land per their owning slice.

## 12. Pre-M04 fix-ups PR — AUDIT FOUND NOT NEEDED (2026-05-04)

OQ-6 lock = (b) originally scoped a separate `fix/pre-m04-blockers` PR to land three Phase 2 verification findings (`.strict()` schema rejection, init seeding zero policy rules, `seedFeaturePack` writes only spec.md) before any M04 S1 work. **On audit 2026-05-04, all three blockers were already resolved on `main`** — every fix shipped via Phase 3 Fix A / C / D on 2026-05-02, well before M04 was scheduled. The blockers.md entries had not been marked resolved at the time, so the M04 kickoff inherited a stale to-do.

**What was already shipped:**

- **Blocker A (`.strict()` → `.passthrough()`):** `packages/shared/src/hooks/payloads/{claude-code,windsurf,cursor}.ts` all use `.passthrough()` on the outer object with explicit Phase 3 Fix A docblock notes. Verified live: the bridge's `safeParse` accepts Claude Code's real SessionStart envelope (with `transcript_path` + `source`) and routes it to the SessionStart handler, which returns the Feature Pack body in `hookSpecificOutput.additionalContext` per Pattern 20.
- **Blocker C (init seeds zero policy rules):** `packages/cli/src/commands/init.ts:142` calls `ensureDefaultPolicy(handle, projectResult.id)` (Phase 3 Fix D, 2026-05-02) and the helper inserts the universal-safe baseline rule set. Phase 4 Fix F (2026-05-03) further hardened by adding per-event matcher coverage.
- **Blocker B (seedFeaturePack writes only spec.md):** `packages/cli/src/lib/init/feature-pack-seed.ts:99-109` seeds all four files (`meta.json`, `spec.md`, `implementation.md`, `techstack.md`) per Phase 3 Fix C, with an in-code citation of the original blocker entry.

**Adjacent finding (NOT a blocker):** the bridge's response shape `hookSpecificOutput.{hookEventName, permissionDecision, permissionDecisionReason, additionalContext?}` is identical for every event type. Per Claude Code's hook-response spec (`code.claude.com/docs/en/hooks` fetched 2026-05-04), only PreToolUse + SessionStart consume `hookSpecificOutput`; PostToolUse / Stop / SessionEnd / SubagentStop expect top-level `decision: 'block'` + `reason` (or empty body to allow). The docs explicitly say wrong-shape `hookSpecificOutput` is "silently ignored" — so the bridge's drift causes no rejected hooks, no failed sessions, no audit gaps. It's a fidelity gap, not a bug. **Reserved as M04 S11 cleanup** (per-event response shaping in `apps/hooks-bridge/src/app.ts`); not pre-M04 work.

**Latent fragility (NOT a blocker):** `apps/mcp-server/src/lib/feature-pack.ts::readPackFromDisk` still does `Promise.all` over all four files — fail-fast on any missing one. Through the supported `coodra init` path this never fires (init seeds all four), but a manually-created pack with only `spec.md` would throw `handler_threw`. **Reserved as M04 S11 cleanup** (mirror the bridge's `readMaybe` pattern for symmetry); not pre-M04 work.

**Net result:** OQ-6 lock retired. No `fix/pre-m04-blockers` PR ships. M04 S1 opens directly off `main` after S0.5 (wireframes). The two reserved cleanups land in M04 S11 alongside the closeout pack. `context_memory/blockers.md` updated 2026-05-04 with ✅ resolved markers + Phase 3 Fix citations on each entry.

**S1 first acceptance check is unchanged:** "fresh `coodra init`'s SessionStart hook against the bridge returns a populated `additionalContext`" — already true on `main` (no fix-up needed for it to hold).

## 13. Locked design decisions (signed off 2026-05-03)

All open questions in M04 were locked by the project lead in the same session this spec was authored. Each lock is mirrored in `context_memory/decisions-log.md` under "M04 OQ-*" entries.

| OQ | Decision | Rationale (one line) | Constrains |
|---|---|---|---|
| OQ-1 | (a) Direct `better-sqlite3` from Next.js server in solo; Drizzle Postgres pool in team | Removes the operational surface of "must have daemons running to view audit"; matches CLI read pattern | §7, S1 storage adapter |
| OQ-2 | (a) Client-side polling at 1500ms default | Works in both modes with one code path; avoids LISTEN/NOTIFY's solo-fallback complication; "feels live" enough for the v1 audience | §8, S4 live adapter, rename `/api/runs/stream` → `/api/runs/[id]/state` |
| OQ-3 | (a) No sign-in screen in solo; every page renders as synthetic `__solo__` | Continuity with CLI's `__solo__` org-default (F7 invariant); zero friction for the developer who just ran `coodra init` | §9, S1 middleware, S10 |
| OQ-4 | (a) Sync-daemon adds `kill_switches` to its pull list; ~10s p95 propagation, no new infra | Builds on M04a's existing 5s pull cadence; bridge's 5s cache TTL is unchanged | §10, S8a, S8b; explicitly EXTENDS M04a OQ-1 |
| OQ-5 | (b) Port the full brand catalog up-front into `apps/web/styles/` | Brand IS the engineering-rigor differentiator; under-investing invites "looks like every dev tool"; catalog is bounded (~200 tokens) | §11, S1 tokens.css, all visual slices |
| OQ-6 | Originally (b) — separate PR; **on audit 2026-05-04 all three blockers already shipped via Phase 3 Fixes A/C/D 2026-05-02; no fix-up PR ships** | blockers.md entries were stale; user's "live observation" reconciled via Claude Code hook docs as silently-ignored response-shape drift, not a rejected hook | §12 retired; M04 S11 picks up two reserved cleanups (per-event response shaping + mcp-server reader symmetry) |
| OQ-7 | (a) Defer deploy-target lock to S2 | Scaffold for portability; pick when the build is real and we know constraints | S1 stays portable; S2 picks Vercel vs Railway vs Fly.io |

**Three structural decisions** (project lead pushbacks during S0 review, 2026-05-03):

| ID | Decision | Rationale | Constrains |
|---|---|---|---|
| STRUCT-1 | Add **S0.5 — IA + nav map + key-screen wireframes** between S0 and S1 | M04 is the UI/UX module; give the feature slices a target before scaffolding | §11, all visual slices reference S0.5's wireframes |
| STRUCT-2 | **Split S8 into S8a (sync-daemon backend; no UI) and S8b (web admin)** | Bidirectional-sync surface stays revertable on its own; M04a OQ-1 extension is explicit; backend can ship + verify before UI | §10, S8a/S8b; sync-daemon scope grows |
| STRUCT-3 | Add **S9 — Dashboard home `/`** as its own slice (not folded into doctor health) | Aggregate-data surface is meaty enough for its own slice; CLI parity is `doctor` summary + `run list` + `pause` status combined | §4 routes, §5 first-5-min, S9 |

The doctor full-detail page (35-check registry rendering) was considered for M04 and **deferred** — operators who need that level of detail can run `coodra doctor --full --json`. The dashboard home's doctor tile shows summary RED/YELLOW counts only.

---

**Implementation plan:** see `implementation.md` for the slice-by-slice work breakdown (S0 → S0.5 → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8a → S8b → S9 → S10 → S11), prerequisites, verification commands, and the pre-M04 fix-up PR walkthrough.

**Tech stack details:** see `techstack.md` for runtime, dependencies, and the brand-tokens delivery mechanics.
