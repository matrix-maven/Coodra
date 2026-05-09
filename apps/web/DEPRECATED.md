# DEPRECATED — superseded by `apps/web-v2/`

As of 2026-05-09, `apps/web-v2/` is the canonical web app for ContextOS. This directory (`apps/web/`) is retained for reference but receives no new feature work.

## Why

`apps/web-v2/` is a design-system rebuild covering the M05 surfaces (decisions, context-packs, packs, graph, kill-switches, workspace) with a Linear/Vercel-style aesthetic. It's solo-mode-first; the parts of `apps/web/` that this doesn't yet replace are documented below.

## Coverage gap (planned follow-ups)

- **Clerk team-mode auth** — `apps/web/middleware.ts` + `/auth/sign-in` + `/auth/sign-up` + `/settings/{account,team,workspace}` are not yet ported. `apps/web-v2/middleware.ts` is solo-mode-only pass-through. Migration tracked as a follow-on.
- **Tests** — `apps/web/__tests__/` Vitest suite has no counterpart in v2 yet. To be ported alongside the team-mode work.

## What to do

- New routes / surfaces: build them in `apps/web-v2/`.
- Bug fixes touching v2-replaced surfaces: fix in v2 only.
- Bug fixes touching auth or workspace settings (still web/-only): fix in web/ for now; the v2 port will inherit the fix.

Once team-mode auth and the test suite are migrated, this directory will be removed and `apps/web-v2/` renamed to `apps/web/`.
