import { execa } from 'execa';
import type { Check } from '../types.js';

export const pnpmPathCheck: Check = {
  id: 19,
  name: 'pnpm reachable on PATH',
  severity: 'green-or-yellow',
  async run(ctx) {
    try {
      const result = await execa('pnpm', ['--version'], {
        timeout: Math.min(ctx.timeoutMs - 200, 1500),
        reject: false,
      });
      if (result.exitCode === 0) {
        return { status: 'green', detail: `pnpm ${String(result.stdout).trim()} on PATH` };
      }
      return {
        status: 'yellow',
        detail: `pnpm exited ${result.exitCode}`,
        remediation: 'Reinstall pnpm with `corepack enable && corepack prepare pnpm@latest`.',
      };
    } catch (err) {
      return {
        status: 'yellow',
        detail: `pnpm not reachable: ${(err as Error).message}`,
        remediation: 'Only required when running Coodra from the dev monorepo. End users do not need pnpm.',
      };
    }
  },
};
