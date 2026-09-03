import pg from 'pg-promise';
import dotenv from 'dotenv';
import { logger } from '../util/logger.js';
import { getActorUserId, getRequestId } from '../util/requestContext.js';

dotenv.config();

const initOptions = {
  error(error, e) {
    if (e.cn) {
      // pg-promise reports connection errors with the password hashed,
      // so logging the cn object is safe.
      logger.error({ cn: e.cn }, 'Database connection error');
      logger.error({ event: error.message || error }, 'Database error event');
    }
  },

  /**
   * Stamps the acting user onto the session so the row-level audit trigger
   * can attribute what follows to a person.
   *
   * The trigger runs inside Postgres and has no way to know who is acting;
   * that is why `changed_by` read the literal 'postgres' for 105,000 rows.
   * It now reads `current_setting('app.actor_id')`, which has to be put there
   * by whoever holds the connection.
   *
   * Why here rather than at the start of each transaction: writes happen both
   * inside `db.tx` and through bare `db.none`/`db.any` calls, so a
   * transaction-only hook would miss a large share of them. `connect` fires on
   * every acquisition from the pool, which covers both.
   *
   * Why the un-awaited query is safe: node-postgres serialises statements per
   * connection in the order they are queued, and pg-promise fires this handler
   * synchronously before the caller's continuation runs. The SET is therefore
   * always queued ahead of the query it is meant to describe.
   *
   * Why the cache: this would otherwise add a round trip to every acquisition,
   * and round trips — not slow SQL — are what this application's latency is
   * made of. A pooled connection keeps its settings, so re-stamping one that
   * already carries the right values is pure cost. Inside `db.tx` the whole
   * transaction is one acquisition and therefore one stamp.
   *
   * Stamping unconditionally (including to empty) is what stops the previous
   * request's actor leaking onto a reused connection.
   */
  connect({ client }) {
    const actorId = getActorUserId();
    const requestId = getRequestId();
    const desired = `${actorId ?? ''}|${requestId ?? ''}`;

    if (client.$wwAuditContext === desired) return;
    client.$wwAuditContext = desired;

    // set_config takes parameters; `SET` does not. is_local=false because the
    // value must outlive any single statement on this connection.
    client
      .query(
        `SELECT set_config('app.actor_id', $1, false),
                set_config('app.request_id', $2, false)`,
        [actorId == null ? '' : String(actorId), requestId ?? '']
      )
      .catch((err) => {
        // Never let audit stamping break a request. A row with no actor is a
        // gap in the trail; a failed query is a broken feature.
        client.$wwAuditContext = null;
        logger.warn({ err: err.message }, 'Could not stamp audit context on connection');
      });
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
  ssl: process.env.TEST_DB_NO_SSL === '1' ? false : { rejectUnauthorized: false },

  // node-pg defaults to 10 connections, and nothing here had ever raised it.
  // That was already tight; it became a real ceiling once PO approvals started
  // holding a connection across the document render, because the approval and
  // its document now share one transaction on one connection. Rendering is
  // capped at 2 concurrent pages (app/util/pdfRenderer.js), so the render is
  // not what exhausts this — but the headroom needs to exist.
  max: Number(process.env.DATABASE_POOL_MAX) || 25,

  // Do not let a caller wait forever for a connection. A pool that is empty
  // for 10 seconds is a pool in trouble, and a fast error is more actionable
  // than a hung request.
  connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS) || 10_000,
  idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS) || 30_000,
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
