import { readFile } from 'node:fs/promises';
import { resolveCoodraConfigJson } from '../../lib/coodra-home.js';
import type { Check } from '../types.js';

const MIN_HEX_LENGTH = 32;

export const localHookSecretCheck: Check = {
  id: 20,
  name: 'LOCAL_HOOK_SECRET present (env or ~/.coodra/config.json)',
  severity: 'yellow',
  async run(ctx) {
    const fromEnv = ctx.env.LOCAL_HOOK_SECRET;
    if (typeof fromEnv === 'string' && fromEnv.length >= MIN_HEX_LENGTH) {
      // Never log the secret itself — only its length and source.
      return { status: 'green', detail: `LOCAL_HOOK_SECRET set via env (length=${fromEnv.length})` };
    }
    const configPath = resolveCoodraConfigJson(ctx.coodraHome);
    try {
      const raw = await readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw) as { localHookSecret?: unknown };
      const value = parsed.localHookSecret;
      if (typeof value === 'string' && value.length >= MIN_HEX_LENGTH) {
        return {
          status: 'green',
          detail: `LOCAL_HOOK_SECRET set via ${configPath} (length=${value.length})`,
        };
      }
      return {
        status: 'yellow',
        detail: `${configPath} present but localHookSecret missing or too short`,
        remediation: 'Run `coodra team login` (when team mode opens) or set LOCAL_HOOK_SECRET in env.',
      };
    } catch {
      // env empty AND config.json missing → yellow
      return {
        status: 'yellow',
        detail: 'LOCAL_HOOK_SECRET not set in env and no config.json present',
        remediation:
          'Set LOCAL_HOOK_SECRET in your env (solo mode) or run `coodra team login` (team mode, when GA).',
      };
    }
  },
};
