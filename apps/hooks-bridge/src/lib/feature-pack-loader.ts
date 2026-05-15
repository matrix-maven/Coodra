import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createLogger } from '@coodra/shared';

/**
 * `apps/hooks-bridge/src/lib/feature-pack-loader.ts` — slim
 * filesystem-only Feature-Pack reader used by the SessionStart
 * handler (decision dec_83ba10c1, 2026-05-02 — bridge-side autonomous
 * coordination defaults).
 *
 * Why not reuse `apps/mcp-server/src/lib/feature-pack.ts`?
 *   The mcp-server's store is filesystem + DB hybrid: it caches +
 *   upserts a `feature_packs` row on every read, walks the parent
 *   chain for inheritance, and exposes a typed `FeaturePackStore`
 *   interface. SessionStart only needs the project-level pack body
 *   as a Markdown string for `additionalContext` injection — DB
 *   updates and inheritance walks are the MCP tool's job. A slim
 *   FS-only reader keeps the bridge's hot path light (no DB hits on
 *   SessionStart) and avoids cross-app TS imports.
 *
 * Inputs:
 *   - `cwd`        — the agent's session cwd (event.cwd from the
 *                    Claude Code SessionStart payload). Used as the
 *                    project root.
 *   - `projectSlug`— resolved by `projectSlugResolver` upstream.
 *
 * Returns null when the pack directory or the three markdown files
 * are missing — the bridge then SKIPS `additionalContext` injection
 * but still returns `permissionDecision: 'allow'` so the session
 * continues.
 */

export interface LoadFeaturePackOptions {
  /** Where the agent session is rooted — the bridge resolves cwd from event.cwd. */
  readonly cwd: string;
  /** Slug returned by `projectSlugResolver`. */
  readonly projectSlug: string;
  /**
   * Override the feature-packs root for tests. Defaults to
   * `<cwd>/docs/feature-packs`.
   */
  readonly featurePacksRoot?: string;
}

export interface LoadedFeaturePack {
  readonly slug: string;
  readonly content: string;
}

const featurePackLoaderLogger = createLogger('hooks-bridge.feature-pack-loader');

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Load the project-level Feature Pack and return a single Markdown
 * blob suitable for `additionalContext`. The blob is composed in
 * the order spec → implementation → techstack with H1 dividers, so
 * the agent's planner can scan section headers without seeing
 * three concatenated documents glued without context.
 *
 * Spec is mandatory; implementation and techstack are optional —
 * if implementation.md or techstack.md is missing we still return
 * the spec body. If even spec.md is missing we return null and
 * the caller skips injection.
 */
export async function loadFeaturePackForSession(options: LoadFeaturePackOptions): Promise<LoadedFeaturePack | null> {
  const root = options.featurePacksRoot ?? join(options.cwd, 'docs', 'feature-packs');
  const dir = resolve(root, options.projectSlug);
  const guard = isAbsolute(dir) && dir.startsWith(resolve(root));
  if (!guard) {
    featurePackLoaderLogger.warn(
      { event: 'feature_pack_path_escape', root, projectSlug: options.projectSlug },
      'feature-pack lookup escaped its root; refusing to load',
    );
    return null;
  }

  // Phase F.6 (2026-05-11) — draft gating. Read meta.json BEFORE the
  // markdown files so we can short-circuit on `status='draft'` without
  // paying the spec/impl/techstack read cost. The meta.json `status`
  // field is the canonical on-disk truth (see comment in
  // `apps/web-v2/lib/actions/packs.ts::togglePackStatusAction` for how
  // it's kept in lockstep with the cloud feature_packs row).
  //
  // Missing meta.json is treated as published — pre-Phase-F packs
  // don't have a status field and must continue to be agent-visible.
  // Malformed meta.json (parse fails) is also treated as published so
  // we don't accidentally hide a working pack because an author left
  // a stray trailing comma.
  const metaRaw = await readMaybe(join(dir, 'meta.json'));
  if (metaRaw !== null) {
    try {
      const meta = JSON.parse(metaRaw) as Record<string, unknown>;
      if (meta.status === 'draft') {
        featurePackLoaderLogger.info(
          { event: 'feature_pack_skipped_draft', dir, projectSlug: options.projectSlug },
          'feature-pack status=draft in meta.json; SessionStart will not inject additionalContext',
        );
        return null;
      }
    } catch (err) {
      // Malformed meta.json — log + carry on (treat as published).
      featurePackLoaderLogger.warn(
        { event: 'feature_pack_meta_parse_failed', dir, err: err instanceof Error ? err.message : String(err) },
        'meta.json parse failed; treating as published (continuing injection)',
      );
    }
  }

  const [spec, implementation, techstack] = await Promise.all([
    readMaybe(join(dir, 'spec.md')),
    readMaybe(join(dir, 'implementation.md')),
    readMaybe(join(dir, 'techstack.md')),
  ]);

  if (spec === null) {
    featurePackLoaderLogger.info(
      { event: 'feature_pack_not_found', dir, projectSlug: options.projectSlug },
      'feature-pack spec.md missing; SessionStart will not inject additionalContext',
    );
    return null;
  }

  const sections: string[] = [`# Coodra Feature Pack — ${options.projectSlug}`];
  sections.push('## spec.md');
  sections.push(spec.trim());
  if (implementation !== null) {
    sections.push('## implementation.md');
    sections.push(implementation.trim());
  }
  if (techstack !== null) {
    sections.push('## techstack.md');
    sections.push(techstack.trim());
  }
  return {
    slug: options.projectSlug,
    content: sections.join('\n\n'),
  };
}
