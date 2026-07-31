import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Check } from '../types.js';

const MIN_HEX_LENGTH = 32;
const RUNTIME_ENV_KEYS = ['LOCAL_HOOK_SECRET', 'MCP_SERVER_PORT', 'HOOKS_BRIDGE_PORT'] as const;
type MissingRuntimeEnv = (typeof RUNTIME_ENV_KEYS)[number] | 'LOCAL_HOOK_SECRET length';

export const localHookSecretCheck: Check = {
  id: 20,
  name: 'Machine runtime env present (~/.coodra/.env)',
  severity: 'yellow',
  async run(ctx) {
    const fromEnv = ctx.env.LOCAL_HOOK_SECRET;
    if (typeof fromEnv === 'string' && fromEnv.length >= MIN_HEX_LENGTH) {
      // Never log the secret itself — only its length and source.
      return { status: 'green', detail: `LOCAL_HOOK_SECRET set via env (length=${fromEnv.length})` };
    }
    const envPath = join(ctx.coodraHome, '.env');
    try {
      const raw = await readFile(envPath, 'utf8');
      const values = new Map<string, string>();
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2]);
      }
      const missing: MissingRuntimeEnv[] = RUNTIME_ENV_KEYS.filter((key) => {
        const value = values.get(key);
        return value === undefined || value.length === 0;
      });
      const localHookSecret = values.get('LOCAL_HOOK_SECRET');
      if (missing.length === 0 && typeof localHookSecret === 'string' && localHookSecret.length >= MIN_HEX_LENGTH) {
        return {
          status: 'green',
          detail: `machine runtime env present at ${envPath} (LOCAL_HOOK_SECRET length=${localHookSecret.length})`,
        };
      }
      if (
        typeof localHookSecret === 'string' &&
        localHookSecret.length > 0 &&
        localHookSecret.length < MIN_HEX_LENGTH
      ) {
        missing.push('LOCAL_HOOK_SECRET length');
      }
      return {
        status: 'yellow',
        detail: `${envPath} present but missing/invalid: ${missing.join(', ')}`,
        remediation: 'Run `coodra install` to repair the machine runtime env.',
      };
    } catch {
      // env empty AND runtime env file missing → yellow
      return {
        status: 'yellow',
        detail: `machine runtime env file missing at ${envPath}`,
        remediation: 'Run `coodra install` to create ~/.coodra/.env with LOCAL_HOOK_SECRET and service ports.',
      };
    }
  },
};
