// Import Sentry SDK
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import dotenv from 'dotenv';

// Ensure env vars are loaded BEFORE reading process.env
dotenv.config();

// Get environment
const env = process.env.NODE_ENV || 'development';

// Configure Sentry based on environment
const sentryConfig = {
  dsn: process.env.SENTRY_DSN,
  environment: env,
  sendDefaultPii: true,
  debug: env === 'development', // Enable debug mode in development
  tracesSampleRate: env === 'production' ? 0.1 : 1.0, // 10% in production, 100% in staging/dev
  profilesSampleRate: env === 'production' ? 0.1 : 1.0, // 10% in production, 100% in staging/dev
  integrations: [
    nodeProfilingIntegration(),
  ],
  // Performance monitoring configuration
  beforeSend(event, hint) {
    console.log('Sentry beforeSend called:', event.type, event.event_id);
    // Filter out health check requests from performance monitoring
    if (event.request?.url?.includes('/health')) {
      return null;
    }
    return event;
  },
  // Error filtering
  beforeSendTransaction(event) {
    // Filter out health check transactions
    if (event.transaction?.includes('/health')) {
      return null;
    }
    return event;
  },
  // Add transport options for debugging
  transportOptions: {
    bufferSize: 30,
  },
};

// Initialize Sentry
console.log('Initializing Sentry with DSN:', process.env.SENTRY_DSN ? 'DSN provided' : 'NO DSN PROVIDED');
console.log('Environment:', env);

Sentry.init(sentryConfig);

console.log('Sentry initialized successfully');

// Export for use in other files
export default Sentry;
