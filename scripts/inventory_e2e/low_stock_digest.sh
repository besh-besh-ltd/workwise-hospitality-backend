#!/usr/bin/env bash
# Inventory E2E: run the daily low-stock digest NOW, once, against the local E2E
# database, instead of waiting for the 07:30 IST cron (reorderService.startLowStockSweeper).
#
#   scripts/inventory_e2e/low_stock_digest.sh              # today (IST)
#   E2E_DIGEST_DATE=2026-10-26 scripts/inventory_e2e/low_stock_digest.sh
#
# It calls the app's own runLowStockSweep() in a separate node process under the same
# environment and preloads as the E2E backend (egress guard, mail sink), so it can run
# while the backend is up. What it does, by design of the app:
#   - only hotels whose stock has STARTED (a FULL count approved, or an opening import)
#     are looked at; the seed starts none (runbook step 9 starts A1);
#   - per hotel, the active items at or below their reorder level become ONE in-app
#     notification (bell) per user holding inventory.update there, type
#     inventory_low_stock_digest; it is NOT an email, so nothing lands in the mail sink;
#   - once per hotel per IST day: a second run the same day reports alreadyDigested.
set -euo pipefail

cd "$(dirname "$0")/../.."
# shellcheck source=scripts/inventory_e2e/e2e_env.sh
source scripts/inventory_e2e/e2e_env.sh
export E2E_DIGEST_DATE="${E2E_DIGEST_DATE:-}"

exec node --experimental-json-modules \
  --import ./scripts/inventory_e2e/e2e_egress_guard.mjs \
  --import ./scripts/vendor_networks/e2e_mail_sink.mjs \
  --input-type=module -e '
import { runLowStockSweep } from "./app/services/inventory/reorderService.js";
import db, { pgp } from "./app/config/dbConn.js";
const today = process.env.E2E_DIGEST_DATE || null;
let code = 0;
try {
  const where = await db.one("SELECT current_database() AS db, host(inet_server_addr()) AS addr");
  if (where.db !== process.env.DATABASE_NAME || !["127.0.0.1", "::1"].includes(where.addr)) {
    throw new Error(`refusing: connected to ${where.db} at ${where.addr}`);
  }
  const out = await runLowStockSweep({ today });
  console.log("[low-stock-digest] sweep:", JSON.stringify(out));
  const rows = await db.any(
    `SELECT n.recipient_user_id, u.employee_code, n.title, n.message, n.action_url, n.additional_data
       FROM tbl_notifications n JOIN tbl_users u ON u.id = n.recipient_user_id
      WHERE n.type = $1 AND n.additional_data->>$2 = $3
      ORDER BY n.id`,
    ["inventory_low_stock_digest", "date", out.date ?? today ?? ""]
  );
  for (const r of rows) {
    console.log(`[low-stock-digest] bell -> ${r.employee_code} (user ${r.recipient_user_id}): ${r.title} | ${r.message} | ${r.action_url}`);
  }
  if (!rows.length) console.log("[low-stock-digest] no digest rows for that date (stock not started anywhere, or nothing below reorder)");
} catch (err) {
  console.error("[low-stock-digest] failed:", err.message);
  code = 1;
} finally {
  pgp.end();
}
process.exit(code);
'
