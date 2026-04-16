import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
// Prefer modern publishable key; fall back to legacy anon key for compatibility
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const browserKey = publishable || anonKey;

export const isSupabaseBrowserConfigured = (): boolean => Boolean(url && browserKey);

if (!isSupabaseBrowserConfigured()) {
  console.warn(
    "Supabase client not configured. Add NEXT_PUBLIC_SUPABASE_URL and either NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY."
  );
}

let cachedClient: SupabaseClient | null = null;

export const supabaseBrowserClient = (): SupabaseClient | null => {
  if (!isSupabaseBrowserConfigured()) return null;
  if (cachedClient) return cachedClient;
  cachedClient = createClient(url || "", browserKey || "", {
    realtime: {
      params: {
        // Helps keep connections alive on some networks
        eventsPerSecond: 5,
      },
    },
  });
  return cachedClient;
};
