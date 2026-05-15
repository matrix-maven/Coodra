import { type CookieOptions, createServerClient } from '@supabase/ssr';
import type { cookies } from 'next/headers';

/**
 * Server-side Supabase client per the user-preferred boilerplate
 * (see ~/.claude/.../memory/supabase-project.md). Used for any server
 * component / route handler that talks to Supabase Auth or queries
 * the public schema directly.
 *
 * In Coodra team mode the M04 storage adapter (lib/db.ts) goes
 * through Drizzle for application reads against `DATABASE_URL`, NOT
 * through this client. This client is reserved for Supabase-specific
 * surfaces (e.g. realtime channels in a future slice; managed auth
 * sessions when we move off Clerk).
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const createClient = (cookieStore: Awaited<ReturnType<typeof cookies>>) => {
  if (supabaseUrl === undefined || supabaseKey === undefined) {
    throw new Error('Supabase env missing: NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY required.');
  }
  return createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options: CookieOptions }>) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // setAll called from a Server Component — ignored when middleware refreshes sessions.
        }
      },
    },
  });
};
