/* eslint-disable no-console */
// IMPORTANT: Import Sentry instrument file at the very top
import './instrument.mjs';

import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import util from './app/util/index.js';
import { consoleLogData } from './app/helper/common.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { SocketConfig } from './app/util/socket.js';
import * as Sentry from '@sentry/node';
const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

// env config
dotenv.config();

import 'newrelic'; // Import after dotenv so New Relic can read environment variables
import { rescheduleAllMilestoneReminders } from './app/helper/cronManager.js';


// Initialize app
const app = express();

// Add this near the top
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});


// Capture any 5xx responses that were handled locally (no thrown error)
app.use((req, res, next) => {
  const startHr = process.hrtime.bigint();
  const noisyPathPatterns = [/^\/favicon\.ico$/, /^\/robots\.txt$/, /^\/health$/, /^\/static\//, /^\/assets\//];
  const botUaPatterns = [/bot/i, /crawler/i, /spider/i, /curl/i];
  res.on('finish', () => {
    try {
      if (res.statusCode >= 400) {
        const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
        const status = res.statusCode;
        const level = status >= 500 ? 'error' : 'warning';
        const message = `HTTP ${status} ${req.method} ${req.originalUrl}`;
        const path = req.originalUrl || '';
        const ua = req.headers['user-agent'] || '';
        const isNoisyPath = noisyPathPatterns.some((re) => re.test(path));
        const isBot = botUaPatterns.some((re) => re.test(ua));
        if (isNoisyPath || isBot) return;
        Sentry.withScope((scope) => {
          scope.setLevel(level);
          scope.setTag('captured_by', 'finish-listener');
          scope.setContext('request', {
            method: req.method,
            url: req.originalUrl,
            statusCode: status,
            userAgent: ua,
            referer: req.headers['referer'] || req.headers['referrer'],
            durationMs: Math.round(durationMs),
          });
          Sentry.captureMessage(message, level);
        });
      }
    } catch (_) {}
  });
  next();
});

// Add debug endpoint for Sentry testing (before util middleware)
app.get('/debug-sentry', async function mainHandler(req, res) {
  console.log('Debug endpoint called, throwing error...');
  try {
    throw new Error('My first Sentry error!');
  } catch (error) {
    console.log('Error caught, capturing with Sentry...');
    const eventId = Sentry.captureException(error);
    // Ensure event is sent in dev before responding
    try { await Sentry.flush(2000); } catch (_) {}
    res.status(500).json({ 
      error: 'Test error sent to Sentry', 
      eventId: eventId || res.sentry || 'No event ID' 
    });
  }
});

app.use(express.static(path.join(__dirname, '/app/uploads')));
util(app);

rescheduleAllMilestoneReminders();


// The error handler must be registered before any other error middleware and after all controllers
Sentry.setupExpressErrorHandler(app);

// Optional fallthrough error handler
app.use(function onError(err, req, res, next) {
  // The error id is attached to `res.sentry` to be returned
  // and optionally displayed to the user for support.
  res.statusCode = 500;
  res.end(res.sentry + "\n");
});

// Create server
const server = http.createServer(app);

SocketConfig(server)

/**
 * @description Server listen
 */
const PORT = process.env.PORT || 3200;
server.listen(PORT);
server.on('error', onError);
server.on('listening', onListening);

/**
 * Event listener for HTTP server "error" event.
 */
function onError(error) {
  if (error.syscall !== 'listen') {
    throw error;
  }

  var bind = typeof PORT === 'string' ? 'Pipe ' + PORT : 'Port ' + PORT;

  // handle specific listen errors with friendly messages
  switch (error.code) {
    case 'EACCES':
      console.error(bind + ' requires elevated privileges');
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(bind + ' is already in use');
      process.exit(1);
      break;
    default:
      throw error;
  }
}

/**
 * Event listener for HTTP server "listening" event.
 */
function onListening() {
  var addr = server.address();
  var bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port;
  consoleLogData('Listening on :: ' + bind);
}
