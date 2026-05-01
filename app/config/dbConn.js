import pg from 'pg-promise';
import dotenv from 'dotenv';
import { logger } from '../util/logger.js';

dotenv.config();

const initOptions = {
  error(error, e) {
    if (e.cn) {
      // pg-promise reports connection errors with the password hashed,
      // so logging the cn object is safe.
      logger.error({ cn: e.cn }, 'Database connection error');
      logger.error({ event: error.message || error }, 'Database error event');
    }
  }
};
const pgp = pg(initOptions);

const cn = {
  user: process.env.DATABASE_USERNAME || null,
  password: process.env.DATABASE_PASSWORD || null,
  database: process.env.DATABASE_NAME || null,
  host: process.env.HOST || null,
  port: process.env.DATABASE_PORT || null,
  dialect: process.env.DATABASE_DIALECT || null,
  // RDS requires SSL; local Postgres (e.g. tests via TEST_DB_NO_SSL=1) does not.
  ssl: process.env.TEST_DB_NO_SSL === '1' ? false : { rejectUnauthorized: false }
};

// Return raw timestamp strings (no JS Date conversion) for type 1114 (timestamp).
pgp.pg.types.setTypeParser(1114, (s) => s);

const db = pgp(cn);

db.connect()
  .then((obj) => {
    obj.done();
    logger.info('Database has been connected at port > 5432');
  })
  .catch((error) => {
    logger.error('ERROR:', error.message || error);
  });

export { pgp, db as default };
