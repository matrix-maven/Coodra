import type { Check } from '../types.js';
import { probeHealthz } from './10-mcp-healthz.js';

export const bridgeHealthzCheck: Check = {
  id: 11,
  name: 'Hooks Bridge HTTP /healthz reachable',
  severity: 'red',
  async run(ctx) {
    return probeHealthz({
      url: `http://127.0.0.1:${ctx.bridgePort}/healthz`,
      timeoutMs: ctx.timeoutMs - 200,
      label: 'Hooks Bridge',
      coodraHome: ctx.coodraHome,
      unitName: 'hooks-bridge',
    });
  },
};
