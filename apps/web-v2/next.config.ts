import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@coodra/contextos-db', '@coodra/contextos-shared'],
  serverExternalPackages: ['better-sqlite3'],
  typedRoutes: false,
};

export default nextConfig;
