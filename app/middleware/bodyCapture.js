import { trace, context } from '@opentelemetry/api';
import { sanitizeBody } from '../util/sanitize.js';

const SKIP_PATHS = new Set(['/health', '/api/health']);

/**
 * Reads the capture switches per call so tests (and a hot env reload) see the
 * current values.
 *
 * Response-body capture is OPT-IN (LOG_RESPONSE_BODY=true). It used to be on
 * by default and exported responses UNSANITIZED, i.e. login tokens and PII in
 * every trace, and re-serialised every JSON response a second time just to
 * measure it.
 */
export function bodyCaptureSettings(env = process.env) {
  return {
    logRequestBody: env.LOG_REQUEST_BODY !== 'false',
    logResponseBody: env.LOG_RESPONSE_BODY === 'true',
    maxBodyLogSize: parseInt(env.MAX_BODY_LOG_SIZE || '4096', 10),
  };
}

const serialize = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

export default function bodyCapture(req, res, next) {
  if (SKIP_PATHS.has(req.path)) return next();

  const span = trace.getSpan(context.active());
  if (!span) return next();

  const { logRequestBody, logResponseBody, maxBodyLogSize } = bodyCaptureSettings();

  // Capture request body (only for non-GET with body)
  if (logRequestBody && req.method !== 'GET' && req.body && Object.keys(req.body).length > 0) {
    try {
      const bodyStr = serialize(sanitizeBody(req.body));
      span.setAttribute('http.request.body', bodyStr.substring(0, maxBodyLogSize));
    } catch {
      // Never break the request over telemetry.
    }
  }

  if (logResponseBody) {
    // res.json(obj) serialises once and hands the string to res.send(). Keep
    // the object from json() and measure the string in send(), so a large
    // response is never stringified a second time: over the cap it is skipped
    // (size recorded), under the cap it is sanitised and serialised (cheap).
    let pendingBody;
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    res.json = function (body) {
      pendingBody = body;
      return originalJson(body);
    };

    res.send = function (chunk) {
      if (pendingBody !== undefined) {
        const body = pendingBody;
        pendingBody = undefined;
        try {
          const size = typeof chunk === 'string' ? chunk.length : Buffer.byteLength(chunk || '');
          if (size > maxBodyLogSize) {
            span.setAttribute('http.response.body.truncated', true);
            span.setAttribute('http.response.body.size', size);
          } else if (body !== null && body !== undefined) {
            const bodyStr = serialize(sanitizeBody(body));
            span.setAttribute('http.response.body', bodyStr.substring(0, maxBodyLogSize));
          }
        } catch {
          // Don't break the response if capture fails.
        }
      }
      return originalSend(chunk);
    };
  }

  next();
}
