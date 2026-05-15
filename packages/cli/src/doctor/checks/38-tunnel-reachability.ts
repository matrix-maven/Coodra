import type { Check } from '../types.js';

/**
 * W4 (2026-05-13) — when `COODRA_PUBLIC_URL` is set (the admin ran
 * `coodra start --tunnel` and a Cloudflare quick-tunnel banner was
 * written to `~/.coodra/.env`), verify the URL is publicly
 * reachable by fetching `/api/healthz`.
 *
 * Why it matters: quick-tunnels expire on `coodra stop` and on
 * cloudflared crashes. A stale COODRA_PUBLIC_URL silently makes
 * every minted invite URL 404 the moment a teammate clicks it. This
 * check turns that silent failure into a YELLOW signal pointing at
 * `coodra stop && coodra start --tunnel` as the recovery.
 *
 * SKIPPED when:
 *   - COODRA_PUBLIC_URL is unset (no tunnel intended).
 *   - URL starts with `http://localhost` or `http://127.0.0.1` (the
 *     non-tunnel default; reachability of the local server is already
 *     covered by checks 10/11/37).
 */
export const tunnelReachabilityCheck: Check = {
  id: 38,
  name: 'Cloudflare tunnel URL reachable (COODRA_PUBLIC_URL)',
  severity: 'red',
  async run(ctx) {
    const url = ctx.env.COODRA_PUBLIC_URL;
    if (typeof url !== 'string' || url.length === 0) {
      return { status: 'skipped' as const, detail: 'COODRA_PUBLIC_URL not set (no tunnel intended).' };
    }
    if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
      return {
        status: 'skipped' as const,
        detail: `COODRA_PUBLIC_URL is local (${url}); tunnel reachability check applies only to public hostnames.`,
      };
    }
    const probeUrl = `${url.replace(/\/$/, '')}/api/healthz`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(ctx.timeoutMs - 200, 500));
    try {
      const response = await fetch(probeUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) {
        return { status: 'green' as const, detail: `Tunnel 200 OK at ${probeUrl}` };
      }
      return {
        status: 'yellow' as const,
        detail: `Tunnel returned ${response.status} at ${probeUrl}`,
        remediation:
          'The local web is up but the tunnel is degraded. Re-run `coodra stop && coodra start --tunnel` to rotate the quick-tunnel.',
      };
    } catch (err) {
      clearTimeout(timer);
      return {
        status: 'red' as const,
        detail: `TUNNEL_UNREACHABLE: ${probeUrl} — ${(err as Error).message}`,
        remediation:
          'The Cloudflare quick-tunnel has likely expired (they only live for the lifetime of the cloudflared process). ' +
          'Run `coodra stop && coodra start --tunnel` to rotate, OR unset COODRA_PUBLIC_URL if you no longer need cross-machine reachability.',
      };
    }
  },
};
