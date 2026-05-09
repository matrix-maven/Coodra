# Module 04 — Web App, Phase 3 (UI redesign + web-v2 handoff)

## Why this phase exists

After M04 Phase 2 closeout (S15 `/sync` admin, 2026-05-04), stakeholder review surfaced that the web app's visual identity didn't match the maturity of the underlying system. The Phase 1+2 spec mandated `border-radius: 0` and a stark utilitarian aesthetic that read as unfinished. Phase 3 was opened on `feat/04-web-app` to:

1. Modernize the visual identity toward Linear/Vercel-style design (rounded corners, refined color ramp, primitive component library).
2. Improve a11y (token contrast bumps, spacing scale, reduced-motion, skip-link).
3. Build a shared primitives library (`components/ui/`) so future work doesn't re-invent surface patterns.

During Phase 3, the redesign work in `apps/web/` revealed enough architectural divergence (component coupling, color-token sprawl) that a clean rebuild as `apps/web-v2/` became cheaper than continuing to refactor in-place. **Phase 3 therefore has two deliverables**: (a) the in-place redesign of `apps/web/` and (b) the next-gen `apps/web-v2/` shell that supersedes it.

## Scope

### In scope
- Token a11y bumps + spacing scale + reduced-motion + skip-link CSS
- Primitives library: structural (PageShell, PageHeader, Section, Card, Tile), form (Input, Button, IconField), data (DataTable, EventRow, RunRow, PolicyRow, StatPill, StatusChip, RiskBadge, ToolBadge), icons
- Apply primitives across all M04 pages
- Full UI redesign — Linear/Vercel-style modern dashboard
- Introduce `apps/web-v2/` covering M05 surfaces (decisions, context-packs, packs, graph, kill-switches, workspace) + per-project feature-pack management
- `apps/web/DEPRECATED.md` documenting the handoff

### Out of scope (deferred)
- Clerk team-mode auth migration to web-v2 — `apps/web-v2/middleware.ts` is solo-mode-only pass-through
- Vitest test-suite migration to web-v2
- Removal of `apps/web/` (will happen after the two items above land)

## Slices that shipped

| Slice | Commit | Surface |
|---|---|---|
| UI 1 — token a11y + spacing scale + reduced-motion + skip-link | `4a7e4ff` | `apps/web/styles/tokens.css`, `apps/web/app/globals.css` |
| UI 2+3 — primitives library (structural, form, data, icons) | `b6428aa` | `apps/web/components/ui/` |
| UI 4+5 — primitives applied across all pages + a11y polish | `fb204b0` | All `apps/web/app/**/*.tsx` |
| Full UI redesign — modern dashboard | `f21fa9b` | `apps/web/` site-wide |
| web-v2 — next-gen shell (M05 surfaces, solo-mode-first) | `fda21fe` | `apps/web-v2/` (78 source files) |

## Verification

```bash
pnpm --filter @coodra/contextos-web dev    # apps/web on :3000 (deprecated, still functional)
pnpm --filter @coodra/contextos-web-v2 dev # apps/web-v2 on :3001 (canonical)
```

Both apps run against the same local SQLite (`~/.contextos/data.db`) or `DATABASE_URL` Postgres. Mode toggle via `CONTEXTOS_MODE`.
