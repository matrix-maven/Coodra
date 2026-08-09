import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '../../../../..');

describe('lifecycle capability wiring — retired bridge parity guard', () => {
  it('keeps active capability logic in the live mcp-server lifecycle path, not only hooks-bridge', async () => {
    const [bridgePreTool, bridgeSessionStart, liveLifecycle, liveCheckPolicy] = await Promise.all([
      readFile(join(repoRoot, 'apps/hooks-bridge/src/handlers/pre-tool-use.ts'), 'utf8'),
      readFile(join(repoRoot, 'apps/hooks-bridge/src/handlers/session-start.ts'), 'utf8'),
      readFile(join(repoRoot, 'apps/mcp-server/src/tools/lifecycle-event/handler.ts'), 'utf8'),
      readFile(join(repoRoot, 'apps/mcp-server/src/tools/check-policy/handler.ts'), 'utf8'),
    ]);

    expect(`${bridgePreTool}\n${bridgeSessionStart}`).toContain('activeCapabilities');
    expect(liveLifecycle).toContain('updateRunActiveCapabilities');
    expect(liveLifecycle).toContain('getRunActiveCapabilities');
    expect(liveCheckPolicy).toContain('activeCapabilities');
  });
});
