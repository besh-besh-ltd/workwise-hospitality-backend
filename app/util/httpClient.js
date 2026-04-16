import axios from 'axios';
import { logger } from './logger.js';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { sanitizeObject } from './sanitize.js';

const httpClient = axios.create({
  timeout: 30000,
});

httpClient.interceptors.request.use((config) => {
  logger.info({
    event: 'external_api_request',
    method: config.method?.toUpperCase(),
    url: config.url,
    hasBody: !!config.data,
  }, `External API: ${config.method?.toUpperCase()} ${config.url}`);
  config._startTime = Date.now();
  return config;
});

httpClient.interceptors.response.use(
  (response) => {
    const duration = Date.now() - (response.config._startTime || 0);
    logger.info({
      event: 'external_api_response',
      method: response.config.method?.toUpperCase(),
      url: response.config.url,
      status: response.status,
      duration_ms: duration,
    }, `External API Response: ${response.status} from ${response.config.url} (${duration}ms)`);
    return response;
  },
  (error) => {
    const duration = Date.now() - (error.config?._startTime || 0);
    const span = trace.getSpan(context.active());

    logger.error({
      event: 'external_api_error',
      method: error.config?.method?.toUpperCase(),
      url: error.config?.url,
      status: error.response?.status,
      duration_ms: duration,
      error_message: error.message,
      response_data: error.response?.data ? sanitizeObject(error.response.data) : undefined,
    }, `External API Error: ${error.message} from ${error.config?.url}`);

    if (span) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: `External API error: ${error.message}` });
    }

    return Promise.reject(error);
  }
);

export default httpClient;
