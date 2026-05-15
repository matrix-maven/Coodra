# Module 04 — Tech Stack

> What `apps/web` runs on, what new dependencies M04 adds, and the rationale for each pin. The brand-token delivery mechanics are covered in spec §11; this file covers the runtime + library layer.

## Runtime

- **Node.js** ≥ 22.16.0 (matches the workspace floor — `essentialsforclaude/10-troubleshooting.md` row 1).
- **Next.js** 15.x (App Router, Server Components, Server Actions, edge-runtime support — though M04 defaults all routes to Node runtime since `better-sqlite3` is a native dep that won't run on edge).
- **React** 19.x (matches Next.js 15 baseline).
- **TypeScript** 5.x with `strict: true`. Same workspace `tsconfig.json` extends as the rest of the monorepo.
- **Tailwind CSS v4** (CSS-first config via `@theme` block — eliminates JS config file; consumes `apps/web/styles/tokens.css` directly). v4 was released 2024-12 and is stable; the brand spec's tight typography/spacing scale is easier to express in CSS variables than as a Tailwind v3 JS config.

## New direct dependencies (production)

```json
{
  "next": "^15.0.0",
  "react": "^19.0.0",
  "react-dom": "^19.0.0",
  "@clerk/nextjs": "^6.0.0",
  "@supabase/supabase-js": "^2.45.0",
  "@supabase/ssr": "^0.5.0",
  "tailwindcss": "^4.0.0",
  "@tailwindcss/postcss": "^4.0.0",
  "drizzle-orm": "workspace:*",
  "better-sqlite3": "workspace:*",
  "postgres": "workspace:*",
  "zod": "workspace:*",
  "@coodra/shared": "workspace:*",
  "@coodra/db": "workspace:*"
}
```

**Why each pin:**

- `next` 15 + `react` 19 — current stable; required for Server Components + Server Actions surface stability.
- `@clerk/nextjs` 6 — the v6 line ships native Next.js 15 App Router + middleware support. Older versions require Pages-Router shims.
- `@supabase/supabase-js` + `@supabase/ssr` — the user's preferred SSR pattern (per `~/.claude/.../memory/supabase-project.md`). `@supabase/ssr` is the canonical bridge for Next.js App Router.
- `tailwindcss` 4 + `@tailwindcss/postcss` — v4's CSS-first config is the right fit for the brand-token-as-CSS-vars approach (spec §11). v4 also drops the runtime JS, smaller bundles.
- `drizzle-orm`, `better-sqlite3`, `postgres`, `zod` — all already workspace deps via `@coodra/db`. Re-declared to keep `apps/web`'s package.json self-documenting; same versions resolve via pnpm workspace protocol.
- `@coodra/shared`, `@coodra/db` — workspace deps for the storage adapter, errors, logger.

**No CSS-in-JS runtime.** No styled-components, no Emotion, no vanilla-extract. Tailwind v4 + the brand-token CSS variables cover everything. Server Components + utility classes is the modern pattern.

**No state management library.** No Redux, no Zustand, no Jotai. Server Components handle 90% of state on the server; the polling adapter (spec §8) is one ~100-line hook in `apps/web/lib/poll.ts`. Anything else is `useState` local to a client component.

## New direct dependencies (dev)

```json
{
  "@types/node": "^22.0.0",
  "@types/react": "^19.0.0",
  "@types/react-dom": "^19.0.0",
  "vitest": "workspace:*",
  "@vitejs/plugin-react": "^4.3.0",
  "happy-dom": "^15.0.0",
  "@testing-library/react": "^16.0.0",
  "@testing-library/user-event": "^14.5.0",
  "@biomejs/biome": "workspace:*"
}
```

**Why these:**

- `vitest` already workspace; `@vitejs/plugin-react` + `happy-dom` for component tests.
- `@testing-library/react` + `user-event` for the React-component tests (StatusChip / RiskBadge / form interactions).
- `@biomejs/biome` already workspace.

**No Storybook.** S0.5's wireframes + the live web app cover the same purpose. Storybook adds a build target + a docs surface for free, but neither pays back at M04's scale (one app, ~20 routes, ~30 components). Re-evaluate if M07 VS Code extension forces a `packages/design-tokens` extraction that needs an external preview tool.

**No Playwright.** E2E tests stay in the existing `__tests__/e2e/` Vitest harness. Playwright would buy us cross-browser smoke tests but adds a CI dependency and a second tooling stack. Acceptable to revisit once M04 ships and we know which routes have flake risk.

## Out-of-scope libraries (deliberately NOT added)

- **Redux / Zustand / Jotai / MobX / Recoil** — global state mgmt. RSC + polling cover M04's needs. Adds runtime + cognitive load.
- **shadcn/ui** — component library that would conflict with the bespoke brand. Brand says "engineering rigor"; shadcn's defaults are friendly + soft (rounded corners, soft shadows). Direct conflict.
- **Material UI / Chakra UI / Mantine** — same reason as shadcn but heavier.
- **react-query / SWR** — mutation + cache library. The polling adapter (spec §8) is purpose-built for this app's pattern; pulling in `react-query` for one polling case adds 30KB of API surface for a 100-line hook.
- **react-hook-form / formik** — form library. M04 forms are simple (≤ 8 fields, server-side validation via Zod, server actions). Native `<form action={fn}>` + `useFormState` is sufficient.
- **Day.js / Moment.js / date-fns** — date library. Native `Intl.DateTimeFormat` + `Intl.RelativeTimeFormat` cover every M04 surface.
- **Lodash** — utility library. Modern JS / TS standard library covers what M04 needs.
- **Storybook / Chromatic** — see above.
- **Playwright / Cypress** — see above.
- **Sentry / Datadog / OpenTelemetry SDK** — error / perf telemetry. Out of scope per spec §3 non-goals (no telemetry from web). Server logs via existing Pino.
- **Recharts / Visx / Tremor / Chart.js** — charting. Brand spec mentions 25 chart styles but M04's dashboard ships only count tiles + an event list — no charts in v1. M04 ships zero data visualizations. Re-evaluate at M07 or a future analytics module.

## Brand-tokens delivery mechanics (recap of spec §11)

- Source files: `brand.md` + `brand.html` (relocated to `docs/brand/` in S0.5).
- Port target: `apps/web/styles/tokens.css` (full catalog up-front per OQ-5 lock).
- Tailwind v4 consumes via `@theme` block in `apps/web/styles/globals.css`:
  ```css
  @theme {
    --color-precision-blue: #1C69D4;
    --color-status-allowed: #22C55E;
    --color-status-partial: #F59E0B;
    --color-status-denied: #EF4444;
    --color-status-info: #1C69D4;
    --color-status-inactive: #6B7280;
    --font-display: 'Inter', system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', ui-monospace, monospace;
    --radius: 0;
    /* … full catalog … */
  }
  ```
- `tailwind.config.ts` is omitted (v4 CSS-first); PostCSS plugin handles compilation.
- Inter + JetBrains Mono served via `next/font/google` (zero CLS, self-hosted by Next.js, font-display: swap).

## Storage adapter mechanics (recap of spec §7)

`apps/web/lib/db.ts`:

```ts
import { createDb, type DbHandle } from '@coodra/db';
import { resolveCoodraDataDb, resolveCoodraHome } from '@coodra/shared';

let cached: DbHandle | undefined;

export function createWebDb(): DbHandle {
  if (cached) return cached;
  if (process.env.COODRA_MODE === 'team') {
    cached = createDb({
      kind: 'cloud',
      postgres: { url: process.env.DATABASE_URL!, max: 10, idleTimeout: 30, connectTimeout: 5 },
    });
  } else {
    const home = resolveCoodraHome({ env: process.env, platform: process.platform });
    cached = createDb({ kind: 'local', sqlite: { path: resolveCoodraDataDb(home) } });
  }
  return cached;
}
```

In team mode, the module-level cache means one Drizzle pool per process. Next.js spawns one Node.js process per worker; a small pool (`max: 10`) per worker is appropriate for the v1 traffic profile (single-org, ~10 concurrent operators).

In solo mode, the SQLite handle is opened lazily on first request. better-sqlite3's WAL mode (already enabled by `@coodra/db` boot) means concurrent reads from the web don't block writes from the bridge.

## Build + bundle posture

- `pnpm --filter @coodra/web build` — Next.js production build; outputs to `apps/web/.next/`.
- `pnpm --filter @coodra/web start` — production server on `:3000`.
- `pnpm --filter @coodra/web dev` — dev server with HMR.
- Turbo cache keyed on workspace deps + lockfile + source file hashes (per existing `turbo.json` pattern).

**Native module bundling note:** `better-sqlite3` cannot be bundled into a Next.js edge-runtime route. Every route that imports `apps/web/lib/db.ts` must declare `runtime = 'nodejs'` (the App Router default; explicit declaration is defensive). M04 has zero edge routes — all are Node runtime.

## CI/CD posture

- Existing `.github/workflows/ci.yml` extended with:
  - `apps/web#typecheck` (parallel)
  - `apps/web#lint` (parallel)
  - `apps/web#test:unit` (parallel)
  - `apps/web#build` (sequential, after lint+typecheck)
- Integration tests against `pgvector/pgvector:pg16` testcontainers cover the team-mode storage path; live-Supabase tests gated by `LIVE_SUPABASE_TEST=1` (off in CI; on for local + nightly).
- Clerk live-tenant test (M04 S2) gated by `CLERK_LIVE_TEST=1` (same posture).

## Deploy target — DEFERRED to S2 per OQ-7

S1 scaffolds for portability. S2 picks one of:

- **Vercel** — best Next.js DX (zero-config builds, image optimisation, edge caching). Adds a new ops surface separate from our Railway/Fly.io stack.
- **Railway** — already in `pending-user-actions.md` for `mcp-server`/`hooks-bridge`/`web`/`nl-assembly`/`semantic-diff`. One ops surface for everything.
- **Fly.io** — same as Railway from a stack-coherence angle; geographic distribution is better.

S2 picks based on what the deploy actually needs (build minutes, bandwidth, region). Until then, no deploy-specific assumptions in S1's code.

## Gotchas

- **`better-sqlite3` native binary mismatch on Vercel** — if S2 picks Vercel, the build needs to install the native binary for the target architecture. Vercel runs Linux x64; the local dev machine is macOS arm64. Solved by `pnpm rebuild better-sqlite3` in the build step OR by using Postgres in production (so solo-mode-on-Vercel never happens).
- **Clerk middleware + Server Actions interaction** — `clerkMiddleware()` from `@clerk/nextjs` 6 must wrap before any route handler that consumes `auth()`. Verify wiring order in S1; the official docs are clear on this.
- **Tailwind v4 + Next.js 15 + Turbopack interaction** — Turbopack's PostCSS pipeline diverges from Webpack's in some edge cases. Default to Webpack in S1 (`next dev` without `--turbo`) until v4 stability on Turbopack is confirmed.
- **`@supabase/ssr` cookie names** — they're auto-managed; don't manually set Supabase cookies in custom middleware. The user's preferred boilerplate (in memory) handles this correctly.
- **RLS + Drizzle session settings** — Drizzle pg pool releases connections back to the pool after each query. To set `app.current_org` per-request reliably, use a transaction wrapper (`SET LOCAL app.current_org = $1` inside the transaction, then queries inside the same transaction). S2 documents this pattern.
- **Polling-from-tab-hidden + `If-Modified-Since`** — when the tab unhides, the polling resumes from its current `If-Modified-Since` cursor. If the tab was hidden for 10 minutes and the run progressed in that window, the first post-unhide poll returns a fresh body (state changed) — the UI updates atomically. No "missed events" gap.
