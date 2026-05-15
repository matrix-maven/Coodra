# Module 04 — Web App, Phase 3 (UI redesign + web-v2 handoff) — closeout

**Date:** 2026-05-09
**Branch:** `feat/04-web-app`
**Closes:** [docs/feature-packs/04-web-app-phase-3/spec.md](../feature-packs/04-web-app-phase-3/spec.md)

## What shipped

### apps/web/ — in-place redesign (4 commits)
- `4a7e4ff` UI 1 — token a11y bumps, spacing scale, reduced-motion, skip-link CSS
- `b6428aa` UI 2+3 — primitives library: structural / form / data / icons
- `fb204b0` UI 4+5 — primitives applied across 21 pages + a11y polish
- `f21fa9b` full UI redesign — Linear/Vercel-style modern dashboard

Plus uncommitted continuations folded into this Phase 3 closeout: page-by-page consumer refactors, new components (`CopyButton`, `NewProjectWizard`, `ProjectsHub`, `CodeBlock`, `EventRow`, `IconField`, `KsModeButton`, `PolicyRow`, `StatPill`, `Topbar`).

### apps/web-v2/ — next-gen shell (1 commit, 78 source files)
- `fda21fe` introduce next-gen web shell — Linear/Vercel-style, M05 surfaces, solo-mode-first

Routes: `/`, `/init`, `/runs`, `/runs/[id]`, `/runs/[id]/live`, `/decisions`, `/context-packs`, `/packs`, `/packs/new`, `/packs/[slug]`, `/policies`, `/templates`, `/graph`, `/kill-switches`, `/workspace`, `/settings`, `/sync`, `/projects`, `/projects/[slug]`, `/projects/[slug]/features`, `/projects/[slug]/features/{new,import,[fslug]}`, `/projects/[slug]/features/[fslug]/{edit,files/[...path]}`, `/projects/[slug]/packs/new`, plus `/api/runs/[id]/state`.

Server actions covering: features, init, kill-switches, packs, policies, projects, runs, services, sync, templates.

Real DB queries (no mocks). Mode-aware (sqlite for solo, postgres for team).

## Decisions made

- **Decision (2026-05-09): apps/web-v2/ supersedes apps/web/.** Rationale: the in-place redesign on apps/web/ revealed enough architectural divergence (color-token sprawl, component coupling) that a clean rebuild was cheaper than continuing refactor. Documented in [apps/web/DEPRECATED.md](../../apps/web/DEPRECATED.md). Alternatives considered: keep iterating on apps/web/, or maintain both indefinitely. Rejected — the primitives library was easier to ship from scratch in v2 than retrofit.
- **Decision (2026-05-09): web-v2 is solo-mode-first, no Clerk yet.** Rationale: scope control. Team-mode auth + the Vitest suite are tracked as follow-on work. apps/web/ remains functional for team-mode demos in the interim.

## Files modified / created in this closeout

- [docs/feature-packs/04-web-app-phase-3/spec.md](../feature-packs/04-web-app-phase-3/spec.md) (new)
- [docs/context-packs/2026-05-09-module-04-web-app-phase-3.md](2026-05-09-module-04-web-app-phase-3.md) (this file)
- [apps/web/DEPRECATED.md](../../apps/web/DEPRECATED.md) (already shipped in `fda21fe`)
- All apps/web/ uncommitted modifications and new components staged with this closeout commit

## Open follow-ups

1. Migrate Clerk team-mode auth from `apps/web/middleware.ts` + `/auth/*` + `/settings/{account,team,workspace}` to `apps/web-v2/`.
2. Migrate Vitest suite from `apps/web/__tests__/` to `apps/web-v2/`.
3. Once both above land, delete `apps/web/` and rename `apps/web-v2/` → `apps/web/`.

## Tests

Existing apps/web/ Vitest suite still runs:
```bash
pnpm --filter @coodra/web test
```

apps/web-v2/ has no tests yet (deferred per spec).
