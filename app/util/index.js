import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import { errors } from 'celebrate';

import v1Router from '../routes/index.js';
import origin from './origin.js';
import error from './error.js';
import otelMiddleware from '../middleware/otelMiddleware.js';
import bodyCapture from '../middleware/bodyCapture.js';
import { httpLogger } from './logger.js';

const util = (app) => {
  app.use(helmet());
  origin(app);
  app.use(cors());
  app.use(compression());
  app.use(httpLogger);
  app.use(otelMiddleware);
  app.use(express.urlencoded({ limit: '100mb', extended: true }));
  app.use(express.json({ limit: '100mb' }));
  // bodyCapture must run AFTER body parsers so traces can include the parsed body.
  app.use(bodyCapture);
  app.use('/api/v1', v1Router);
  error(app);
  app.use(errors());
};
export default util;
