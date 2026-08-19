import { describe, expect, it, vi } from 'vitest';

import { probePortOccupant, reapPortOwner, waitForOwnDaemon } from '../../../src/lib/daemon-identity.js';

/**
 * The daemon-ownership bug: every macOS daemon operation was scoped to
 * the launchd LABEL, so a process that lost its label association was
 * invisible to `bootout` while still holding its port. `stop`,
 * `uninstall` and `start` all reported success over it for eleven days
 * while every launchd retry died of EADDRINUSE.
 *
 * These tests are written against that scenario specifically: a
 * listener answering 200 that is NOT the process the command launched.
 */

const URL_ = 'http://127.0.0.1:3100/healthz';

function identityResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function respondWith(body: unknown, status = 200) {
  return vi.fn(async () => identityResponse(body, status)) as unknown as typeof fetch;
}

const DAEMON = { ok: true, service: 'mcp-server', pid: 10564, bootId: 'boot-a', home: '/home/.coodra' };

describe('probePortOccupant', () => {
  it('reads a Coodra daemon identity', async () => {
    const occupant = await probePortOccupant({ url: URL_, fetchImpl: respondWith(DAEMON) });
    expect(occupant).toEqual({
      kind: 'coodra',
      service: 'mcp-server',
      pid: 10564,
      bootId: 'boot-a',
      home: '/home/.coodra',
    });
  });

  it('reports nothing listening when the connection fails', async () => {
    const failing = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await probePortOccupant({ url: URL_, fetchImpl: failing })).toEqual({ kind: 'none' });
  });

  it('treats a 200 without our envelope as foreign, not as healthy', async () => {
    // The pre-fix `/healthz` answered a bare `ok`. A caller that only
    // checked reachability could not tell it from a daemon it started.
    const occupant = await probePortOccupant({ url: URL_, fetchImpl: respondWith('ok') });
    expect(occupant.kind).toBe('foreign');
  });

  it('treats a non-2xx responder as foreign, not as absent', async () => {
    // The orphan answered 404 on `/health` — something IS on the port.
    const occupant = await probePortOccupant({ url: URL_, fetchImpl: respondWith({ error: 'not_found' }, 404) });
    expect(occupant.kind).toBe('foreign');
  });

  it('rejects a partial envelope rather than half-trusting it', async () => {
    const occupant = await probePortOccupant({
      url: URL_,
      fetchImpl: respondWith({ ok: true, service: 'mcp-server' }),
    });
    expect(occupant.kind).toBe('foreign');
  });
});

describe('waitForOwnDaemon', () => {
  it('accepts a daemon on a free port', async () => {
    const result = await waitForOwnDaemon({ url: URL_, fetchImpl: respondWith(DAEMON), previousBootId: null });
    expect(result.ok).toBe(true);
  });

  it('accepts a replacement whose bootId differs from the previous owner', async () => {
    const replacement = { ...DAEMON, pid: 99, bootId: 'boot-b' };
    const result = await waitForOwnDaemon({
      url: URL_,
      fetchImpl: respondWith(replacement),
      previousBootId: 'boot-a',
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.identity.pid).toBe(99);
  });

  it('refuses the stale owner — the false green that hid the bug', async () => {
    // The exact production scenario: the orphan keeps answering 200
    // with its own identity while the daemon we launched dies of
    // EADDRINUSE. Before the fix this printed "listening on :3100".
    const result = await waitForOwnDaemon({
      url: URL_,
      fetchImpl: respondWith(DAEMON),
      previousBootId: 'boot-a',
      timeoutMs: 300,
      initialBackoffMs: 50,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('stale_owner');
    expect(result.ok === false && result.reason === 'stale_owner' && result.identity.pid).toBe(10564);
  });

  it('reports a foreign listener distinctly from a timeout', async () => {
    const result = await waitForOwnDaemon({
      url: URL_,
      fetchImpl: respondWith('ok'),
      timeoutMs: 300,
      initialBackoffMs: 50,
    });
    expect(result.ok === false && result.reason).toBe('foreign_listener');
  });

  it('times out when nothing ever answers', async () => {
    const failing = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await waitForOwnDaemon({
      url: URL_,
      fetchImpl: failing,
      timeoutMs: 300,
      initialBackoffMs: 50,
    });
    expect(result.ok === false && result.reason).toBe('timeout');
  });
});

describe('reapPortOwner', () => {
  /** Answers as the daemon until `killed` flips, then as an empty port. */
  function reapableDaemon(state: { killed: boolean }, body = DAEMON) {
    return vi.fn(async () => {
      if (state.killed) throw new Error('ECONNREFUSED');
      return identityResponse(body);
    }) as unknown as typeof fetch;
  }

  it('does nothing when the port is already free', async () => {
    const failing = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await reapPortOwner({ url: URL_, service: 'mcp-server', fetchImpl: failing });
    expect(result.outcome).toBe('nothing_listening');
  });

  it('SIGTERMs the orphan and confirms the port was released', async () => {
    const state = { killed: false };
    const kill = vi.fn((_pid: number, _signal: NodeJS.Signals) => {
      state.killed = true;
    });
    const result = await reapPortOwner({
      url: URL_,
      service: 'mcp-server',
      fetchImpl: reapableDaemon(state),
      killImpl: kill,
      graceMs: 500,
    });
    expect(result).toEqual({ outcome: 'reaped', pid: 10564, escalated: false });
    expect(kill).toHaveBeenCalledExactlyOnceWith(10564, 'SIGTERM');
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const state = { killed: false };
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === 'SIGKILL') state.killed = true;
    });
    const result = await reapPortOwner({
      url: URL_,
      service: 'mcp-server',
      fetchImpl: reapableDaemon(state),
      killImpl: kill,
      graceMs: 300,
    });
    expect(result).toEqual({ outcome: 'reaped', pid: 10564, escalated: true });
    expect(kill.mock.calls.map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports survival rather than claiming success', async () => {
    const kill = vi.fn();
    const result = await reapPortOwner({
      url: URL_,
      service: 'mcp-server',
      fetchImpl: reapableDaemon({ killed: false }),
      killImpl: kill,
      graceMs: 200,
    });
    expect(result).toEqual({ outcome: 'survived', pid: 10564 });
  });

  it('never kills a foreign listener', async () => {
    const kill = vi.fn();
    const result = await reapPortOwner({
      url: URL_,
      service: 'mcp-server',
      fetchImpl: respondWith('ok'),
      killImpl: kill,
    });
    expect(result.outcome).toBe('not_ours');
    expect(kill).not.toHaveBeenCalled();
  });

  it('never kills a different Coodra service that happens to answer', async () => {
    const kill = vi.fn();
    const result = await reapPortOwner({
      url: URL_,
      service: 'mcp-server',
      fetchImpl: respondWith({ ...DAEMON, service: 'web' }),
      killImpl: kill,
    });
    expect(result.outcome).toBe('not_ours');
    expect(kill).not.toHaveBeenCalled();
  });

  it('never kills a daemon serving a different COODRA_HOME', async () => {
    // launchd labels are global per user but COODRA_HOME is not, so a
    // scratch-home smoke run shares this port namespace. Stopping THIS
    // home must not take down the other installation.
    const kill = vi.fn();
    const result = await reapPortOwner({
      url: URL_,
      service: 'mcp-server',
      home: '/home/.coodra',
      fetchImpl: respondWith({ ...DAEMON, home: '/scratch/.coodra' }),
      killImpl: kill,
    });
    expect(result.outcome).toBe('not_ours');
    expect(result.outcome === 'not_ours' && result.detail).toContain('/scratch/.coodra');
    expect(kill).not.toHaveBeenCalled();
  });

  it('treats a process that vanished between probe and kill as reaped', async () => {
    const kill = vi.fn(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    const result = await reapPortOwner({
      url: URL_,
      service: 'mcp-server',
      fetchImpl: respondWith(DAEMON),
      killImpl: kill,
      graceMs: 100,
    });
    expect(result).toEqual({ outcome: 'reaped', pid: 10564, escalated: false });
  });
});
