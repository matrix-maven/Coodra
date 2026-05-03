'use client';

import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser Supabase client per the user-preferred boilerplate
 * (see ~/.claude/.../memory/supabase-project.md).
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const createClient = () => {
  if (supabaseUrl === undefined || supabaseKey === undefined) {
    throw new Error('Supabase env missing: NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY required.');
  }
  return createBrowserClient(supabaseUrl, supabaseKey);
};
