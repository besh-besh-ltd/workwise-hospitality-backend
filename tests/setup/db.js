// Test-side pg-promise instance. Mirrors app/config/dbConn.js but connects to
// the test database created by globalSetup. Exposes:
//   - db                : pg-promise instance bound to hospitality_test_<runId>
//   - withTx(fn)        : runs fn inside a tx and ALWAYS rolls back at the end
//                         (the default per-test isolation mode)
//   - truncateDynamic() : truncates dynamic tables between tests that need
//                         multiple committed transactions
//   - closeDb()         : releases the pool (call from afterAll if needed)

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Promise from "bluebird";
import pgp from "pg-promise";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_DIR = path.resolve(__dirname, "..", "..");

// Load .env.test so this file works whether called from Jest (where globalSetup
// already loaded it) or standalone (e.g. in a one-off Node REPL).
dotenv.config({ path: path.join(BACKEND_DIR, ".env.test"), override: false });

const dbName =
  process.env.TEST_DB_NAME_RESOLVED ||
  // Fallback: compute the same name envguard.js would compute.
  (() => {
    const prefix = process.env.TEST_DB_PREFIX || "hospitality_test";
    const runId =
      process.env.TEST_RUN_ID ||
      (process.env.GITHUB_RUN_ID ? `ci_${process.env.GITHUB_RUN_ID}` : null) ||
      (process.env.USER || "local")
        .replace(/[^a-zA-Z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
    return `${prefix}_${runId || "local"}`;
  })();

if (!/^hospitality_test(_[a-zA-Z0-9_-]+)?$/.test(dbName)) {
  throw new Error(`tests/setup/db.js refusing to connect to '${dbName}'`);
}

// pg-promise event hooks: retry transient connection drops once. RDS sometimes
// closes idle TLS sockets between sequential test suites; without retry the
// next query hits a "Client has encountered a connection error" or "read
// ECONNRESET" before pg-promise's pool replaces the dead client. The `error`
// event fires from the pool BEFORE the awaiting query's promise rejects, so
// we use it for diagnostics; actual retry is wrapped via a query proxy below.
const initOptions = {
  promiseLib: Promise,
  error(err, e) {
    // Suppress noisy stack on transient disconnects — they're retried below.
    if (isTransientDisconnect(err)) {
      // eslint-disable-next-line no-console
      console.warn(`[test-db] transient disconnect on query: ${err.code || err.message}`);
    }
  },
};
const factory = pgp(initOptions);
factory.pg.types.setTypeParser(1114, (s) => s); // raw timestamps, like prod

// Identifies the small set of pg-/network-level errors that mean "the
// connection died between dispatch and reply, retrying the same statement is
// safe (it never executed)." We deliberately exclude protocol-level errors
// like 25P02 (failed-tx) — those mean the SQL DID run, just inside a poisoned
// tx, so retrying the query alone won't help.
function isTransientDisconnect(err) {
  if (!err) return false;
  const msg = String(err.message || "");
  return (
    err.code === "ECONNRESET" ||
    err.code === "ETIMEDOUT" ||
    err.code === "57P01" || // admin_shutdown
    /Connection terminated/i.test(msg) ||
    /Client has encountered a connection error/i.test(msg) ||
    /read ECONNRESET/i.test(msg)
  );
}

// Local Postgres (brew) doesn't speak TLS; only enable SSL for RDS / remote.
const _useSsl = process.env.TEST_DB_NO_SSL !== "1";
const _rawDb = factory({
  host: process.env.HOST,
  port: Number(process.env.DATABASE_PORT || 5432),
  user: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  database: dbName,
  ssl: _useSsl ? { rejectUnauthorized: false } : false,
});

// Wrap the top-level query methods (`none`, `one`, `oneOrNone`, `any`,
// `manyOrNone`, `result`) to retry once on a transient connection drop.
// Transactions (`tx`) are NOT retried — re-running a tx that already partially
// committed could double-apply effects. Tests that hit a transient disconnect
// inside `db.tx(...)` will surface the error and rerun the suite if needed.
const RETRY_METHODS = ["none", "one", "oneOrNone", "any", "manyOrNone", "result"];
function withRetry(target, method) {
  return async function retried(...args) {
    try {
      return await target[method](...args);
    } catch (err) {
      if (!isTransientDisconnect(err)) throw err;
      // Wait 100ms for pool to swap in a fresh client, then retry once.
      await new Promise((r) => setTimeout(r, 100));
      // eslint-disable-next-line no-console
      console.warn(`[test-db] retrying after ${err.code || "disconnect"}: ${method}`);
      return target[method](...args);
    }
  };
}

export const db = new Proxy(_rawDb, {
  get(t, prop) {
    if (RETRY_METHODS.includes(prop)) return withRetry(t, prop);
    return t[prop];
  },
});

// Sentinel error used by withTx to force rollback without polluting the
// test's actual error path.
class _RollbackSentinel extends Error {
  constructor() {
    super("__test_rollback__");
    this.name = "_RollbackSentinel";
  }
}

/**
 * Wraps `fn(tx)` in a Postgres transaction that ALWAYS rolls back. Use this
 * for unit/integration tests that don't need durability — fast, isolated.
 *
 * If `fn` throws, the original error is re-thrown after rollback. Otherwise
 * the rollback happens silently and the test continues green.
 */
export async function withTx(fn) {
  let result;
  let userError;
  try {
    await db.tx(async (t) => {
      try {
        result = await fn(t);
      } catch (err) {
        userError = err;
      }
      // Force rollback regardless of whether fn succeeded.
      throw new _RollbackSentinel();
    });
  } catch (err) {
    if (!(err instanceof _RollbackSentinel)) {
      // Real DB-level error (e.g. constraint violation outside fn's catch).
      throw err;
    }
  }
  if (userError) throw userError;
  return result;
}

// Tables that hold dynamic per-test/per-run data. Truncated between tests that
// need multiple committed transactions (e.g. concurrency tests). Reference
// data, hospitality network, users, products, vendors, approval policies, and
// other fixture rows are NOT in this list — they survive across tests.
const DYNAMIC_TABLES = [
  "tbl_approval_actions",
  "tbl_approval_step_approvers",
  "tbl_approval_instance_steps",
  "tbl_approval_instance_change_log",
  "tbl_approval_instances",
  "tbl_lifecycle_history",
  "tbl_rfq_activity",
  "tbl_rfq_change_history",
  "tbl_rfq_clarification_message_files",
  "tbl_rfq_clarification_messages",
  "tbl_rfq_clarification_files",
  "tbl_rfq_clarifications",
  "tbl_rfq_persistent_jobs",
  "tbl_rfq_product_target_price",
  "tbl_rfq_product_tech_evaluation_clauses_files",
  "tbl_rfq_product_tech_evaluation_clauses",
  "tbl_rfq_product_tech_evaluation_comments_files",
  "tbl_rfq_product_tech_evaluation_comments",
  "tbl_rfq_product_tech_evaluation_vendors_response_files",
  "tbl_rfq_product_tech_evaluation_vendors_response",
  "tbl_rfq_product_tech_evaluation_cleared_vendors",
  "tbl_rfq_product_tech_eval_vendor_replacements",
  "tbl_rfq_product_tech_evaluation",
  "tbl_tech_evaluation_rounds",
  "tbl_quote_finalization_history",
  "tbl_quote_finalization",
  "tbl_quote_item_files",
  "tbl_quote_item_history",
  "tbl_quote_items",
  "tbl_quotes_files",
  "tbl_quotes_payment_terms",
  "tbl_quotes",
  "tbl_quote_activity",
  "tbl_quote_estimates_item",
  "tbl_quote_estimates",
  "tbl_negotiation_round_approvals",
  "tbl_negotiation_round_quotes",
  "tbl_negotiation_rounds",
  "tbl_purchase_order_document",
  "tbl_purchase_order_hsn_mapping",
  "tbl_purchase_order_tasks",
  "tbl_purchase_order_product",
  "tbl_rfq_purchase_order",
  "tbl_payment_milestone",
  "tbl_rfq_product_files",
  "tbl_rfq_files",
  "tbl_rfq_product_vendors",
  "tbl_rfq_products_specs",
  "tbl_rfq_products",
  "tbl_rfq_terms_map",
  "tbl_rfq_hotel_mappings",
  "tbl_rfq_quote_excel",
  "tbl_rfq_draft_sheets",
  "tbl_rfq_filters",
  "tbl_rfq",
  "tbl_notifications",
  "tbl_login_log",
  "tbl_token_login_data",
  "tbl_query_message_reads",
  "tbl_query_message_files",
  "tbl_query_messages",
];

/**
 * Truncates all dynamic tables. Reference data + most fixtures stay intact,
 * BUT the `TRUNCATE … CASCADE` chains through `tbl_vendor_payments` (FK →
 * tbl_rfq / tbl_quotes) and on into `tbl_vendor_hotel_category_subscription`
 * (FK → tbl_vendor_payments via payment_id), nuking the vendor-subscription
 * fixtures. To keep fixture invariants intact across tests, we re-run
 * `seedVendors` after the truncate. (We cannot simply add tbl_vendor_payments
 * to DYNAMIC_TABLES — that would still nuke subs via the same chain — and we
 * cannot drop CASCADE because then the truncate errors out on the existing FK.)
 *
 * Use between tests that span multiple committed transactions (e.g. concurrency
 * tests) where the withTx rollback isolation isn't applicable.
 */
export async function truncateDynamic() {
  const list = DYNAMIC_TABLES.map((t) => `public.${t}`).join(", ");
  await db.none(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  // Re-seed vendor subscriptions that were CASCADEd through tbl_vendor_payments.
  const { seedVendorSubscriptions } = await import("../fixtures/vendors.js");
  await db.tx(async (t) => seedVendorSubscriptions(t));
}

export async function closeDb() {
  await factory.end();
}
