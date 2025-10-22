import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment!');
}

// Default anonymous client for unauthenticated operations.  In a token‑only
// architecture we no longer rely on browser cookies; instead each request
// should include a JWT in the `Authorization` header.  This default client
// may be used for public endpoints where no user token is provided.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ⚠️ Only use this for trusted backend server actions
export const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

/**
 * Create a Supabase client that is scoped to an end‑user JWT.  When the
 * frontend sends requests to this API it should include an `Authorization`
 * header in the form `Bearer <access_token>`.  Pass that token here to
 * authenticate all downstream Supabase calls for the duration of the request.
 *
 * @param {string|undefined|null} accessToken a JWT obtained from Supabase.auth
 * @returns a Supabase client with the user context set, or the anonymous
 *          client if no token was provided
 */
export function getSupabaseClient(accessToken) {
  if (!accessToken) {
    return supabase;
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}
