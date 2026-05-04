// Jest setupFiles entry — runs in EACH test worker BEFORE any test file
// (and any imports it pulls in) executes. Critical because:
//
//   The production `app/config/dbConn.js` calls `dotenv.config()` (no path)
//   on import, which reads `.env` and binds the production pg-promise pool
//   to `DATABASE_NAME=hospitality_stage`. Without this shim, every test that
//   imports a production model would hit the STAGING database, not the
//   per-run test database created by `prepareTestDb.js`.
//
// What we do here:
//   1. Force NODE_ENV=test.
//   2. Load `.env.test` with override=true so its values win against any
//      pre-set env vars.
//   3. Compute the same `hospitality_test_<runId>` name that `envguard.js`
//      computed during globalSetup, and set `DATABASE_NAME` to it. dotenv's
//      default no-override behaviour then keeps that value when dbConn.js
//      runs its own dotenv.config().
//
// The runId is derived deterministically from the same inputs envguard uses,
// so the suffix matches what globalSetup created.

import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_DIR = path.resolve(__dirname, "..", "..");

process.env.NODE_ENV = "test";

// Load .env.test FIRST (override=true) — wins over any leftover env vars.
dotenv.config({ path: path.join(BACKEND_DIR, ".env.test"), override: true });

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function computeRunId() {
  if (process.env.TEST_RUN_ID) return sanitize(process.env.TEST_RUN_ID);
  if (process.env.GITHUB_RUN_ID) return sanitize(`ci_${process.env.GITHUB_RUN_ID}`);
  let user = "local";
  try {
    user = os.userInfo().username;
  } catch {}
  return sanitize(user) || "local";
}

const prefix = process.env.TEST_DB_PREFIX || "hospitality_test";
const runId = computeRunId();
const dbName = `${prefix}_${runId}`;

if (!/^hospitality_test(_[a-zA-Z0-9_-]+)?$/.test(dbName)) {
  throw new Error(`tests/setup/jestEnv.js refusing dbName='${dbName}'`);
}

// Override DATABASE_NAME so the production dbConn.js binds to the test DB.
// (dotenv inside dbConn.js will NOT overwrite this — its default override=false.)
process.env.DATABASE_NAME = dbName;
process.env.TEST_DB_NAME_RESOLVED = dbName;

// Stub nodemailer so sendMail calls don't actually try to authenticate against
// gmail/brevo SMTP (which fail with 535 in the test env, polluting logs).
// We swap createTransport for a function that returns a transport whose
// sendMail just resolves with a fake messageId. Tests that need to assert on
// emails sent should use the dedicated email mock helper (TBD).
import nodemailer from "nodemailer";
nodemailer.createTransport = function stubCreateTransport() {
  return {
    sendMail(_mailOptions, cb) {
      const info = { messageId: "<test-stub-mail>", response: "250 OK (stub)" };
      if (typeof cb === "function") {
        // Mirror the real callback shape: cb(err, info).
        cb(null, info);
        return;
      }
      return Promise.resolve(info);
    },
    verify(cb) {
      if (typeof cb === "function") cb(null, true);
      return Promise.resolve(true);
    },
    close() {},
  };
};
