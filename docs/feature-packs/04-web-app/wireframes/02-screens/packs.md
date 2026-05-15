# `/packs` and `/packs/[slug]` — Pack browser (S7)

CLI parity: `coodra pack {list, show, regenerate, delete}`.

## `/packs` — desktop

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  packs                                                                                  │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                         │
│  FEATURE PACKS                                                                          │
│  Every pack under docs/feature-packs/ in this project.                                  │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │ SLUG                  TEMPLATE         PARENT          ACTIVE  FILES   ACTIONS  │    │
│  ├─────────────────────────────────────────────────────────────────────────────────┤    │
│  │ 04-web-app           generic           08b-cli-…       ✓       4/4    ▸ View  │    │
│  │ 08b-cli-expansion    generic           08a-cli         ✗       4/4    ▸ View  │    │
│  │ 08a-cli              generic           —               ✓       4/4    ▸ View  │    │
│  │ verify-m08b          generic           —               ✓       4/4    ▸ View  │    │
│  │ broken-pack          —                 —               ✗       1/4 ⚠   ▸ View  │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
│   broken-pack: missing implementation.md, techstack.md (file count includes warnings)   │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

- SLUG column uses `--font-mono`.
- TEMPLATE / PARENT columns use `--font-mono` `--color-text-code` (linkable).
- ACTIVE column: ✓ in `--color-status-success`, ✗ in `--color-text-tertiary`.
- FILES column: shows `present/expected` count; warning glyph (⚠) when files are missing. Tooltip lists missing files.
- ACTIONS: View link only; mutations live on the detail page.

## `/packs/[slug]` — desktop

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  packs / 04-web-app                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                         │
│  04-web-app                                                                             │
│  ^^^^^^^^^^^                                                                            │
│  --font-mono weight 500 text-3xl                                                        │
│                                                                                         │
│  template: generic        parent: 08b-cli-expansion        isActive: true               │
│  ^^^^^^^^^^^^^^^^^        ^^^^^^^^^^^^^^^^^^^^^^^^^        ^^^^^^^^^^^^^^^^             │
│  --font-mono text-sm      mono link                        StatusChip success           │
│                                                                                         │
│  Updated: 2026-05-04T22:48:11.000Z                                                      │
│                                                                                         │
│                                                       ┌─────────────────────┐           │
│                                                       │   REGENERATE  ▾    │           │
│                                                       └─────────────────────┘           │
│                                                              │                           │
│                                                              ▼                           │
│                                                  ┌─────────────────────┐                │
│                                                  │ REGENERATE          │                │
│                                                  │ DELETE…             │                │
│                                                  └─────────────────────┘                │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │ spec.md (16 KB) │ implementation.md (12 KB) │ techstack.md (5 KB) │ meta.json   │    │
│  │ ─────────────────                                                                │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
│  spec.md (default tab — markdown rendered)                                              │
│  ──────                                                                                 │
│                                                                                         │
│  # Module 04 — Web App (apps/web admin + audit-trail UI for Coodra) — Spec           │
│                                                                                         │
│  > Status: kickoff (2026-05-03). No implementation slice has landed yet…                │
│                                                                                         │
│  ## 1. What M04 is                                                                      │
│  ...                                                                                    │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## Markdown render

Uses the same renderer M08b S12 ships (`packages/cli/src/lib/export/render-html.ts`), with the `__CTX_CODE_N__` sentinel pattern for code spans. Headings (Inter weight 700–900), body (Inter 400 14/22), code blocks (`--font-mono` 13/20, `--color-bg-elevated` background, `--space-4` padding, no border-radius). Links: `--color-brand` underline on hover.

## Regenerate

Click `REGENERATE` → confirmation dialog: "Regenerating refreshes the auto-marker sections (`<!-- @auto:* -->`) from the project's current shape. Manual edits between auto-marker pairs are preserved. Continue?"

Confirm → server action runs `regeneratePack` (M08b S16 helper) → success toast: "Regenerated 04-web-app from template 'generic' (3 files updated)."

## Delete

Click `DELETE…` → two-step confirm: type the slug, then confirm. Server action soft-flips `feature_packs.is_active = false` (per ADR-007 append-only). Removes the directory on disk too.

## Token annotations

Same conventions as previous wireframes. Markdown content respects brand tokens (no override; tokens ARE the markdown styles).

## Mobile

Tabs become horizontal scroll. Markdown content full-width. The dropdown action button stacks below the header.

## Solo vs team

Identical. Packs are per-project; the project context comes from the chrome's project switcher.
