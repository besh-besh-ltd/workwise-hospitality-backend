/* eslint-disable no-console */
// Inventory module: LOCAL end-to-end seed (Task E3).
//
// Seeds the world the inventory E2E scenarios run against, into a LOCAL
// database built by the test harness (scripts/inventory_e2e/e2e_server.sh does
// both). See scripts/inventory_e2e/E2E_RUNBOOK.md.
//
//   node scripts/inventory_e2e/seed.mjs                 (hospitality_test_e2e_inventory @ 127.0.0.1)
//   node scripts/inventory_e2e/seed.mjs --db=hospitality_test_e2e_inventory --host=127.0.0.1
//
// SAFETY. Never reads any .env file (backend/.env points at the shared stage
// database). Connection settings come from --db/--host/--port/--user or the
// E2E_DB_* env vars only. Refuses unless the database name looks local
// (/^hospitality_test_|local|dev/, never prod/stage/staging/main) AND the host
// is localhost / 127.0.0.1 / ::1, and once connected asserts the server
// answered on loopback.
//
// IDEMPOTENT. Every row the seed writes has an id in 96801..96899, or hangs off
// one (a seed company, hotel, user, PO, RFQ, ARC or MR). A re-run first deletes
// that whole world, including everything an E2E run built on top of it (delivery
// plans, dispatches, GRNs, RTVs, short-closes, mark-outs, adjustments, counts,
// ledger rows, MRs, notifications, activity rows), then seeds it again. Nothing
// outside that world is touched.
//
// The ledger (tbl_inv_movement) is append-only: its trigger refuses DELETE. The
// cleanup disables that one trigger INSIDE the seed's transaction, deletes the
// seed companies' movements only, and re-enables it before commit. A failure
// rolls the ALTERs back with everything else, so the trigger is never left off.
// Stop the backend before re-seeding: ALTER TABLE waits for its lock.
//
// The world (ids are fixed, so the runbook can name them):
//   Company A "Saffron Hotels (E2E)": hotels A1 Mumbai (96801), A2 Pune (96802)
//   Company B "Indigo Resorts (E2E)": hotel B1 Panaji (96803), for isolation checks
//   users (password E2e@12345; buyers log in with an employee code):
//     96801 Storekeeper @ A1            INVE2E-STORE
//     96802 Inventory Controller @ A1+A2 (+ MR Raiser @ A1 F&B, A1 Housekeeping, A2) INVE2E-CTRL
//     96803 PO initiator / buyer, company A (awarding.create, MR raise/approve) INVE2E-BUYER
//     96804 Company B buyer + Inventory Controller (company B) INVE2E-BBUYER
//     96811 vendor FreshKart (hospitality vendor, active subscription) INVE2E-VENDOR
//   catalogue: 3 products / variants (paneer, basmati rice, shower cap)
//   inventory items with barcodes, unit conversions and par levels at A1/A2
//   stock NOT started at any hotel, no movements
//   PO 96801: multi-hotel RFQ PO (A1 + A2), vendor-accepted, no delivery plan yet
//   PO 96802: call-off PO (A1 only) from an active ARC contract, vendor-accepted
//   one live site-rep receive link for PO 96802 @ A1 (fixed token)

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import pgPromise from "pg-promise";

// ---------------------------------------------------------------------------
// Connection + guard
// ---------------------------------------------------------------------------

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const conn = {
  database: arg("db") || process.env.E2E_DB_NAME || "hospitality_test_e2e_inventory",
  host: arg("host") || process.env.E2E_DB_HOST || "127.0.0.1",
  port: Number(arg("port") || process.env.E2E_DB_PORT || 5432),
  user: arg("user") || process.env.E2E_DB_USER || os.userInfo().username,
  password: process.env.E2E_DB_PASSWORD || undefined,
  ssl: false,
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const LOCAL_DB = /^hospitality_test_|local|dev/;
const NEVER_DB = /prod|stage|staging|main/i;

if (!LOCAL_DB.test(conn.database) || NEVER_DB.test(conn.database)) {
  console.error(`ABORT: '${conn.database}' does not look like a local database (need /^hospitality_test_|local|dev/).`);
  process.exit(2);
}
if (!LOCAL_HOSTS.has(conn.host)) {
  console.error(`ABORT: host '${conn.host}' is not local (localhost / 127.0.0.1 / ::1).`);
  process.exit(2);
}

const pgp = pgPromise();
pgp.pg.types.setTypeParser(1114, (s) => s);
const db = pgp(conn);

const MANIFEST = process.env.E2E_SEED_MANIFEST || "/tmp/inv-e2e/seed.json";
const FRONTEND = (process.env.E2E_FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// The world's ids. Range 96801..96899.
// ---------------------------------------------------------------------------

const RANGE = [96801, 96899];
const PASSWORD = "E2e@12345";

const ID = Object.freeze({
  companyA: 96801, // tbl_company: buyer parent A
  companyB: 96802, // tbl_company: buyer parent B
  vendorCompany: 96811, // tbl_company: the vendor's company
  hospA: 96801, // tbl_hospitality_companies
  hospB: 96802,
  A1: 96801, // tbl_hospitality_company_hotels
  A2: 96802,
  B1: 96803,
  processA: 96801, // tbl_approval_processes
  processB: 96802,
  storekeeper: 96801, // tbl_users
  controller: 96802,
  buyer: 96803,
  buyerB: 96804,
  vendor: 96811,
  rfq: 96801,
  quote: 96801,
  rfqPo: 96801, // multi-hotel RFQ PO (A1 + A2)
  callOffPo: 96802, // call-off PO (A1)
  arc: 96801,
  contract: 96801,
  mr: 96801,
});

// Reference data (seed_reference.sql + the test fixtures every e2e DB carries).
const DEPT = { PROCUREMENT: 10201, ENGINEERING: 10202, FB: 10203, HOUSEKEEPING: 10204 };
const STATE_MH = 116;
const STATE_GOA = 115;
const CITY = { MUMBAI: 1056, PUNE: 1057, PANAJI: 1051 };
const CATEGORY = { DAIRY: 256, PANEER: 262, PROVISIONS: 227, RICE: 381, HOUSEKEEPING: 273, TOILETRIES: 313 };

const GSTIN = {
  companyA: "27AAKCS9701H1ZQ",
  A1: "27AAKCS9701H1ZQ",
  A2: "27AAKCS9701H2ZP",
  companyB: "30AABCI4402K1Z3",
  B1: "30AABCI4402K1Z3",
  vendor: "27AAGCF5521M1ZT",
};

// Catalogue (seed-owned global rows) and company A's stock items.
// unit = the PO / RFQ unit; stockUom = the stock item's unit; poToStock = factor.
const PRODUCTS = [
  {
    key: "paneer", id: 96801, name: "Fresh Paneer (E2E)", variant: "Fresh Paneer 1 kg block",
    sku: "E2E-PNR-1KG", hsn: "0406", categories: [CATEGORY.DAIRY, CATEGORY.PANEER],
    item: { id: 96801, name: "Paneer", code: "PNR-001", stockUom: "kg", trackExpiry: true, minShelfLifeDays: 3 },
    uoms: [],
    barcodes: [{ code: "8901234500019", pack: 1, label: "1 kg block (weighed: opens the qty pad)" }],
    levels: { A1: [5, 10, 30, "Cold room C1"], A2: [4, 8, 20, "Chiller 2"] },
  },
  {
    key: "rice", id: 96802, name: "Basmati Rice (E2E)", variant: "Basmati Rice 25 kg bag",
    sku: "E2E-RICE-25KG", hsn: "1006", categories: [CATEGORY.PROVISIONS, CATEGORY.RICE],
    item: { id: 96802, name: "Basmati Rice", code: "RICE-001", stockUom: "kg", trackExpiry: false, minShelfLifeDays: null },
    uoms: [{ label: "Bag", factor: 25 }],
    barcodes: [
      { code: "8901234500026", pack: 25, label: "25 kg bag (one scan = 25 kg = 1 Bag)" },
      { code: "8901234500033", pack: 1, label: "1 kg pack" },
    ],
    levels: { A1: [50, 100, 300, "Dry store R2"], A2: [25, 50, 150, "Dry store 1"] },
  },
  {
    key: "cap", id: 96803, name: "Shower Cap (E2E)", variant: "Shower Cap (guest amenity)",
    sku: "E2E-HK-CAP", hsn: "3924", categories: [CATEGORY.HOUSEKEEPING, CATEGORY.TOILETRIES],
    item: { id: 96803, name: "Shower Cap", code: "HK-CAP-001", stockUom: "pc", trackExpiry: false, minShelfLifeDays: null },
    uoms: [{ label: "Carton", factor: 100 }],
    barcodes: [
      { code: "8901234500040", pack: 1, label: "each" },
      { code: "8901234500057", pack: 100, label: "carton of 100" },
    ],
    levels: { A1: [100, 200, 600, "HK store S3"], A2: [50, 100, 300, "HK store 1"] },
  },
];
const P = Object.fromEntries(PRODUCTS.map((p) => [p.key, p]));
// Company B holds the SAME paneer barcode on its own item: a scan must resolve per tenant.
const B_ITEM = { id: 96811, name: "Paneer (Indigo)", code: "PNR-B-001" };

// The multi-hotel RFQ PO: [product, PO unit, qty, unit price, GST %, delivery period].
const RFQ_PO_LINES = [
  { key: "paneer", lineId: 96801, rfqProductId: 96801, quoteItemId: 96801, unit: "kg", qty: 40, price: 380, gst: 5 },
  { key: "rice", lineId: 96802, rfqProductId: 96802, quoteItemId: 96802, unit: "Bag", qty: 10, price: 2250, gst: 5 },
  { key: "cap", lineId: 96803, rfqProductId: 96803, quoteItemId: 96803, unit: "pc", qty: 500, price: 4, gst: 18 },
];
const DELIVERY_PERIOD = "3 days";
// The call-off PO and its rate contract (single-hotel ARC at A1, F&B).
const CONTRACT_LINES = [
  { key: "paneer", arcItemId: 96801, lineId: 96801, uom: "kg", rate: 360, gst: 5, committed: 600 },
  { key: "rice", arcItemId: 96802, lineId: 96802, uom: "Bag", rate: 2200, gst: 5, committed: 120 },
  { key: "cap", arcItemId: 96803, lineId: 96803, uom: "pc", rate: 3.8, gst: 18, committed: 10000 },
];
const CALL_OFF_LINES = [
  { key: "paneer", lineId: 96811, mrItemId: 96801, qty: 15 },
  { key: "cap", lineId: 96812, mrItemId: 96802, qty: 300 },
];

// Fixed site-rep token (local DB only): base64url(sha256(label)), the same 43-char shape
// generateReceiveToken() produces. Only its sha256 is stored, as issueSiteRepToken does.
const SITE_REP_TOKEN = crypto.createHash("sha256").update("inventory-e2e/site-rep/call-off-po/A1").digest("base64url");

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** "YYYY-MM-DD HH:mm:ss" IST wall clock `offsetMs` from now: how bid_end_date is stored. */
const istString = (offsetMs) => new Date(Date.now() + offsetMs + 5.5 * HOUR).toISOString().replace("T", " ").slice(0, 19);
const utcString = (offsetMs) => new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);
const isoDate = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const istDate = (days) => new Date(Date.now() + days * DAY + 5.5 * HOUR).toISOString().slice(0, 10);
const r2 = (n) => Math.round(n * 100) / 100;
const lineTotal = (qty, price, gst) => r2(qty * price * (1 + gst / 100));

// ---------------------------------------------------------------------------
// Cleanup: the whole world, including rows the E2E run created on top of it.
// ---------------------------------------------------------------------------

async function cleanup(t) {
  const [lo, hi] = RANGE;
  const inRange = (col) => `${col} BETWEEN ${lo} AND ${hi}`;
  const ids = async (sql, params) => (await t.any(sql, params)).map((r) => Number(r.id));

  const userIds = await ids(`SELECT id FROM tbl_users WHERE ${inRange("id")} OR email ILIKE '%@inv-e2e.example.invalid'`);
  const companyIds = await ids(`SELECT id FROM tbl_company WHERE ${inRange("id")}`);
  const hospIds = await ids(`SELECT id FROM tbl_hospitality_companies WHERE ${inRange("id")}`);
  const hotelIds = await ids(`SELECT id FROM tbl_hospitality_company_hotels WHERE ${inRange("id")} OR hospitality_company_id = ANY($1::int[])`, [hospIds]);
  const variantIds = PRODUCTS.map((p) => p.id);

  const rfqIds = await ids(
    `SELECT id FROM tbl_rfq WHERE ${inRange("id")} OR hospitality_company_id = ANY($1::int[]) OR hotel_id = ANY($2::int[]) OR created_by = ANY($3::int[])`,
    [hospIds, hotelIds, userIds]
  );
  const arcIds = await ids(`SELECT id FROM tbl_arc WHERE ${inRange("id")} OR hospitality_company_id = ANY($1::int[]) OR created_by = ANY($2::int[])`, [hospIds, userIds]);
  const contractIds = await ids(`SELECT id FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[]) OR vendor_id = ANY($2::int[])`, [arcIds, userIds]);
  const mrIds = await ids(`SELECT id FROM tbl_material_requisition WHERE hospitality_company_id = ANY($1::int[]) OR raised_by = ANY($2::int[])`, [hospIds, userIds]);
  const poIds = await ids(
    `SELECT id FROM tbl_rfq_purchase_order
      WHERE ${inRange("id")} OR rfq_id = ANY($1::int[]) OR arc_contract_id = ANY($2::bigint[]) OR source_mr_id = ANY($3::bigint[])
         OR finalized_vendor_id = ANY($4::int[]) OR initiated_by = ANY($4::int[]) OR company_id = ANY($5::int[])`,
    [rfqIds, contractIds, mrIds, userIds, companyIds]
  );
  const instanceIds = await ids(
    `SELECT id FROM tbl_approval_instances
      WHERE hospitality_company_id = ANY($1::int[]) OR initiated_by = ANY($2::int[])
         OR (entity_type = 'RFQ' AND entity_id = ANY($3::int[])) OR (entity_type = 'PO' AND entity_id = ANY($4::int[]))`,
    [hospIds, userIds, rfqIds, poIds]
  );

  const del = (sql, params) => t.none(sql, params);
  const H = [hospIds];

  // ---- Inventory (every table carries hospitality_company_id). Children first.
  await t.none(`ALTER TABLE tbl_inv_movement DISABLE TRIGGER tbl_inv_movement_immutable`);
  await del(`DELETE FROM tbl_inv_movement WHERE hospitality_company_id = ANY($1::int[])`, H);
  await t.none(`ALTER TABLE tbl_inv_movement ENABLE TRIGGER tbl_inv_movement_immutable`);
  for (const table of [
    "tbl_inv_batch", "tbl_inv_balance",
    "tbl_inv_count_line_event", "tbl_inv_count_line", "tbl_inv_count",
    "tbl_inv_adjustment_line", "tbl_inv_adjustment",
    "tbl_inv_out_line", "tbl_inv_out",
    "tbl_po_short_close",
    "tbl_rtv_line", "tbl_rtv",
    "tbl_grn_attachment", "tbl_grn_line_alloc", "tbl_grn_line", "tbl_grn",
  ]) {
    await del(`DELETE FROM ${table} WHERE hospitality_company_id = ANY($1::int[])`, H);
  }
  await del(`DELETE FROM tbl_purchase_order_document WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
  for (const table of ["tbl_po_dispatch_line", "tbl_po_dispatch", "tbl_po_delivery_line", "tbl_po_delivery"]) {
    await del(`DELETE FROM ${table} WHERE hospitality_company_id = ANY($1::int[])`, H);
  }
  await del(`DELETE FROM tbl_token_login_data WHERE token_type = 'GRN' AND (entity_id = ANY($1::bigint[]) OR hotel_id = ANY($2::int[]) OR added_by = ANY($3::int[]))`, [poIds, hotelIds, userIds]);
  for (const table of [
    "tbl_inv_doc_sequence", "tbl_inv_hotel_item", "tbl_inv_item_barcode", "tbl_inv_item_uom", "tbl_inv_item_variant",
    "tbl_inv_item", "tbl_inv_category_default", "tbl_inv_hotel_settings", "tbl_inv_company_settings",
  ]) {
    await del(`DELETE FROM ${table} WHERE hospitality_company_id = ANY($1::int[])`, H);
  }

  // ---- Purchase orders (RFQ awards, call-offs, and any MR release the run made).
  await del(`DELETE FROM tbl_arc_callof_po WHERE po_id = ANY($1::int[]) OR mr_id = ANY($2::bigint[]) OR arc_contract_id = ANY($3::bigint[])`, [poIds, mrIds, contractIds]);
  await del(
    `DELETE FROM tbl_lifecycle_history
      WHERE (entity_type = 'PO' AND entity_id = ANY($1::int[]))
         OR (entity_type IN ('RFQ', 'TENDER') AND entity_id = ANY($2::int[]))
         OR (entity_type = 'ARC' AND entity_id = ANY($3::int[]))
         OR performed_by = ANY($4::int[])`,
    [poIds, rfqIds, arcIds, userIds]
  );
  await del(`DELETE FROM tbl_po_send_back_files WHERE uploaded_by = ANY($1::int[])`, [userIds]);
  await del(`DELETE FROM tbl_po_send_backs WHERE purchase_order_id = ANY($1::int[]) OR rfq_id = ANY($2::int[])`, [poIds, rfqIds]);
  await del(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
  await del(`DELETE FROM tbl_purchase_order_tasks WHERE po_id = ANY($1::int[]) OR rfq_id = ANY($2::int[])`, [poIds, rfqIds]);
  await del(`DELETE FROM tbl_payment_milestone WHERE po_id = ANY($1::int[]) OR rfq_id = ANY($2::int[])`, [poIds, rfqIds]);
  await del(`UPDATE tbl_rfq_purchase_order SET replaces_po_id = NULL WHERE replaces_po_id = ANY($1::int[])`, [poIds]);
  await del(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [poIds]);

  // ---- Material requisitions.
  await del(`DELETE FROM tbl_material_requisition_item WHERE mr_id = ANY($1::bigint[]) OR arc_contract_id = ANY($2::bigint[])`, [mrIds, contractIds]);
  await del(`DELETE FROM tbl_material_requisition WHERE id = ANY($1::bigint[])`, [mrIds]);

  // ---- Approval instances (steps/actions cascade; step approvers hang off steps).
  await del(
    `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
       (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
    [instanceIds]
  );
  await del(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);

  // ---- RFQs.
  await del(`DELETE FROM tbl_quotes_payment_terms WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`, [rfqIds]);
  await del(`DELETE FROM tbl_quote_item_history WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE rfq_id = ANY($1::int[]))`, [rfqIds]);
  for (const table of [
    "tbl_quote_activity", "tbl_quote_finalization_history", "tbl_quote_finalization", "tbl_quote_items", "tbl_quotes",
    "tbl_rfq_terms_map", "tbl_rfq_activity", "tbl_rfq_clarifications", "tbl_vendor_payments",
    "tbl_rfq_product_vendors", "tbl_rfq_products_specs", "tbl_rfq_products", "tbl_rfq_hotel_mappings",
  ]) {
    await del(`DELETE FROM ${table} WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  }
  await del(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);

  // ---- ARC (the order the vendor-networks seed uses).
  await del(`DELETE FROM tbl_arc_amendment WHERE arc_contract_id = ANY($1::bigint[])`, [contractIds]);
  await del(
    `DELETE FROM tbl_arc_contract_line_hotel WHERE arc_contract_line_id IN
       (SELECT id FROM tbl_arc_contract_line WHERE arc_contract_id = ANY($1::bigint[]))`,
    [contractIds]
  );
  await del(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = ANY($1::bigint[])`, [contractIds]);
  await del(`DELETE FROM tbl_arc_contract WHERE id = ANY($1::bigint[])`, [contractIds]);
  await del(`DELETE FROM tbl_arc_hotel_mappings WHERE arc_id = ANY($1::bigint[]) OR hotel_id = ANY($2::int[])`, [arcIds, hotelIds]);
  await del(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [arcIds]); // items, invitations, event log cascade

  // ---- Side tables keyed by user / company.
  await del(`DELETE FROM tbl_notifications WHERE recipient_user_id = ANY($1::int[]) OR sender_user_id = ANY($1::int[])`, [userIds]);
  await del(
    `DELETE FROM tbl_activity_events WHERE actor_user_id = ANY($1::int[]) OR hospitality_company_id = ANY($2::int[]) OR buyer_company_id = ANY($3::int[])`,
    [userIds, hospIds, companyIds]
  );
  await del(`DELETE FROM tbl_report_exports WHERE requested_by = ANY($1::int[]) OR hospitality_company_id = ANY($2::int[])`, [userIds, hospIds]);
  await del(`DELETE FROM tbl_approval_delegations WHERE created_by = ANY($1::int[]) OR delegate_user_id = ANY($1::int[]) OR delegator_user_id = ANY($1::int[])`, [userIds]);

  // ---- Vendor subscriptions and catalogue mappings.
  await del(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = ANY($1::int[])`, [userIds]);
  await del(`DELETE FROM tbl_product_variant_vendor_mapping WHERE vendor_id = ANY($1::int[]) OR product_variant_id = ANY($2::int[])`, [userIds, variantIds]);

  // ---- Buyer configuration.
  await del(`DELETE FROM tbl_approval_policies WHERE hospitality_company_id = ANY($1::int[])`, H); // steps cascade
  await del(`DELETE FROM tbl_approval_processes WHERE company_id = ANY($1::int[]) OR ${inRange("id")}`, [companyIds]);
  await del(`DELETE FROM tbl_approval_hierarchy WHERE company_id = ANY($1::int[]) OR user_id = ANY($2::int[])`, [companyIds, userIds]);
  await del(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[]) OR company_id = ANY($2::int[])`, [userIds, hospIds]);
  await del(`DELETE FROM tbl_user_department WHERE user_id = ANY($1::int[])`, [userIds]);
  await del(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[]) OR hospitality_company_id = ANY($2::int[])`, [userIds, hospIds]);

  // ---- Identities.
  await del(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [userIds]);
  await del(`DELETE FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[])`, [hotelIds]);
  await del(`DELETE FROM tbl_hospitality_companies WHERE id = ANY($1::int[])`, H);
  await del(`DELETE FROM tbl_company_location WHERE company_id = ANY($1::int[])`, [companyIds]);
  await del(`DELETE FROM tbl_company WHERE id = ANY($1::int[])`, [companyIds]);

  // ---- Catalogue (seed-owned global rows).
  await del(`DELETE FROM tbl_product_categories WHERE product_id = ANY($1::int[])`, [variantIds]);
  await del(`DELETE FROM tbl_product_variant WHERE id = ANY($1::int[])`, [variantIds]);
  await del(`DELETE FROM tbl_product WHERE id = ANY($1::int[])`, [variantIds]);

  return { users: userIds.length, pos: poIds.length, rfqs: rfqIds.length };
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function roleIds(t) {
  const titles = ["Storekeeper", "Inventory Controller", "Final Awarding P1", "RFQ Observer", "MR Raiser", "MR Approver"];
  const rows = await t.any(`SELECT id, title FROM tbl_roles WHERE title = ANY($1::text[]) AND created_by IS NULL`, [titles]);
  const map = Object.fromEntries(rows.map((r) => [r.title, Number(r.id)]));
  const missing = titles.filter((x) => !map[x]);
  if (missing.length) {
    throw new Error(`system roles missing: ${missing.join(", ")} (did the inventory migrations run?)`);
  }
  return map;
}

async function seedBuyerSide(t, hash, roles) {
  await t.none(
    `INSERT INTO tbl_company (id, company_name, is_hospitality, gstin, "createdAt")
     VALUES ($1, 'Saffron Hotels Pvt Ltd (E2E)', 1, $2, now()), ($3, 'Indigo Resorts Pvt Ltd (E2E)', 1, $4, now())`,
    [ID.companyA, GSTIN.companyA, ID.companyB, GSTIN.companyB]
  );
  await t.none(
    `INSERT INTO tbl_hospitality_companies (id, buyer_company_id, name, gst, registered_office_address, contact_email)
     VALUES ($1, $2, 'Saffron Hotels (E2E)', $3, 'Nariman Point, Mumbai 400021', 'procurement@inv-e2e.example.invalid'),
            ($4, $5, 'Indigo Resorts (E2E)', $6, 'Miramar, Panaji 403001', 'procurement.b@inv-e2e.example.invalid')`,
    [ID.hospA, ID.companyA, GSTIN.companyA, ID.hospB, ID.companyB, GSTIN.companyB]
  );
  const hotels = [
    [ID.A1, ID.hospA, "Saffron Grand Mumbai (A1)", "Mumbai", "Maharashtra", STATE_MH, CITY.MUMBAI, GSTIN.A1, "Marine Drive, Mumbai 400020"],
    [ID.A2, ID.hospA, "Saffron Residency Pune (A2)", "Pune", "Maharashtra", STATE_MH, CITY.PUNE, GSTIN.A2, "Koregaon Park, Pune 411001"],
    [ID.B1, ID.hospB, "Indigo Bay Goa (B1)", "Panaji", "Goa", STATE_GOA, CITY.PANAJI, GSTIN.B1, "Dona Paula, Panaji 403004"],
  ];
  for (const [id, hosp, name, city, state, stateId, cityId, gst, address] of hotels) {
    await t.none(
      `INSERT INTO tbl_hospitality_company_hotels
         (id, hospitality_company_id, name, city, state, state_id, city_id, gst, status, full_address, delivery_address, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Active', $9, $9, 'paid')`,
      [id, hosp, name, city, state, stateId, cityId, gst, address]
    );
  }

  const users = [
    // [id, name, email, mobile, company, employee code, designation, department]
    [ID.storekeeper, "Sunita Rao (Storekeeper A1, E2E)", "storekeeper.a1@inv-e2e.example.invalid", "9000096801", ID.companyA, "INVE2E-STORE", "Storekeeper", DEPT.FB],
    [ID.controller, "Vikram Shah (Inventory Controller, E2E)", "inventory.controller@inv-e2e.example.invalid", "9000096802", ID.companyA, "INVE2E-CTRL", "Inventory Controller", DEPT.PROCUREMENT],
    [ID.buyer, "Priya Nair (Purchase Manager, E2E)", "buyer.a@inv-e2e.example.invalid", "9000096803", ID.companyA, "INVE2E-BUYER", "Purchase Manager", DEPT.PROCUREMENT],
    [ID.buyerB, "Arjun Desai (Indigo buyer, E2E)", "buyer.b@inv-e2e.example.invalid", "9000096804", ID.companyB, "INVE2E-BBUYER", "Purchase Manager", DEPT.PROCUREMENT],
  ];
  for (const [id, name, email, mobile, company, code, designation, dept] of users) {
    await t.none(
      `INSERT INTO tbl_users (id, name, email, mobile, user_type, status, is_deleted, company_id, employee_code, designation, password)
       VALUES ($1, $2, $3, $4, 2, 1, 0, $5, $6, $7, $8)`,
      [id, name, email, mobile, company, code, designation, hash]
    );
    await t.none(`INSERT INTO tbl_user_department (user_id, department_id) VALUES ($1, $2)`, [id, dept]);
  }

  // Company + hotel mappings (how the app lists a user's companies and hotels).
  const mappings = [
    [ID.storekeeper, ID.hospA, [ID.A1]],
    [ID.controller, ID.hospA, [ID.A1, ID.A2]],
    [ID.buyer, ID.hospA, [ID.A1, ID.A2]],
    [ID.buyerB, ID.hospB, [ID.B1]],
  ];
  for (const [userId, hosp, hotelIds] of mappings) {
    await t.none(
      `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type) VALUES ($1, $2, NULL, 0)`,
      [userId, hosp]
    );
    for (const hotelId of hotelIds) {
      await t.none(
        `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type) VALUES ($1, $2, $3, 1)`,
        [userId, hosp, hotelId]
      );
    }
  }

  // Role scopes, as the admin screens write them (tbl_user_role_scopes.company_id is the
  // HOSPITALITY company; hotel NULL = every hotel; department/process NULL = all).
  // [user, role, hospitality company, hotel, department (optional, NULL = all)]
  //
  // Reorder's MR draft needs mr.create at the exact hotel/department cell (D3's gate).
  // MR Raiser is the platform role that carries mr.create, so the controller holds it
  // pinned to A1 / F&B (where ARC 96801 is) and A1 / Housekeeping (no contract there, so
  // a draft is refused NOT_CONTRACTED rather than FORBIDDEN). The storekeeper holds no
  // mr.* permission and must not be able to draft an MR.
  const scopes = [
    [ID.storekeeper, roles["Storekeeper"], ID.hospA, ID.A1],
    [ID.controller, roles["Inventory Controller"], ID.hospA, ID.A1],
    [ID.controller, roles["Inventory Controller"], ID.hospA, ID.A2],
    [ID.controller, roles["MR Raiser"], ID.hospA, ID.A1, DEPT.FB],
    [ID.controller, roles["MR Raiser"], ID.hospA, ID.A1, DEPT.HOUSEKEEPING],
    [ID.controller, roles["MR Raiser"], ID.hospA, ID.A2],
    [ID.buyer, roles["Final Awarding P1"], ID.hospA, null],
    [ID.buyer, roles["RFQ Observer"], ID.hospA, null],
    [ID.buyer, roles["MR Raiser"], ID.hospA, null],
    [ID.buyer, roles["MR Approver"], ID.hospA, null],
    [ID.buyerB, roles["Final Awarding P1"], ID.hospB, null],
    [ID.buyerB, roles["Inventory Controller"], ID.hospB, null],
  ];
  for (const [userId, roleId, hosp, hotelId, departmentId = null] of scopes) {
    await t.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [userId, roleId, hosp, hotelId, departmentId]
    );
  }

  await t.none(
    `INSERT INTO tbl_approval_processes (id, company_id, name, description, is_active, created_by, process_type)
     VALUES ($1, $2, 'Standard Procurement (E2E)', 'Inventory E2E', true, $3, 'RFQ'),
            ($4, $5, 'Standard Procurement (E2E B)', 'Inventory E2E', true, $6, 'RFQ')`,
    [ID.processA, ID.companyA, ID.buyer, ID.processB, ID.companyB, ID.buyerB]
  );
  // Company-wide one-step policies naming the buyer: an MR raised from Reorder (or a PO the
  // run initiates) has an approver, and the buyer's own submissions approve on submission.
  let policyId = RANGE[0];
  for (const entity of ["PO", "MR"]) {
    await t.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id, is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, $2, $3, NULL, NULL, true, $4, NULL, false, false, 1)`,
      [policyId, entity, ID.hospA, ID.buyer]
    );
    await t.none(
      `INSERT INTO tbl_approval_policy_steps (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ANY', 'USER', $2)`,
      [policyId, ID.buyer]
    );
    policyId += 1;
  }
}

async function seedVendor(t, hash) {
  await t.none(
    `INSERT INTO tbl_company (id, company_name, is_hospitality, gstin, location, "createdAt")
     VALUES ($1, 'FreshKart Foods & Supplies (E2E)', 1, $2, 'Turbhe MIDC, Navi Mumbai 400705', now())`,
    [ID.vendorCompany, GSTIN.vendor]
  );
  // Vendors log in by email; this one's email is undeliverable (.invalid), which the login
  // route's Joi .email() refuses, so it also carries an employee code to log in with.
  await t.none(
    `INSERT INTO tbl_users (id, name, email, mobile, user_type, status, is_deleted, company_id, employee_code, password)
     VALUES ($1, 'FreshKart Foods & Supplies (E2E)', 'vendor.freshkart@inv-e2e.example.invalid', '9000096811', 3, 1, 0, $2, 'INVE2E-VENDOR', $3)`,
    [ID.vendor, ID.vendorCompany, hash]
  );
  await t.none(
    `INSERT INTO tbl_company_location (company_id, country_id, state_id, city_id, address) VALUES ($1, 1, $2, $3, 'Turbhe MIDC, Navi Mumbai 400705')`,
    [ID.vendorCompany, STATE_MH, CITY.MUMBAI]
  );
  // Admin-assigned (payment_id NULL), active for a year: the subscription gate on vendor
  // dispatch (requireActiveSubscriptionForIssuedPo) passes for a hospitality vendor.
  const subs = [
    ["category", CATEGORY.DAIRY], ["category", CATEGORY.PROVISIONS], ["category", CATEGORY.HOUSEKEEPING],
    ["subcategory", CATEGORY.PANEER], ["subcategory", CATEGORY.RICE], ["subcategory", CATEGORY.TOILETRIES],
    ["hotel", ID.A1], ["hotel", ID.A2],
  ];
  for (const [itemType, itemId] of subs) {
    await t.none(
      `INSERT INTO tbl_vendor_hotel_category_subscription (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
       VALUES ($1, $2, $3, 0, $4, $5, 'active')`,
      [ID.vendor, itemType, itemId, isoDate(-30), isoDate(335)]
    );
  }
}

async function seedCatalogue(t) {
  for (const p of PRODUCTS) {
    const slug = p.sku.toLowerCase();
    await t.none(
      `INSERT INTO tbl_product (id, name, description, slug, sku, created_by, updated_by, status, is_deleted, added_by, is_approve, approved_at)
       VALUES ($1, $2, 'Inventory E2E catalogue product', $3, $4, $5, $5, 1, 0, $5, 1, now())`,
      [p.id, p.name, slug, p.sku, ID.buyer]
    );
    await t.none(
      `INSERT INTO tbl_product_variant (id, name, slug, sku, created_by, updated_by, status, is_deleted, added_by, is_approve, product_id, approved_at, hsn_code)
       VALUES ($1, $2, $3, $4, $5, $5, 1, 0, $5, 1, $1, now(), $6)`,
      [p.id, p.variant, slug, p.sku, ID.buyer, p.hsn]
    );
    for (const categoryId of p.categories) {
      await t.none(`INSERT INTO tbl_product_categories (product_id, category_id) VALUES ($1, $2)`, [p.id, categoryId]);
    }
    await t.none(
      `INSERT INTO tbl_product_variant_vendor_mapping (product_variant_id, vendor_id, status, is_approved, approved_at, created_at, updated_at)
       VALUES ($1, $2, true, true, now(), now(), now())`,
      [p.id, ID.vendor]
    );
  }
}

async function seedInventory(t) {
  // Company A: settings at the defaults the scenarios rely on (0% over-receipt tolerance,
  // no negative stock, GST not in cost, EVERY adjustment needs approval, no count freeze).
  await t.none(
    `INSERT INTO tbl_inv_company_settings
       (hospitality_company_id, over_receipt_tolerance_pct, allow_negative_stock, include_gst_in_cost,
        adjustment_auto_approve_limit, count_freeze, created_by, updated_by)
     VALUES ($1, 0, false, false, 0, false, $2, $2), ($3, 0, false, false, 0, false, $4, $4)`,
    [ID.hospA, ID.controller, ID.hospB, ID.buyerB]
  );
  // Doc codes for readable numbers (GRN/A1/2026-27/00001). stock_started_at stays NULL.
  for (const [hotelId, hosp, code] of [[ID.A1, ID.hospA, "A1"], [ID.A2, ID.hospA, "A2"], [ID.B1, ID.hospB, "B1"]]) {
    await t.none(
      `INSERT INTO tbl_inv_hotel_settings (hotel_id, hospitality_company_id, doc_code, created_by, updated_by) VALUES ($1, $2, $3, NULL, NULL)`,
      [hotelId, hosp, code]
    );
  }
  for (const p of PRODUCTS) {
    const it = p.item;
    await t.none(
      `INSERT INTO tbl_inv_item (id, hospitality_company_id, display_name, item_code, stock_uom, track_expiry, min_shelf_life_days, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [it.id, ID.hospA, it.name, it.code, it.stockUom, it.trackExpiry, it.minShelfLifeDays, ID.controller]
    );
    await t.none(
      `INSERT INTO tbl_inv_item_variant (hospitality_company_id, inv_item_id, product_variant_id, created_by) VALUES ($1, $2, $3, $4)`,
      [ID.hospA, it.id, p.id, ID.controller]
    );
    for (const u of p.uoms) {
      await t.none(
        `INSERT INTO tbl_inv_item_uom (hospitality_company_id, inv_item_id, uom_label, factor_to_stock, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [ID.hospA, it.id, u.label, u.factor, ID.controller]
      );
    }
    for (const b of p.barcodes) {
      await t.none(
        `INSERT INTO tbl_inv_item_barcode (hospitality_company_id, inv_item_id, code, pack_factor, source, created_by)
         VALUES ($1, $2, $3, $4, 'MANUFACTURER', $5)`,
        [ID.hospA, it.id, b.code, b.pack, ID.controller]
      );
    }
    for (const [hotelKey, [min, reorder, max, bin]] of Object.entries(p.levels)) {
      await t.none(
        `INSERT INTO tbl_inv_hotel_item (hotel_id, inv_item_id, hospitality_company_id, min_qty, reorder_level, max_qty, bin_label, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [ID[hotelKey], it.id, ID.hospA, min, reorder, max, bin, ID.controller]
      );
    }
  }
  // Company B: its own paneer item carrying the SAME barcode (tenant-scoped resolve check).
  await t.none(
    `INSERT INTO tbl_inv_item (id, hospitality_company_id, display_name, item_code, stock_uom, track_expiry, min_shelf_life_days, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'kg', true, 3, $5, $5)`,
    [B_ITEM.id, ID.hospB, B_ITEM.name, B_ITEM.code, ID.buyerB]
  );
  await t.none(
    `INSERT INTO tbl_inv_item_variant (hospitality_company_id, inv_item_id, product_variant_id, created_by) VALUES ($1, $2, $3, $4)`,
    [ID.hospB, B_ITEM.id, P.paneer.id, ID.buyerB]
  );
  await t.none(
    `INSERT INTO tbl_inv_item_barcode (hospitality_company_id, inv_item_id, code, pack_factor, source, created_by)
     VALUES ($1, $2, $3, 1, 'MANUFACTURER', $4)`,
    [ID.hospB, B_ITEM.id, P.paneer.barcodes[0].code, ID.buyerB]
  );
  await t.none(
    `INSERT INTO tbl_inv_hotel_item (hotel_id, inv_item_id, hospitality_company_id, min_qty, reorder_level, max_qty, bin_label)
     VALUES ($1, $2, $3, 2, 5, 15, 'Cold room')`,
    [ID.B1, B_ITEM.id, ID.hospB]
  );
}

/** The multi-hotel RFQ PO (A1 + A2), awarded to the vendor and accepted yesterday. */
async function seedRfqPo(t) {
  await t.none(
    `INSERT INTO tbl_rfq (
       id, rfq_no, comment, company_name, response_email, contact_name, contact_number, bid_end_date, location,
       is_published, status, created_by, updated_by, "timestamp", hospitality_company_id, hotel_id, department_id,
       process_id, is_tender, tender_publish_date, vendor_clarification_date, title, rfq_type)
     VALUES ($1, 9680001, 'Monthly dairy, rice and guest amenities for Mumbai and Pune.', 'Saffron Hotels (E2E)',
             'buyer.a@inv-e2e.example.invalid', 'Priya Nair', '9000096803', $2, 'Mumbai + Pune',
             1, 1, $3, $3, now() - interval '14 days', $4, $5, $6, $7, 0, $8, $9,
             '[E2E-INV] Dairy, rice and guest amenities: Mumbai + Pune', 'RFQ')`,
    [ID.rfq, istString(-5 * DAY), ID.buyer, ID.hospA, ID.A1, DEPT.PROCUREMENT, ID.processA, utcString(-12 * DAY), utcString(-8 * DAY)]
  );
  for (const hotelId of [ID.A1, ID.A2]) {
    await t.none(`INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`, [ID.rfq, hotelId, ID.buyer]);
  }
  await t.none(
    `INSERT INTO tbl_quotes (id, rfq_id, rfq_no, created_by, updated_by, gstin) VALUES ($1, $2, 9680001, $3, $3, $4)`,
    [ID.quote, ID.rfq, ID.vendor, GSTIN.vendor]
  );
  let subtotal = 0;
  let total = 0;
  for (const l of RFQ_PO_LINES) {
    const p = P[l.key];
    await t.none(
      `INSERT INTO tbl_rfq_products (id, rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, $2, '', '', '', '', '', $3, 0)`,
      [l.rfqProductId, ID.rfq, p.id]
    );
    await t.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, $2, 'Quantity', $3, 0), ($1, $2, 'Unit', $4, 0)`,
      [ID.rfq, p.id, String(l.qty), l.unit]
    );
    await t.none(`INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, $2, $3, 0)`, [ID.rfq, p.id, ID.vendor]);
    const lt = lineTotal(l.qty, l.price, l.gst);
    await t.none(
      `INSERT INTO tbl_quote_items
         (id, rfq_id, rfq_no, quote_id, product_variant_id, unit_price, tax, tax_mode, total_price, comment, delivery_period, product_name, quantity)
       VALUES ($1, $2, 9680001, $3, $4, $5, $6, 'percentage', $7, '', $8, $9, $10)`,
      [l.quoteItemId, ID.rfq, ID.quote, p.id, l.price, l.gst, lt, DELIVERY_PERIOD, p.variant, String(l.qty)]
    );
    subtotal += l.qty * l.price;
    total += lt;
  }
  const first = RFQ_PO_LINES[0];
  await t.none(
    `INSERT INTO tbl_rfq_purchase_order
       (id, rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price, finalized_vendor_id, total_value,
        quote_id, initiated_by, created_at, updated_at, gstin, terms_and_conditions, vendor_action_at)
     VALUES ($1, $2, $3, 'E2E-INV-PO-1001', 'approved', $4, $5, $6, $7, $8, $9, $10,
             now() - interval '3 days', now() - interval '1 day', $11,
             'Deliver to each hotel''s receiving bay between 07:00 and 11:00.', now() - interval '1 day')`,
    [
      ID.rfqPo, ID.rfq, ID.companyA, RFQ_PO_LINES.map((l) => l.rfqProductId), first.qty, first.price, ID.vendor, r2(total),
      RFQ_PO_LINES.map((l) => l.quoteItemId), ID.buyer, GSTIN.A1,
    ]
  );
  for (const l of RFQ_PO_LINES) {
    await t.none(
      `INSERT INTO tbl_purchase_order_product
         (id, purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, charges_meta, total_price, product_variant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [l.lineId, ID.rfqPo, l.rfqProductId, l.quoteItemId, l.qty, l.unit, l.price,
        JSON.stringify({ tax: l.gst, tax_mode: "percentage" }), lineTotal(l.qty, l.price, l.gst), P[l.key].id]
    );
  }
  return { subtotal: r2(subtotal), total: r2(total) };
}

/** An active single-hotel ARC at A1 (F&B), an MR released against it, and its call-off PO. */
async function seedCallOff(t) {
  await t.none(
    `INSERT INTO tbl_arc (id, arc_number, title, description, category_id, hospitality_company_id, hotel_id, department_id, process_id,
                          status, is_group, submission_start_at, submission_end_at, contract_start_at, contract_end_at,
                          payment_terms_expected, delivery_expected, created_by)
     VALUES ($1, 'ARC-E2E-INV-0001', '[E2E-INV] Kitchen and amenities rate contract, Mumbai', 'Annual rates for paneer, rice and shower caps.',
             $2, $3, $4, $5, $6, 'contract_active', false,
             now() - interval '60 days', now() - interval '45 days', now() - interval '30 days', now() + interval '335 days',
             '30 days from invoice', 'Within 2 days of call-off', $7)`,
    [ID.arc, CATEGORY.DAIRY, ID.hospA, ID.A1, DEPT.FB, ID.processA, ID.buyer]
  );
  await t.none(`INSERT INTO tbl_arc_hotel_mappings (arc_id, hotel_id, created_by) VALUES ($1, $2, $3)`, [ID.arc, ID.A1, ID.buyer]);
  await t.none(
    `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status, responded_at) VALUES ($1, $2, 'submitted', now() - interval '50 days')`,
    [ID.arc, ID.vendor]
  );
  await t.none(
    `INSERT INTO tbl_arc_contract (id, arc_id, vendor_id, status, generated_at, signed_by_vendor_at)
     VALUES ($1, $2, $3, 'active', now() - interval '31 days', now() - interval '30 days')`,
    [ID.contract, ID.arc, ID.vendor]
  );
  const consumed = Object.fromEntries(CALL_OFF_LINES.map((c) => [c.key, c.qty]));
  for (const c of CONTRACT_LINES) {
    await t.none(
      `INSERT INTO tbl_arc_item (id, arc_id, product_variant_id, indicative_qty, uom, hsn) VALUES ($1, $2, $3, $4, $5, $6)`,
      [c.arcItemId, ID.arc, P[c.key].id, c.committed, c.uom, P[c.key].hsn]
    );
    await t.none(
      `INSERT INTO tbl_arc_contract_line (id, arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty, consumed_qty, payment_terms, delivery_terms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '30 days from invoice', 'Within 2 days of call-off')`,
      [c.lineId, ID.contract, c.arcItemId, c.rate, c.gst, c.committed, consumed[c.key] ?? 0]
    );
  }
  const requiredBy = istDate(2);
  await t.none(
    `INSERT INTO tbl_material_requisition
       (id, mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, required_by_date, justification,
        delivery_location, status, raised_by, submitted_at, created_at)
     VALUES ($1, 'MR-E2E-INV-0001', 'Kitchen + amenities top-up, Mumbai', $2, $3, $4, 'normal', $5,
             'Weekend banquet', 'Main kitchen receiving bay', 'po_released', $6, now() - interval '2 days', now() - interval '2 days')`,
    [ID.mr, ID.hospA, ID.A1, DEPT.FB, requiredBy, ID.buyer]
  );
  const rate = Object.fromEntries(CONTRACT_LINES.map((c) => [c.key, c]));
  let total = 0;
  const poQty = CALL_OFF_LINES.reduce((s, c) => s + c.qty, 0);
  for (const c of CALL_OFF_LINES) total += lineTotal(c.qty, rate[c.key].rate, rate[c.key].gst);
  await t.none(
    `INSERT INTO tbl_rfq_purchase_order
       (id, rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price, finalized_vendor_id, total_value,
        quote_id, arc_contract_id, source_mr_id, is_call_off, initiated_by, created_at, updated_at, gstin, vendor_action_at)
     VALUES ($1, NULL, $2, 'E2E-INV-CO-1002', 'approved', '{}', $3, $4, $5, $6, '{}', $7, $8, true, $9,
             now() - interval '2 days', now() - interval '1 day', $10, now() - interval '1 day')`,
    [ID.callOffPo, ID.companyA, poQty, rate.paneer.rate, ID.vendor, r2(total), ID.contract, ID.mr, ID.buyer, GSTIN.A1]
  );
  for (const c of CALL_OFF_LINES) {
    const cl = rate[c.key];
    await t.none(
      `INSERT INTO tbl_material_requisition_item (id, mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [c.mrItemId, ID.mr, P[c.key].id, c.qty, cl.uom, ID.contract, cl.lineId, cl.rate]
    );
    await t.none(
      `INSERT INTO tbl_purchase_order_product
         (id, purchase_order_id, quantity, unit, unit_price, charges_meta, total_price, product_variant_id, arc_contract_line_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [c.lineId, ID.callOffPo, c.qty, cl.uom, cl.rate, JSON.stringify({ tax: cl.gst, tax_mode: "percentage", other_charges: [] }),
        lineTotal(c.qty, cl.rate, cl.gst), P[c.key].id, cl.lineId]
    );
    await t.none(
      `INSERT INTO tbl_arc_callof_po (po_id, mr_id, arc_contract_id, arc_contract_line_id, quantity, price_applied, released_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() - interval '2 days')`,
      [ID.callOffPo, ID.mr, ID.contract, cl.lineId, c.qty, cl.rate]
    );
  }
  return { total: r2(total), requiredBy };
}

/** One live site-rep receive link: call-off PO @ A1, stored hashed exactly as issueSiteRepToken stores it. */
async function seedSiteRep(t) {
  const hash = crypto.createHash("sha256").update(SITE_REP_TOKEN, "utf8").digest("hex");
  const row = await t.one(
    `INSERT INTO tbl_token_login_data
       (token_type, entity_id, name, email, phone, added_by, token, token_hash, expires_at, hotel_id)
     VALUES ('GRN', $1, 'Ramesh (Mumbai receiving bay, E2E)', 'siterep.a1@inv-e2e.example.invalid', '9000096899', $2, NULL, $3,
             now() + interval '14 days', $4)
     RETURNING id, expires_at`,
    [ID.callOffPo, ID.buyer, hash, ID.A1]
  );
  return { tokenId: Number(row.id), expiresAt: row.expires_at };
}

// ---------------------------------------------------------------------------

async function main() {
  const where = await db.one(`SELECT current_database() AS db, host(inet_server_addr()) AS addr`);
  if (where.db !== conn.database) throw new Error(`connected to '${where.db}', expected '${conn.database}'`);
  if (!["127.0.0.1", "::1"].includes(where.addr)) {
    throw new Error(`server address is '${where.addr}', not loopback: refusing to seed`);
  }

  const hash = bcrypt.hashSync(PASSWORD, 10);
  const out = await db.tx(async (t) => {
    const removed = await cleanup(t);
    const roles = await roleIds(t);
    await seedBuyerSide(t, hash, roles);
    await seedVendor(t, hash);
    await seedCatalogue(t);
    await seedInventory(t);
    const rfqPo = await seedRfqPo(t);
    const callOff = await seedCallOff(t);
    const siteRep = await seedSiteRep(t);
    return { removed, roles, rfqPo, callOff, siteRep };
  });

  const siteRepLink = `${FRONTEND}/receive/token#t=${SITE_REP_TOKEN}`;
  const manifest = {
    seededAt: new Date().toISOString(),
    database: `${conn.database}@${conn.host}:${conn.port}`,
    password: PASSWORD,
    logins: {
      storekeeper: { employee_code: "INVE2E-STORE", userId: ID.storekeeper, scope: "Storekeeper @ A1" },
      controller: { employee_code: "INVE2E-CTRL", userId: ID.controller, scope: "Inventory Controller @ A1, A2; MR Raiser (mr.create) @ A1 F&B, A1 Housekeeping, A2" },
      buyer: { employee_code: "INVE2E-BUYER", userId: ID.buyer, scope: "Final Awarding P1 (awarding.create), RFQ Observer, MR Raiser/Approver, company A" },
      buyerB: { employee_code: "INVE2E-BBUYER", userId: ID.buyerB, scope: "Final Awarding P1 + Inventory Controller, company B" },
      vendor: { employee_code: "INVE2E-VENDOR", email: "vendor.freshkart@inv-e2e.example.invalid", userId: ID.vendor },
    },
    roles: out.roles,
    companies: { A: ID.hospA, B: ID.hospB, tblCompanyA: ID.companyA, tblCompanyB: ID.companyB, vendorCompany: ID.vendorCompany },
    hotels: { A1: ID.A1, A2: ID.A2, B1: ID.B1 },
    departments: { procurement: DEPT.PROCUREMENT, fb: DEPT.FB, housekeeping: DEPT.HOUSEKEEPING },
    items: Object.fromEntries(PRODUCTS.map((p) => [p.key, { invItemId: p.item.id, productVariantId: p.id, name: p.item.name, stockUom: p.item.stockUom, barcodes: p.barcodes, uoms: p.uoms }])),
    companyBItem: { invItemId: B_ITEM.id, barcode: P.paneer.barcodes[0].code },
    gs1Paneer: `(01)0${P.paneer.barcodes[0].code}(17)${istDate(10).slice(2).replace(/-/g, "")}(10)PNR-E2E-01`,
    pos: {
      multiHotel: { poId: ID.rfqPo, poNumber: "E2E-INV-PO-1001", rfqId: ID.rfq, hotels: [ID.A1, ID.A2], lineIds: Object.fromEntries(RFQ_PO_LINES.map((l) => [l.key, l.lineId])), total: out.rfqPo.total },
      callOff: { poId: ID.callOffPo, poNumber: "E2E-INV-CO-1002", hotel: ID.A1, arcId: ID.arc, contractId: ID.contract, mrId: ID.mr, requiredBy: out.callOff.requiredBy, lineIds: Object.fromEntries(CALL_OFF_LINES.map((l) => [l.key, l.lineId])), total: out.callOff.total },
    },
    siteRep: { tokenId: out.siteRep.tokenId, poId: ID.callOffPo, hotelId: ID.A1, token: SITE_REP_TOKEN, link: siteRepLink },
    // What Reorder (step 10) matches an MR draft against: ARC 96801, hotel A1, department F&B.
    // remaining = committed - consumed, in the contract's unit; an MR draft does not consume.
    contractLines: Object.fromEntries(
      CONTRACT_LINES.map((c) => {
        const consumed = CALL_OFF_LINES.find((l) => l.key === c.key)?.qty ?? 0;
        return [c.key, { arcContractLineId: c.lineId, uom: c.uom, unitRate: c.rate, committed: c.committed, remaining: c.committed - consumed }];
      })
    ),
    reorder: { hotelId: ID.A1, departmentId: DEPT.FB, user: "INVE2E-CTRL" },
  };
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

  const line = (k, v) => console.log(`  ${k.padEnd(28)} ${v}`);
  console.log(`\nInventory E2E world seeded into ${conn.database} @ ${conn.host}:${conn.port}`);
  console.log(`  (cleanup removed ${out.removed.users} users, ${out.removed.pos} POs, ${out.removed.rfqs} RFQs of the previous run)\n`);
  console.log(`LOGINS  POST /api/v1/users/login?conform=true  {"employee_code":"…","password":"${PASSWORD}"}`);
  line("Storekeeper @ A1", `INVE2E-STORE   user ${ID.storekeeper}`);
  line("Inventory Controller A1+A2", `INVE2E-CTRL    user ${ID.controller}`);
  line("PO initiator / buyer (A)", `INVE2E-BUYER   user ${ID.buyer}`);
  line("Company B buyer", `INVE2E-BBUYER  user ${ID.buyerB}`);
  line("Vendor FreshKart", `INVE2E-VENDOR  user ${ID.vendor}  (email vendor.freshkart@inv-e2e.example.invalid)`);
  console.log("\nCOMPANIES / HOTELS");
  line("Company A (hospitality)", `${ID.hospA}  Saffron Hotels (E2E): A1 ${ID.A1} Mumbai, A2 ${ID.A2} Pune`);
  line("Company B (hospitality)", `${ID.hospB}  Indigo Resorts (E2E): B1 ${ID.B1} Panaji`);
  line("stock started", "no hotel (no movements seeded)");
  console.log("\nITEMS (company A)  barcode -> stock units per scan");
  for (const p of PRODUCTS) {
    line(`${p.item.name} (${p.item.id})`, `${p.item.stockUom}${p.item.trackExpiry ? ", expiry-tracked" : ""}; ` +
      p.barcodes.map((b) => `${b.code} x${b.pack}`).join(", ") + (p.uoms.length ? `; ${p.uoms.map((u) => `${u.label}=${u.factor} ${p.item.stockUom}`).join(", ")}` : ""));
  }
  line("GS1 paneer (batch+expiry)", manifest.gs1Paneer);
  console.log("\nPURCHASE ORDERS (both vendor-accepted, status approved)");
  line(`PO ${ID.rfqPo} E2E-INV-PO-1001`, `multi-hotel RFQ PO, A1 + A2: paneer 40 kg, rice 10 Bag, caps 500 pc; ₹${out.rfqPo.total}`);
  line(`PO ${ID.callOffPo} E2E-INV-CO-1002`, `call-off PO, A1: paneer 15 kg, caps 300 pc; ₹${out.callOff.total}; due ${out.callOff.requiredBy}`);
  console.log("\nRATE CONTRACT ARC-E2E-INV-0001 (A1, F&B): what Reorder's MR draft matches");
  for (const [key, c] of Object.entries(manifest.contractLines)) {
    line(`${P[key].item.name} line ${c.arcContractLineId}`, `₹${c.unitRate}/${c.uom}, ${c.remaining} of ${c.committed} ${c.uom} remaining`);
  }
  console.log("\nSITE-REP RECEIVE LINK (PO 96802 @ A1)");
  console.log(`  ${siteRepLink}`);
  console.log(`\nManifest: ${MANIFEST}\n`);
}

main()
  .catch((err) => {
    console.error(`SEED FAILED: ${err.message}`);
    console.error("If an earlier run left rows this cleanup does not know about, rebuild the database:");
    console.error("  E2E_RESET=full scripts/inventory_e2e/e2e_server.sh   (or E2E_RUN_ID=e2e_inventory node scripts/vendor_networks/e2e_prepare_db.mjs)");
    process.exitCode = 1;
  })
  .finally(() => pgp.end());
