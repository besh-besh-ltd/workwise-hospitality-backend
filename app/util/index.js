import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import { errors } from 'celebrate';

import v1Router from '../routes/index.js';
import origin from './origin.js';
import { buildCorsOptions } from './corsOptions.js';
import error from './error.js';
import otelMiddleware from '../middleware/otelMiddleware.js';
import bodyCapture from '../middleware/bodyCapture.js';
import requestContext from '../middleware/requestContext.js';
import activityCapture from '../middleware/activityCapture.js';
import { httpLogger } from './logger.js';
import { trustProxySetting } from './trustProxy.js';

const util = (app) => {
  // req.ip = the client behind TRUST_PROXY_HOPS reverse proxies (default 1); see trustProxy.js.
  app.set('trust proxy', trustProxySetting());
  app.use(helmet());
  origin(app);
  // Origin policy + preflight caching: see corsOptions.js (CORS_ORIGINS env).
  app.use(cors(buildCorsOptions(process.env)));
  app.use(compression());
  app.use(httpLogger);
  app.use(otelMiddleware);
  app.use(express.urlencoded({ limit: '100mb', extended: true }));
  app.use(express.json({ limit: '100mb' }));
  // bodyCapture must run AFTER body parsers so traces can include the parsed body.
  app.use(bodyCapture);
  // Opens the ambient per-request context. Must wrap the router so it stays
  // open for the whole request, including anything the handlers await. The
  // acting user is read from `req` lazily, since authentication is per-route
  // and has not run yet at this point.
  app.use(requestContext);
  // Records what happened, after the response has gone out. Mounted here so
  // one line covers all 343 mutating routes rather than 343 call sites.
  app.use(activityCapture);
  app.use('/api/v1', v1Router);
  error(app);
  app.use(errors());
};
export default util;
