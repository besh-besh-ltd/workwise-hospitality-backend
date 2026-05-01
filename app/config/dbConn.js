import pg from 'pg-promise';
import dotenv from 'dotenv';
import Config from '../config/app.config.js';
import { sendMail } from '../helper/common.js';
import { logger } from '../util/logger.js';

// env config
dotenv.config();
const initOptions = {
  query(e) {
    // console.log(e.query);
  },
  error(error, e) {
    if (e.cn) {
      // A connection-related error;
      // Connections are reported back with the password hashed,
      // for safe errors logging, without exposing passwords.
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
  // Setting `ssl: false` lets node-postgres skip the TLS handshake entirely.
  ssl: process.env.TEST_DB_NO_SSL === "1" ? false : { rejectUnauthorized: false }
};
// const cn = 'postgres://process.env.DB_USER:process.env.DB_PASS@process.env.DB_HOST:process.env.DB_PORT/process.env.DB_NAME';

pgp.pg.types.setTypeParser(1114, (s) => s);

const db = pgp(cn); // database instance;

db.connect()
  .then((obj) => {
    obj.done(); // success, release the connection;
    logger.info("Database has been connected at port > 5432")
  })
  .catch((error) => {
    logger.error('ERROR:', error.message || error);
  });

export { pgp, db as default };
