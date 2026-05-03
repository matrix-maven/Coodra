import { NextResponse } from 'next/server';

/**
 * `/api/healthz` — uptime probe. No auth, no DB read. Mirrors the
 * pattern used by `apps/hooks-bridge/src/app.ts:101-108` and
 * `apps/mcp-server/src/transport/http.ts`.
 *
 * Used by:
 *   - Process supervisors (Vercel / Railway / Fly.io) for health checks
 *   - `contextos doctor` (M08b S18 check 11 already polls bridge :3101;
 *     this is the equivalent for the web on :3000 — future doctor
 *     extension can probe it)
 *   - Any monitoring tool that wants to know the web is responding
 */
export function GET() {
  return NextResponse.json({
    ok: true,
    service: 'contextos-web',
    mode: process.env.CONTEXTOS_MODE ?? 'solo',
    serverStartedAt: new Date().toISOString(),
  });
}
