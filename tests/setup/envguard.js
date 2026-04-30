// Loads .env.test, validates the target test DB name, and returns a connection
// config + the FQ db name. Used by prepareTestDb.js and dropTestDb.js.
//
// Safety: refuses to operate unless NODE_ENV=test and the computed DB name
// matches ^hospitality_test(_[a-zA-Z0-9_-]+)?$ — preventing accidental drops
// of staging or production databases that share the same RDS instance.

import { fileURLToPath } from "url";
import path from "path";
import os from "os";
import fs from "fs";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_DIR = path.resolve(__dirname, "..", "..");
const ENV_TEST_PATH = path.join(BACKEND_DIR, ".env.test");

const SAFE_NAME_RE = /^hospitality_test(_[a-zA-Z0-9_-]+)?$/;
const KNOWN_PROTECTED_NAMES = new Set([
  "hospitality",
  "hospitality_prod",
  "hospitality_production",
  "hospitality_stage",
  "hospitality_staging",
]);

function abort(message, code = 2) {
  console.error(`ABORT: ${message}`);
  process.exit(code);
}

export function loadTestEnv() {
  if (!fs.existsSync(ENV_TEST_PATH)) {
    abort(`missing ${ENV_TEST_PATH}`);
  }
  dotenv.config({ path: ENV_TEST_PATH, override: true });

  if (process.env.NODE_ENV !== "test") {
    abort(`NODE_ENV must be 'test', got '${process.env.NODE_ENV}'`);
  }

  // DATABASE_PASSWORD is intentionally not required: local Postgres (brew)
  // uses peer auth on localhost with an empty password.
  const required = ["HOST", "DATABASE_USERNAME"];
  for (const key of required) {
    if (!process.env[key]) abort(`${key} is required (.env.test)`);
  }
}

export function computeRunId() {
  const explicit = process.env.TEST_RUN_ID;
  if (explicit) return sanitize(explicit);
  if (process.env.GITHUB_RUN_ID) return sanitize(`ci_${process.env.GITHUB_RUN_ID}`);
  const user = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return "local";
    }
  })();
  return sanitize(user) || "local";
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

export function getTestDbConfig() {
  loadTestEnv();
  const prefix = process.env.TEST_DB_PREFIX || "hospitality_test";
  if (!/^hospitality_test(_[a-zA-Z0-9_-]+)?$/.test(prefix)) {
    abort(`TEST_DB_PREFIX must start with 'hospitality_test' (got '${prefix}')`);
  }

  const runId = computeRunId();
  const dbName = `${prefix}_${runId}`;

  if (!SAFE_NAME_RE.test(dbName)) {
    abort(`computed DB name '${dbName}' does not match safe pattern`);
  }
  if (KNOWN_PROTECTED_NAMES.has(dbName)) {
    abort(`refusing to operate on '${dbName}'`);
  }

  return {
    host: process.env.HOST,
    port: Number(process.env.DATABASE_PORT || 5432),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    maintenanceDb: process.env.TEST_MAINTENANCE_DB || "postgres",
    dbName,
    runId,
    backendDir: BACKEND_DIR,
    setupDir: __dirname,
  };
}

export const SAFE_NAME = SAFE_NAME_RE;
