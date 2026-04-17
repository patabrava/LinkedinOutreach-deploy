const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

export const getCanonicalSiteOrigin = (): string => {
  const envOrigin =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim() || "";

  if (envOrigin) {
    return trimTrailingSlash(envOrigin);
  }

  return "";
};

export const resolveAuthRedirectOrigin = (requestOrigin: string): string => {
  const canonicalOrigin = getCanonicalSiteOrigin();
  if (canonicalOrigin) {
    return canonicalOrigin;
  }

  if (process.env.NODE_ENV === "production") {
    return "";
  }

  const trimmedRequestOrigin = trimTrailingSlash(requestOrigin.trim());
  if (trimmedRequestOrigin.includes("localhost:3000")) {
    return trimmedRequestOrigin;
  }

  return "http://localhost:3000";
};
