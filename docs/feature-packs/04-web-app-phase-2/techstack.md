# Module 04 Phase 2 — Tech Stack

> What Phase 2 adds to the Phase 1 stack. The full Phase 1 stack (Next.js 15 + React 19 + Tailwind v4 + Clerk v6 + Supabase SSR + Drizzle + better-sqlite3 + Vitest + Biome) is documented in `../04-web-app/techstack.md` and is unchanged here. Phase 2 introduces three new direct dependencies and one library promotion.

## Runtime — unchanged

Phase 2 does not bump Node, Next.js, React, TypeScript, or Tailwind versions. Same workspace floors:
- Node ≥ 22.16.0
- Next.js 15.x
- React 19.x
- TypeScript 5.x strict
- Tailwind v4 with `@theme` block consuming `apps/web/styles/tokens.css`

## New direct dependencies (production)

```json
{
  "react-markdown": "^9.0.0",
  "rehype-sanitize": "^6.0.0",
  "remark-gfm": "^4.0.0",
  "reactflow": "^11.11.4"
}
```

### Why each pin

#### `react-markdown` ^9

The markdown renderer for `/packs/[slug]` (S5) and the FP editor's preview pane (S6).

- v9 is the current stable; ESM-only, which fits the Next.js 15 ESM-by-default posture.
- Tree-shakable; only the components we use end up in the bundle.
- Composable transform pipeline (`remarkPlugins` + `rehypePlugins`) — we add `remark-gfm` for GitHub-flavored markdown (tables, task lists, strikethrough) and `rehype-sanitize` for XSS protection.
- Component-override prop lets us map every HTML element to a brand-token class without touching the markdown source. Example wiring:

```tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  rehypePlugins={[rehypeSanitize]}
  components={{
    h1: ({ children }) => <h1 className="font-display text-4xl font-black uppercase text-(--color-text-primary)">{children}</h1>,
    code: ({ inline, children }) =>
      inline
        ? <code className="font-mono text-(--color-text-primary) bg-(--color-bg-elevated) px-1">{children}</code>
        : <code className="font-mono">{children}</code>,
    a: ({ href, children }) => <a href={href} className="text-(--color-brand) hover:underline">{children}</a>,
    // … h2-h6, p, ul, ol, blockquote, table, td, th
  }}
>
  {pack.spec}
</ReactMarkdown>
```

**Alternatives considered:**
- `marked` + `dompurify` — lower-level; we'd hand-write the React adapter ourselves. Larger surface to test for XSS regressions.
- `mdx-bundler` — overkill for static markdown rendering; intended for MDX runtime compilation.
- Server-side `unified` pipeline + raw HTML output — works but loses the React component-override ergonomics; would force us to ship escape-hatch sanitization downstream.

react-markdown wins on safety + ergonomics + bundle size.

#### `rehype-sanitize` ^6

The XSS gate. Runs after parse, removes `<script>`, javascript: URLs, on*= handlers, dangerous SVG attrs.

- Default config (`rehype-sanitize/lib/github`) is GitHub's own allowlist — battle-tested.
- We extend it minimally: allow our brand-color CSS classes through `clobberPrefix: 'user-content-'` (prevents user IDs from clobbering page-level IDs).
- Tested in S5 with hostile fixtures (script tag, javascript: link, on*= handler) — all stripped to empty / safe equivalents.

**Why not trust the source.** Pack files are user-editable via the FP editor (S6). A user could paste arbitrary markdown including HTML; sanitize defends against that. The CLI's `pack regen` writes auto-marker sections that include code blocks; those are markdown-fenced + already safe, but the sanitizer is in the chain regardless.

#### `remark-gfm` ^4

Adds GitHub-flavored markdown to react-markdown's CommonMark base: tables, task lists, strikethrough, autolinks. Most ContextOS docs (system-architecture.md, feature-pack specs) use GFM tables extensively, so this is mandatory not optional.

#### `reactflow` ^11.11.4

The graph-rendering canvas for `/graph` (S9).

- v11.11.x is the current stable (v12 is in beta as of 2026-05-04).
- TypeScript-native; types ship with the package.
- Works in React 19 + Next.js 15 App Router (verified via the package's release notes for 11.11.0).
- Plugin architecture (custom node/edge components) lets us style nodes with brand tokens (zero radius, brand-blue edges, Inter font).
- Active maintenance + large community.

**Alternatives considered:**
- `cytoscape.js` — more graph-theory features but heavier (300KB+ vs react-flow's 80KB) and the React wrapper (`react-cytoscapejs`) is third-party + lightly maintained.
- Inline `d3-force` — full control but we'd write all the rendering ourselves; ~400 lines for what react-flow gives us in 50.
- `react-force-graph` — built on three.js / d3-force; heavier; canvas-based (worse a11y than react-flow's SVG).
- `vis-network` — older API; less idiomatic React.

react-flow wins on bundle size + React-idiomatic API + brand-styling ergonomics.

**Pin to 11.x not 12.x:** v12 introduces breaking API changes (the package was renamed `@xyflow/react`); we wait until v12 is stable + ecosystem catches up.

## New direct dependencies (dev)

```json
{
  "@types/react-flow": "skip — types ship with the package"
}
```

No new dev deps. Vitest + Biome + happy-dom + @testing-library/react cover the new test surface.

## Library promotions (no new deps, but cross-package surface change)

### `packages/cli/src/lib/init/runInit` exported as a public library entry

For `/init` wizard (S4). The CLI's `init` command body lives in `packages/cli/src/commands/init.ts` and calls into a private helper. Phase 2 promotes that helper to `packages/cli/src/lib/init/run.ts` as `export async function runInit(opts: RunInitOpts): Promise<RunInitResult>`. The CLI command becomes a thin wrapper. The web Server Action calls the same library entry.

**Why a library promotion, not a CLI subprocess.** Subprocess spawning from a Next.js Server Action is fragile (cwd, env, output capture, error mapping). Direct library call gives us:
- Typed return values
- Synchronous error propagation
- No process boundary to debug
- Same code path as CLI for verification

### `packages/cli/src/lib/doctor/registry.ts::runDoctorRegistry` exported

For `/doctor` page (S8). Same pattern: the CLI's `doctor` command body promotes to a library function that returns the structured check report. CLI keeps its TTY rendering; web reads the JSON directly.

## Brand-token additions

**None.** Phase 2 introduces zero new CSS custom properties. The markdown renderer (S5), the graph canvas (S9), and the doctor page (S8) all consume Phase 1's existing tokens from `apps/web/styles/tokens.css`.

## Test surface additions

Phase 2 adds these test fixtures + helpers (no new framework deps):

- `apps/web/__tests__/__fixtures__/markdown-xss.md` — battery of XSS hostile inputs for the renderer.
- `apps/web/__tests__/__fixtures__/feature-pack-with-markers.md` — pack with auto-managed sections to exercise the marker parser.
- `apps/web/__tests__/__fixtures__/graph-100-nodes.json` — synthetic graph for `/graph` rendering tests.
- `apps/web/__tests__/helpers/sse-test-client.ts` — lightweight EventSource shim for `/logs` integration tests under happy-dom.

## Summary table — Phase 2 net new surface

| Category | Count | Notes |
|---|---:|---|
| Production deps | +4 | react-markdown, rehype-sanitize, remark-gfm, reactflow |
| Dev deps | 0 | All test infra reused from Phase 1 |
| New runtime / framework versions | 0 | Same Next 15, React 19, Tailwind v4 |
| New brand tokens | 0 | tokens.css unchanged |
| New CLI library entries | 2 | `runInit`, `runDoctorRegistry` |
| New web routes | 7 | `/init`, `/packs/[slug]/edit`, `/packs/[slug]/runs`, `/graph`, `/doctor`, `/logs/[service]`, `/sync` |
| New API endpoints | 5 | `/api/project-context`, `/api/doctor/state`, `/api/sync/state`, `/api/logs/[service]/stream`, the FP editor save endpoint |
| New schema tables | 0 | Phase 2 reads/writes existing 11 |
| New schema migrations | 1 | `0009_run_events_orphan_backfill.sql` (data migration) |

## Bundle-size impact

Estimated production bundle delta (via `pnpm build` analysis, pre-implementation):

| Dep | gzipped | notes |
|---|---:|---|
| react-markdown + remark-gfm + rehype-sanitize | ~28 KB | tree-shaken; lazy-load on `/packs/[slug]` and `/packs/[slug]/edit` only |
| reactflow | ~80 KB | lazy-load on `/graph` only via dynamic import |
| **Total Phase 2 bundle delta** | ~108 KB | All gated to specific routes; dashboard / runs / kill-switches unchanged |

We use Next.js dynamic imports (`next/dynamic` with `ssr: false`) for the graph canvas and the editor preview pane to keep the bundle gating tight.

## Versions to verify before S1

Per `essentialsforclaude/04-when-in-doubt.md §4.2`, before S1 implementation:

```sh
npm view react-markdown version
npm view rehype-sanitize version
npm view remark-gfm version
npm view reactflow version
```

If any pin in this file is stale by ≥1 major version when S1 starts, update the pin in this file in the same commit that adds the dep. Otherwise hold the version locked here.

## What we explicitly did NOT add

- **No CodeMirror / Monaco** — the FP editor uses a plain textarea (per OQ-3 lock; brand-promise of operator-grade).
- **No tiptap / lexical / slate** — same reason.
- **No socket.io / ws** — `/logs` uses native SSE per OQ-6.
- **No d3 / cytoscape / three.js** — `/graph` uses react-flow per OQ-5.
- **No mermaid / plantuml** — Phase 2 markdown renderer doesn't render diagram fences (out of scope; Phase 3 if we ever need them).
- **No MDX runtime** — no MDX in Phase 2; pack docs are vanilla markdown.
- **No PWA / service worker** — Phase 2 stays SSR-first.
