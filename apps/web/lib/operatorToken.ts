const OPERATOR_TOKEN_STORAGE_KEY = "linkedin_outreach_operator_api_token";

export const getOperatorApiToken = (): string => {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(OPERATOR_TOKEN_STORAGE_KEY) || "";
};

export const setOperatorApiToken = (token: string): void => {
  if (typeof window === "undefined") return;
  const trimmed = token.trim();
  if (!trimmed) {
    window.localStorage.removeItem(OPERATOR_TOKEN_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(OPERATOR_TOKEN_STORAGE_KEY, trimmed);
};

export const clearOperatorApiToken = (): void => setOperatorApiToken("");

export const getOperatorApiHeaders = (): HeadersInit => {
  const token = getOperatorApiToken();
  return token ? { "x-api-token": token } : {};
};

