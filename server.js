/* eslint-disable no-console */
// IMPORTANT: Import OTel instrument file at the very top
import './otel-instrument.mjs';

import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import util from './app/util/index.js';
import { consoleLogData, logError } from './app/helper/common.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { SocketConfig } from './app/util/socket.js';
import db, { pgp } from './app/config/dbConn.js';
const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

// env config
dotenv.config();

import { rescheduleAllMilestoneReminders, rescheduleAllRfqPublishJobs, startVendorAcceptanceReminderCron, rescheduleAllNegotiationRoundExpirations, startRfqStuckPublishWatchdog } from './app/helper/cronManager.js';
import { startArcAmendmentLifecycleCron } from './app/services/arcAmendmentLifecycleService.js';
import { logger } from './app/util/logger.js';


// Initialize app
const app = express();

// Basic health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Deep health check — verifies DB connectivity
app.get('/api/health', async (req, res) => {
  try {
    await db.one('SELECT 1 AS alive');
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', message: 'Database connection failed' });
  }
});


app.use(express.static(__dirname));
util(app);

rescheduleAllMilestoneReminders();
rescheduleAllRfqPublishJobs();
startVendorAcceptanceReminderCron();
rescheduleAllNegotiationRoundExpirations();
startRfqStuckPublishWatchdog();
startArcAmendmentLifecycleCron();


// Clean error handler
app.use(function onError(err, req, res, next) {
  logError('Unhandled error in global handler', err);
  res.statusCode = 500;
  res.json({ status: 3, message: 'An internal error has occurred. Please try again later.' });
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
}

// ── Graceful shutdown ────────────────────────────────────────
function gracefulShutdown(signal) {
  logger.info(`\n${signal} received — starting graceful shutdown`);

  // Stop accepting new connections, drain in-flight requests
  server.close(() => {
    logger.info('HTTP server closed');

    // Close DB connection pool
    pgp.end();
    logger.info('Database pool closed');
  });

  // Force exit after 15s if draining hangs
  setTimeout(() => {
    logger.error('Forced shutdown after 15s timeout');
    process.exit(1);
  }, 15000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
