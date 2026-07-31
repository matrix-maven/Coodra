import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localHookSecretCheck } from '../../../src/doctor/checks/20-local-hook-secret.js';
import type { CheckContext } from '../../../src/doctor/types.js';

function ctx(coodraHome: string, env: NodeJS.ProcessEnv = {}): CheckContext {
  return {
    cwd: coodraHome,
    coodraHome,
    dataDb: join(coodraHome, 'data.db'),
    env,
    mcpPort: 3100,
    bridgePort: 3101,
    webPort: 3001,
    now: () => new Date('2026-07-31T00:00:00.000Z'),
    timeoutMs: 500,
    platform: 'darwin',
    nodeVersion: '26.0.0',
  };
}

describe('localHookSecretCheck', () => {
  it('reads the machine runtime env file created by coodra install', async () => {
    const home = await mkdtemp(join(tmpdir(), 'coodra-doctor-runtime-env-'));
    await writeFile(
      join(home, '.env'),
      [`LOCAL_HOOK_SECRET=${'a'.repeat(64)}`, 'MCP_SERVER_PORT=3100', 'HOOKS_BRIDGE_PORT=3101'].join('\n'),
      'utf8',
    );

    const result = await localHookSecretCheck.run(ctx(home));

    expect(result.status).toBe('green');
    expect(result.detail).toContain('.env');
  });

  it('warns when the runtime env file is missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'coodra-doctor-runtime-env-'));

    const result = await localHookSecretCheck.run(ctx(home));

    expect(result.status).toBe('yellow');
    expect(result.detail).toContain('machine runtime env file missing');
    expect(result.remediation).toContain('coodra install');
  });

  it('warns when service ports are missing from the runtime env file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'coodra-doctor-runtime-env-'));
    await mkdir(home, { recursive: true });
    await writeFile(join(home, '.env'), `LOCAL_HOOK_SECRET=${'a'.repeat(64)}\n`, 'utf8');

    const result = await localHookSecretCheck.run(ctx(home));

    expect(result.status).toBe('yellow');
    expect(result.detail).toContain('MCP_SERVER_PORT');
    expect(result.detail).toContain('HOOKS_BRIDGE_PORT');
  });
});
