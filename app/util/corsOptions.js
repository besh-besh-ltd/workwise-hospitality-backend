/**
 * CORS policy for the API.
 *
 * Two goals:
 *  1. `maxAge` on every preflight. Without Access-Control-Max-Age the browser
 *     re-sends an OPTIONS before every Authorization-bearing request (264k
 *     preflights/week in prod). 7200 s is Chromium's cap.
 *  2. An optional exact-origin allowlist. `CORS_ORIGINS` is a comma-separated
 *     list of origins (scheme://host[:port], no path). When set, a matching
 *     Origin is reflected (with Vary: Origin) and anything else gets no CORS
 *     headers, so the browser blocks it. When unset, the previous permissive
 *     behaviour (`*`) is kept so a deploy cannot break before the env is set.
 */
export const CORS_MAX_AGE_SECONDS = 7200;

export function parseCorsOrigins(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function buildCorsOptions(env = process.env) {
  const allowed = new Set(parseCorsOrigins(env.CORS_ORIGINS));
  const base = { maxAge: CORS_MAX_AGE_SECONDS, credentials: true };

  if (allowed.size === 0) {
    return { ...base, origin: '*' };
  }

  return {
    ...base,
    origin(requestOrigin, callback) {
      // No Origin header = not a cross-origin browser request; nothing to add.
      callback(null, Boolean(requestOrigin) && allowed.has(requestOrigin));
    },
  };
}
