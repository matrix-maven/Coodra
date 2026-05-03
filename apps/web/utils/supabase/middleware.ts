import { type CookieOptions, createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Supabase middleware client per the user-preferred boilerplate. Reserved
 * for the future case where Supabase Auth sessions are refreshed via
 * Next.js middleware (M04 ships with Clerk auth; this client is staged
 * for a future migration).
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const createClient = (request: NextRequest) => {
  if (supabaseUrl === undefined || supabaseKey === undefined) {
    throw new Error('Supabase env missing: NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY required.');
  }
  let supabaseResponse = NextResponse.next({ request: { headers: request.headers } });

  createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options: CookieOptions }>) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  return supabaseResponse;
};
