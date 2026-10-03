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
