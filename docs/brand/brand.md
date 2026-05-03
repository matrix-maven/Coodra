# ContextOS — Brand Guide

## 1. Visual Theme & Atmosphere

ContextOS is developer tooling made visual — a design system that communicates precision, engineering discipline, and zero-tolerance confidence. The interface alternates between deep dark hero sections and sharp, information-dense content areas, creating a rhythm reminiscent of a high-precision instrument panel: everything purposeful, nothing decorative.

The design language is built around angular geometry, extreme typographic weight contrast, and a singular precision-blue accent. Every decision serves clarity. Nothing is added without functional reason.

**Core Identity:**
- **Precision** — every element is deliberate, measured, justified
- **Focus** — dark surfaces, tight typography, single accent color eliminate distraction
- **Authority** — extreme weight contrast and uppercase display convey confidence without noise

---

## 2. Visual Principles

### Precision Over Decoration
The interface communicates through structure, not ornamentation. No decorative gradients, no illustrative elements, no visual noise. Depth is achieved through surface elevation (dark-to-darker) and typographic contrast — not shadows, textures, or graphics.

### Angular Geometry Is Non-Negotiable
Zero border-radius on all structural elements. Every button, input, card, modal, and panel is a precise rectangle. Sharp corners communicate engineering rigor. Rounding dilutes the identity.

### Accent Used Sparingly
The precision-blue (`#1C69D4`) is reserved exclusively for interactive elements — links, active states, focus rings, primary buttons. It never appears as a background, decorative stripe, or large-surface fill. Its rarity is what gives it power.

### Dark-First, Contrast-Driven
Dark mode is the primary surface for hero sections. The near-black hero with slightly elevated containers creates cinematic contrast against white content sections. Light mode is the default for content areas — the showroom rhythm of dark/light drives the visual identity.

---

## 3. Color Palette

### Primary Brand
| Role | Value | Token |
|---|---|---|
| Precision Blue (accent) | `#1C69D4` | `--color-brand` |
| Precision Blue (focus) | `#0653B6` | `--color-brand-hover` |

### Neutral Scale (Dark Mode)
| Role | Value | Token |
|---|---|---|
| Base background | `#0A0A0F` | `--color-bg-base` |
| Surface | `#111118` | `--color-bg-surface` |
| Elevated | `#1A1A24` | `--color-bg-elevated` |
| Primary text | `#F0F0F5` | `--color-text-primary` |
| Secondary text | `#9898B0` | `--color-text-secondary` |
| Tertiary text | `#5C5C78` | `--color-text-tertiary` |

### Neutral Scale (Light Mode)
| Role | Value | Token |
|---|---|---|
| Base background | `#FFFFFF` | `--color-bg-base` |
| Surface | `#F4F4F8` | `--color-bg-surface` |
| Elevated | `#EBEBF0` | `--color-bg-elevated` |
| Primary text | `#262626` | `--color-text-primary` |
| Secondary text | `#757575` | `--color-text-secondary` |
| Tertiary text | `#BBBBBB` | `--color-text-tertiary` |

### Status Colors (both modes)
| Role | Value | Token |
|---|---|---|
| Success / Allowed | `#22C55E` | `--color-status-success` |
| Warning / Partial | `#F59E0B` | `--color-status-warning` |
| Error / Denied | `#EF4444` | `--color-status-error` |
| Info / PreToolUse | `#1C69D4` | `--color-status-info` |
| Neutral / Inactive | `#6B7280` | `--color-status-neutral` |

---

## 4. Typography

### Font Families
- **Display:** `Inter` (weight 300) — for hero headings, uppercase only. Whispered authority.
- **Body / UI:** `Inter` — for all interface text, navigation, buttons, labels.
- **Monospace:** `JetBrains Mono` — for file paths, IDs, event names, code snippets.

### Typographic Hierarchy
| Role | Font | Size | Weight | Line Height | Transform |
|---|---|---|---|---|---|
| Display Hero | Inter | 60px | 300 | 1.30 | UPPERCASE |
| Section Heading | Inter | 32px | 400 | 1.30 | UPPERCASE |
| Nav Emphasis / CTA | Inter | 16–18px | 700–900 | 1.20 | — |
| Body | Inter | 16px | 400 | 1.15 | — |
| Secondary | Inter | 13px | 400 | 1.50 | — |
| Label / Badge | Inter | 11px | 500 | 1.40 | UPPERCASE |
| Monospace | JetBrains Mono | 12–13px | 400 | 1.50–1.60 | — |

### Typographic Principles
- **Whispered authority:** Display headings at weight 300 create scale without aggression. The size carries the hierarchy; the weight stays restrained.
- **Stark navigation:** Nav and CTA elements at weight 700–900 create extreme contrast with display text. This tension (300 vs 900) is the defining typographic gesture.
- **Tight everything:** Line heights from 1.15 to 1.30. No relaxed leading. Information is compressed and deliberate.
- **Uppercase display:** All display and section headings are uppercase — monumental, architectural.
- **Avoid middle weights:** The system uses 300, 400, 700, and 900. Intermediate weights (500–600) dilute the contrast effect and are not used.

---

## 5. Components

### Buttons
- **Primary:** Precision-blue fill, white text, weight 700, zero border-radius, 16px
- **Ghost:** Transparent fill, `--color-border-default` border, primary text color, zero border-radius
- **Hover states:** Brand color darkens to `#0653B6`; ghost border thickens or tints
- **No rounded corners — ever**

### Cards & Containers
- Sharp-cornered rectangles — `border-radius: 0`
- `--color-bg-surface` on dark, `#FFFFFF` on light
- Borders via `--color-border-subtle`
- No decorative shadows on base cards; elevation cards use `--shadow-md`

### Inputs
- Zero border-radius
- `--color-bg-elevated` background
- `--color-border-default` border at rest
- `--color-brand` border on focus with `--shadow-brand` ring

### Navigation
- `Inter` 16–18px, weight 700–900 for primary links
- White text on dark surface, `#262626` on light surface
- Hover: no underline, color unchanged — interaction signaled by weight and placement
- Active sidebar item: `--color-brand-muted` background, `--color-brand` left border (2px)

### Status Badges
- Rectangular (zero radius)
- Transparent background, colored border and text
- Always paired with label text — color is never the sole signal

### Code / Monospace
- `JetBrains Mono` at 12–13px
- `--color-bg-elevated` background
- `--color-text-code` (green-tinted in dark, dark green in light)

---

## 6. Layout

### Spacing System
Base unit: 8px. All spacing is a multiple of 4px at minimum.

| Token | Value |
|---|---|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-6` | 24px |
| `--space-8` | 32px |
| `--space-12` | 48px |
| `--space-16` | 64px |

### Whitespace Philosophy
- **Panel sections:** Generous padding creates instrument-panel clarity — each zone has its own visual territory.
- **Content rows:** Tight row padding (`--space-4`) and compact line heights — information-dense, no waste.
- **Page separators:** Section gaps (`--space-8`) and page-level horizontal padding (`--space-12`) provide breathing room between logical zones.

### Grid
- Sidebar: fixed-width, left-anchored
- Main content: fluid
- Modals: centered, constrained width, full-bleed backdrop overlay

---

## 7. Depth & Elevation

| Level | Treatment | Use |
|---|---|---|
| Base (0) | `--color-bg-base` | App background |
| Surface (1) | `--color-bg-surface` | Sidebar, panels, cards |
| Elevated (2) | `--color-bg-elevated` + `--shadow-md` | Modals, dropdowns, tooltips |
| Focus | `--shadow-brand` ring | Focus states on interactive elements |

No shadows at surface level — elevation is communicated through color steps, not drop shadows.

---

## 8. Responsive Behavior

| Breakpoint | Width | Key Changes |
|---|---|---|
| Mobile | < 640px | Single column, sidebar collapses to bottom nav |
| Tablet | 640–1024px | Two-column begins, sidebar optional |
| Desktop | 1024–1280px | Full layout, sidebar always visible |
| Large Desktop | 1280px+ | Expanded content area, max-width applied to content |

**Collapsing strategy:**
- Display headings: 60px → scales down, uppercase and weight 300 maintained
- Navigation: horizontal → icon-only or hamburger
- Content panels: stack vertically
- Typography weight contrast preserved at all breakpoints

---

## 9. Do's and Don'ts

### Do
- Use `Inter` weight 300 uppercase for all display headings
- Keep ALL corners sharp (0px radius) — angular geometry is identity-defining
- Use precision-blue (`#1C69D4`) only for interactive elements — never decoratively
- Apply weight 700–900 for navigation and CTAs — the weight contrast is intentional
- Keep line heights tight (1.15–1.30) throughout
- Reference CSS custom property tokens in all component code

### Don't
- Round corners — zero radius is not a preference, it is the system
- Use precision-blue for backgrounds or large surface fills — it is an accent only
- Use intermediate font weights (500–600) — use the extremes
- Add decorative elements — structure and typography carry everything
- Use relaxed line heights — text is always compressed and efficient
- Hardcode hex values in component code — always use token variables

---

## 10. Component Prompt Guide

### Quick Color Reference
| Purpose | Value |
|---|---|
| Background (dark) | `#0A0A0F` |
| Surface (dark) | `#111118` |
| Primary text (dark) | `#F0F0F5` |
| Background (light) | `#FFFFFF` |
| Primary text (light) | `#262626` |
| Secondary text | `#757575` (light) / `#9898B0` (dark) |
| Accent | `#1C69D4` |
| Focus | `#0653B6` |

### Example Component Specs
- **Hero section:** Dark base (`#1A1A1A`). Heading at 60px `Inter` weight 300, uppercase, line-height 1.30, white text. Zero border-radius everywhere.
- **Navigation:** White surface. `Inter` 16–18px weight 900 for links, `#262626` text. Sharp rectangular layout.
- **Primary button:** 16px `Inter` weight 700, line-height 1.20. `#1C69D4` fill. Zero border-radius. White text.
- **Content section (light):** White background. Heading 32px `Inter` weight 400 uppercase, line-height 1.30, `#262626`. Body 16px `Inter` weight 400, line-height 1.15.
- **Status badge:** Transparent background. Border and text in status color. `Inter` 11px weight 500 uppercase. Zero border-radius.