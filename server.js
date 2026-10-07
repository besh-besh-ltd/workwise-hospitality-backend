/* eslint-disable no-console */
// IMPORTANT: Import OTel instrument file at the very top
import './otel-instrument.mjs';

import http from 'http';
import dotenv from 'dotenv';
import { createApp } from './app/app.js';
import { SocketConfig } from './app/util/socket.js';
import { pgp } from './app/config/dbConn.js';

// env config
dotenv.config();

import { rescheduleAllMilestoneReminders, rescheduleAllRfqPublishJobs, startVendorAcceptanceReminderCron, rescheduleAllNegotiationRoundExpirations, rescheduleAllArcNegotiationRoundExpirations, startRfqStuckPublishWatchdog, startNegotiationRoundClosureSweeper, startPoDocumentWatchdog } from './app/helper/cronManager.js';
import { startArcAmendmentLifecycleCron } from './app/services/arcAmendmentLifecycleService.js';
import { logger } from './app/util/logger.js';


// Initialize app. Routes, middleware and the error handler live in
// app/app.js. NOTE: there is intentionally no express.static mount: it used to
// serve this directory, i.e. the backend source, to the internet.
const app = createApp();

rescheduleAllMilestoneReminders();
rescheduleAllRfqPublishJobs();
startVendorAcceptanceReminderCron();
rescheduleAllNegotiationRoundExpirations();
// Backstop for the one-shot in-memory jobs above, which are lost on any restart.
startNegotiationRoundClosureSweeper();
rescheduleAllArcNegotiationRoundExpirations();
startRfqStuckPublishWatchdog();
startPoDocumentWatchdog();
startArcAmendmentLifecycleCron();


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
