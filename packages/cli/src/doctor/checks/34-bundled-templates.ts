import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTemplate, TemplateLoadError } from '../../lib/templates/load-template.js';
import type { Check } from '../types.js';

/**
 * Module 08b S18 check 34 — bundled templates manifest integrity.
 *
 * RED when any expected bundled template (`generic`, `nextjs-saas`,
 * `python-fastapi`, `python-ml`, `node-monorepo`, `rust-cli`,
 * `go-service`) is missing OR fails to parse via `loadTemplate`.
 * Catches a corrupted install — npm tarball missing files, partial
 * extraction, manual edit that broke template.json schema.
 *
 * GREEN when all 7 templates load cleanly.
 */
const EXPECTED_BUNDLED = [
  'generic',
  'nextjs-saas',
  'python-fastapi',
  'python-ml',
  'node-monorepo',
  'rust-cli',
  'go-service',
] as const;

const here = dirname(fileURLToPath(import.meta.url));

export const bundledTemplatesCheck: Check = {
  id: 34,
  name: 'Bundled templates manifest is intact (M08b)',
  severity: 'red',
  async run(_ctx) {
    // Resolution order:
    //   1. `<here>/templates`          — bundled CLI: every check
    //      module is collapsed into `dist/index.js` by esbuild,
    //      so `import.meta.url` resolves to `<dist>/index.js` and
    //      bundle.mjs copies templates to `<dist>/templates/`.
    //   2. `<here>/../../templates`    — dev tsc-only build: source
    //      maps to `dist/doctor/checks/`, two levels up = `dist/`.
    //   3. `<here>/../../../templates` — vitest source mode where
    //      `here = packages/cli/src/doctor/checks/`, three levels
    //      up = `packages/cli/templates/`.
    const candidates = [
      resolve(here, 'templates'),
      resolve(here, '..', '..', 'templates'),
      resolve(here, '..', '..', '..', 'templates'),
    ];
    const bundledDir = candidates.find((c) => existsSync(c));
    if (bundledDir === undefined) {
      return {
        status: 'red',
        detail: `bundled templates dir not found (looked at ${candidates.join(', ')})`,
        remediation:
          'Reinstall: `npm i -g @coodra/cli`. The templates dir ships inside the npm tarball; if missing, the install is corrupted.',
      };
    }
    const present = new Set(readdirSync(bundledDir));
    const missing = EXPECTED_BUNDLED.filter((name) => !present.has(name));
    if (missing.length > 0) {
      return {
        status: 'red',
        detail: `missing bundled templates: ${missing.join(', ')} (looked in ${bundledDir})`,
        remediation: 'Reinstall the CLI to repair the template manifest.',
      };
    }
    const errors: string[] = [];
    for (const name of EXPECTED_BUNDLED) {
      try {
        await loadTemplate(`${bundledDir}/${name}`);
      } catch (err) {
        const message = err instanceof TemplateLoadError ? `${err.code}: ${err.message}` : (err as Error).message;
        errors.push(`${name}: ${message}`);
      }
    }
    if (errors.length > 0) {
      return {
        status: 'red',
        detail: `template parse errors: ${errors.join('; ')}`,
        remediation: 'Reinstall the CLI; bundled templates appear corrupted on disk.',
      };
    }
    return { status: 'green', detail: `${EXPECTED_BUNDLED.length} bundled templates loaded cleanly` };
  },
};
