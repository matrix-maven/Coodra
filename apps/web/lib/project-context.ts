import type { ProjectDetailRow } from '@coodra/db';
import { notFound } from 'next/navigation';

import { getProject } from '@/lib/queries/projects';

/**
 * `apps/web/lib/project-context.ts` — URL-bound project resolver
 * (M04 Phase 2 S2 hub-and-spoke IA).
 *
 * Every page under `/projects/[slug]/*` calls this helper at the top
 * to resolve the URL slug to a `projects` row. Returns the row on
 * success; calls Next.js `notFound()` on miss (renders the project
 * not-found page).
 *
 * Why URL-based, not cookie-based: pre-pivot Phase 2 used a
 * `coodra_selected_project` cookie. The IA pivot 2026-05-04 drops
 * the cookie — every project-scoped URL carries the slug, which
 * makes deep-links scope correctly without cross-tab leakage and
 * lets browser back/forward act as project switching. See
 * `spec.md §6` for the full rationale.
 *
 * The `__global__` sentinel is queryable here (deep-link lands the
 * sentinel page), but it's filtered out of the `/` picker via S1's
 * F2 fix.
 */

/**
 * Resolve `params.slug` (URL-decoded) to a project row. Calls
 * `notFound()` if no row matches, so the caller never sees null.
 *
 *     const project = await resolveProjectFromParams(params);
 *     // project is ProjectDetailRow from here, never null.
 */
export async function resolveProjectFromParams(
  params: Promise<{ slug: string }> | { slug: string },
): Promise<ProjectDetailRow> {
  const resolved = 'then' in params ? await params : params;
  const slug = decodeURIComponent(resolved.slug);
  const row = await getProject(slug);
  if (row === null) notFound();
  return row;
}
