import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * web-v2 — solo-mode-first middleware. Auth in v2 follows the same
 * envelope as the original web app, but the v2 shell is intentionally
 * scoped to read-only solo-mode browsing for the design-system pass.
 * Team-mode auth is reintroduced in a follow-up.
 */
export function middleware(_req: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js)).*)'],
};
