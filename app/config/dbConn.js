import Promise from 'bluebird';
import pg from 'pg-promise';
import dotenv from 'dotenv';
import Config from '../config/app.config.js';
import { sendMail } from '../helper/common.js';
import { logger } from '../util/logger.js';

// env config
dotenv.config();
const initOptions = {
  promiseLib: Promise,
  query(e) {
    // console.log(e.query);
  },
  error(error, e) {
    if (e.cn) {
      // A connection-related error;
      // Connections are reported back with the password hashed,
      // for safe errors logging, without exposing passwords.
      console.log('CN:', e.cn);
      console.log('EVENT:', error.message || error);

      sendMail({
        from: Config.webmasterMail, // sender address
        to: Config.developers, // list of receivers
        subject: `URL || Work wise || Dev DB Error`, // Subject line
        html: `Error: ${JSON.stringify(e.cn)} <br> ${JSON.stringify(
          error.message
        )} <br> ${JSON.stringify(error)}` // plain text body
      });
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
  ssl: {
    rejectUnauthorized: false
  }
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
