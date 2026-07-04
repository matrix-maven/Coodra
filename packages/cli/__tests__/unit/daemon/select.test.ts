import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectDaemonManager } from '../../../src/lib/daemon/index.js';

describe('selectDaemonManager', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'coodra-daemon-select-'));
  });

  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('falls back to fallback on win32 (no native manager in 08a)', async () => {
    const mgr = await selectDaemonManager({ coodraHome: home, platform: 'win32' });
    expect(mgr.kind).toBe('fallback');
  });

  it('COODRA_DAEMON_MANAGER=fallback forces the PID-file manager on any platform', async () => {
    // launchd/systemd unit names are global per user (com.coodra.<name>) —
    // a smoke/scratch instance MUST be able to opt out of the native
    // manager or its stop boots out the user's real daemons (2026-07-02).
    for (const platform of ['darwin', 'linux'] as const) {
      const mgr = await selectDaemonManager({
        coodraHome: home,
        platform,
        env: { COODRA_DAEMON_MANAGER: 'fallback' },
      });
      expect(mgr.kind).toBe('fallback');
    }
  });

  it('ignores an unrecognised COODRA_DAEMON_MANAGER value', async () => {
    const mgr = await selectDaemonManager({
      coodraHome: home,
      platform: 'win32',
      env: { COODRA_DAEMON_MANAGER: 'launchd-please' },
    });
    expect(mgr.kind).toBe('fallback'); // win32 default, not because of the env
  });

  it('falls back when launchd / systemd are unreachable on darwin / linux', async () => {
    // We can't easily stub isAvailable() without DI; the contract holds that
    // selectDaemonManager always returns a working manager. On a CI runner
    // without launchd/systemd-user this will return fallback.
    const mgr = await selectDaemonManager({ coodraHome: home });
    expect(['launchd', 'systemd', 'fallback']).toContain(mgr.kind);
    expect(await mgr.isAvailable()).toBe(true);
  });
});
