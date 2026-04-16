import { trace } from '@opentelemetry/api';

const otelMiddleware = (req, res, next) => {
  const span = trace.getActiveSpan();
  if (span) {
    const companyId = req.headers['x-company-id'];
    const hotelId = req.headers['x-hotel-id'];

    if (companyId) span.setAttribute('hospitality.company_id', companyId);
    if (hotelId) span.setAttribute('hospitality.hotel_id', hotelId);
  }

  const startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    if (duration > 2000 && span) {
      span.addEvent('slow_response', {
        'http.method': req.method,
        'http.url': req.originalUrl,
        'response.duration_ms': duration,
        'http.status_code': res.statusCode,
      });
    }

    // Attach authenticated user context to span
    if (span && req.user) {
      span.setAttribute('enduser.id', String(req.user.id));
      if (req.user.email) span.setAttribute('enduser.email', req.user.email);
      if (req.user.user_type) span.setAttribute('enduser.role', String(req.user.user_type));
    }
  });

  next();
};

export default otelMiddleware;
