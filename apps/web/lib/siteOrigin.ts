const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

export const getCanonicalSiteOrigin = (): string => {
  const envOrigin =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim() || "";

  if (envOrigin) {
    return trimTrailingSlash(envOrigin);
  }

  return "";
};
