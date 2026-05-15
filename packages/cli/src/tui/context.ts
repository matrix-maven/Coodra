/**
 * `src/tui/context.ts` — the small bootstrap context the TUI chrome
 * needs at launch: CLI version, cwd, resolved `~/.coodra/`, machine
 * mode, and the current project's slug. Gathered once before the Ink
 * tree mounts; the Status view fetches its own richer data lazily.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveCoodraHome } from '../lib/coodra-home.js';
import { readTeamConfig } from '../lib/team-config.js';
import { VERSION } from '../version.js';

export interface TuiContext {
  readonly version: string;
  readonly cwd: string;
  readonly coodraHome: string;
  readonly mode: 'solo' | 'team';
  /** Clerk org slug, when in team mode and the config carries one. */
  readonly orgSlug: string | null;
  /** Project slug from `<cwd>/.coodra.json`, or null for an unregistered cwd. */
  readonly projectSlug: string | null;
}

/** Resolve the TUI bootstrap context. Never throws — every probe degrades to a safe default. */
export async function loadTuiContext(): Promise<TuiContext> {
  const cwd = process.cwd();
  const coodraHome = resolveCoodraHome();

  let mode: 'solo' | 'team' = 'solo';
  let orgSlug: string | null = null;
  try {
    const cfg = readTeamConfig({ homeOverride: coodraHome });
    mode = cfg.mode;
    orgSlug = cfg.team?.clerkOrgSlug ?? null;
  } catch {
    // No config / unreadable — solo is the safe default.
  }

  let projectSlug: string | null = null;
  try {
    const raw = await readFile(join(cwd, '.coodra.json'), 'utf8');
    const parsed = JSON.parse(raw) as { projectSlug?: unknown };
    if (typeof parsed.projectSlug === 'string' && parsed.projectSlug.length > 0) {
      projectSlug = parsed.projectSlug;
    }
  } catch {
    // Not a registered project — projectSlug stays null.
  }

  return { version: VERSION, cwd, coodraHome, mode, orgSlug, projectSlug };
}

/** The right-side label for the top bar — `solo · my-awesome-app`. */
export function stateLabel(ctx: TuiContext): string {
  const project = ctx.projectSlug ?? '(no project)';
  return `${ctx.mode} · ${project}`;
}
