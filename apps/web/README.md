# `@coodra/contextos-web` — Module 04 Web App

Next.js 15 admin + audit-trail UI for ContextOS. Same build in solo (against `~/.contextos/data.db` via `better-sqlite3`) and team (against Supabase Postgres + Clerk JWT). Brand fidelity per `docs/brand/`.

Spec, slice plan, and per-route wireframes live at [`docs/feature-packs/04-web-app/`](../../docs/feature-packs/04-web-app/).

## Local dev

```sh
# Once: copy env values from repo root
cp ../../.env apps/web/.env.local

# Dev server on :3000
pnpm --filter @coodra/contextos-web dev
```

Solo mode (default) reads from `~/.contextos/data.db`. Team mode reads from the cloud Postgres at `DATABASE_URL`.

## Verification

```sh
pnpm --filter @coodra/contextos-web typecheck
pnpm --filter @coodra/contextos-web lint
pnpm --filter @coodra/contextos-web test:unit
pnpm --filter @coodra/contextos-web build
```

## What's in S1 (this commit)

- App Router shell — `app/layout.tsx`, `app/page.tsx` (placeholder), `app/api/healthz/route.ts`, `app/not-found.tsx`
- Brand tokens — `styles/tokens.css` (full catalog from `docs/brand/brand.html`) + Tailwind v4 `@theme` consumption in `app/globals.css`
- Storage adapter — `lib/db.ts` (`createWebDb()` per OQ-1: direct `better-sqlite3` in solo, Drizzle pg in team)
- Auth — `middleware.ts` (solo bypass per OQ-3 + Clerk wrapper in team) + `lib/auth.ts` (`getActor()`)
- Clerk JWT issuer probe — `lib/clerk-issuer.ts` (no user-typed env var per S1 acceptance)
- Polling skeleton — `lib/poll.ts` (full impl in S4)
- Supabase SSR — `utils/supabase/{server,client,middleware}.ts` per the user-preferred boilerplate
- Three brand primitives — `components/{StatusChip,RiskBadge,ToolBadge}.tsx`
- Header chrome + breadcrumb — `components/{HeaderNav,Breadcrumb,SoloModeBadge}.tsx`
- Unit tests — storage adapter + auth + middleware + primitives

## What's NOT in S1 (deferred)

- Real run/policy/project/pack/template/kill-switch routes (S3+)
- Polling implementation against `/api/runs/[id]/state` (S4)
- Live data — placeholder home page only
- Clerk live-tenant smoke test (S2)
- Drizzle schema applied to Supabase Postgres (S2)
- Dashboard tiles + real data aggregation (S9)

See [`docs/feature-packs/04-web-app/implementation.md`](../../docs/feature-packs/04-web-app/implementation.md) for the full slice plan.
