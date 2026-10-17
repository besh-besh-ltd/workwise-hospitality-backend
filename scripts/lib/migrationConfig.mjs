/**
 * Resolving which database the migration runner talks to.
 *
 * This repo uses neither DATABASE_URL nor the PG* conventions that migration
 * tools default to. app/config/dbConn.js:20-28 reads HOST / DATABASE_PORT /
 * DATABASE_USERNAME / DATABASE_PASSWORD / DATABASE_NAME and flips SSL on
 * TEST_DB_NO_SSL. The runner must resolve the same database from the same
 * variables, or "what we migrated" and "what the app queries" can diverge with
 * nothing to notice it.
 *
 * A connection OBJECT is returned rather than a URL string on purpose:
 * production passwords are free-form, and percent-encoding them into a URL is an
 * avoidable class of bug.
 */
const REQUIRED = ["HOST", "DATABASE_USERNAME", "DATABASE_NAME"];

export function buildConnection(env = process.env) {
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(
      `missing required database env var(s): ${missing.join(", ")}. ` +
        "These come from backend/.env locally, or --env-file on the deploy host."
    );
  }

  return {
    host: env.HOST,
    port: Number(env.DATABASE_PORT || 5432),
    user: env.DATABASE_USERNAME,
    // Local brew Postgres uses peer auth with no password; RDS always has one.
    password: env.DATABASE_PASSWORD ?? "",
    database: env.DATABASE_NAME,
    // RDS presents a cert we do not pin, exactly as dbConn.js does.
    ssl: env.TEST_DB_NO_SSL === "1" ? false : { rejectUnauthorized: false },
  };
}

/** Safe to print and safe to put in a CI log: identifies the target, omits the password. */
export function describeTarget(conn) {
  return `${conn.user}@${conn.host}:${conn.port}/${conn.database}`;
}
