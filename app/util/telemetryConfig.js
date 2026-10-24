/**
 * Pure telemetry configuration helpers, shared by otel-instrument.mjs and the
 * pino-http logger. This module must stay dependency-free: otel-instrument.mjs
 * imports it BEFORE the instrumented libraries (http, express, pg) load.
 *
 * Why: ~75% of prod requests are background polling and health probes. Each
 * one produced a full trace (http + every express layer + pg spans) and an
 * access-log line, which cost CPU on an already CPU-bound process and filled
 * SigNoz with noise.
 */

/** Health probes and badge/count polling: no trace, no access log. */
export const NOISY_ROUTES = new Set([
  '/health',
  '/api/health',
  '/api/v1/general/hospitality/approval/pending/counts',
  '/api/v1/users/notifications/unread-count',
]);

export const DEFAULT_TRACES_SAMPLER = 'parentbased_traceidratio';
export const DEFAULT_TRACES_SAMPLER_ARG = '0.25';

/** Path without query string or trailing slash ('/' stays '/'). */
export function requestPath(url) {
  const path = String(url || '/').split('?')[0].split('#')[0];
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

export function isNoisyRoute(url) {
  return NOISY_ROUTES.has(requestPath(url));
}

/**
 * http instrumentation `ignoreIncomingRequestHook`: CORS preflights, health
 * probes and the polling routes get no span (and so no child spans either).
 */
export function shouldIgnoreIncomingRequest(req) {
  if (!req) return false;
  if (String(req.method || '').toUpperCase() === 'OPTIONS') return true;
  return isNoisyRoute(req.url);
}

/**
 * Query parameters that carry a credential: `?token=` (the legacy GRN site-rep
 * link and the vendor upload link) and `?t=` (the receive-link landing page).
 * Their values never reach a span, an access log or a log line.
 */
export const SECRET_QUERY_PARAMS = new Set(['token', 't']);
export const REDACTED_QUERY_VALUE = 'REDACTED';

const secretParamName = (rawKey) => {
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    // keep the raw key
  }
  // `token[]=` / `token[0]=` still name the token parameter.
  return SECRET_QUERY_PARAMS.has(key.replace(/\[.*$/, '').trim().toLowerCase());
};

/**
 * `url` (a path with query, or an absolute URL) with the value of every secret
 * query parameter replaced by REDACTED. Returned unchanged (the same string)
 * when it has none.
 */
export function redactUrlSecrets(url) {
  const s = String(url ?? '');
  const q = s.indexOf('?');
  if (q < 0) return s;
  const hashAt = s.indexOf('#', q);
  const query = hashAt < 0 ? s.slice(q + 1) : s.slice(q + 1, hashAt);
  let changed = false;
  const parts = query.split('&').map((part) => {
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    if (!rawKey || !secretParamName(rawKey)) return part;
    changed = true;
    return `${rawKey}=${REDACTED_QUERY_VALUE}`;
  });
  if (!changed) return s;
  return `${s.slice(0, q + 1)}${parts.join('&')}${hashAt < 0 ? '' : s.slice(hashAt)}`;
}

/** A copy of a parsed query object (req.query) with secret parameters' values replaced. */
export function redactQuerySecrets(query) {
  if (!query || typeof query !== 'object') return query;
  let changed = false;
  const out = {};
  for (const [key, value] of Object.entries(query)) {
    if (secretParamName(key)) {
      out[key] = REDACTED_QUERY_VALUE;
      changed = true;
    } else {
      out[key] = value;
    }
  }
  return changed ? out : query;
}

/**
 * http instrumentation `startIncomingSpanHook`: when the request URL carries a
 * secret query parameter, the URL attributes of the server span are replaced
 * with redacted ones. The instrumentation merges these over the attributes it
 * derived from the raw URL (both the old http.url / http.target and the stable
 * url.query), so the raw value never lands on the span. Other requests get no
 * extra attributes.
 */
export function redactedIncomingSpanAttributes(req) {
  const raw = req?.url;
  if (typeof raw !== 'string') return {};
  const redacted = redactUrlSecrets(raw);
  if (redacted === raw) return {};
  const q = redacted.indexOf('?');
  const scheme = req.socket?.encrypted ? 'https' : 'http';
  const host = req.headers?.host || 'localhost';
  return {
    'http.target': redacted,
    'http.url': `${scheme}://${host}${redacted}`,
    'url.query': q < 0 ? '' : redacted.slice(q + 1),
  };
}

/**
 * Default trace sampler: parent-based TraceIdRatio at 25%, using the standard
 * OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG env vars so ops can override
 * without a code change. Returns the env values to apply; never overrides
 * values that are already set.
 */
export function traceSamplerEnvDefaults(env = process.env) {
  const out = {};
  if (!env.OTEL_TRACES_SAMPLER) {
    out.OTEL_TRACES_SAMPLER = DEFAULT_TRACES_SAMPLER;
    if (!env.OTEL_TRACES_SAMPLER_ARG) out.OTEL_TRACES_SAMPLER_ARG = DEFAULT_TRACES_SAMPLER_ARG;
  }
  return out;
}

/** Instrumentation options passed to getNodeAutoInstrumentations(). */
export function buildInstrumentationConfig() {
  return {
    '@opentelemetry/instrumentation-http': {
      enabled: true,
      ignoreIncomingRequestHook: shouldIgnoreIncomingRequest,
      // ?token= / ?t= links: the credential must not be exported with the span.
      startIncomingSpanHook: redactedIncomingSpanAttributes,
    },
    '@opentelemetry/instrumentation-express': {
      enabled: true,
      // One span per middleware/handler layer x every request was most of the
      // span volume; the http server span already carries route + timing.
      ignoreLayersType: ['middleware', 'request_handler'],
    },
    '@opentelemetry/instrumentation-pg': {
      enabled: true,
      // Pool pings, crons and anything outside a request no longer start
      // orphan root traces.
      requireParentSpan: true,
    },
    '@opentelemetry/instrumentation-pino': { enabled: false },
    '@opentelemetry/instrumentation-winston': { enabled: false },
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-dns': { enabled: false },
    '@opentelemetry/instrumentation-net': { enabled: false },
  };
}
