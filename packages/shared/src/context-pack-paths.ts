import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * `packages/shared/src/context-pack-paths.ts` — shared helpers that
 * compute the on-disk location for context-pack markdown files.
 *
 * Two consumers in v1:
 *
 *   1. `apps/mcp-server/src/lib/context-pack.ts` — `createContextPackStore`
 *      (the MCP `save_context_pack` tool's backing store).
 *   2. `apps/hooks-bridge/src/lib/auto-context-pack.ts` — Phase 4 Fix H
 *      (Slice 3 — 2026-05-03 audit): the bridge's SessionEnd
 *      auto-save now materialises a markdown file alongside the DB
 *      insert. Pre-Fix-H auto-saves landed in DB only; users couldn't
 *      see auto-saved sessions without opening sqlite.
 *
 * Both call sites now use the SAME path computation so a manual
 * `save_context_pack` call mid-session and the bridge's autonomous
 * SessionEnd save produce the same filename for the same runId
 * (which idempotency check catches as a no-op via `context_packs.run_id`
 * unique constraint, but matching filenames keep `ls ~/.contextos/packs/`
 * coherent).
 *
 * These helpers were originally in `apps/mcp-server/src/lib/context-pack.ts`
 * (lines 91-126 pre-Fix-H). Extracted to `@coodra/contextos-shared`
 * to avoid an app→app dependency from the bridge to the mcp-server.
 * The mcp-server module re-exports them so the existing public API
 * is unchanged.
 */

/**
 * Default root for on-disk `YYYY-MM-DD-<runId>.md` files.
 *
 * F13 closure (verification 2026-04-27): the auto-saved per-pack
 * markdown lands in `~/.contextos/packs/` by default — out of any
 * repo, separate from the curated archive at `docs/context-packs/`.
 * The override knob (env `CONTEXTOS_CONTEXT_PACKS_ROOT`, or
 * `contextPacksRoot` option on `createContextPackStore`) still
 * applies. Hand-curated module closeouts live in
 * `<repo>/docs/context-packs/` and stay tracked in git; this default
 * separates the runtime artifact from the curated archive so
 * closeouts don't leave orphan auto-saved files in the repo.
 */
export function defaultContextPacksRoot(): string {
  return resolve(homedir(), '.contextos', 'packs');
}

/**
 * Build the on-disk filename for a context-pack markdown file.
 *
 * The runId is shaped `run:{projectId}:{sessionId}:{uuid}` per
 * `system-architecture.md §4.3`. Sliced naively into a filename, the
 * colon separators produce names like `2026-04-25-run:proj.md` —
 * works on macOS/Linux but Windows reserves `:` and rejects the
 * create. Verification finding §8.4 surfaced this; the fix sanitizes
 * every Windows-reserved char (`<>:"/\\|?*`) into hyphens BEFORE
 * slicing, then takes 16 chars (vs the prior 8) so the run prefix
 * `run-` plus a meaningful slice of the projectId remains visible
 * in `ls` output.
 *
 * Old: `2026-04-25-run:proj.md`
 * New: `2026-04-25-run-proj_xxxx-x.md` (or similar, depending on
 *       runId shape; always Windows-safe).
 */
export function contextPackFilename(runId: string, createdAt: Date): string {
  const yyyyMmDd = createdAt.toISOString().slice(0, 10);
  const safe = runId.replace(/[<>:"/\\|?* -]/g, '-').slice(0, 16);
  return `${yyyyMmDd}-${safe}.md`;
}
