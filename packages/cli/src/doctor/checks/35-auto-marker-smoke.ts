import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAutoSections } from '../../lib/auto-marker/index.js';
import type { Check } from '../types.js';

/**
 * Module 08b S18 check 35 — @auto-marker grammar smoke.
 *
 * Loads each bundled template's *.tmpl files, runs the @auto-marker
 * parser, reports YELLOW if any parse error is detected. Catches a
 * regression where someone edits a template by hand and breaks an
 * @auto open/close pair — would otherwise only surface when an
 * operator runs `coodra init --mode auto` with that template.
 *
 * GREEN when every shipped template's auto sections round-trip
 * cleanly.
 */
const here = dirname(fileURLToPath(import.meta.url));
const TMPL_FILES = ['spec.md.tmpl', 'implementation.md.tmpl', 'techstack.md.tmpl'];

export const autoMarkerSmokeCheck: Check = {
  id: 35,
  name: '@auto-marker grammar valid in every bundled template (M08b)',
  severity: 'green-or-yellow',
  async run(_ctx) {
    // Same resolution order as check 34 — bundled CLI ships templates
    // at `<dist>/templates/` (esbuild collapses checks into dist/index.js).
    const candidates = [
      resolve(here, 'templates'),
      resolve(here, '..', '..', 'templates'),
      resolve(here, '..', '..', '..', 'templates'),
    ];
    const bundledDir = candidates.find((c) => existsSync(c));
    if (bundledDir === undefined) {
      return { status: 'skipped', detail: 'bundled templates dir not found (covered by check 34)' };
    }
    const errors: string[] = [];
    for (const tmplName of readdirSync(bundledDir)) {
      const tmplDir = join(bundledDir, tmplName);
      for (const fname of TMPL_FILES) {
        const path = join(tmplDir, fname);
        if (!existsSync(path)) continue;
        try {
          const raw = readFileSync(path, 'utf8');
          const result = parseAutoSections(raw);
          if (result.errors.length > 0) {
            for (const e of result.errors) {
              errors.push(`${tmplName}/${fname}:${e.line} ${e.code} — ${e.message}`);
            }
          }
        } catch (err) {
          errors.push(`${tmplName}/${fname}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (errors.length === 0) {
      return { status: 'green', detail: 'every bundled template parses cleanly' };
    }
    return {
      status: 'yellow',
      detail: `${errors.length} parser issue(s): ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? `…+${errors.length - 3} more` : ''}`,
      remediation:
        'Run `pnpm --filter @coodra/cli test:unit` to surface the same errors in the parser test suite, then fix the offending template files.',
    };
  },
};
