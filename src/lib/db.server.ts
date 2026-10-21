import { createClient } from "@supabase/supabase-js";

if (!process.env.VITE_SUPABASE_URL) {
  throw new Error("Missing VITE_SUPABASE_URL environment variable");
}

if (!process.env.EXT_SUPABASE_SERVICE_ROLE) {
  throw new Error("Missing EXT_SUPABASE_SERVICE_ROLE environment variable");
}

export const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.EXT_SUPABASE_SERVICE_ROLE,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);


