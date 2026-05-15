import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { platform } from 'node:os';
import { URL } from 'node:url';

/**
 * `packages/cli/src/lib/browser-handoff.ts` — generic OAuth-Device-Auth-
 * style browser handoff helper for Phase G commands (`login`, `logout`,
 * `team join`, `org switch`).
 *
 * Flow:
 *
 *   1. Caller calls `startLoopbackListener({ expectedState, timeoutMs })`.
 *      The helper picks a random port in [PORT_MIN..PORT_MAX], starts
 *      an HTTP server bound to 127.0.0.1, and returns:
 *        - `port`: the bound port
 *        - `tokenPromise`: resolves with the captured token, or rejects
 *           on timeout / state mismatch / shutdown
 *        - `close()`: graceful shutdown
 *   2. Caller builds the cli-login URL with the port + state and calls
 *      `openBrowser(url)`. Browser opens, user signs in, web redirects
 *      back to `http://127.0.0.1:<port>/?token=...&state=...`
 *   3. Listener handles the GET, validates state, resolves the promise
 *      with the token, responds with a friendly HTML page, then closes.
 *
 * Port range [50000..65000] is the IANA "dynamic / private" range —
 * avoids collisions with system services + common dev servers.
 *
 * Why a one-shot listener and not a long-running server:
 *   - Security: the listener accepts exactly one request before dying.
 *     An attacker who captures the URL must hit it within ~milliseconds
 *     of legitimate use, which they can't reliably do.
 *   - Resource: no orphan listeners after a `coodra login` flow.
 *   - State: state token is single-use both server-side (in cli-login-
 *     state.ts) AND here (the listener dies after one good request).
 */

const PORT_MIN = 50000;
const PORT_MAX = 65000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const PORT_PICK_ATTEMPTS = 8;

export class BrowserHandoffError extends Error {
  readonly code: 'timeout' | 'state_mismatch' | 'no_token' | 'malformed_request' | 'shutdown';
  constructor(code: BrowserHandoffError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'BrowserHandoffError';
  }
}

export interface LoopbackListener {
  /** The bound TCP port. Use in the cli-login URL. */
  readonly port: number;
  /**
   * Resolves with the captured token on successful handoff, or rejects
   * with `BrowserHandoffError` on timeout / mismatch / shutdown.
   */
  readonly tokenPromise: Promise<string>;
  /**
   * Force-close the listener. Safe to call before tokenPromise settles —
   * tokenPromise will reject with `shutdown` if it hasn't already.
   */
  readonly close: () => void;
}

export interface StartListenerOptions {
  /** Expected state token. Listener rejects requests with mismatched state. */
  readonly expectedState: string;
  /** Listener gives up after this many ms. Default 5 minutes. */
  readonly timeoutMs?: number;
  /** Override the host. Default '127.0.0.1' (always loopback). */
  readonly host?: string;
}

/**
 * Pick a random port within [PORT_MIN..PORT_MAX]. Inclusive range.
 */
function pickPort(): number {
  return Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1)) + PORT_MIN;
}

/**
 * Try to start an HTTP server on a random port up to PORT_PICK_ATTEMPTS
 * times. Returns the running server + bound port. Throws after all
 * attempts fail (typically only on broken systems with no free ports).
 */
async function listenOnRandomPort(
  host: string,
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; port: number }> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < PORT_PICK_ATTEMPTS; attempt++) {
    const port = pickPort();
    const server = createServer(handler);
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, host, () => {
          server.off('error', rejectListen);
          resolveListen();
        });
      });
      return { server, port };
    } catch (err) {
      lastErr = err as Error;
      // EADDRINUSE → try another port
      server.close();
    }
  }
  throw new BrowserHandoffError(
    'no_token',
    `Could not bind any port in ${PORT_MIN}..${PORT_MAX} after ${PORT_PICK_ATTEMPTS} attempts. Last error: ${lastErr?.message ?? 'unknown'}`,
  );
}

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Coodra — Signed in</title>
<style>
  body { font-family: ui-monospace, monospace; background: #0a0a0a; color: #e0e0e0; padding: 60px 24px; max-width: 540px; margin: 0 auto; }
  h1 { color: #f4d35e; font-size: 22px; margin: 0 0 16px; }
  p { line-height: 1.65; color: #c0c0c0; margin: 0 0 16px; }
  code { background: #1a1a1a; padding: 2px 6px; border-radius: 2px; color: #f4d35e; }
</style></head><body>
<h1>✓ Signed in</h1>
<p>Your terminal has your auth token. You can close this tab.</p>
<p>If something looks wrong, run <code>coodra logout</code> in your terminal and try again.</p>
</body></html>`;

const ERROR_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Coodra — Sign-in failed</title>
<style>
  body { font-family: ui-monospace, monospace; background: #0a0a0a; color: #e0e0e0; padding: 60px 24px; max-width: 540px; margin: 0 auto; }
  h1 { color: #ff6b6b; font-size: 22px; margin: 0 0 16px; }
  p { line-height: 1.65; color: #c0c0c0; }
  code { background: #1a1a1a; padding: 2px 6px; border-radius: 2px; color: #f4d35e; }
</style></head><body>
<h1>✗ Sign-in failed</h1>
<p>The redirect did not match the expected state. Return to your terminal and run <code>coodra login</code> again.</p>
</body></html>`;

/**
 * Start the loopback listener and return the port + token promise.
 *
 * The listener:
 *   - accepts GET on any path (browser may redirect with /? or /)
 *   - extracts `token` and `state` query parameters
 *   - if `state` doesn't match `expectedState`, responds 400 + rejects
 *   - if `token` is missing or empty, responds 400 + rejects
 *   - otherwise responds 200 (HTML) + resolves
 *   - closes itself after responding
 *
 * Timeout: if no valid request arrives within `timeoutMs`, the promise
 * rejects with `BrowserHandoffError('timeout', ...)` and the server is
 * closed.
 */
export async function startLoopbackListener(opts: StartListenerOptions): Promise<LoopbackListener> {
  const expectedState = opts.expectedState;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const host = opts.host ?? '127.0.0.1';

  let resolveToken: ((token: string) => void) | null = null;
  let rejectToken: ((err: Error) => void) | null = null;
  const tokenPromise = new Promise<string>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  // Settle the promise at most once; subsequent calls no-op.
  let settled = false;
  const settleResolve = (token: string): void => {
    if (settled) return;
    settled = true;
    resolveToken?.(token);
  };
  const settleReject = (err: Error): void => {
    if (settled) return;
    settled = true;
    rejectToken?.(err);
  };

  const { server, port } = await listenOnRandomPort(host, (req, res) => {
    try {
      // Construct URL safely — req.url is "/?token=..." or "/"
      const requestUrl = new URL(req.url ?? '/', `http://${host}:${port}`);
      const token = requestUrl.searchParams.get('token');
      const state = requestUrl.searchParams.get('state');

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(ERROR_HTML);
        settleReject(
          new BrowserHandoffError(
            'state_mismatch',
            `state mismatch — expected ${expectedState}, got ${state ?? '(missing)'}`,
          ),
        );
        return;
      }
      if (token === null || token.length === 0) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(ERROR_HTML);
        settleReject(new BrowserHandoffError('no_token', 'no token in callback URL'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SUCCESS_HTML);
      settleResolve(token);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ERROR_HTML);
      settleReject(new BrowserHandoffError('malformed_request', (err as Error).message));
    }
  });

  // Close the server once the promise settles (either way).
  const closeServer = (): void => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  };

  // Timeout watchdog
  const timer = setTimeout(() => {
    settleReject(
      new BrowserHandoffError(
        'timeout',
        `browser handoff timed out after ${Math.round(timeoutMs / 1000)}s. The browser tab may have been closed before auth completed.`,
      ),
    );
    closeServer();
  }, timeoutMs);

  // Always release the timer when the promise settles
  void tokenPromise.finally(() => {
    clearTimeout(timer);
    closeServer();
  });

  return {
    port,
    tokenPromise,
    close: () => {
      settleReject(new BrowserHandoffError('shutdown', 'listener closed by caller'));
      clearTimeout(timer);
      closeServer();
    },
  };
}

/**
 * Open the given URL in the user's default browser via the platform-
 * native helper. Returns whether the spawn succeeded; the caller should
 * fall back to printing the URL if this returns false.
 *
 * The function does NOT wait for the browser to exit — that would block
 * forever. We fire-and-forget and let the OS handle the rest.
 */
export function openBrowser(url: string): boolean {
  const p = platform();
  let cmd: string;
  let args: readonly string[];
  if (p === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (p === 'win32') {
    // start "" "URL" — the empty title prevents `start` from
    // misinterpreting the URL as the window title.
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    // linux + bsd + others
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
