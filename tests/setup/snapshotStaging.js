// Re-pulls schema.sql + seed_reference.sql from the staging RDS via pg_dump.
// Run when a new migration lands on staging that the test schema must match.
//
// Reads HOST/credentials from .env (NOT .env.test) — staging is the source of truth.
// Output: backend/tests/setup/{schema.sql, seed_reference.sql}. Commit results to git.
//
// Usage:
//   node tests/setup/snapshotStaging.js

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_DIR = path.resolve(__dirname, "..", "..");
const ENV_PATH = path.join(BACKEND_DIR, ".env");

const SCHEMA_EXCLUDE_TABLES = [
  "public._migration_dept_access_backup",
  "public._migration_policy_deactivation_backup",
  // audit_log_temp is included — it's the target of `log_changes_direct()`
  // triggers on tbl_rfq, tbl_quote*, tbl_purchase_order_*, etc. Excluding it
  // breaks any test that mutates those tables.
  "public.tbl_category_bkp",
  "public.tbl_product_bkp",
  "public.tbl_product_categories_bkp",
  "public.tbl_product_variant_bkp",
  "public.stg_products",
  "public.product_search_record",
];

const REFERENCE_TABLES = [
  "public.tbl_roles",
  "public.tbl_permissions",
  "public.tbl_role_permissions",
  "public.tbl_approval_processes",
  "public.tbl_country_code",
  "public.tbl_location_country",
  "public.tbl_location_states",
  "public.tbl_location_cities",
  "public.tbl_category",
  "public.tbl_product_categories",
  // tbl_product + tbl_product_variant are needed because the vendor-eligibility
  // query joins through them to resolve a variant's category. Without these,
  // any test that exercises the eligibility / publish flow gets empty joins.
  "public.tbl_product",
  "public.tbl_product_variant",
  "public.tbl_charge_names",
];

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`missing ${ENV_PATH}`);
  }
  dotenv.config({ path: ENV_PATH, override: true });
  for (const k of ["HOST", "DATABASE_USERNAME", "DATABASE_PASSWORD", "DATABASE_NAME"]) {
    if (!process.env[k]) throw new Error(`${k} required in .env`);
  }
}

function runPgDump(args, outFile) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PGPASSWORD: process.env.DATABASE_PASSWORD };
    const child = spawn("pg_dump", args, { env });
    const out = fs.createWriteStream(outFile);
    child.stdout.pipe(out);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      out.end();
      if (code !== 0) {
        reject(new Error(`pg_dump exited ${code}: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}

function buildBaseArgs() {
  return [
    "-h", process.env.HOST,
    "-p", process.env.DATABASE_PORT || "5432",
    "-U", process.env.DATABASE_USERNAME,
    "-d", process.env.DATABASE_NAME,
    "--no-owner",
    "--no-privileges",
  ];
}

async function snapshotSchema() {
  const out = path.join(__dirname, "schema.sql");
  console.log(`[snapshotStaging] dumping schema from ${process.env.DATABASE_NAME}...`);
  const args = [
    ...buildBaseArgs(),
    "--schema-only",
    "--no-comments",
    ...SCHEMA_EXCLUDE_TABLES.flatMap((t) => ["--exclude-table", t]),
  ];
  await runPgDump(args, out);
  const lines = fs.readFileSync(out, "utf8").split("\n").length;
  console.log(`[snapshotStaging] schema.sql: ${lines} lines`);
}

async function snapshotReference() {
  const out = path.join(__dirname, "seed_reference.sql");
  console.log("[snapshotStaging] dumping reference data...");
  const args = [
    ...buildBaseArgs(),
    "--data-only",
    "--rows-per-insert=200",
    ...REFERENCE_TABLES.flatMap((t) => ["--table", t]),
  ];
  await runPgDump(args, out);
  const lines = fs.readFileSync(out, "utf8").split("\n").length;
  console.log(`[snapshotStaging] seed_reference.sql: ${lines} lines`);
}

async function main() {
  loadEnv();
  await snapshotSchema();
  await snapshotReference();
  console.log("[snapshotStaging] DONE — review diff and commit if changes look right.");
}

main().catch((err) => {
  console.error("ABORT:", err.message);
  process.exit(1);
});
