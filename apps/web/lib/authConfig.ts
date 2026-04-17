type AuthConfigStatus = {
  configured: boolean;
  missing: string[];
};

const readAuthConfig = (): AuthConfigStatus => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  const key = publishable || anon;
  const missing: string[] = [];

  if (!url) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!key) {
    missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  return {
    configured: missing.length === 0,
    missing,
  };
};

let warned = false;

export const getAuthConfigStatus = (): AuthConfigStatus => {
  const status = readAuthConfig();
  if (!status.configured && !warned && process.env.NODE_ENV === "production") {
    warned = true;
    console.warn(
      "Supabase auth is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY before deploying."
    );
  }
  return status;
};

export const isSupabaseAuthConfigured = (): boolean => getAuthConfigStatus().configured;
