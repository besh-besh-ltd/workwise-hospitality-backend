/**
 * Builds the production Express app (routes + middleware + error handler)
 * without listening, starting crons, or attaching socket.io — server.js does
 * those. Kept separate so tests can drive the exact app production serves.
 *
 * There is deliberately NO `express.static` mount. server.js used to serve its
 * own directory, which published the backend source (server.js, package.json,
 * Dockerfile, app/config/app.config.js) to anyone who asked.
 */
import express from 'express';
import util from './util/index.js';
import db from './config/dbConn.js';
import { logError } from './helper/common.js';

export function createApp() {
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

  util(app);

  // Clean error handler. Express recognises error middleware by its arity,
  // so `next` must stay in the signature.
  // eslint-disable-next-line no-unused-vars
  app.use(function onError(err, req, res, next) {
    logError('Unhandled error in global handler', err);
    res.statusCode = 500;
    res.json({ status: 3, message: 'An internal error has occurred. Please try again later.' });
  });

  return app;
}

export default createApp;
