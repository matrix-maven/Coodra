import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeHealthz } from '../../../src/doctor/checks/10-mcp-healthz.js';

/**
 * Locks the post-08a-cleanup PID-aware severity refinement: doctor
 * checks 10/11 distinguish "process crashed" (RED) from "never started"
 * (YELLOW) by reading `<coodra-home>/pids/<unitName>.pid`.
 *
 * The probe target is a local port that's guaranteed unbound (we use a
 * high random port nobody listens on). fetch fails ECONNREFUSED, then
 * the probe consults the PID file to choose severity.
 */
describe('probeHealthz — PID-aware severity', () => {
  let home: string;
  // A port that's almost certainly free. If a local process happens to
  // bind it during the run, the test would surface as a false GREEN —
  // unlikely enough not to flake.
  const UNBOUND_PORT = 53999;
  const URL = `http://127.0.0.1:${UNBOUND_PORT}/healthz`;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'coodra-healthz-pid-'));
    await mkdir(join(home, 'pids'), { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('YELLOW with `Run coodra start` remediation when no PID file (never started)', async () => {
    const result = await probeHealthz({
      url: URL,
      timeoutMs: 1000,
      label: 'Hooks Bridge',
      coodraHome: home,
      unitName: 'hooks-bridge',
    });
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/ECONNREFUSED|probe failed/);
    expect(result.remediation).toMatch(/coodra start/);
  });

  it('RED with crash-recovery remediation when PID file exists but PID is dead', async () => {
    // PID 1 is init/launchd — we don't have permission to signal it
    // (would return EPERM, which our isProcessAlive treats as "alive").
    // Use a PID we know is dead: spawn-and-exit a child, capture its
    // PID, wait for exit, then write that PID to the file. Crucially,
    // the OS may reuse the PID later — but for the test's lifetime
    // (a few ms) the chance of collision is negligible.
    const { spawn } = await import('node:child_process');
    const child = spawn('node', ['-e', 'process.exit(0)']);
    const deadPid = child.pid;
    expect(deadPid).toBeGreaterThan(0);
    await new Promise((r) => child.on('exit', r));
    // Wait an additional tick so the OS reaps the process — kill(0) on
    // the freshly-reaped PID returns ESRCH ("no such process").
    await new Promise((r) => setTimeout(r, 50));

    await writeFile(join(home, 'pids', 'hooks-bridge.pid'), `${deadPid}\n`, 'utf8');

    const result = await probeHealthz({
      url: URL,
      timeoutMs: 1000,
      label: 'Hooks Bridge',
      coodraHome: home,
      unitName: 'hooks-bridge',
    });
    expect(result.status).toBe('red');
    expect(result.detail).toMatch(new RegExp(`PID file points at PID ${deadPid}.*no longer alive`));
    expect(result.remediation).toMatch(/coodra stop.*coodra start/s);
  });

  it('YELLOW (transient) when PID file exists and PID is alive but probe fails', async () => {
    // The current process is, by definition, alive. Use process.pid as
    // a stand-in for a daemon that started successfully but isn't yet
    // serving healthz (booting / jammed).
    await writeFile(join(home, 'pids', 'hooks-bridge.pid'), `${process.pid}\n`, 'utf8');

    const result = await probeHealthz({
      url: URL,
      timeoutMs: 1000,
      label: 'Hooks Bridge',
      coodraHome: home,
      unitName: 'hooks-bridge',
    });
    // Process is alive but probe fails — yellow with remediation,
    // not red (no crash signal).
    expect(result.status).toBe('yellow');
    expect(result.remediation).toMatch(/coodra start/);
  });
});
