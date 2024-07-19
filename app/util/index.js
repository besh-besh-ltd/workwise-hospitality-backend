import express from 'express';
import helmet from 'helmet';
import compression from 'compression';

import cors from 'cors';
//import sequelize from '../database/index.js';
//import swaggerUi from 'swagger-ui-express';
// import { createRequire } from 'module';
// const require = createRequire(import.meta.url);
// const swaggerDocument = require('../resources/swagger/swagger.json');
import v1Router from '../routes/index.js';
import origin from './origin.js';
import { errors } from 'celebrate';
import error from './error.js';
import { winstonInternalErrorLogger, winstonLogger } from './logger.js';

const util = (app) => {
  app.use(helmet());
  origin(app);
  app.use(cors());
  app.use(compression());

  // loggers
  app.use(winstonLogger);

  app.use(
    express.urlencoded({
      limit: '100mb',
      extended: true
    })
  );

  app.use(express.json({ limit: '100mb' }));
  // swagger APIs list
  //app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
  // handling routes
  // app.use('/api/web/v1', v1Router);

  app.use('/api/v1', v1Router);

  // app.use('/agent/api/web/v1', v1Router);
  // error response
  error(app);
  // validation errors
  app.use(errors());
};
export default util;
