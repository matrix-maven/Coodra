import { setTimeout as delay } from 'node:timers/promises';

/**
 * `packages/cli/src/lib/daemon-identity` — who is actually on the port.
 *
 * ## The bug this exists to close
 *
 * Every daemon operation on macOS was scoped to the launchd LABEL:
 * `stop()` is `launchctl bootout gui/<uid>/com.coodra.<name>`,
 * `uninstall()` is that plus unlinking the plist, and `status()` maps
 * any non-zero `launchctl print` to `state: 'stopped'` — conflating
 * "label not loaded" with "no process running".
 *
 * Once a process loses its label association (a bootout that unloaded
 * the label while the process survived and reparented to launchd), it
 * becomes invisible to all three while still holding the port. Every
 * later command then reported success against a label that no longer
 * named anything:
 *
 *   - `coodra stop`      — booted out a label naming nothing. "Stopped."
 *   - `coodra uninstall`  — same stop, then removed the plist, leaving
 *                           the process running. "Complete."
 *   - `coodra start`      — bootstrapped a unit that died of EADDRINUSE,
 *                           while `waitForHealth` saw the ORPHAN's 200
 *                           and printed "listening on :3100".
 *
 * Observed in the field: an orphan from 2026-08-08 held :3100 for
 * eleven days across many stop/uninstall/start cycles, with 105832
 * consecutive EADDRINUSE lines in the daemon log and a green CLI
 * throughout. The memory rollup worker — which only runs on the HTTP
 * transport — therefore never ran once.
 *
 * ## The fix
 *
 * Liveness is a question about a PROCESS, so it has to be asked of the
 * process. `/healthz` now answers with `{ service, pid, bootId, home }`
 * and this module turns that into the two questions the commands
 * actually need:
 *
 *   - `start`: is the daemon answering now a DIFFERENT process from the
 *     one that was answering before I started? `bootId` answers that
 *     without correlating against launchd, and unlike a pid it cannot
 *     be recycled into a false match.
 *   - `stop` / `uninstall`: did the port actually get released, and if
 *     not, is the holder one of ours to reap?
 *
 * ## What may be killed
 *
 * Only a process that self-identifies as a Coodra daemon. A `foreign`
 * listener — anything that answers without our envelope — is reported
 * and never touched: the port is a convention, not a claim of
 * ownership, and killing whatever happens to hold 3100 is not a repair.
 */

/** A listener that answered with a Coodra daemon envelope. */
export interface CoodraDaemonIdentity {
  readonly kind: 'coodra';
  readonly service: string;
  readonly pid: number;
  readonly bootId: string;
  readonly home: string | null;
}

/** Something is listening, but it is not a Coodra daemon. */
export interface ForeignListener {
  readonly kind: 'foreign';
  readonly detail: string;
}

/** Nothing answered — connection refused, timeout, or no listener. */
export interface NoListener {
  readonly kind: 'none';
}

export type PortOccupant = CoodraDaemonIdentity | ForeignListener | NoListener;

export interface ProbeOptions {
  readonly url: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

function parseIdentity(body: unknown): CoodraDaemonIdentity | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.service !== 'string' || b.service.length === 0) return null;
  if (typeof b.bootId !== 'string' || b.bootId.length === 0) return null;
  if (typeof b.pid !== 'number' || !Number.isFinite(b.pid)) return null;
  return {
    kind: 'coodra',
    service: b.service,
    pid: b.pid,
    bootId: b.bootId,
    home: typeof b.home === 'string' ? b.home : null,
  };
}

/**
 * Ask the port who it is. Never throws — an unreachable port is an
 * answer ("nothing there"), not an error.
 *
 * A 200 that does not carry our envelope is `foreign` rather than
 * `none`, and that distinction is the point: the pre-fix `/health` 404
 * and a bare `ok` were both indistinguishable from a healthy daemon to
 * a caller that only looked at reachability.
 */
export async function probePortOccupant(options: ProbeOptions): Promise<PortOccupant> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(options.url, { signal: controller.signal });
    if (!response.ok) {
      return { kind: 'foreign', detail: `responded ${response.status}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: 'foreign', detail: 'responded 200 with a non-JSON body' };
    }
    const identity = parseIdentity(body);
    return identity ?? { kind: 'foreign', detail: 'responded 200 without a Coodra daemon identity' };
  } catch {
    return { kind: 'none' };
  } finally {
    clearTimeout(timer);
  }
}

export interface WaitForOwnDaemonOptions extends ProbeOptions {
  /**
   * Identity seen on this port BEFORE the start was issued, if any.
   * A daemon still reporting this `bootId` is the one that was already
   * there — proof the start did not take effect, not proof of health.
   */
  readonly previousBootId?: string | null;
  readonly timeoutMs?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

export type WaitForOwnDaemonResult =
  | { readonly ok: true; readonly identity: CoodraDaemonIdentity }
  /** A daemon is serving, but it is the one that was already running. */
  | { readonly ok: false; readonly reason: 'stale_owner'; readonly identity: CoodraDaemonIdentity }
  | { readonly ok: false; readonly reason: 'foreign_listener'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'timeout' };

/**
 * Poll until a Coodra daemon that is NOT the previous occupant answers.
 *
 * Replaces the "any 2xx means my daemon started" gate. The distinction
 * costs one extra field on the wire and turns the eleven-day silent
 * failure above into an error message on the first run.
 */
export async function waitForOwnDaemon(options: WaitForOwnDaemonOptions): Promise<WaitForOwnDaemonResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBackoff = options.maxBackoffMs ?? 1000;
  let backoff = options.initialBackoffMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  let lastSeen: PortOccupant = { kind: 'none' };
  while (Date.now() < deadline) {
    const occupant = await probePortOccupant(options);
    lastSeen = occupant;
    if (occupant.kind === 'coodra') {
      // A crash-looping unit behind a stale owner keeps answering with
      // the OLD bootId forever. Keep polling rather than returning
      // immediately — the previous daemon may still be shutting down
      // and the replacement may be seconds from binding.
      if (options.previousBootId == null || occupant.bootId !== options.previousBootId) {
        return { ok: true, identity: occupant };
      }
    }
    await delay(backoff);
    backoff = Math.min(backoff * 2, maxBackoff);
  }

  if (lastSeen.kind === 'coodra') return { ok: false, reason: 'stale_owner', identity: lastSeen };
  if (lastSeen.kind === 'foreign') return { ok: false, reason: 'foreign_listener', detail: lastSeen.detail };
  return { ok: false, reason: 'timeout' };
}

export interface ReapOptions extends ProbeOptions {
  /** Only reap a daemon whose `service` matches. */
  readonly service: string;
  /**
   * Only reap a daemon reporting this `COODRA_HOME`. A daemon serving a
   * different home belongs to another installation on the same machine
   * — the scratch-home smoke case `daemon/index.ts` already warns about
   * — and stopping THIS home must not take it down.
   *
   * `null` disables the check (the daemon reported no home).
   */
  readonly home?: string | null;
  readonly killImpl?: (pid: number, signal: NodeJS.Signals) => void;
  readonly graceMs?: number;
}

export type ReapResult =
  | { readonly outcome: 'nothing_listening' }
  | { readonly outcome: 'reaped'; readonly pid: number; readonly escalated: boolean }
  | { readonly outcome: 'survived'; readonly pid: number }
  /** Held by a daemon from another install, or by something not ours. */
  | { readonly outcome: 'not_ours'; readonly detail: string };

/**
 * Release the port by terminating the Coodra daemon holding it.
 *
 * Called by `stop` and `uninstall` AFTER the supervisor has been asked
 * to tear the unit down, because the supervisor is the correct path and
 * usually works. This is the backstop for the case the launchd label no
 * longer names the process — where, without it, the command reports
 * success over a daemon that is still running and still holding the
 * port for the next `start` to fail against.
 *
 * SIGTERM first so the daemon runs its shutdown (the rollup worker and
 * stale-runs sweeper both await in-flight passes before the DB closes),
 * SIGKILL only if it is still answering after the grace period.
 */
export async function reapPortOwner(options: ReapOptions): Promise<ReapResult> {
  const kill = options.killImpl ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const graceMs = options.graceMs ?? 3000;

  const occupant = await probePortOccupant(options);
  if (occupant.kind === 'none') return { outcome: 'nothing_listening' };
  if (occupant.kind === 'foreign') return { outcome: 'not_ours', detail: occupant.detail };
  if (occupant.service !== options.service) {
    return { outcome: 'not_ours', detail: `port held by Coodra '${occupant.service}', not '${options.service}'` };
  }
  if (options.home != null && occupant.home != null && occupant.home !== options.home) {
    return { outcome: 'not_ours', detail: `port held by a daemon serving ${occupant.home}` };
  }

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGKILL'];
  for (const [attempt, signal] of signals.entries()) {
    try {
      kill(occupant.pid, signal);
    } catch (err) {
      // ESRCH — already gone between the probe and the kill. That is a
      // success, not a failure.
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        return { outcome: 'reaped', pid: occupant.pid, escalated: attempt > 0 };
      }
      throw err;
    }

    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      await delay(100);
      const after = await probePortOccupant(options);
      if (after.kind === 'none' || (after.kind === 'coodra' && after.bootId !== occupant.bootId)) {
        return { outcome: 'reaped', pid: occupant.pid, escalated: attempt > 0 };
      }
    }
  }

  return { outcome: 'survived', pid: occupant.pid };
}
