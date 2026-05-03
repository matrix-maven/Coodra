import type { NextConfig } from 'next';

/**
 * `apps/web/next.config.ts` — Next.js 15 App Router config.
 *
 * Per M04 spec.md §7 (storage adapter, OQ-1) every M04 route runs on
 * the Node.js runtime — `better-sqlite3` is a native module and cannot
 * load on Vercel's edge runtime. We do NOT set a global `runtime` here;
 * App Router defaults to Node.js per route, and any future edge-runtime
 * route must explicitly opt out via `export const runtime = 'edge'`
 * (which would also need to drop the storage adapter import).
 *
 * `transpilePackages` is required because `@coodra/contextos-db` ships
 * un-built TS source via the workspace protocol (other workspace consumers
 * import from compiled `dist/`). Next.js compiles the imported sources on
 * demand instead of asking for a separate build step here.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@coodra/contextos-db', '@coodra/contextos-shared'],
  serverExternalPackages: ['better-sqlite3'],
  typedRoutes: true,
};

export default nextConfig;
