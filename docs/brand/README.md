# Coodra Brand Sources

Canonical visual-identity sources for the Coodra web app (`apps/web-v2`) and
public product surfaces that need to match.

## Files In This Directory

- [`brand.md`](./brand.md) - narrative design-system spec covering visual
  principles, typography, color, spacing, motion, components, and accessibility.
- [`brand.html`](./brand.html) - single-file rendered reference page for tokens
  and component primitives in light and dark modes.
- `coodra-lockup.svg`, `coodra-motto.svg`, `coodra-pillars.svg` - reusable brand
  assets. Check visible text before using an asset in new public material.

## How To Use These Files

- New product UI should consume the established tokens before inventing new
  colors, spacing, or component shapes.
- Public docs, decks, screenshots, and launch material should use the same logo
  and color system so Coodra reads as one product.
- If a token or component needs to change, update this folder first, then port
  the change into `apps/web-v2`.

When in doubt about a token, open `brand.html`; it is the rendered reference.
