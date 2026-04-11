import { trace, context } from '@opentelemetry/api';
import { sanitizeBody } from '../util/sanitize.js';

const SKIP_PATHS = new Set(['/health', '/api/health']);
const LOG_REQUEST_BODY = process.env.LOG_REQUEST_BODY !== 'false';
const LOG_RESPONSE_BODY = process.env.LOG_RESPONSE_BODY !== 'false';
const MAX_BODY_LOG_SIZE = parseInt(process.env.MAX_BODY_LOG_SIZE || '4096', 10);

export default function bodyCapture(req, res, next) {
  if (SKIP_PATHS.has(req.path)) return next();

  const span = trace.getSpan(context.active());

  // Capture request body (only for non-GET with body)
  if (LOG_REQUEST_BODY && req.method !== 'GET' && req.body && Object.keys(req.body).length > 0) {
    const sanitized = sanitizeBody(req.body);
    const bodyStr = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);

    if (span) {
      span.setAttribute('http.request.body', bodyStr.substring(0, MAX_BODY_LOG_SIZE));
    }
  }

  // Capture response body by wrapping res.json()
  if (LOG_RESPONSE_BODY) {
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      if (span && body) {
        try {
          const bodyStr = JSON.stringify(body);
          if (bodyStr.length <= MAX_BODY_LOG_SIZE) {
            span.setAttribute('http.response.body', bodyStr);
          } else {
            span.setAttribute('http.response.body', bodyStr.substring(0, MAX_BODY_LOG_SIZE) + '...[truncated]');
            span.setAttribute('http.response.body.truncated', true);
          }
        } catch {
          // Don't break response if serialization fails
        }
      }
      return originalJson(body);
    };
  }

  next();
}
