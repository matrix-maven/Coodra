'use server';

import { homedir } from 'node:os';
import { detectIDE } from '@coodra/cli/lib/detect';
import { resolveGraphifyPython } from '@coodra/cli/lib/init/graphify-python';
import { DEFAULT_GRAPHIFY_GRAPH_PATH, unwireGraphify, wireGraphify } from '@coodra/cli/lib/init/graphify-wire';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { refuseInTeamHosted } from '@/lib/action-guards';

/**
 * `apps/web-v2/lib/actions/integrations.ts` — server actions for the
 * `/settings/integrations` Graphify card (Module 09, Track 9B).
 *
 *   enableGraphifyAction(formData)  — wire Graphify's stdio MCP server
 *                                     (a structural-query tool) into
 *                                     every agent config detected on
 *                                     this machine.
 *   disableGraphifyAction(formData) — remove the `graphify` MCP entry
 *                                     from every detected agent config.
 *
 * Both wrap the 9·Core writers from `@coodra/cli` — the same idempotent,
 * never-clobber code the CLI's `coodra graphify` command runs. They
 * autodetect IDEs exactly like `coodra graphify enable` with no `--ide`.
 * Coodra mints no Work Packs from the graph — the agent
 * calls Graphify's query tools directly.
 *
 * Deployment gate: `refuseInTeamHosted`. A deployed (team-hosted) web
 * server has no developer agent configs to write — wiring is a
 * local-laptop operation. The integrations page renders the
 * `coodra graphify enable` CLI command in that mode instead.
 */

const SLUG_RE = /^[a-z0-9_-]+$/;
const INTEGRATIONS_HREF = '/settings/integrations';

const PROJECT_FORM_SCHEMA = z.object({
  projectSlug: z.string().min(1, 'projectSlug is required').regex(SLUG_RE, 'projectSlug is malformed'),
  cwd: z
    .string()
    .min(1, 'cwd is required')
    .refine((v) => v.startsWith('/'), 'cwd must be an absolute path'),
});

function firstZodMessage(err: z.ZodError): string {
  const issue = err.issues[0];
  return issue === undefined ? 'invalid form data' : issue.message;
}

function errorHref(code: string, message: string): string {
  const search = new URLSearchParams();
  search.set('error', code);
  search.set('errorMessage', message);
  return `${INTEGRATIONS_HREF}?${search.toString()}`;
}

/**
 * Wire Graphify's MCP server into every detected agent config for one
 * project. Idempotent — re-running is a no-op; a drifted entry is
 * preserved (the CLI's `--force` is the escape hatch, intentionally not
 * exposed in the web).
 */
export async function enableGraphifyAction(formData: FormData): Promise<void> {
  refuseInTeamHosted('enableGraphifyAction');

  const parsed = PROJECT_FORM_SCHEMA.safeParse({
    projectSlug: String(formData.get('projectSlug') ?? ''),
    cwd: String(formData.get('cwd') ?? ''),
  });
  if (!parsed.success) {
    redirect(errorHref('invalid_input', firstZodMessage(parsed.error)));
  }
  const { projectSlug, cwd } = parsed.data;
  const userHome = homedir();

  const detected = await detectIDE();
  if (detected.length === 0) {
    redirect(
      errorHref(
        'no_ide_detected',
        'No supported IDE (Claude Code, Codex) was detected on this machine. Install one, then retry.',
      ),
    );
  }

  // Auto-detect + verify an interpreter that can `import graphify.serve,
  // mcp` rather than hardcoding bare `python3` (which usually fails to
  // spawn and shows the server as "failed" in the agent).
  const resolution = await resolveGraphifyPython({ cwd, env: process.env });

  try {
    for (const ide of detected) {
      await wireGraphify({
        ide,
        cwd,
        userHome,
        python: resolution.python,
        graphPath: DEFAULT_GRAPHIFY_GRAPH_PATH,
        force: false,
        dryRun: false,
      });
    }
  } catch (err) {
    redirect(errorHref('enable_failed', (err as Error).message));
  }

  redirect(`${INTEGRATIONS_HREF}?enabled=${encodeURIComponent(projectSlug)}`);
}

/**
 * Remove the `graphify` MCP entry from every detected agent config for
 * one project. Idempotent — a missing file or missing entry is a no-op.
 */
export async function disableGraphifyAction(formData: FormData): Promise<void> {
  refuseInTeamHosted('disableGraphifyAction');

  const parsed = PROJECT_FORM_SCHEMA.safeParse({
    projectSlug: String(formData.get('projectSlug') ?? ''),
    cwd: String(formData.get('cwd') ?? ''),
  });
  if (!parsed.success) {
    redirect(errorHref('invalid_input', firstZodMessage(parsed.error)));
  }
  const { projectSlug, cwd } = parsed.data;
  const userHome = homedir();

  const detected = await detectIDE();
  try {
    for (const ide of detected) {
      await unwireGraphify({ ide, cwd, userHome, dryRun: false });
    }
  } catch (err) {
    redirect(errorHref('disable_failed', (err as Error).message));
  }

  redirect(`${INTEGRATIONS_HREF}?disabled=${encodeURIComponent(projectSlug)}`);
}
