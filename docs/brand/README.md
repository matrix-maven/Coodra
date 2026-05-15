# Coodra Brand Sources

Canonical visual-identity sources for the Coodra web app (`apps/web`, Module 04) and any future surface that needs to match (M07 VS Code webview, future installer GUIs, marketing-when-it-ships).

## Files in this directory

- **[`brand.md`](./brand.md)** — narrative design-system spec (1,140 lines). Covers visual principles, typography scale, color palette (light + dark), spacing scale, motion, components (chips, badges, status pills, tile grid, etc.), accessibility commitments. Read this when authoring a new surface or component to confirm you're aligned with the system.
- **[`brand.html`](./brand.html)** — single-file reference page that renders every token + every component primitive in both light and dark modes against the actual fonts. Open in a browser to see what the design system looks like end-to-end. The `<style>` block is the canonical token catalog — when porting to `apps/web/styles/tokens.css` (M04 S1, OQ-5 lock), copy these CSS custom properties verbatim, do not invent variants.

## Origin

Authored by the project lead at the M04 kickoff review (2026-05-03) and dropped at repo root with the message "Brand system absorbed". Relocated to `docs/brand/` in M04 S0.5 (2026-05-04) so the repo root stays focused on operational artefacts and the brand sources live alongside the rest of the project documentation.

## How M04 consumes these

- **M04 S0.5** (this slice) — every wireframe in `docs/feature-packs/04-web-app/wireframes/02-screens/` annotates each visual element with the token name from `brand.md` so the S1 implementer never has to guess "what color is this".
- **M04 S1** — `apps/web/styles/tokens.css` ships the full token catalog as CSS custom properties. Tailwind v4's `@theme` block in `globals.css` consumes them. The unit test in M04 acceptance criterion 10 (spec §2 AC-10) greps the built CSS for hardcoded `#` outside `tokens.css` and `border-radius` values > 0 to enforce brand fidelity automatically.
- **M04 S5–S9** (every visible slice) — components instantiated under `apps/web/components/` consume the tokens via Tailwind utility classes (e.g. `bg-status-success`, `text-text-secondary`, `font-mono`, `p-4`).

## Token-name conventions (worth knowing before reading the wireframes)

The wireframes use the brand.md token names verbatim. Highlights:

- Colors: `--color-brand` (Precision Blue), `--color-brand-hover`, `--color-bg-{base,surface,elevated,overlay}`, `--color-text-{primary,secondary,tertiary,inverted,code}`, `--color-border-{subtle,default,strong}`, `--color-status-{success,warning,error,info,neutral}`, `--color-risk-{low,medium,high}`.
- Fonts: `--font-display` and `--font-sans` (both Inter), `--font-mono` (JetBrains Mono).
- Spacing: `--space-1` (4px) through `--space-16` (64px). Used everywhere.
- Shape: zero border-radius is implicit (the brand mandates it; the wireframes don't annotate it on every element).

When in doubt about a token, open `brand.html` — it's the rendered ground truth.

## Out of scope for this folder

Logos, icon sets, marketing collateral, font files. Those live elsewhere if/when they're authored. The brand spec describes them but doesn't ship them.
