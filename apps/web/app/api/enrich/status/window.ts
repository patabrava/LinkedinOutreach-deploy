const CONNECT_ONLY_LIMIT_LOOKBACK_DAYS = 7;

export const getConnectOnlyLimitWindowStart = (now: Date = new Date()) => {
  return new Date(now.getTime() - CONNECT_ONLY_LIMIT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
};
