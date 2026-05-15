import semver from 'semver';

import { NpmViewError, npmViewVersion } from '../../lib/npm-view.js';
import { VERSION } from '../../version.js';
import type { Check } from '../types.js';

/**
 * Module 08b S18 check 32 — newer @coodra/cli published.
 *
 * Gated by `COODRA_DOCTOR_CHECK_UPDATES=1` because doctor is
 * otherwise fully offline; users who want the network probe opt in.
 * `--check-updates` flag wiring on the doctor command is reserved
 * for a follow-up — the env var is the contract operators can set
 * permanently in their shell rc to keep the check on.
 *
 * YELLOW when a newer version is published. GREEN when up-to-date.
 * SKIPPED when the env gate isn't set (default). RED on registry
 * failure (so the operator notices the network problem instead of
 * silently believing they're up to date).
 */
export const upgradeAvailableCheck: Check = {
  id: 32,
  name: 'No newer @coodra/cli published (M08b)',
  severity: 'green-or-yellow',
  async run(ctx) {
    if (ctx.env.COODRA_DOCTOR_CHECK_UPDATES !== '1') {
      return {
        status: 'skipped',
        detail: 'set COODRA_DOCTOR_CHECK_UPDATES=1 to enable npm-registry version probe',
      };
    }
    let published: string;
    try {
      published = await npmViewVersion();
    } catch (err) {
      const message = err instanceof NpmViewError ? `${err.code}: ${err.message}` : (err as Error).message;
      return {
        status: 'red',
        detail: `npm view failed: ${message}`,
        remediation:
          'Check internet connectivity / corporate proxy. Re-run `coodra doctor --full` once the registry is reachable.',
      };
    }
    if (!semver.valid(published) || !semver.valid(VERSION)) {
      return {
        status: 'red',
        detail: `version sentinels invalid (installed=${VERSION}, published=${published})`,
      };
    }
    if (semver.gt(published, VERSION)) {
      return {
        status: 'yellow',
        detail: `installed ${VERSION}, latest ${published}`,
        remediation: `Run \`npm i -g @coodra/cli@${published}\` then \`coodra upgrade\` to apply migrations + restart daemons.`,
      };
    }
    return { status: 'green', detail: `installed ${VERSION} matches latest published` };
  },
};
