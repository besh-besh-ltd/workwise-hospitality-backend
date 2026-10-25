// Tenant isolation across EVERY inventory route (task E1), table-driven.
//
// One committed world, built once through the real HTTP routes: Company A
// (hotels A1 / A2 / A3) and Company B (hotel B1), each with a PO, stock and one
// of every document. Every route then gets a row in a table, and each row is
// exercised as four people:
//
//   B_ALL     every permission, in Company B. A Company A id must answer 404
//             (status 2) carrying nothing of A's, exactly as a missing id
//             does; a Company A hotel / item / delivery id in the query or
//             body is never trusted.
//   A_OTHER   every permission, in Company A, at hotel A2 only. A resource at
//             A1 is out of scope: 404 by rule C3, word for word what a
//             missing id gets, although it is the caller's own company.
//             Company-level routes (items, settings) are the exception: a
//             grant at any hotel of the company covers them (B3).
//   A_NOPERM  in Company A AT the resource's hotel, holding every permission
//             EXCEPT the route's own (`perm`, resource.action): 403 when the
//             record stays visible, 404 when the missing permission is the
//             one that makes it visible.
//   A_ALL     the positive control: 2xx, so every 404 above is isolation and
//             not a broken fixture.
//
// "Exactly as a missing id does" means the whole answer: HTTP status, content
// type and the full JSON body (status, message, code, details, anything else),
// with only true echoes normalised: an id field answered back under the name
// the request sent it (see signature()). Every emptied table counts ids in its
// own range, so no foreign id can equal a request id by coincidence, and the
// comparator's own tests replay two leaks that once got past it.
// Every probe naming someone else's record has a twin naming no record at all
// (a replayed idempotency key has no "missing" form, so its full answer is
// pinned instead).
//
// The first test walks the mounted Express app and fails, naming the routes,
// when an inventory route has no row here (or a row names a route that is no
// longer mounted). It fails closed: a mount it cannot read is an error, and a
// route anywhere in the app whose handler is an inventory controller export
// must be listed too.
//
// Users are created by the suite (and removed again) so no fixture role can
// blur a check. HTTP commits for real: the dynamic tables are truncated before
// and after, the other rows the suite writes (activity events, the ARC
// contract, MR drafts) are deleted above a watermark, and afterAll fails if any
// table's row count differs from what it was before the suite.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import crypto, { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import excelJS from "exceljs";
import express from "express";
import { db, closeDb, truncateDynamic } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import { buildTestApp } from "../setup/app.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import { generateReceiveToken } from "../../app/helper/receiveToken.js";
import { receiveTokenLimiter } from "../../app/middleware/receiveTokenRateLimit.js";
import { allReports, isRunnable } from "../../app/services/reports/definitions/index.js";
import { INVENTORY_REPORT_FAMILIES } from "../../app/services/reports/inventoryReportKit.js";
import { drainReceivingNotices } from "../../app/services/inventory/notices/receivingNotices.js";
import { drainApprovalNotices } from "../../app/services/inventory/notices/approvalNotices.js";

const CONTROLLERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../app/controllers/inventory");

const BASE = "/api/v1/inventory";
const CO_A = IDS.hospitality.A;
const CO_B = IDS.hospitality.B;
const { A1, A2, A3, B1 } = IDS.hotels;
const FB = IDS.departments.fb;
const VENDOR = IDS.users.vendor_alpha; // the vendor on every Company A PO
const OTHER_VENDOR = IDS.users.vendor_beta; // the vendor on Company B's PO
const BOGUS = 2000000000; // an id no table holds
const PRICE = 7777.77; // every PO line's unit price: must never reach a token response
const BUCKET_HOST = `${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;
const OWN_URL = (key) => `https://${BUCKET_HOST}/${key}`;

const U = {
  A_ALL: 88701,
  B_ALL: 88702,
  A_OTHER: 88703,
  A_NOPERM: 88704,
  A_CREATOR: 88705, // raises the adjustments / counts A_ALL decides (no self-approval)
  SUPER: 88706, // user_type 8: the platform super admin (IDS.users.superAdmin is not one)
};

// The inventory and receiving reports, from the registry itself.
const INVENTORY_REPORTS = allReports().filter((d) => INVENTORY_REPORT_FAMILIES.includes(d.family));
const REPORT_KEYS = INVENTORY_REPORTS.map((d) => d.key);
const ALL_KEYS = [
  "grn.read", "grn.create", "grn.update", "grn.approve",
  "inventory.read", "inventory.create", "inventory.update", "inventory.approve", "inventory.admin",
  "awarding.read", "awarding.create", // PO_SCOPE_PERMISSIONS / PO_INITIATE_PERMISSIONS
  ...INVENTORY_REPORTS.map((d) => d.permission),
];
const WIDE = { from: "2020-04-01", to: "2031-03-31" }; // every report period the world can touch
const CREATOR_KEYS = ["grn.read", "grn.create", "grn.update", "inventory.read", "inventory.create", "inventory.update"];

// Strings only Company A's data carries. Every A name and remark holds
// ISO-A-SECRET; every A document number holds its hotel's doc code.
const SECRETS_A = [
  "ISO-A-SECRET", "ISOA1SECRET", "ISOA2SECRET", "ISOA3SECRET", "ISO-A1-ONLY", "Hotel A-1", "Hotel A-2", "Hotel A-3",
];
// What a Company A user scoped to A2 must never see from a hotel-scoped list.
const SECRETS_A1 = ["ISOA1SECRET", "ISO-A1-ONLY", "Hotel A-1"];

const W = {}; // the world: ids, numbers, names
const C = {}; // http clients by user
const madeRoles = [];
const scopeIds = [];
const prevUser = {};
let nopermScope = null;
let TODAY;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const leaksIn = (body, secrets = SECRETS_A) => {
  const text = JSON.stringify(body ?? {});
  return secrets.filter((s) => text.includes(s));
};

const pathOf = (p) => (p.startsWith("/api/") ? p : `${BASE}${p}`);

/** A key that holds an id (or a list of them): id, poId, hotel_id, deliveryLineIds, clientEventId ... */
const ID_KEY = /(^id$|Id$|_id$|Ids$|_ids$)/;
/** One name per id field however it is spelt: poId = po_id, grnLineIds = grnLineId. */
const fold = (k) => k.replace(/_/g, "").toLowerCase().replace(/ids$/, "id");
/** `dispatches` -> `dispatch`, `items` -> `item`: names a bare `:id` after the segment before it. */
const singular = (w) => (/(ch|sh|s|x)es$/.test(w) ? w.slice(0, -2) : w.replace(/s$/, ""));
/** Response fields that echo a non-id request value verbatim, by route: the scanned code. */
const ECHO_FIELDS = [{ route: `${BASE}/scan/resolve`, key: "code" }];

/**
 * The values a request sent, by (folded) name: the route's path params (named
 * from `pattern`, e.g. "PATCH /po/:poId/deliveries/:deliveryId"), and its
 * id-keyed query / body / multipart fields. Nothing else: a quantity, a date
 * or a remark is never an echo.
 */
function sentValues(spec, pattern) {
  const sent = new Map();
  const put = (key, value) => {
    if (value === null || value === undefined || typeof value === "object") return;
    const k = fold(key);
    if (!sent.has(k)) sent.set(k, new Set());
    sent.get(k).add(String(value));
  };
  const [p, query = ""] = pathOf(spec.path).split("?");
  if (pattern) {
    const pat = pathOf(pattern.slice(pattern.indexOf(" ") + 1)).split("/");
    const segs = p.split("/");
    if (pat.length !== segs.length) throw new Error(`${spec.path} does not match the route ${pattern}`);
    pat.forEach((s, i) => {
      if (!s.startsWith(":")) return;
      put(s.slice(1), decodeURIComponent(segs[i]));
      if (s === ":id" && i > 0) put(`${singular(pat[i - 1])}Id`, decodeURIComponent(segs[i]));
    });
  }
  const echoes = ECHO_FIELDS.filter((e) => e.route === p).map((e) => e.key);
  const keep = (k) => ID_KEY.test(k) || echoes.includes(k);
  for (const [k, v] of new URLSearchParams(query)) if (keep(k)) put(k, v);
  const walk = (v, key) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object" && !Buffer.isBuffer(v)) for (const [k, x] of Object.entries(v)) walk(x, k);
    else if (key && keep(key)) put(key, v);
  };
  walk(spec.body, null);
  walk(spec.fields, null);
  return { sent, echoes };
}

/**
 * `value` with an echo replaced by "<echo>": a field (or list) under an id key,
 * or one of the route's ECHO_FIELDS, whose value the request sent under that
 * same name. Any other id stays as it is, so a foreign id is never mistaken
 * for an echo because it happens to equal some other value of the request.
 */
function normalized(value, req, key = null) {
  if (Array.isArray(value)) return value.map((v) => normalized(v, req, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalized(v, req, k)]));
  }
  const echoable = key && (ID_KEY.test(key) || req.echoes.includes(key));
  if (echoable && (typeof value === "number" || typeof value === "string") && req.sent.get(fold(key))?.has(String(value))) {
    return "<echo>";
  }
  return value;
}

/**
 * What an answer looks like from outside: HTTP status, content type and the
 * full body, with only true echoes of `spec` (the request that got it)
 * normalised; `pattern` is its route, which names the path params. Two
 * refusals are indistinguishable iff their signatures are equal.
 */
function signature(res, spec, pattern = null) {
  const body = Buffer.isBuffer(res.body) ? { binary: res.body.length } : res.body;
  const empty = body && typeof body === "object" && !Object.keys(body).length;
  return {
    status: res.status,
    type: res.type ?? null,
    body: normalized(empty && res.text ? res.text : body ?? null, sentValues(spec, pattern)),
  };
}

/** Send a request spec {method, path, body?, attach?, fields?, headers?} as a client. */
function send(client, spec) {
  let r = client[spec.method](pathOf(spec.path));
  for (const [k, v] of Object.entries(spec.headers ?? {})) r = r.set(k, v);
  if (spec.attach) {
    for (const [k, v] of Object.entries(spec.fields ?? {})) r = r.field(k, v);
    return r.attach(spec.attach.field, spec.attach.buffer, { filename: spec.attach.filename, contentType: spec.attach.contentType });
  }
  return spec.body === undefined ? r : r.send(spec.body);
}

/** Setup steps must succeed; a failure names the step and the answer. */
async function must(req, what) {
  const res = await req;
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

const pdf = () => ({ field: "file", buffer: Buffer.from("%PDF-1.4 isolation"), filename: "doc.pdf", contentType: "application/pdf" });

async function openingSheet(rows = [["ISO-A-OPEN-1", "Opening item", 5, "kg", 10, "B-1"]]) {
  const wb = new excelJS.Workbook();
  const ws = wb.addWorksheet("Opening");
  ws.addRow(["Item Code", "Item Name", "Qty", "Unit", "Unit Cost", "Bin"]);
  for (const r of rows) ws.addRow(r);
  return {
    field: "file",
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
    filename: "opening.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

async function makeRole(title, keys) {
  const role = await db.one(
    `INSERT INTO tbl_roles (title, description, created_by) VALUES ($1, 'E1 isolation test role', $2) RETURNING id`,
    [title, IDS.users.superAdmin]
  );
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id)
     SELECT $1, p.id FROM tbl_permissions p WHERE (p.resource::text || '.' || p.action::text) = ANY($2::text[])`,
    [role.id, keys]
  );
  madeRoles.push(Number(role.id));
  return Number(role.id);
}

const withoutRoles = new Map();
/** A role holding every key except `perms` (cached per set). */
async function roleWithout(perms) {
  const list = [].concat(perms);
  const k = [...list].sort().join(",");
  if (!withoutRoles.has(k)) withoutRoles.set(k, await makeRole(`E1 all but ${k}`, ALL_KEYS.filter((p) => !list.includes(p))));
  return withoutRoles.get(k);
}

/** A_NOPERM now holds everything but `perms`, at `hotelId` of Company A only. */
async function grantNoPerm(perms, hotelId) {
  if (nopermScope) await revokeRoleScopes(db, [nopermScope]);
  nopermScope = await grantRoleScope(db, { userId: U.A_NOPERM, roleId: await roleWithout(perms), companyId: CO_A, hotelId });
}

let poSeq = 0;
/** A committed RFQ PO; lines = [{qty, variant}] at PRICE a unit. */
async function makePo({ company = "A", hotel, mappedHotels = [], vendor, lines, status = "approved" }) {
  const isA = company === "A";
  const owner = isA ? U.A_ALL : U.B_ALL;
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: owner, status: 1, is_published: 1, hotel, hospitality: isA ? CO_A : CO_B,
    department: IDS.departments.proc, process: isA ? IDS.processes.A_P1 : IDS.processes.B_P1,
    title: isA ? "ISO-A-SECRET tender" : "ISO-B tender",
  });
  for (const h of mappedHotels) {
    await db.none(`INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`, [rfq_id, h, owner]);
  }
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, vendor]
  );
  const poNumber = `${isA ? "ISO-A-SECRET" : "ISO-B"}-PO-${process.pid}-${++poSeq}`;
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price, finalized_vendor_id,
        total_value, quote_id, initiated_by, vendor_action_at)
     VALUES ($1, $2, $3, $4, '{}', 1, $5, $6, $7, '{}', $8, now()) RETURNING id`,
    [rfq_id, isA ? IDS.companies.A : IDS.companies.B, poNumber, status, PRICE, vendor,
      lines.reduce((s, l) => s + l.qty * PRICE, 0), owner]
  );
  const lineIds = [];
  for (const l of lines) {
    const rp = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
      [rfq_id, l.variant]
    );
    const qi = await db.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, comment, delivery_period, quantity)
       VALUES ($1, $2, $3, $4, $5, $6, '', '', $7) RETURNING id`,
      [rfq_id, rfq_no, quote.id, l.variant, PRICE, PRICE * l.qty, String(l.qty)]
    );
    const pop = await db.one(
      `INSERT INTO tbl_purchase_order_product
         (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, charges_meta, total_price, product_variant_id)
       VALUES ($1, $2, $3, $4, 'kg', $5, '{"tax":18,"tax_mode":"percentage","other_charges":[]}'::jsonb, $6, $7)
       RETURNING id`,
      [po.id, rp.id, qi.id, l.qty, PRICE, PRICE * l.qty, l.variant]
    );
    lineIds.push(Number(pop.id));
  }
  return { poId: Number(po.id), poNumber, lineIds };
}

/** A site-rep link as B6 issues it (only the sha256 is stored). */
async function issueToken(poId, { hotelId = A1, expired = false, revoked = false } = {}) {
  const token = generateReceiveToken();
  const hash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  const row = await db.one(
    `INSERT INTO tbl_token_login_data
       (token_type, entity_id, name, email, phone, added_by, token, token_hash, hotel_id, expires_at, revoked_at)
     VALUES ('GRN', $1, 'Site rep', 'site.rep@example.test', '9876543210', $2, NULL, $3, $4,
             CASE WHEN $5 THEN now() - interval '1 minute' ELSE now() + interval '14 days' END,
             CASE WHEN $6 THEN now() ELSE NULL END)
     RETURNING id`,
    [poId, U.A_ALL, hash, hotelId, expired, revoked]
  );
  return { token, tokenId: Number(row.id) };
}

let variants = [];
const nextVariant = () => {
  const v = variants.shift();
  if (!v) throw new Error("ran out of catalogue variants");
  return v;
};

/** An A item straight into tbl_inv_item (no catalogue variant needed). */
async function rawItem(name, { company = CO_A, code = null } = {}) {
  const row = await db.one(
    `INSERT INTO tbl_inv_item (hospitality_company_id, display_name, stock_uom, item_code) VALUES ($1, $2, 'kg', $3) RETURNING id`,
    [company, name, code]
  );
  return Number(row.id);
}

const grnLine = (poLineId, qty) => ({ poLineId, receivedQty: qty, acceptedQty: qty, rejectedQty: 0 });

/** A posted (or draft) Company A receipt at A1 on W.poA line 1. */
async function postGrnA({ qty = 1, post = true } = {}) {
  return must(C.aAll.post(`${BASE}/grn`).send({
    poId: W.poA.poId, hotelId: A1, receivedAt: TODAY, post, clientEventId: randomUUID(),
    remarks: "ISO-A1-ONLY receipt", vendorChallanNo: "ISO-A1-ONLY-CH", lines: [grnLine(W.poA.lineIds[0], qty)],
  }), "A GRN");
}

const freshPoA = async (extra = {}) => {
  const po = await makePo({ hotel: A1, vendor: VENDOR, lines: [{ qty: 10, variant: W.variantA1 }], ...extra });
  const plan = await must(C.aAll.get(`${BASE}/po/${po.poId}/deliveries`), "fresh plan");
  const delivery = plan.deliveries.find((d) => d.hotelId === A1);
  return { ...po, deliveryId: delivery.id, deliveryLineId: delivery.lines[0].id };
};

const newRtv = (grnLineId, disposition = "REPLACE") => must(C.aAll.post(`${BASE}/rtv`).send({
  grnId: W.grnA.id, disposition, remarks: "ISO-A1-ONLY return", lines: [{ grnLineId, qty: 1, reason: "damaged" }],
}), "RTV");

const newAdjustment = () => must(C.creator.post(`${BASE}/adjustments`).send({
  hotelId: A1, reasonCode: "WASTAGE", remarks: "ISO-A1-ONLY adjustment", submit: true, clientEventId: randomUUID(),
  lines: [{ invItemId: W.itemA1, qty: -1 }],
}), "adjustment");

async function newCount(invItemId, { counted = false, submitted = false } = {}) {
  const count = await must(C.creator.post(`${BASE}/counts`).send({
    hotelId: A1, scope: "SELECTED", isBlind: false, invItemIds: [invItemId],
  }), "count");
  if (counted || submitted) {
    await must(C.creator.put(`${BASE}/counts/${count.id}/lines`).send({
      lines: [{ invItemId, countedQty: 0, clientEventId: randomUUID() }],
    }), "count lines");
  }
  if (submitted) await must(C.creator.post(`${BASE}/counts/${count.id}/submit`).send({}), "count submit");
  return count;
}

/** An active ARC contract line at a Company A hotel for F&B, in kg (so reorder can draft an MR). */
async function makeArcContract({ hotelId, variantId }) {
  const arc = await db.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, process_id, status,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
     VALUES ($1, 'ISO-A-SECRET ARC', (SELECT id FROM tbl_category ORDER BY id LIMIT 1), $2, $3, $4, $5,
             'contract_active', NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days',
             NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $6)
     RETURNING id`,
    [`ISO-A-ARC-${process.pid}`, CO_A, hotelId, FB, IDS.processes.A_P1, U.A_ALL]
  );
  const contract = await db.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`,
    [arc.id, VENDOR]
  );
  const item = await db.one(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 100, 'kg') RETURNING id`,
    [arc.id, variantId]
  );
  const line = await db.one(
    `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty, consumed_qty)
     VALUES ($1, $2, 90, 5, 1000, 0) RETURNING id`,
    [contract.id, item.id]
  );
  return { arcId: Number(arc.id), contractId: Number(contract.id), lineId: Number(line.id) };
}

// ---------------------------------------------------------------------------
// leftovers: what the suite writes outside the truncated tables
// ---------------------------------------------------------------------------

// Rows above the watermark taken in beforeAll are the suite's own, deleted
// children first. Activity rows are written after the response (on 'finish'),
// so the cleanup waits for them to settle first.
const WATERMARKED = [
  "tbl_audit_row_changes", // row triggers: deleted last of all, after the cleanup's own deletes
  "tbl_activity_events",
  "tbl_material_requisition_item",
  "tbl_material_requisition",
  "tbl_arc_contract_line",
  "tbl_arc_item",
  "tbl_arc_contract",
  "tbl_arc",
];
const watermark = {};

/** Row count of every table in the test database, by name. */
async function tableCounts() {
  const rows = await db.any(
    `SELECT table_name AS t,
            (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', table_name), false, true, '')))[1]::text::bigint AS n
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  return Object.fromEntries(rows.map((r) => [r.t, Number(r.n)]));
}

/** Wait until no activity row has landed for a moment (they are written after the response). */
async function activitySettled() {
  let last = null;
  for (let i = 0; i < 30; i += 1) {
    const { n } = await db.one(`SELECT count(*)::text || ':' || COALESCE(max(id), 0)::text AS n FROM tbl_activity_events`);
    if (n === last) return;
    last = n;
    await new Promise((r) => setTimeout(r, 300));
  }
}

let countsBefore = null;

// Separate id ranges. After a truncate every table counts from 1 again, so PO
// 5, delivery 5 and GRN line 5 would all exist, and an id the answer should
// never carry could pass for one the request sent. Each table the truncate
// leaves empty (the dynamic tables and whatever their CASCADE reaches) gets
// its own block of ID_RANGE ids instead, its sequence found in the catalogue
// (pg_depend: owned-by and identity sequences), and put back afterwards.
const ID_RANGE = 1_000_000;
const rebased = [];

async function separateIdRanges() {
  const owned = await db.any(
    `SELECT s.oid::regclass::text AS seq, t.relname AS tbl, a.attname AS col, ps.seqmax::text AS seqmax
       FROM pg_class s
       JOIN pg_sequence ps ON ps.seqrelid = s.oid
       JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid
                       AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
       JOIN pg_class t ON t.oid = d.refobjid AND t.relkind IN ('r', 'p')
       JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE s.relkind = 'S'
      ORDER BY t.relname, a.attname`
  );
  let block = 0;
  for (const o of owned.filter((r) => countsBefore[r.tbl] === 0)) {
    block += 1;
    const base = block * ID_RANGE;
    if (Number(o.seqmax) < base + ID_RANGE || base + ID_RANGE >= BOGUS) {
      throw new Error(`no room for an id range of ${ID_RANGE} for ${o.tbl}.${o.col} (${o.seq})`);
    }
    const cur = await db.one(`SELECT last_value::text AS last, is_called FROM ${o.seq}`);
    rebased.push({ ...o, last: cur.last, called: cur.is_called });
    await db.one(`SELECT setval($1::regclass, $2)`, [o.seq, base]);
  }
  return rebased.length;
}

/** Each sequence back where it was (or at its table's max id, should rows remain). */
async function restoreIdRanges() {
  for (const r of rebased) {
    const { max } = await db.one(`SELECT max($1:name)::text AS max FROM $2:name`, [r.col, r.tbl]);
    if (max != null && BigInt(max) >= BigInt(r.last)) await db.one(`SELECT setval($1::regclass, $2::bigint, true)`, [r.seq, max]);
    else await db.one(`SELECT setval($1::regclass, $2::bigint, $3)`, [r.seq, r.last, r.called]);
  }
}

// ---------------------------------------------------------------------------
// the world
// ---------------------------------------------------------------------------

async function createUsers() {
  const users = [
    [U.A_ALL, "E1 A all", IDS.companies.A],
    [U.B_ALL, "E1 B all", IDS.companies.B],
    [U.A_OTHER, "E1 A at A2", IDS.companies.A],
    [U.A_NOPERM, "E1 A without", IDS.companies.A],
    [U.A_CREATOR, "E1 A storekeeper", IDS.companies.A],
    [U.SUPER, "E1 super admin", null, 8], // no mapping, no role: user_type 8 alone
  ];
  for (const [id, name, company, type = 2] of users) {
    await db.none(
      `INSERT INTO tbl_users (id, name, email, status, user_type, company_id) VALUES ($1, $2, $3, 1, $5, $4)`,
      [id, name, `e1.iso.${id}@test.local`, company, type]
    );
  }
  const map = (user, hospitality, hotel) => db.none(
    `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [user, hospitality, hotel, hotel == null ? 0 : 1, IDS.users.superAdmin]
  );
  await map(U.A_ALL, CO_A, null);
  await map(U.B_ALL, CO_B, null);
  await map(U.A_OTHER, CO_A, A2);
  await map(U.A_NOPERM, CO_A, A1);
  await map(U.A_CREATOR, CO_A, null);

  const all = await makeRole("E1 every inventory permission", ALL_KEYS);
  const creator = await makeRole("E1 storekeeper", CREATOR_KEYS);
  scopeIds.push(
    await grantRoleScope(db, { userId: U.A_ALL, roleId: all, companyId: CO_A }),
    await grantRoleScope(db, { userId: U.B_ALL, roleId: all, companyId: CO_B }),
    await grantRoleScope(db, { userId: U.A_OTHER, roleId: all, companyId: CO_A, hotelId: A2 }),
    await grantRoleScope(db, { userId: U.A_CREATOR, roleId: creator, companyId: CO_A }),
  );
}

async function buildWorld() {
  TODAY = (await db.one(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;
  variants = (await db.any(`SELECT id FROM tbl_product_variant ORDER BY id DESC LIMIT 40`)).map((r) => Number(r.id));

  // Document codes: every A document number carries its hotel's secret code.
  for (const [h, code] of [[A1, "ISOA1SECRET"], [A2, "ISOA2SECRET"], [A3, "ISOA3SECRET"]]) {
    await must(C.aAll.put(`${BASE}/settings/hotel/${h}`).send({ docCode: code }), `doc code ${h}`);
  }
  await must(C.bAll.put(`${BASE}/settings/hotel/${B1}`).send({ docCode: "ISOB1" }), "doc code B1");
  await must(C.aAll.put(`${BASE}/settings/company`).send({ adjustmentAutoApproveLimit: 0, countFreeze: false }), "A settings");
  await must(C.bAll.put(`${BASE}/settings/company`).send({ adjustmentAutoApproveLimit: 0, countFreeze: false }), "B settings");

  // Items.
  W.variantA1 = nextVariant();
  W.variantA2 = nextVariant();
  W.variantB = nextVariant();
  W.itemA1 = (await must(C.aAll.post(`${BASE}/items`).send({
    productVariantId: W.variantA1, displayName: "ISO-A-SECRET Saffron", stockUom: "kg",
  }), "item A1")).id;
  W.itemA2 = (await must(C.aAll.post(`${BASE}/items`).send({
    productVariantId: W.variantA2, displayName: "ISO-A-SECRET Basmati", stockUom: "kg",
  }), "item A2")).id;
  W.itemB = (await must(C.bAll.post(`${BASE}/items`).send({
    productVariantId: W.variantB, displayName: "ISO-B Rice", stockUom: "kg",
  }), "item B")).id;
  W.countItems = [];
  for (let i = 0; i < 6; i += 1) W.countItems.push(await rawItem(`ISO-A-SECRET Count ${i}`));
  W.itemOpen = await rawItem("ISO-A-SECRET Opening", { code: "ISO-A-OPEN-1" });
  W.itemBCount = await rawItem("ISO-B Count", { company: CO_B });
  W.variantBait = nextVariant();
  const bait = await db.one(`SELECT name FROM tbl_product_variant WHERE id = $1`, [W.variantBait]);
  W.baitA = await rawItem(bait.name);
  W.barcodeA = await must(C.aAll.post(`${BASE}/items/${W.itemA1}/barcodes`).send({ code: "8901234500017", packFactor: 1 }), "barcode A");
  await must(C.aAll.put(`${BASE}/hotel-items/${A1}/${W.itemA1}`).send({
    minQty: 1, reorderLevel: 2, maxQty: 50, binLabel: "ISO-A1-ONLY-BIN",
  }), "hotel item A1");

  // Company A: a PO at A1 (accepted), its plan, a posted receipt, a vendor dispatch.
  W.poA = await makePo({ hotel: A1, vendor: VENDOR, lines: [{ qty: 40, variant: W.variantA1 }, { qty: 40, variant: W.variantA2 }] });
  const planA = await must(C.aAll.get(`${BASE}/po/${W.poA.poId}/deliveries`), "A plan");
  W.deliveryA = planA.deliveries.find((d) => d.hotelId === A1);
  W.grnA = await postGrnA({ qty: 20 });
  W.dispatchA = await must(C.vendor.post(`${BASE}/vendor/po/${W.poA.poId}/dispatches`).send({
    hotelId: A1, challanNo: "ISO-A1-ONLY-DSP", challanDate: TODAY, expectedDeliveryDate: TODAY,
    lines: [{ poLineId: W.poA.lineIds[1], qty: 2 }],
  }), "A dispatch");
  W.tokenA = await issueToken(W.poA.poId, { hotelId: A1 });

  // Company A stock documents at A1.
  W.outA = await must(C.creator.post(`${BASE}/out`).send({
    hotelId: A1, docType: "OUT", departmentId: FB, remarks: "ISO-A1-ONLY out", clientEventId: randomUUID(),
    lines: [{ invItemId: W.itemA1, qty: 1 }],
  }), "A out");
  W.adjA = await newAdjustment();
  W.countA = await newCount(W.countItems[0]);
  W.arcA = await makeArcContract({ hotelId: A1, variantId: W.variantA1 });
  const draftKey = randomUUID();
  W.mrDraftA = { ...(await must(C.aAll.post(`${BASE}/reorder/mr-draft`).send({
    hotelId: A1, departmentId: FB, clientEventId: draftKey, items: [{ invItemId: W.itemA1, qty: 2 }],
  }), "A MR draft")), clientEventId: draftKey };

  // Company B: a PO at B1 (Beta's), a posted receipt, stock documents, a dispatch.
  W.poB = await makePo({ company: "B", hotel: B1, vendor: OTHER_VENDOR, lines: [{ qty: 10, variant: W.variantB }] });
  const planB = await must(C.bAll.get(`${BASE}/po/${W.poB.poId}/deliveries`), "B plan");
  W.deliveryB = planB.deliveries.find((d) => d.hotelId === B1);
  W.grnB = await must(C.bAll.post(`${BASE}/grn`).send({
    poId: W.poB.poId, hotelId: B1, receivedAt: TODAY, post: true, clientEventId: randomUUID(),
    lines: [grnLine(W.poB.lineIds[0], 5)],
  }), "B GRN");
  W.dispatchB = await must(C.otherVendor.post(`${BASE}/vendor/po/${W.poB.poId}/dispatches`).send({
    hotelId: B1, challanNo: "ISO-B-DSP", challanDate: TODAY, expectedDeliveryDate: TODAY,
    lines: [{ poLineId: W.poB.lineIds[0], qty: 1 }],
  }), "B dispatch");
  W.outB = await must(C.bAll.post(`${BASE}/out`).send({
    hotelId: B1, docType: "OUT", departmentId: FB, clientEventId: randomUUID(), lines: [{ invItemId: W.itemB, qty: 1 }],
  }), "B out");
  W.adjB = await must(C.bAll.post(`${BASE}/adjustments`).send({
    hotelId: B1, reasonCode: "WASTAGE", submit: true, clientEventId: randomUUID(), lines: [{ invItemId: W.itemB, qty: -1 }],
  }), "B adjustment");
  W.countB = await must(C.bAll.post(`${BASE}/counts`).send({
    hotelId: B1, scope: "SELECTED", isBlind: false, invItemIds: [W.itemBCount],
  }), "B count");
  W.tokenB = await issueToken(W.poB.poId, { hotelId: B1 });

  // Sanity: ids of different tables never coincide (each table has its own range).
  const blocks = [
    W.poA.poId, W.poA.lineIds[0], W.deliveryA.id, W.deliveryA.lines[0].id, W.grnA.id, W.grnA.lines[0].id, W.itemA1,
    W.outA.id, W.adjA.id, W.countA.id, W.dispatchA.id, W.tokenA.tokenId,
  ].map((id) => Math.floor(Number(id) / ID_RANGE));
  expect({ distinct: new Set(blocks).size, rebased: Math.min(...blocks) >= 1 }).toEqual({ distinct: blocks.length, rebased: true });

  // Sanity: the world carries the markers the leak checks look for.
  expect(W.grnA.grnNumber).toContain("ISOA1SECRET");
  expect(W.outA.outNumber).toContain("ISOA1SECRET");
  expect(W.grnB.grnNumber).toContain("ISOB1");
}

beforeAll(async () => {
  await truncateDynamic();
  await activitySettled();
  for (const table of WATERMARKED) {
    watermark[table] = Number((await db.one(`SELECT COALESCE(max(id), 0)::bigint AS n FROM ${table}`)).n);
  }
  countsBefore = await tableCounts();
  expect(await separateIdRanges()).toBeGreaterThan(40);
  for (const id of [VENDOR, OTHER_VENDOR]) {
    prevUser[id] = await db.one(`SELECT user_type, status FROM tbl_users WHERE id = $1`, [id]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [id]);
  }
  await createUsers();
  [C.aAll, C.bAll, C.other, C.noPerm, C.creator, C.vendor, C.otherVendor, C.anon, C.super] = await Promise.all([
    httpClient(U.A_ALL), httpClient(U.B_ALL), httpClient(U.A_OTHER), httpClient(U.A_NOPERM),
    httpClient(U.A_CREATOR), httpClient(VENDOR), httpClient(OTHER_VENDOR), httpClient(null), httpClient(U.SUPER),
  ]);
  await buildWorld();
});

afterAll(async () => {
  try {
    const users = Object.values(U);
    await drainReceivingNotices();
    await drainApprovalNotices();
    await activitySettled();
    await revokeRoleScopes(db, [...scopeIds, ...(nopermScope ? [nopermScope] : [])]);
    await truncateDynamic();
    const dropAbove = (table) => (watermark[table] == null ? null : db.none(`DELETE FROM ${table} WHERE id > $1`, [watermark[table]]));
    for (const table of WATERMARKED.slice(1)) await dropAbove(table);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [users]);
    await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [users]);
    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = ANY($1::int[])`, [madeRoles]);
    await db.none(`DELETE FROM tbl_roles WHERE id = ANY($1::int[])`, [madeRoles]);
    await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [users]);
    for (const [id, row] of Object.entries(prevUser)) {
      await db.none(`UPDATE tbl_users SET user_type = $2, status = $3 WHERE id = $1`, [id, row.user_type, row.status]);
    }
    await dropAbove("tbl_audit_row_changes");
    await restoreIdRanges();
    // Nothing of the suite's may outlive it: every table holds what it held before.
    if (countsBefore) {
      const after = await tableCounts();
      const changed = Object.keys({ ...countsBefore, ...after })
        .filter((t) => (countsBefore[t] ?? 0) !== (after[t] ?? 0))
        .map((t) => `${t}: ${countsBefore[t] ?? 0} -> ${after[t] ?? 0}`);
      if (changed.length) throw new Error(`the isolation suite left rows behind in ${changed.join(", ")}`);
    }
  } finally {
    await closeDb();
  }
});

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------
//
// DOC rows: a route addressing one Company A record (or hotel) by id.
//   ids(fresh)    flat ids the request needs; `idKey` is swapped for BOGUS to
//                 build the "missing record" twin B's answer must match
//   req(ids)      the request; the positive control sends the same one
//   foreign(ids)  more requests by B carrying Company A ids in query/body
//   perm          resource.action the route's service gates on
//   scoped        A_OTHER's status; noPerm: A_NOPERM's; ok: A_ALL's
//   hotel         where A_NOPERM's grant sits (the record's hotel; A1 default)
//   fresh()       a record of the row's own when the positive control
//                 consumes it (posts, deletes, cancels ...)

const q = (method, path, body) => ({ method, path, body });
/** A probe naming someone else's record, and its twin naming no record at all: same answer, byte for byte. */
const pair = (spec, twin, { expect = 404, who = "B" } = {}) => ({ spec, twin, expect, who });
/**
 * A replayed idempotency key of someone else's document. There is no
 * "missing" twin (a fresh key creates a document), so the full answer is
 * pinned instead: it names nothing of theirs.
 */
const replayed = (spec, body, { expect = 404, who = "B" } = {}) => ({ spec, body, expect, who });

const DOC_ROWS = [
  // ── delivery plan, short-close, site-rep links (PO read / initiate gates) ──
  {
    key: "GET /po/:poId/deliveries", perm: "awarding.read", scoped: 404, noPerm: 404, ok: 200,
    ids: () => ({ poId: W.poA.poId }), idKey: "poId",
    req: (x) => q("get", `/po/${x.poId}/deliveries`),
  },
  {
    key: "PUT /po/:poId/deliveries", perm: "awarding.create", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => freshPoA(), idKey: "poId",
    ids: (f) => ({ poId: f.poId, lineId: f.lineIds[0] }),
    req: (x) => q("put", `/po/${x.poId}/deliveries`, {
      deliveries: [{ hotelId: A1, phaseNo: 1, dueDate: null, remarks: null, lines: [{ poLineId: x.lineId, plannedQty: 10 }] }],
    }),
  },
  {
    key: "PATCH /po/:poId/deliveries/:deliveryId", perm: "awarding.create", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => freshPoA(), idKey: "poId",
    ids: (f) => ({ poId: f.poId, deliveryId: f.deliveryId }),
    req: (x) => q("patch", `/po/${x.poId}/deliveries/${x.deliveryId}`, { dueDate: null }),
    // B on its own PO naming A's delivery.
    foreign: (x) => [pair(
      q("patch", `/po/${W.poB.poId}/deliveries/${x.deliveryId}`, { dueDate: null }),
      q("patch", `/po/${W.poB.poId}/deliveries/${BOGUS}`, { dueDate: null }),
    )],
  },
  {
    key: "POST /po/:poId/short-close", perm: "awarding.create", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => freshPoA(), idKey: "poId",
    ids: (f) => ({ poId: f.poId, deliveryLineId: f.deliveryLineId }),
    req: (x) => q("post", `/po/${x.poId}/short-close`, {
      target: { type: "lines", deliveryLineIds: [x.deliveryLineId] }, reasonCode: "no_longer_needed", remarks: null,
    }),
    // B on its own PO naming A's delivery lines.
    foreign: (x) => [pair(
      q("post", `/po/${W.poB.poId}/short-close`, {
        target: { type: "lines", deliveryLineIds: [x.deliveryLineId] }, reasonCode: "no_longer_needed", remarks: null,
      }),
      q("post", `/po/${W.poB.poId}/short-close`, {
        target: { type: "lines", deliveryLineIds: [BOGUS] }, reasonCode: "no_longer_needed", remarks: null,
      }),
    )],
  },
  {
    key: "POST /po/:poId/short-close/reopen", perm: "awarding.create", scoped: 404, noPerm: 403, ok: 200,
    fresh: async () => {
      const f = await freshPoA();
      await must(C.aAll.post(`${BASE}/po/${f.poId}/short-close`).send({
        target: { type: "lines", deliveryLineIds: [f.deliveryLineId] }, reasonCode: "no_longer_needed",
      }), "short-close to reopen");
      return f;
    },
    ids: (f) => ({ poId: f.poId, deliveryLineId: f.deliveryLineId }), idKey: "poId",
    req: (x) => q("post", `/po/${x.poId}/short-close/reopen`, { deliveryLineIds: [x.deliveryLineId], remarks: "back on" }),
    foreign: (x) => [pair(
      q("post", `/po/${W.poB.poId}/short-close/reopen`, { deliveryLineIds: [x.deliveryLineId], remarks: "x" }),
      q("post", `/po/${W.poB.poId}/short-close/reopen`, { deliveryLineIds: [BOGUS], remarks: "x" }),
    )],
  },
  {
    key: "POST /po/:poId/site-rep/revoke", perm: "grn.create", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => issueToken(W.poA.poId, { hotelId: A1 }),
    ids: (f) => ({ poId: W.poA.poId, tokenId: f.tokenId }), idKey: "poId",
    req: (x) => q("post", `/po/${x.poId}/site-rep/revoke`, { tokenId: x.tokenId }),
    // B on its own PO naming A's link.
    foreign: (x) => [pair(
      q("post", `/po/${W.poB.poId}/site-rep/revoke`, { tokenId: x.tokenId }),
      q("post", `/po/${W.poB.poId}/site-rep/revoke`, { tokenId: BOGUS }),
    )],
  },

  // ── receiving ──
  {
    key: "GET /receive/po/:poId", perm: "grn.create", scoped: 404, noPerm: 403, ok: 200,
    ids: () => ({ poId: W.poA.poId }), idKey: "poId",
    req: (x) => q("get", `/receive/po/${x.poId}?hotelId=${A1}`),
    foreign: (x) => [
      pair(q("get", `/receive/po/${x.poId}`), q("get", `/receive/po/${BOGUS}`)),
      pair(q("get", `/receive/po/${x.poId}?hotelId=${B1}`), q("get", `/receive/po/${BOGUS}?hotelId=${B1}`)),
    ],
  },
  {
    key: "POST /grn", perm: "grn.create", scoped: 404, noPerm: 403, ok: 201,
    ids: () => ({ poId: W.poA.poId }), idKey: "poId",
    req: (x) => q("post", "/grn", {
      poId: x.poId, hotelId: A1, receivedAt: TODAY, post: false, clientEventId: randomUUID(),
      lines: [grnLine(W.poA.lineIds[0], 1)],
    }),
    foreign: (x) => [
      // A's PO received at B's own hotel.
      pair(
        q("post", "/grn", { poId: x.poId, hotelId: B1, receivedAt: TODAY, post: true, clientEventId: randomUUID(), lines: [grnLine(W.poA.lineIds[0], 1)] }),
        q("post", "/grn", { poId: BOGUS, hotelId: B1, receivedAt: TODAY, post: true, clientEventId: randomUUID(), lines: [grnLine(W.poA.lineIds[0], 1)] }),
      ),
      // B's own PO with A's PO line: a line error, word for word a missing line's.
      pair(
        q("post", "/grn", { poId: W.poB.poId, hotelId: B1, receivedAt: TODAY, post: true, clientEventId: randomUUID(), lines: [grnLine(W.poA.lineIds[0], 1)] }),
        q("post", "/grn", { poId: W.poB.poId, hotelId: B1, receivedAt: TODAY, post: true, clientEventId: randomUUID(), lines: [grnLine(BOGUS, 1)] }),
        { expect: 400 },
      ),
      // Replaying the key of A's posted receipt.
      replayed(
        q("post", "/grn", { poId: W.poB.poId, hotelId: B1, receivedAt: TODAY, post: true, clientEventId: W.grnA.clientEventId, lines: [grnLine(W.poB.lineIds[0], 1)] }),
        { status: 2, message: "GRN not found", code: "NOT_FOUND", details: {} },
      ),
    ],
  },
  {
    key: "GET /grn/:id", perm: "grn.read", scoped: 404, noPerm: 404, ok: 200,
    ids: () => ({ id: W.grnA.id }), idKey: "id",
    req: (x) => q("get", `/grn/${x.id}`),
  },
  {
    key: "PUT /grn/:id", perm: "grn.update", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => postGrnA({ post: false }), ids: (f) => ({ id: f.id }), idKey: "id",
    req: (x) => q("put", `/grn/${x.id}`, {
      hotelId: A1, receivedAt: TODAY, post: false, remarks: "ISO-A1-ONLY edited", lines: [grnLine(W.poA.lineIds[0], 1)],
    }),
  },
  {
    key: "POST /grn/:id/post", perm: "grn.create", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => postGrnA({ post: false }), ids: (f) => ({ id: f.id }), idKey: "id",
    req: (x) => q("post", `/grn/${x.id}/post`, { clientEventId: randomUUID() }),
  },
  {
    key: "DELETE /grn/:id", perm: "grn.update", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => postGrnA({ post: false }), ids: (f) => ({ id: f.id }), idKey: "id",
    req: (x) => q("delete", `/grn/${x.id}`),
  },
  {
    key: "POST /grn/:id/reverse", perm: "grn.approve", scoped: 404, noPerm: 403, ok: 201,
    fresh: () => postGrnA({ qty: 1 }), ids: (f) => ({ id: f.id }), idKey: "id",
    req: (x) => q("post", `/grn/${x.id}/reverse`, { reason: "ISO-A1-ONLY wrong receipt", lines: "all" }),
  },
  {
    key: "POST /grn/:id/attachments", perm: "grn.update", scoped: 404, noPerm: 403, ok: 201,
    fresh: () => postGrnA({ post: false }), ids: (f) => ({ id: f.id }), idKey: "id",
    req: (x) => ({ method: "post", path: `/grn/${x.id}/attachments`, fields: { kind: "CHALLAN" }, attach: pdf() }),
  },
  {
    key: "DELETE /grn/:id/attachments/:attId", perm: "grn.update", scoped: 404, noPerm: 403, ok: 200,
    fresh: async () => {
      const g = await postGrnA({ post: false });
      const att = await must(send(C.aAll, { method: "post", path: `/grn/${g.id}/attachments`, fields: { kind: "OTHER" }, attach: pdf() }), "attachment");
      return { id: g.id, attId: att.id };
    },
    ids: (f) => f, idKey: "id",
    req: (x) => q("delete", `/grn/${x.id}/attachments/${x.attId}`),
  },
  {
    // Exactly what GET /grn/:id answers.
    key: "GET /grn/:id/pdf", perm: "grn.read", scoped: 404, noPerm: 404, ok: 200,
    ids: () => ({ id: W.grnA.id }), idKey: "id",
    req: (x) => q("get", `/grn/${x.id}/pdf`),
  },

  // ── returns to vendor ──
  {
    key: "POST /rtv", perm: "grn.approve", scoped: 404, noPerm: 403, ok: 200,
    ids: () => ({ grnId: W.grnA.id, grnLineId: W.grnA.lines[0].id }), idKey: "grnId",
    req: (x) => q("post", "/rtv", {
      grnId: x.grnId, disposition: "REPLACE", remarks: "ISO-A1-ONLY return", lines: [{ grnLineId: x.grnLineId, qty: 1, reason: "damaged" }],
    }),
    // B's own receipt naming A's receipt line.
    foreign: (x) => [pair(
      q("post", "/rtv", { grnId: W.grnB.id, disposition: "REPLACE", remarks: "x", lines: [{ grnLineId: x.grnLineId, qty: 1, reason: "damaged" }] }),
      q("post", "/rtv", { grnId: W.grnB.id, disposition: "REPLACE", remarks: "x", lines: [{ grnLineId: BOGUS, qty: 1, reason: "damaged" }] }),
    )],
  },
  {
    key: "GET /rtv/:id", perm: "grn.read", scoped: 404, noPerm: 404, ok: 200,
    fresh: () => newRtv(W.grnA.lines[0].id), ids: (f) => ({ id: f.id }), idKey: "id",
    req: (x) => q("get", `/rtv/${x.id}`),
  },
  {
    key: "POST /rtv/:id/dispatch", perm: "grn.approve", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => newRtv(W.grnA.lines[0].id), ids: (f) => ({ id: f.id }), idKey: "id",
    req: (x) => q("post", `/rtv/${x.id}/dispatch`, { challanNo: "ISO-A1-ONLY-GP" }),
  },
  {
    key: "POST /rtv/:id/close", perm: "grn.approve", scoped: 404, noPerm: 403, ok: 200,
    // A CREDIT return: closing a REPLACE one waits on the re-delivery.
    fresh: async () => {
      const r = await newRtv(W.grnA.lines[0].id, "CREDIT");
      await must(C.aAll.post(`${BASE}/rtv/${r.id}/dispatch`).send({}), "RTV dispatch");
      return r;
    },
    ids: (f) => ({ id: f.id }), idKey: "id",
    req: (x) => q("post", `/rtv/${x.id}/close`, { creditNoteRef: "ISO-A1-ONLY-CN" }),
  },
  {
    key: "POST /rtv/:id/cancel", perm: "grn.approve", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => newRtv(W.grnA.lines[0].id), ids: (f) => ({ id: f.id }), idKey: "id",
    req: (x) => q("post", `/rtv/${x.id}/cancel`),
  },

  // ── company items (company-level: a grant at ANY hotel of the company covers them, B3) ──
  {
    key: "PUT /items/:id", perm: "inventory.admin", scoped: "company", noPerm: 403, ok: 200,
    ids: () => ({ id: W.itemA2 }), idKey: "id",
    req: (x) => q("put", `/items/${x.id}`, { displayName: "ISO-A-SECRET Basmati", stockUom: "kg", isActive: true }),
  },
  {
    key: "POST /items/:id/variants", perm: "inventory.admin", scoped: "company", noPerm: 403, ok: 200,
    fresh: () => ({ variant: nextVariant() }), ids: (f) => ({ id: W.itemA2, variant: f.variant }), idKey: "id",
    req: (x) => q("post", `/items/${x.id}/variants`, { productVariantId: x.variant }),
  },
  {
    key: "GET /items/:id/uoms", perm: "inventory.read", scoped: "company", noPerm: 404, ok: 200,
    ids: () => ({ id: W.itemA1 }), idKey: "id",
    req: (x) => q("get", `/items/${x.id}/uoms`),
  },
  {
    key: "PUT /items/:id/uoms", perm: "inventory.update", scoped: "company", noPerm: 403, ok: 200,
    ids: () => ({ id: W.itemA2 }), idKey: "id",
    req: (x) => q("put", `/items/${x.id}/uoms`, { uoms: [{ uomLabel: "box", factorToStock: 10 }] }),
  },
  {
    key: "POST /items/:id/barcodes", perm: "inventory.update", scoped: "company", noPerm: 403, ok: 200,
    ids: () => ({ id: W.itemA2 }), idKey: "id",
    req: (x) => q("post", `/items/${x.id}/barcodes`, { code: `89012345${String(Date.now()).slice(-5)}`, packFactor: 1 }),
  },
  {
    key: "DELETE /items/:id/barcodes/:barcodeId", perm: "inventory.update", scoped: "company", noPerm: 403, ok: 200,
    fresh: () => must(C.aAll.post(`${BASE}/items/${W.itemA2}/barcodes`).send({ code: "8901234500048" }), "barcode"),
    ids: (f) => ({ id: W.itemA2, barcodeId: f.id }), idKey: "id",
    req: (x) => q("delete", `/items/${x.id}/barcodes/${x.barcodeId}`),
    // B's own item naming A's barcode.
    foreign: (x) => [pair(q("delete", `/items/${W.itemB}/barcodes/${x.barcodeId}`), q("delete", `/items/${W.itemB}/barcodes/${BOGUS}`))],
  },

  // ── hotel setup ──
  {
    key: "PUT /hotel-items/:hotelId/:invItemId", perm: "inventory.update", scoped: 404, noPerm: 403, ok: 200,
    ids: () => ({ hotelId: A1, invItemId: W.itemA1 }), idKey: "hotelId",
    req: (x) => q("put", `/hotel-items/${x.hotelId}/${x.invItemId}`, { minQty: 1, reorderLevel: 2, maxQty: 50, binLabel: "ISO-A1-ONLY-BIN" }),
    // B's own hotel naming A's item.
    foreign: (x) => [pair(
      q("put", `/hotel-items/${B1}/${x.invItemId}`, { minQty: 1, reorderLevel: 2, maxQty: 50, binLabel: null }),
      q("put", `/hotel-items/${B1}/${BOGUS}`, { minQty: 1, reorderLevel: 2, maxQty: 50, binLabel: null }),
    )],
  },
  {
    key: "GET /settings/hotel/:hotelId", perm: "inventory.read", scoped: 404, noPerm: 404, ok: 200,
    ids: () => ({ hotelId: A1 }), idKey: "hotelId",
    req: (x) => q("get", `/settings/hotel/${x.hotelId}`),
  },
  {
    key: "PUT /settings/hotel/:hotelId", perm: "inventory.admin", scoped: 404, noPerm: 403, ok: 200,
    ids: () => ({ hotelId: A1 }), idKey: "hotelId",
    req: (x) => q("put", `/settings/hotel/${x.hotelId}`, { docCode: "ISOA1SECRET" }),
  },
  {
    key: "POST /opening/:hotelId/preview", perm: "inventory.admin", scoped: 404, noPerm: 403, ok: 200, hotel: A3,
    fresh: async () => ({ sheet: await openingSheet() }),
    ids: (f) => ({ hotelId: A3, sheet: f.sheet }), idKey: "hotelId",
    req: (x) => ({ method: "post", path: `/opening/${x.hotelId}/preview`, attach: x.sheet }),
  },
  {
    key: "POST /opening/:hotelId/post", perm: "inventory.admin", scoped: 404, noPerm: 403, ok: 200, hotel: A3,
    ids: () => ({ hotelId: A3, invItemId: W.itemOpen, key: randomUUID() }), idKey: "hotelId",
    req: (x) => q("post", `/opening/${x.hotelId}/post`, {
      rows: [{ invItemId: x.invItemId, stockQty: 5, unitCost: 10, binLabel: null }], clientEventId: x.key,
    }),
    // B's own hotel naming A's item: a row error ("No matching item"), word
    // for word what a missing item id gets.
    foreign: (x) => [pair(
      q("post", `/opening/${B1}/post`, { rows: [{ invItemId: x.invItemId, stockQty: 5, unitCost: 10, binLabel: null }], clientEventId: randomUUID() }),
      q("post", `/opening/${B1}/post`, { rows: [{ invItemId: BOGUS, stockQty: 5, unitCost: 10, binLabel: null }], clientEventId: randomUUID() }),
      { expect: 400 },
    )],
  },

  // ── stock (stockCommon.assertDocAccess: 404 for anything the caller cannot read, C3) ──
  {
    key: "GET /stock/:hotelId/items/:invItemId", perm: "inventory.read", scoped: 404, noPerm: 404, ok: 200,
    ids: () => ({ hotelId: A1, invItemId: W.itemA1 }), idKey: "hotelId",
    req: (x) => q("get", `/stock/${x.hotelId}/items/${x.invItemId}`),
    foreign: (x) => [pair(q("get", `/stock/${B1}/items/${x.invItemId}`), q("get", `/stock/${B1}/items/${BOGUS}`))],
  },
  {
    key: "GET /stock/:hotelId/items/:invItemId/ledger", perm: "inventory.read", scoped: 404, noPerm: 404, ok: 200,
    ids: () => ({ hotelId: A1, invItemId: W.itemA1 }), idKey: "hotelId",
    req: (x) => q("get", `/stock/${x.hotelId}/items/${x.invItemId}/ledger`),
    foreign: (x) => [pair(q("get", `/stock/${B1}/items/${x.invItemId}/ledger`), q("get", `/stock/${B1}/items/${BOGUS}/ledger`))],
  },
  {
    key: "POST /out", perm: "inventory.create", scoped: 404, noPerm: 403, ok: 201,
    ids: () => ({ hotelId: A1 }), idKey: "hotelId",
    req: (x) => q("post", "/out", {
      hotelId: x.hotelId, docType: "OUT", departmentId: FB, clientEventId: randomUUID(), lines: [{ invItemId: W.itemA1, qty: 1 }],
    }),
    foreign: () => [
      pair(
        q("post", "/out", { hotelId: B1, docType: "OUT", departmentId: FB, clientEventId: randomUUID(), lines: [{ invItemId: W.itemA1, qty: 1 }] }),
        q("post", "/out", { hotelId: B1, docType: "OUT", departmentId: FB, clientEventId: randomUUID(), lines: [{ invItemId: BOGUS, qty: 1 }] }),
      ),
      replayed(
        q("post", "/out", { hotelId: B1, docType: "OUT", departmentId: FB, clientEventId: W.outA.clientEventId, lines: [{ invItemId: W.itemB, qty: 1 }] }),
        { status: 2, message: "Document not found", code: "NOT_FOUND", details: {} },
      ),
    ],
  },
  {
    key: "GET /out/:id", perm: "inventory.read", scoped: 404, noPerm: 404, ok: 200,
    ids: () => ({ id: W.outA.id }), idKey: "id",
    req: (x) => q("get", `/out/${x.id}`),
  },
  {
    key: "POST /adjustments", perm: "inventory.create", scoped: 404, noPerm: 403, ok: 201,
    ids: () => ({ hotelId: A1 }), idKey: "hotelId",
    req: (x) => q("post", "/adjustments", {
      hotelId: x.hotelId, reasonCode: "WASTAGE", submit: true, clientEventId: randomUUID(), lines: [{ invItemId: W.itemA1, qty: -1 }],
    }),
    foreign: () => [
      pair(
        q("post", "/adjustments", { hotelId: B1, reasonCode: "WASTAGE", submit: true, clientEventId: randomUUID(), lines: [{ invItemId: W.itemA1, qty: -1 }] }),
        q("post", "/adjustments", { hotelId: B1, reasonCode: "WASTAGE", submit: true, clientEventId: randomUUID(), lines: [{ invItemId: BOGUS, qty: -1 }] }),
      ),
      replayed(
        q("post", "/adjustments", { hotelId: B1, reasonCode: "WASTAGE", submit: true, clientEventId: W.adjA.clientEventId, lines: [{ invItemId: W.itemB, qty: -1 }] }),
        { status: 2, message: "Adjustment not found", code: "NOT_FOUND", details: {} },
      ),
    ],
  },
  {
    key: "GET /adjustments/:id", perm: "inventory.read", scoped: 404, noPerm: 404, ok: 200,
    ids: () => ({ id: W.adjA.id }), idKey: "id",
    req: (x) => q("get", `/adjustments/${x.id}`),
  },
  {
    key: "POST /adjustments/:id/approve", perm: "inventory.approve", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => newAdjustment(), ids: (f) => ({ id: f.id }), idKey: "id",
    req: (x) => q("post", `/adjustments/${x.id}/approve`),
  },
  {
    key: "POST /adjustments/:id/reject", perm: "inventory.approve", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => newAdjustment(), ids: (f) => ({ id: f.id }), idKey: "id",
    req: (x) => q("post", `/adjustments/${x.id}/reject`, { reason: "not needed" }),
  },

  // ── counts (assertDocAccess: 404, C3) ──
  {
    key: "POST /counts", perm: "inventory.create", scoped: 404, noPerm: 403, ok: 201,
    ids: () => ({ hotelId: A1 }), idKey: "hotelId",
    req: (x) => q("post", "/counts", { hotelId: x.hotelId, scope: "SELECTED", isBlind: false, invItemIds: [W.countItems[5]] }),
    foreign: () => [pair(
      q("post", "/counts", { hotelId: B1, scope: "SELECTED", isBlind: false, invItemIds: [W.countItems[5]] }),
      q("post", "/counts", { hotelId: B1, scope: "SELECTED", isBlind: false, invItemIds: [BOGUS] }),
    )],
  },
  {
    key: "GET /counts/:id", perm: "inventory.read", scoped: 404, noPerm: 404, ok: 200,
    ids: () => ({ id: W.countA.id }), idKey: "id",
    req: (x) => q("get", `/counts/${x.id}`),
  },
  {
    key: "PUT /counts/:id/lines", perm: "inventory.create", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => newCount(W.countItems[1]), ids: (f) => ({ id: f.id }), idKey: "id",
    req: (x) => q("put", `/counts/${x.id}/lines`, { lines: [{ invItemId: W.countItems[1], countedQty: 0, clientEventId: randomUUID() }] }),
    // B's own count naming A's item.
    foreign: () => [pair(
      q("put", `/counts/${W.countB.id}/lines`, { lines: [{ invItemId: W.countItems[1], countedQty: 0, clientEventId: randomUUID() }] }),
      q("put", `/counts/${W.countB.id}/lines`, { lines: [{ invItemId: BOGUS, countedQty: 0, clientEventId: randomUUID() }] }),
    )],
  },
  {
    key: "POST /counts/:id/submit", perm: "inventory.create", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => newCount(W.countItems[2], { counted: true }), ids: (f) => ({ id: f.id }), idKey: "id",
    req: (x) => q("post", `/counts/${x.id}/submit`, {}),
  },
  {
    key: "POST /counts/:id/approve", perm: "inventory.approve", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => newCount(W.countItems[3], { submitted: true }), ids: (f) => ({ id: f.id }), idKey: "id",
    req: (x) => q("post", `/counts/${x.id}/approve`, { reasons: {} }),
  },
  {
    key: "POST /counts/:id/cancel", perm: "inventory.approve", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => newCount(W.countItems[4]), ids: (f) => ({ id: f.id }), idKey: "id",
    req: (x) => q("post", `/counts/${x.id}/cancel`),
  },

  // ── labels and short links ──
  {
    key: "POST /labels/items", perm: "inventory.update", scoped: 404, noPerm: 403, ok: 200,
    ids: () => ({ hotelId: A1, invItemId: W.itemA1 }), idKey: "hotelId",
    req: (x) => q("post", "/labels/items", { layout: "A4_65", hotelId: x.hotelId, items: [{ invItemId: x.invItemId, copies: 1 }] }),
    foreign: (x) => {
      const labels = (hotelId, invItemId) => q("post", "/labels/items", {
        layout: "A4_65", ...(hotelId ? { hotelId } : {}), items: [{ invItemId, copies: 1 }],
      });
      return [
        // No hotel: A's item reads like no item.
        pair(labels(null, x.invItemId), labels(null, BOGUS)),
        // B's own hotel with A's item.
        pair(labels(B1, x.invItemId), labels(B1, BOGUS)),
        // A hotel that does not exist: the hotel is refused before any item is looked up.
        pair(labels(BOGUS, x.invItemId), labels(BOGUS, BOGUS)),
        pair(labels(BOGUS, x.invItemId), labels(BOGUS, BOGUS), { who: "OTHER" }),
      ];
    },
  },
  {
    // Exactly what GET /grn/:id answers.
    key: "POST /labels/grn/:grnId", perm: "grn.read", scoped: 404, noPerm: 404, ok: 200,
    ids: () => ({ grnId: W.grnA.id }), idKey: "grnId",
    req: (x) => q("post", `/labels/grn/${x.grnId}`, { layout: "A4_65", mode: "per_pack" }),
  },
  {
    // scanService.resolveShortLink: "never 403: a link reveals nothing".
    key: "GET /s/resolve", perm: "grn.read", scoped: 404, noPerm: 404, ok: 200,
    ids: () => ({ id: W.grnA.id }), idKey: "id",
    req: (x) => q("get", `/s/resolve?t=g&id=${x.id}`),
    foreign: () => [
      pair(q("get", `/s/resolve?t=p&id=${W.poA.poId}`), q("get", `/s/resolve?t=p&id=${BOGUS}`)),
      pair(q("get", `/s/resolve?t=i&id=${W.itemA1}`), q("get", `/s/resolve?t=i&id=${BOGUS}`)),
      pair(q("get", `/s/resolve?t=d&id=${W.dispatchA.id}`), q("get", `/s/resolve?t=d&id=${BOGUS}`)),
    ],
  },

  // ── reorder (D3): the hotel is gated against the caller's own scopes ──
  {
    key: "GET /reorder", perm: "inventory.read", scoped: 404, noPerm: 404, ok: 200,
    ids: () => ({ hotelId: A1 }), idKey: "hotelId",
    req: (x) => q("get", `/reorder?hotelId=${x.hotelId}`),
  },
  {
    key: "POST /reorder/mr-draft", perm: "inventory.update", scoped: 404, noPerm: 403, ok: 201,
    ids: () => ({ hotelId: A1, invItemId: W.itemA1 }), idKey: "hotelId",
    req: (x) => q("post", "/reorder/mr-draft", {
      hotelId: x.hotelId, departmentId: FB, clientEventId: randomUUID(), items: [{ invItemId: x.invItemId, qty: 1 }],
    }),
    foreign: (x) => {
      const draft = (invItemId, clientEventId = randomUUID()) => q("post", "/reorder/mr-draft", {
        hotelId: B1, departmentId: FB, clientEventId, items: [{ invItemId, qty: 1 }],
      });
      return [
        // B's own hotel with A's item.
        pair(draft(x.invItemId), draft(BOGUS)),
        // Replaying the key of A's draft: refused as any reused key is, naming nothing of A's.
        replayed(draft(W.itemB, W.mrDraftA.clientEventId), {
          status: 0, message: "This request was already used for another requisition", code: "CONFLICT",
          details: { field: "clientEventId" },
        }, { expect: 409 }),
      ];
    },
  },

  // ── legacy PO routes owned by inventory (mounted under /api/v1/po) ──
  {
    key: "POST /api/v1/po/addSiteRepresentative", perm: "grn.create", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => freshPoA(), ids: (f) => ({ poId: f.poId }), idKey: "poId",
    req: (x) => q("post", "/api/v1/po/addSiteRepresentative", {
      po_id: x.poId, hotel_id: A1, name: "Site rep", email: "rep@example.test", phone: "9876543210",
    }),
  },
  {
    key: "POST /api/v1/po/markGRN", perm: "grn.create", scoped: 404, noPerm: 403, ok: 200,
    fresh: () => makePo({ hotel: A1, vendor: VENDOR, lines: [{ qty: 3, variant: W.variantA1 }], status: "dispatched" }),
    ids: (f) => ({ poId: f.poId }), idKey: "poId",
    req: (x) => q("post", "/api/v1/po/markGRN", { po_id: x.poId, remarks: "received" }),
  },
  {
    key: "GET /api/v1/po/:po_id", perm: "awarding.read", scoped: 404, noPerm: 404, ok: 200,
    ids: () => ({ poId: W.poA.poId }), idKey: "poId",
    req: (x) => q("get", `/api/v1/po/${x.poId}`),
  },
];

// LIST rows: lists and aggregates. Each probe: who, request, and what it must
// answer — a status, or 'empty' (200 with no rows). B's and A_OTHER's answers
// never carry A (resp. A1) data; `has` names what the answer must contain.
const rowsOf = (data) => data?.rows ?? data;
const NO_CODE = "8901234599990"; // a barcode no company holds
const link = (t, id) => encodeURIComponent(`https://x.test/s?t=${t}&id=${id}`);
const LIST_ROWS = [
  {
    key: "GET /receive/awaiting",
    probes: () => [
      { who: "B", req: q("get", "/receive/awaiting"), expect: 200, has: [W.poB.poNumber] },
      { who: "B", req: q("get", `/receive/awaiting?hotelId=${A1}`), expect: "empty", sameAs: q("get", `/receive/awaiting?hotelId=${BOGUS}`) },
      { who: "OTHER", req: q("get", `/receive/awaiting?hotelId=${A1}`), expect: "empty", sameAs: q("get", `/receive/awaiting?hotelId=${BOGUS}`) },
      { who: "A", req: q("get", `/receive/awaiting?hotelId=${A1}`), expect: 200, has: [W.poA.poNumber] },
    ],
  },
  {
    key: "GET /grn",
    probes: () => [
      { who: "B", req: q("get", "/grn"), expect: 200, has: [W.grnB.grnNumber] },
      { who: "B", req: q("get", `/grn?hotelId=${A1}`), expect: "empty", sameAs: q("get", `/grn?hotelId=${BOGUS}`) },
      { who: "B", req: q("get", `/grn?poId=${W.poA.poId}`), expect: "empty", sameAs: q("get", `/grn?poId=${BOGUS}`) },
      { who: "B", req: q("get", "/grn?status=draft"), expect: 200 },
      { who: "OTHER", req: q("get", `/grn?hotelId=${A1}`), expect: "empty", sameAs: q("get", `/grn?hotelId=${BOGUS}`) },
      { who: "OTHER", req: q("get", `/grn?poId=${W.poA.poId}`), expect: "empty", sameAs: q("get", `/grn?poId=${BOGUS}`) },
      { who: "A", req: q("get", `/grn?hotelId=${A1}`), expect: 200, has: [W.grnA.grnNumber] },
    ],
  },
  {
    key: "GET /items",
    probes: () => [
      { who: "B", req: q("get", "/items"), expect: 200, has: ["ISO-B Rice"] },
      { who: "B", req: q("get", "/items?search=ISO-A-SECRET"), expect: "empty", sameAs: q("get", "/items?search=ISO-Z-NOTHING") },
      { who: "B", req: q("get", `/items?hotelId=${A1}`), expect: 404, sameAs: q("get", `/items?hotelId=${BOGUS}`) },
      { who: "OTHER", req: q("get", `/items?hotelId=${A1}`), expect: 404, sameAs: q("get", `/items?hotelId=${BOGUS}`) },
      // The hint only narrows among B's own companies: naming A narrows to nothing.
      { who: "B", req: q("get", `/items?hospitality_company_id=${CO_A}`), expect: "empty", sameAs: q("get", `/items?hospitality_company_id=${BOGUS}`) },
      { who: "A", req: q("get", "/items"), expect: 200, has: ["ISO-A-SECRET Saffron"] },
    ],
  },
  {
    key: "GET /items/suggest",
    probes: () => [
      // W.baitA is an A item named exactly like catalogue variant W.variantBait.
      { who: "B", req: q("get", `/items/suggest?productVariantId=${W.variantBait}`), expect: 200, lacksItem: W.baitA },
      { who: "B", req: q("get", `/items/suggest?productVariantId=${W.variantA1}`), expect: 200 },
      { who: "B", req: q("get", `/items/suggest?productVariantId=${W.variantBait}&hospitality_company_id=${CO_A}`), expect: 403, sameAs: q("get", `/items/suggest?productVariantId=${W.variantBait}&hospitality_company_id=${BOGUS}`) },
      { who: "A", req: q("get", `/items/suggest?productVariantId=${W.variantBait}`), expect: 200, hasItem: W.baitA },
    ],
  },
  {
    key: "GET /hotel-items",
    probes: () => [
      { who: "B", req: q("get", `/hotel-items?hotelId=${B1}`), expect: 200 },
      { who: "B", req: q("get", `/hotel-items?hotelId=${A1}`), expect: 404, sameAs: q("get", `/hotel-items?hotelId=${BOGUS}`) },
      { who: "OTHER", req: q("get", `/hotel-items?hotelId=${A1}`), expect: 404, sameAs: q("get", `/hotel-items?hotelId=${BOGUS}`) },
      { who: "A", req: q("get", `/hotel-items?hotelId=${A1}`), expect: 200, has: ["ISO-A1-ONLY-BIN"] },
    ],
  },
  {
    key: "GET /stock",
    probes: () => [
      { who: "B", req: q("get", "/stock"), expect: 200, has: ["ISO-B Rice"] },
      { who: "B", req: q("get", `/stock?hotelId=${A1}`), expect: 404, sameAs: q("get", `/stock?hotelId=${BOGUS}`) },
      { who: "B", req: q("get", "/stock?search=ISO-A-SECRET"), expect: "empty", sameAs: q("get", "/stock?search=ISO-Z-NOTHING") },
      { who: "OTHER", req: q("get", `/stock?hotelId=${A1}`), expect: 404, sameAs: q("get", `/stock?hotelId=${BOGUS}`) },
      { who: "A", req: q("get", `/stock?hotelId=${A1}`), expect: 200, has: ["ISO-A-SECRET Saffron"] },
    ],
  },
  {
    key: "GET /out",
    probes: () => [
      { who: "B", req: q("get", "/out"), expect: 200, has: [W.outB.outNumber] },
      { who: "B", req: q("get", `/out?hotelId=${A1}`), expect: "empty", sameAs: q("get", `/out?hotelId=${BOGUS}`) },
      { who: "OTHER", req: q("get", `/out?hotelId=${A1}`), expect: "empty", sameAs: q("get", `/out?hotelId=${BOGUS}`) },
      { who: "A", req: q("get", `/out?hotelId=${A1}`), expect: 200, has: [W.outA.outNumber] },
    ],
  },
  {
    key: "GET /adjustments",
    probes: () => [
      { who: "B", req: q("get", "/adjustments"), expect: 200, has: [W.adjB.adjustmentNumber] },
      { who: "B", req: q("get", `/adjustments?hotelId=${A1}`), expect: "empty", sameAs: q("get", `/adjustments?hotelId=${BOGUS}`) },
      { who: "OTHER", req: q("get", `/adjustments?hotelId=${A1}`), expect: "empty", sameAs: q("get", `/adjustments?hotelId=${BOGUS}`) },
      { who: "A", req: q("get", `/adjustments?hotelId=${A1}`), expect: 200, has: [W.adjA.adjustmentNumber] },
    ],
  },
  {
    key: "GET /counts",
    probes: () => [
      { who: "B", req: q("get", "/counts"), expect: 200, has: [W.countB.countNumber] },
      { who: "B", req: q("get", `/counts?hotelId=${A1}`), expect: "empty", sameAs: q("get", `/counts?hotelId=${BOGUS}`) },
      { who: "OTHER", req: q("get", `/counts?hotelId=${A1}`), expect: "empty", sameAs: q("get", `/counts?hotelId=${BOGUS}`) },
      { who: "A", req: q("get", `/counts?hotelId=${A1}`), expect: 200, has: [W.countA.countNumber] },
    ],
  },
  {
    key: "GET /overview",
    probes: () => [
      { who: "B", req: q("get", "/overview"), expect: 200, has: ["Hotel B-1"] },
      { who: "B", req: q("get", `/overview?hotelId=${A1}`), expect: 404, sameAs: q("get", `/overview?hotelId=${BOGUS}`) },
      { who: "OTHER", req: q("get", `/overview?hotelId=${A1}`), expect: 404, sameAs: q("get", `/overview?hotelId=${BOGUS}`) },
      { who: "OTHER", req: q("get", "/overview"), expect: 200 },
      { who: "A", req: q("get", `/overview?hotelId=${A1}`), expect: 200, has: ["Hotel A-1"] },
    ],
  },
  {
    key: "GET /scan/resolve",
    probes: () => [
      // A's barcode, scanned by B with no context and in B's own hotel: unknown, like a code nobody has.
      { who: "B", req: q("get", `/scan/resolve?code=${W.barcodeA.code}`), expect: 200, kind: "unknown", sameAs: q("get", `/scan/resolve?code=${NO_CODE}`) },
      { who: "B", req: q("get", `/scan/resolve?code=${W.barcodeA.code}&context=hotel:${B1}`), expect: 200, kind: "unknown", sameAs: q("get", `/scan/resolve?code=${NO_CODE}&context=hotel:${B1}`) },
      // A's own QR short links, scanned by B: like a link to nothing.
      { who: "B", req: q("get", `/scan/resolve?code=${link("i", W.itemA1)}&context=hotel:${B1}`), expect: 200, kind: "unknown", sameAs: q("get", `/scan/resolve?code=${link("i", BOGUS)}&context=hotel:${B1}`) },
      { who: "B", req: q("get", `/scan/resolve?code=${link("g", W.grnA.id)}`), expect: 200, kind: "unknown", sameAs: q("get", `/scan/resolve?code=${link("g", BOGUS)}`) },
      // A user at A2 scanning A1's receipt link.
      { who: "OTHER", req: q("get", `/scan/resolve?code=${link("g", W.grnA.id)}`), expect: 200, kind: "unknown", sameAs: q("get", `/scan/resolve?code=${link("g", BOGUS)}`) },
      // A's hotel or PO as the scan context.
      { who: "B", req: q("get", `/scan/resolve?code=${W.barcodeA.code}&context=hotel:${A1}`), expect: 404, sameAs: q("get", `/scan/resolve?code=${W.barcodeA.code}&context=hotel:${BOGUS}`) },
      { who: "B", req: q("get", `/scan/resolve?code=${W.barcodeA.code}&context=po:${W.poA.poId}`), expect: 404, sameAs: q("get", `/scan/resolve?code=${W.barcodeA.code}&context=po:${BOGUS}`) },
      { who: "OTHER", req: q("get", `/scan/resolve?code=${W.barcodeA.code}&context=hotel:${A1}`), expect: 404, sameAs: q("get", `/scan/resolve?code=${W.barcodeA.code}&context=hotel:${BOGUS}`) },
      { who: "OTHER", req: q("get", `/scan/resolve?code=${W.barcodeA.code}&context=po:${W.poA.poId}`), expect: 404, sameAs: q("get", `/scan/resolve?code=${W.barcodeA.code}&context=po:${BOGUS}`) },
      { who: "A", req: q("get", `/scan/resolve?code=${W.barcodeA.code}&context=hotel:${A1}`), expect: 200, kind: "item", has: ["ISO-A-SECRET Saffron"] },
    ],
  },
];

// COMPANY rows: entity-less company routes. The company is the caller's; a
// hint (query/header) may only narrow among companies they hold the
// permission in, so naming Company A is refused exactly like naming none.
const COMPANY_ROWS = [
  { key: "GET /settings/company", perm: "inventory.read", req: (hint) => q("get", `/settings/company${hint ? `?hospitality_company_id=${hint}` : ""}`) },
  {
    key: "PUT /settings/company", perm: "inventory.admin", mutates: true,
    req: (hint) => q("put", `/settings/company${hint ? `?hospitality_company_id=${hint}` : ""}`, { adjustmentAutoApproveLimit: 0, countFreeze: false }),
  },
  { key: "GET /category-defaults", perm: "inventory.read", req: (hint) => q("get", `/category-defaults${hint ? `?hospitality_company_id=${hint}` : ""}`) },
  {
    key: "PUT /category-defaults", perm: "inventory.admin", mutates: true,
    req: (hint) => q("put", `/category-defaults${hint ? `?hospitality_company_id=${hint}` : ""}`, { rows: [] }),
  },
  {
    key: "POST /items", perm: "inventory.admin", mutates: true, ok: 200,
    req: (hint, v) => q("post", `/items${hint ? `?hospitality_company_id=${hint}` : ""}`, {
      productVariantId: v, displayName: "ISO-A-SECRET New", stockUom: "kg",
    }),
  },
];

// VENDOR rows: a vendor acts only on a PO finalised to them.
const VENDOR_ROWS = [
  {
    key: "GET /vendor/po/:poId/deliveries", ok: 200,
    ids: () => ({ poId: W.poA.poId }), idKey: "poId",
    req: (x) => q("get", `/vendor/po/${x.poId}/deliveries`),
  },
  {
    key: "POST /vendor/po/:poId/dispatches", ok: 201,
    ids: () => ({ poId: W.poA.poId }), idKey: "poId",
    req: (x) => q("post", `/vendor/po/${x.poId}/dispatches`, {
      hotelId: A1, challanNo: "ISO-A1-ONLY-DSP2", challanDate: TODAY, expectedDeliveryDate: TODAY,
      lines: [{ poLineId: W.poA.lineIds[1], qty: 1 }],
    }),
  },
  {
    key: "POST /vendor/po/:poId/dispatches/:id/cancel", ok: 200,
    fresh: () => must(C.vendor.post(`${BASE}/vendor/po/${W.poA.poId}/dispatches`).send({
      hotelId: A1, challanNo: "ISO-A1-ONLY-DSP3", challanDate: TODAY, expectedDeliveryDate: TODAY,
      lines: [{ poLineId: W.poA.lineIds[1], qty: 1 }],
    }), "dispatch to cancel"),
    ids: (f) => ({ poId: W.poA.poId, id: f.id }), idKey: "poId",
    req: (x) => q("post", `/vendor/po/${x.poId}/dispatches/${x.id}/cancel`),
    // The owner of PO A naming Company B's dispatch under their own PO.
    ownerForeign: () => [pair(
      q("post", `/vendor/po/${W.poA.poId}/dispatches/${W.dispatchB.id}/cancel`),
      q("post", `/vendor/po/${W.poA.poId}/dispatches/${BOGUS}/cancel`),
    )],
  },
  {
    key: "POST /api/v1/po/raiseInvoice", ok: 200,
    ids: () => ({ poId: W.poA.poId }), idKey: "poId",
    req: (x) => q("post", "/api/v1/po/raiseInvoice", { po_id: x.poId, invoice_url: OWN_URL(`invoices/${randomUUID()}.pdf`) }),
  },
  {
    key: "POST /api/v1/po/markDispatched", ok: 200,
    fresh: () => makePo({ hotel: A1, vendor: VENDOR, lines: [{ qty: 3, variant: W.variantA1 }] }),
    ids: (f) => ({ poId: f.poId }), idKey: "poId",
    req: (x) => q("post", "/api/v1/po/markDispatched", { po_id: x.poId }),
  },
];

// TOKEN routes: covered by the "site-rep links" describe below.
const TOKEN_KEYS = ["GET /token/receive-context", "POST /token/grn", "POST /token/grn/:id/attachments"];

// Inventory-owned routes mounted outside /api/v1/inventory.
const ELSEWHERE = [
  "POST /api/v1/po/addSiteRepresentative", // B6: issues a hashed site-rep link
  "POST /api/v1/po/markGRN", // B1: legacy receive shim
  "GET /api/v1/po/:po_id", // B6: token-redacted PO view
  "POST /api/v1/po/raiseInvoice", // C4: invoice number / date / amount / dispatch
  "POST /api/v1/po/markDispatched", // C4: legacy dispatch shim
];

const TABLE_KEYS = [
  ...DOC_ROWS.map((r) => r.key), ...LIST_ROWS.map((r) => r.key), ...COMPANY_ROWS.map((r) => r.key),
  ...VENDOR_ROWS.map((r) => r.key), ...TOKEN_KEYS,
];

/**
 * The path a router is mounted at, read back from Express 4's mount regexp
 * (path-to-regexp 0.1, end:false). Fails closed: anything it cannot read
 * exactly (an array of paths, a regexp, a wildcard) is an error, never skipped.
 */
function mountOf(layer) {
  if (layer.regexp?.fast_slash) return "";
  const src = layer.regexp?.source ?? "";
  const fail = () => new Error(`route guard cannot read the mount /${src}/ (${layer.name})`);
  const m = src.match(/^\^(.*)\\\/\?\(\?=\\\/\|\$\)$/);
  if (!m) throw fail();
  let k = 0;
  const mount = m[1]
    .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => {
      const key = layer.keys?.[k++];
      if (!key?.name) throw fail();
      return `:${key.name}`;
    })
    .replace(/\\(.)/g, "$1");
  if (/[\\^$*+?()[\]{}|]/.test(mount) || k !== (layer.keys?.length ?? 0)) throw fail();
  return mount;
}

/**
 * Every METHOD + full path mounted on the app, with its route's handlers. A
 * `.all()` route is listed as ALL, and plain middleware mounted at a path
 * (`use('/x', fn)`, which answers anything under /x) as USE: both need a row
 * like any other route. Middleware on "/" (auth, parsers) is not a route.
 */
function mountedRoutes(app) {
  const out = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        if (typeof layer.route.path !== "string") {
          throw new Error(`route guard cannot read the route ${String(layer.route.path)} under ${prefix || "/"}`);
        }
        for (const m of Object.keys(layer.route.methods)) {
          const method = m === "_all" ? "ALL" : m.toUpperCase();
          out.push({ key: `${method} ${prefix}${layer.route.path}`, handles: layer.route.stack.map((l) => l.handle) });
        }
      } else if (layer.name === "mounted_app") {
        throw new Error(`route guard cannot walk a mounted sub-app under ${prefix || "/"}`);
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountOf(layer));
      } else if (!layer.regexp?.fast_slash) {
        out.push({ key: `USE ${prefix}${mountOf(layer)}`, handles: [layer.handle] });
      }
    }
  };
  walk(app._router.stack, "");
  return out;
}

/** Every function app/controllers/inventory/* exports (named, and the default object's values). */
async function inventoryHandlers() {
  const handlers = new Set();
  for (const file of fs.readdirSync(CONTROLLERS_DIR).filter((f) => f.endsWith(".js"))) {
    const mod = await import(pathToFileURL(path.join(CONTROLLERS_DIR, file)).href);
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === "function") handlers.add(value);
      if (name === "default" && value && typeof value === "object") {
        for (const v of Object.values(value)) if (typeof v === "function") handlers.add(v);
      }
    }
  }
  return handlers;
}

// ---------------------------------------------------------------------------
// 1. Every inventory route has an entry
// ---------------------------------------------------------------------------

const underBase = (key) => {
  const p = key.split(" ")[1];
  return p === BASE || p.startsWith(`${BASE}/`);
};

describe("route enumeration guard", () => {
  it("every mounted inventory route has an isolation entry, and every entry is mounted", async () => {
    const mounted = mountedRoutes(await buildTestApp()).map((r) => r.key);
    const inventory = mounted.filter(underBase).map((r) => r.replace(` ${BASE}/`, " /"));
    expect(inventory.length).toBeGreaterThan(60);

    const keys = new Set(TABLE_KEYS);
    const known = new Set([...inventory, ...ELSEWHERE.filter((k) => mounted.includes(k))]);
    const missing = inventory.filter((r) => !keys.has(r)).sort();
    const notMounted = TABLE_KEYS.filter((k) => !known.has(k)).sort();
    const elsewhereUnlisted = ELSEWHERE.filter((k) => !keys.has(k) || !mounted.includes(k));
    // A failure lists the routes: add an isolation row for each `missing` one.
    expect({ missing, notMounted, elsewhereUnlisted }).toEqual({ missing: [], notMounted: [], elsewhereUnlisted: [] });
    expect(new Set(TABLE_KEYS).size).toBe(TABLE_KEYS.length);
  });

  it("an inventory controller handler mounted anywhere else in the app is listed too", async () => {
    const routes = mountedRoutes(await buildTestApp());
    const handlers = await inventoryHandlers();
    const usesInventory = (r) => r.handles.some((h) => handlers.has(h));
    // Sanity: the matcher recognises the handler of every /inventory route itself.
    expect(routes.filter((r) => underBase(r.key) && !r.key.startsWith("USE ") && !usesInventory(r)).map((r) => r.key)).toEqual([]);
    // Anywhere else, each must be an ELSEWHERE entry (which the first test ties to a row).
    const outside = routes.filter((r) => !underBase(r.key) && usesInventory(r)).map((r) => r.key);
    expect(outside.filter((k) => !ELSEWHERE.includes(k))).toEqual([]);
  });

  it("the mount reader fails closed on a mount it cannot read", () => {
    const layer = (source, keys = []) => ({ name: "router", regexp: new RegExp(source, "i"), keys });
    expect(mountOf(layer("^\\/api\\/v1\\/inventory\\/?(?=\\/|$)"))).toBe("/api/v1/inventory");
    expect(mountOf(layer("^\\/x\\/(?:([^\\/]+?))\\/?(?=\\/|$)", [{ name: "id" }]))).toBe("/x/:id");
    expect(() => mountOf(layer("^(?:\\/a|\\/b)\\/?(?=\\/|$)"))).toThrow(/cannot read the mount/); // an array of paths
    expect(() => mountOf(layer("^\\/a(.*)\\/?(?=\\/|$)"))).toThrow(/cannot read the mount/); // a wildcard
    expect(() => mountOf(layer("^\\/x\\/(?:([^\\/]+?))\\/?(?=\\/|$)"))).toThrow(/cannot read the mount/); // a param with no key
    expect(() => mountOf(layer("^\\/x$"))).toThrow(/cannot read the mount/); // not a mount regexp at all
  });

  it("an .all() route and plain middleware mounted at a path are routes too", () => {
    const router = express.Router();
    router.all("/anything", (req, res) => res.end());
    router.use("/hidden", (req, res) => res.end());
    router.get("/x", (req, res) => res.end());
    const app = express();
    app.use(BASE, router);
    app.use((req, res, next) => next()); // on "/": not a route
    expect(mountedRoutes(app).map((r) => r.key)).toEqual([`ALL ${BASE}/anything`, `USE ${BASE}/hidden`, `GET ${BASE}/x`]);
    const star = express();
    star.use("*", (req, res) => res.end());
    expect(() => mountedRoutes(star)).toThrow(/cannot read the mount/);
  });
});

describe("the comparator", () => {
  // Answers built by hand, ids deliberately colliding the way they do right
  // after a truncate (PO 5, delivery 5, GRN line 1, qty 1).
  const answer = (body) => ({ status: 404, type: "application/json", body: { status: 2, code: "NOT_FOUND", ...body } });
  const same = (pattern, a, aSpec, b, bSpec) => JSON.stringify(signature(a, aSpec, pattern)) === JSON.stringify(signature(b, bSpec, pattern));

  it("an id the request sent, answered back under the same name, is an echo", () => {
    const pattern = "PATCH /po/:poId/deliveries/:deliveryId";
    const spec = q("patch", "/po/7/deliveries/5", { dueDate: null });
    const twin = q("patch", `/po/7/deliveries/${BOGUS}`, { dueDate: null });
    expect(same(pattern,
      answer({ message: "Delivery not found", details: { deliveryId: "5" } }), spec,
      answer({ message: "Delivery not found", details: { deliveryId: String(BOGUS) } }), twin)).toBe(true);
  });

  it("a foreign PO id is not an echo because it equals another id of the request (patchDueDate mutation)", () => {
    // The foreign delivery 5 belongs to PO 5; a missing one falls back to the caller's own PO 7.
    const pattern = "PATCH /po/:poId/deliveries/:deliveryId";
    const spec = q("patch", "/po/7/deliveries/5", { dueDate: null });
    const twin = q("patch", `/po/7/deliveries/${BOGUS}`, { dueDate: null });
    expect(same(pattern,
      answer({ message: "Delivery not found", details: { deliveryId: "5", poId: 5 } }), spec,
      answer({ message: "Delivery not found", details: { deliveryId: String(BOGUS), poId: 7 } }), twin)).toBe(false);
  });

  it("a foreign GRN id is not an echo because it equals a line id or a quantity (RTV mutation)", () => {
    // The foreign line 1 belongs to GRN 1; a missing one falls back to the caller's own GRN 3.
    const body = (grnLineId) => ({ grnId: 3, disposition: "REPLACE", remarks: "x", lines: [{ grnLineId, qty: 1, reason: "damaged" }] });
    expect(same("POST /rtv",
      answer({ message: "Some lines are not on this goods receipt", details: { grnLineIds: [1], grnId: 1 } }), q("post", "/rtv", body(1)),
      answer({ message: "Some lines are not on this goods receipt", details: { grnLineIds: [BOGUS], grnId: 3 } }), q("post", "/rtv", body(BOGUS)),
    )).toBe(false);
  });

  it("a whole value is an echo only in a field that echoes it: the scanned code, on the scan route", () => {
    const scan = (code) => q("get", `/scan/resolve?code=${code}`);
    const resolved = (code) => ({ status: 200, type: "application/json", body: { status: 1, data: { kind: "unknown", code, item: null } } });
    expect(same("GET /scan/resolve", resolved("8901234500017"), scan("8901234500017"), resolved(NO_CODE), scan(NO_CODE))).toBe(true);
    // The same field on another route is data, not an echo.
    const add = (code) => q("post", "/items/5/barcodes", { code });
    const added = (code) => ({ status: 200, type: "application/json", body: { status: 1, data: { code } } });
    expect(same("POST /items/:id/barcodes", added("8901234500017"), add("8901234500017"), added(NO_CODE), add(NO_CODE))).toBe(false);
  });

  it("a request path that does not fit the route named for it is an error, not a guess", () => {
    expect(() => signature(answer({}), q("get", "/grn/5/pdf"), "GET /grn/:id")).toThrow(/does not match the route/);
  });
});

// ---------------------------------------------------------------------------
// 2. Records addressed by id
// ---------------------------------------------------------------------------

async function expectRefused(res, { route, actor, status, secrets = SECRETS_A }) {
  expect({
    route, actor, status: res.status, bodyStatus: res.body?.status, leaks: leaksIn(res.body, secrets),
  }).toEqual({ route, actor, status, bodyStatus: status === 404 ? 2 : 0, leaks: [] });
}

/** Two answers to requests on `pattern` must be indistinguishable: the whole signature, true echoes normalised. */
async function expectSame(label, pattern, res, spec, twinRes, twinSpec) {
  expect({ ...label, answer: signature(res, spec, pattern) }).toEqual({ ...label, answer: signature(twinRes, twinSpec, pattern) });
}

describe("records addressed by id", () => {
  it.each(DOC_ROWS.map((r) => [r.key, r]))("%s", async (route, row) => {
    const fresh = row.fresh ? await row.fresh() : {};
    const ids = row.ids(fresh);
    const real = row.req(ids);
    const missingSpec = row.req({ ...ids, [row.idKey]: BOGUS });

    // Company B: 404, nothing of A's, and indistinguishable from a missing id.
    const asB = await send(C.bAll, real);
    await expectRefused(asB, { route, actor: "B", status: 404 });
    await expectSame({ route, actor: "B" }, route, asB, real, await send(C.bAll, missingSpec), missingSpec);
    const callers = { B: C.bAll, OTHER: C.other };
    for (const [i, probe] of (row.foreign?.(ids) ?? []).entries()) {
      const actor = `${probe.who} foreign #${i}`;
      if (!probe.twin && !probe.body) throw new Error(`${route} ${actor}: every foreign probe needs a twin (or a pinned body)`);
      const client = callers[probe.who];
      const res = await send(client, probe.spec);
      await expectRefused(res, { route, actor, status: probe.expect, secrets: probe.who === "B" ? SECRETS_A : SECRETS_A1 });
      if (probe.twin) await expectSame({ route, actor }, route, res, probe.spec, await send(client, probe.twin), probe.twin);
      else expect({ route, actor, body: res.body }).toEqual({ route, actor, body: probe.body });
    }

    // Company A, other hotel only.
    if (row.scoped === "company") {
      if (real.method === "get") expect({ route, status: (await send(C.other, real)).status }).toEqual({ route, status: 200 });
    } else {
      const scoped = await send(C.other, real);
      await expectRefused(scoped, { route, actor: "A at A2 only", status: row.scoped, secrets: SECRETS_A1 });
      // C3: an out-of-scope record of the caller's own company reads like a missing one too.
      if (row.scoped === 404) await expectSame({ route, actor: "A at A2 only" }, route, scoped, real, await send(C.other, missingSpec), missingSpec);
    }

    // Company A, right hotel, everything but the route's permission.
    await grantNoPerm(row.perm, row.hotel ?? A1);
    const noPerm = await send(C.noPerm, real);
    await expectRefused(noPerm, { route, actor: `A without ${row.perm}`, status: row.noPerm, secrets: [] });
    if (row.noPerm === 404) {
      await expectSame({ route, actor: `A without ${row.perm}` }, route, noPerm, real, await send(C.noPerm, missingSpec), missingSpec);
    }

    // Positive control.
    const good = await send(C.aAll, real);
    expect({ route, status: good.status, body: good.status < 300 ? null : good.body }).toEqual({ route, status: row.ok, body: null });
  });
});

describe("a GRN's PDF and labels", () => {
  it("refuse exactly as GET /grn/:id does, for every caller who can't see the GRN", async () => {
    await grantNoPerm("grn.read", A1);
    const callers = { B: C.bAll, "A at A2 only": C.other, "A without grn.read": C.noPerm };
    for (const [who, client] of Object.entries(callers)) {
      for (const id of [W.grnA.id, BOGUS]) {
        const answer = async (spec) => signature(await send(client, spec), spec);
        const grn = await answer(q("get", `/grn/${id}`));
        const pdfRes = await answer(q("get", `/grn/${id}/pdf`));
        const labels = await answer(q("post", `/labels/grn/${id}`, { layout: "A4_65", mode: "per_pack" }));
        expect({ who, id, grn: grn.status, pdf: pdfRes, labels }).toEqual({ who, id, grn: 404, pdf: grn, labels: grn });
      }
    }
  });
});

describe("a platform super admin (user_type 8)", () => {
  it("reads both companies' records with no mapping or role of their own", async () => {
    const reads = [
      q("get", `/grn/${W.grnA.id}`), q("get", `/grn/${W.grnB.id}`),
      q("get", `/out/${W.outA.id}`), q("get", `/out/${W.outB.id}`),
      q("get", `/stock?hotelId=${A1}`), q("get", `/stock?hotelId=${B1}`),
      q("get", `/po/${W.poA.poId}/deliveries`), q("get", `/po/${W.poB.poId}/deliveries`),
      q("get", `/reorder?hotelId=${A1}`), q("get", `/settings/hotel/${B1}`),
    ];
    const answers = [];
    for (const spec of reads) answers.push({ path: spec.path, status: (await send(C.super, spec)).status });
    expect(answers).toEqual(reads.map((spec) => ({ path: spec.path, status: 200 })));
  });
});

// ---------------------------------------------------------------------------
// 3. Lists and aggregates
// ---------------------------------------------------------------------------

describe("lists and aggregates", () => {
  it.each(LIST_ROWS.map((r) => [r.key, r]))("%s", async (route, row) => {
    const client = { B: C.bAll, OTHER: C.other, A: C.aAll };
    for (const [i, p] of row.probes().entries()) {
      const res = await send(client[p.who], p.req);
      const label = `${route} probe #${i} as ${p.who}`;
      const status = p.expect === "empty" ? 200 : p.expect;
      expect({ label, status: res.status }).toEqual({ label, status });
      if (p.who !== "A") {
        const secrets = p.who === "B" ? SECRETS_A : SECRETS_A1;
        expect({ label, leaks: leaksIn(res.body, secrets) }).toEqual({ label, leaks: [] });
      }
      if (p.expect === "empty") {
        const rows = rowsOf(res.body.data);
        expect({ label, rows: Array.isArray(rows) ? rows.length : rows }).toEqual({ label, rows: 0 });
      }
      if (p.kind) expect({ label, kind: res.body.data?.kind }).toEqual({ label, kind: p.kind });
      if (p.kind === "unknown") expect({ label, item: res.body.data?.item }).toEqual({ label, item: null });
      for (const s of p.has ?? []) expect({ label, has: s, found: JSON.stringify(res.body).includes(s) }).toEqual({ label, has: s, found: true });
      const itemIds = (Array.isArray(res.body.data) ? res.body.data : []).map((x) => x.invItemId);
      if (p.hasItem) expect({ label, hasItem: itemIds.includes(p.hasItem) }).toEqual({ label, hasItem: true });
      if (p.lacksItem) expect({ label, hasItem: itemIds.includes(p.lacksItem) }).toEqual({ label, hasItem: false });
      if (p.sameAs) await expectSame({ label }, route, res, p.req, await send(client[p.who], p.sameAs), p.sameAs);
    }
  });

  it("inventory reports: Company B sees none of A's rows, and naming A's hotel narrows to nothing", async () => {
    // Every inventory / receiving report in the registry, and each one runnable.
    expect(REPORT_KEYS.length).toBeGreaterThanOrEqual(10);
    expect(INVENTORY_REPORTS.filter((d) => !isRunnable(d)).map((d) => d.key)).toEqual([]);
    for (const key of REPORT_KEYS) {
      const preview = (body) => q("post", `/api/v1/reports/${key}/preview`, body);
      const all = await send(C.bAll, preview(WIDE));
      expect({ key, status: all.status, leaks: leaksIn(all.body) }).toEqual({ key, status: 200, leaks: [] });
      const namedSpec = preview({ ...WIDE, hotel_ids: [A1] });
      const named = await send(C.bAll, namedSpec);
      expect({ key, status: named.status, total: named.body?.data?.total_rows, leaks: leaksIn(named.body) })
        .toEqual({ key, status: 200, total: 0, leaks: [] });
      const bogusSpec = preview({ ...WIDE, hotel_ids: [BOGUS] });
      await expectSame({ key }, "POST /api/v1/reports/:key/preview", named, namedSpec, await send(C.bAll, bogusSpec), bogusSpec);
    }
    // The control: A's own stock report does carry A's rows.
    const mine = await C.aAll.post("/api/v1/reports/stock_on_hand/preview").send(WIDE);
    expect(JSON.stringify(mine.body)).toContain("ISO-A-SECRET Saffron");
  });

  it("A moving stock changes nothing B or a user at A2 can see: the overview and every inventory report", async () => {
    const views = async () => {
      const out = {};
      for (const [who, client] of [["B", C.bAll], ["A at A2 only", C.other]]) {
        const overview = await client.get(`${BASE}/overview`);
        out[`${who} /overview`] = { status: overview.status, body: overview.body };
        for (const key of REPORT_KEYS) {
          const r = await client.post(`/api/v1/reports/${key}/preview`).send(WIDE);
          out[`${who} ${key}`] = { status: r.status, body: r.body };
        }
      }
      return out;
    };
    const stockOfA = async () => JSON.stringify((await C.aAll.get(`${BASE}/stock/${A1}/items/${W.itemA1}`)).body.data);

    const before = await views();
    expect(Object.entries(before).filter(([, v]) => v.status !== 200).map(([k]) => k)).toEqual([]);
    const aBefore = await stockOfA();
    await postGrnA({ qty: 1 });
    await must(C.aAll.post(`${BASE}/out`).send({
      hotelId: A1, docType: "OUT", departmentId: FB, clientEventId: randomUUID(), lines: [{ invItemId: W.itemA1, qty: 1 }],
    }), "A out");
    const after = await views();
    expect(after).toEqual(before);
    // The control: A's own stock did move (a GRN in and a mark-out, so the ledger grew).
    expect(await stockOfA()).not.toEqual(aBefore);
  });

  it("GET /reorder: no hotel means the caller's own; Create MR draft follows inventory.update", async () => {
    const own = await C.bAll.get(`${BASE}/reorder`);
    expect({ status: own.status, hotel: own.body.data?.hotelId, leaks: leaksIn(own.body) }).toEqual({ status: 200, hotel: B1, leaks: [] });
    expect(own.body.data.hotels.map((h) => h.id).filter((id) => [A1, A2, A3].includes(id))).toEqual([]);
    const other = await C.other.get(`${BASE}/reorder`);
    expect({ status: other.status, hotel: other.body.data?.hotelId, leaks: leaksIn(other.body, SECRETS_A1) })
      .toEqual({ status: 200, hotel: A2, leaks: [] });
    expect(other.body.data.hotels.map((h) => h.id)).toEqual([A2]);

    const mine = await C.aAll.get(`${BASE}/reorder?hotelId=${A1}`);
    expect({ status: mine.status, can: mine.body.data?.can }).toEqual({ status: 200, can: { createMrDraft: true } });
    await grantNoPerm("inventory.update", A1);
    const readOnly = await C.noPerm.get(`${BASE}/reorder?hotelId=${A1}`);
    expect({ status: readOnly.status, can: readOnly.body.data?.can }).toEqual({ status: 200, can: { createMrDraft: false } });
  });
});

// ---------------------------------------------------------------------------
// 4. Company-level routes
// ---------------------------------------------------------------------------

describe("company-level routes", () => {
  it.each(COMPANY_ROWS.map((r) => [r.key, r]))("%s", async (route, row) => {
    const v = () => (row.key === "POST /items" ? nextVariant() : undefined);

    // B naming Company A: refused exactly as naming a company that does not exist.
    const namedSpec = row.req(CO_A, v());
    const bogusSpec = row.req(BOGUS, v());
    const named = await send(C.bAll, namedSpec);
    await expectRefused(named, { route, actor: "B naming A", status: 403 });
    await expectSame({ route, actor: "B naming A" }, route, named, namedSpec, await send(C.bAll, bogusSpec), bogusSpec);

    // B on its own: B's company, nothing of A's.
    if (!row.mutates) {
      const own = await send(C.bAll, row.req(null));
      expect({ route, status: own.status, leaks: leaksIn(own.body) }).toEqual({ route, status: 200, leaks: [] });
      // A user at A2 only reads Company A's company-level settings: a grant at any hotel covers them.
      expect({ route, status: (await send(C.other, row.req(null))).status }).toEqual({ route, status: 200 });
    }

    await grantNoPerm(row.perm, A1);
    await expectRefused(await send(C.noPerm, row.req(null, v())), { route, actor: `A without ${row.perm}`, status: 403, secrets: [] });

    const good = await send(C.aAll, row.req(null, v()));
    expect({ route, status: good.status }).toEqual({ route, status: row.ok ?? 200 });
  });

  it("a barcode clash is per company: B may reuse A's code and is never told whose it is", async () => {
    const res = await C.bAll.post(`${BASE}/items/${W.itemB}/barcodes`).send({ code: W.barcodeA.code });
    expect({ status: res.status, leaks: leaksIn(res.body) }).toEqual({ status: 200, leaks: [] });
  });
});

// ---------------------------------------------------------------------------
// 5. Vendor routes
// ---------------------------------------------------------------------------

describe("vendor routes", () => {
  it.each(VENDOR_ROWS.map((r) => [r.key, r]))("%s", async (route, row) => {
    const fresh = row.fresh ? await row.fresh() : {};
    const ids = row.ids(fresh);
    const real = row.req(ids);

    const other = await send(C.otherVendor, real);
    await expectRefused(other, { route, actor: "another vendor", status: 404 });
    const missingSpec = row.req({ ...ids, [row.idKey]: BOGUS });
    await expectSame({ route, actor: "another vendor" }, route, other, real, await send(C.otherVendor, missingSpec), missingSpec);

    for (const [i, probe] of (row.ownerForeign?.() ?? []).entries()) {
      const actor = `PO owner foreign #${i}`;
      const res = await send(C.vendor, probe.spec);
      expect({ route, actor, status: res.status, leaks: leaksIn(res.body, ["ISO-B"]) })
        .toEqual({ route, actor, status: probe.expect, leaks: [] });
      await expectSame({ route, actor }, route, res, probe.spec, await send(C.vendor, probe.twin), probe.twin);
    }

    const good = await send(C.vendor, real);
    expect({ route, status: good.status, body: good.status < 300 ? null : good.body }).toEqual({ route, status: row.ok, body: null });
  });
});

// ---------------------------------------------------------------------------
// 6. Site-rep links (X-Receive-Token)
// ---------------------------------------------------------------------------

const PRICE_KEY = /price|rate|cost|value|amount|tax/i;
function allKeys(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allKeys(v, out);
    }
  }
  return out;
}
const priceKeysIn = (body) => allKeys(body).filter((k) => PRICE_KEY.test(k));

describe("site-rep links", () => {
  const tok = (token) => ({ "X-Receive-Token": token });
  let multi; // a two-hotel A PO, its link bound to A1
  let multiToken;

  beforeAll(async () => {
    receiveTokenLimiter.reset();
    multi = await makePo({ hotel: A1, mappedHotels: [A1, A2], vendor: VENDOR, lines: [{ qty: 10, variant: W.variantA2 }] });
    multiToken = await issueToken(multi.poId, { hotelId: A1 });
  });

  it("a link reads only its own PO at its own hotel; ids in the query are ignored", async () => {
    const res = await send(C.anon, {
      ...q("get", `/token/receive-context?poId=${W.poB.poId}&hotelId=${A2}`), headers: tok(multiToken.token),
    });
    expect(res.status).toBe(200);
    expect({ po: res.body.data.po.id, hotel: res.body.data.hotel.id }).toEqual({ po: multi.poId, hotel: A1 });
    expect(leaksIn(res.body, ["ISO-B", "Hotel A-2"])).toEqual([]);
    expect(priceKeysIn(res.body)).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(String(PRICE));
  });

  it("a link cannot post to another PO or hotel: the body's ids are refused or overridden", async () => {
    const before = await db.one(`SELECT count(*)::int AS n FROM tbl_grn WHERE po_id = ANY($1::int[])`, [[W.poB.poId, W.poA.poId]]);
    // Another PO (B's), naming B's line.
    const otherPo = await send(C.anon, {
      ...q("post", "/token/grn", { poId: W.poB.poId, hotelId: B1, receivedAt: TODAY, clientEventId: randomUUID(), lines: [grnLine(W.poB.lineIds[0], 1)] }),
      headers: tok(multiToken.token),
    });
    expect({ status: otherPo.status, leaks: leaksIn(otherPo.body, ["ISO-B"]) }).toEqual({ status: 404, leaks: [] });
    // Another PO of the same company, with that PO's line.
    const sibling = await send(C.anon, {
      ...q("post", "/token/grn", { poId: W.poA.poId, receivedAt: TODAY, clientEventId: randomUUID(), lines: [grnLine(W.poA.lineIds[0], 1)] }),
      headers: tok(multiToken.token),
    });
    expect(sibling.status).toBe(404);
    const after = await db.one(`SELECT count(*)::int AS n FROM tbl_grn WHERE po_id = ANY($1::int[])`, [[W.poB.poId, W.poA.poId]]);
    expect(after.n).toBe(before.n);

    // Its own PO, but the other hotel in the body: posted at the link's hotel.
    const posted = await send(C.anon, {
      ...q("post", "/token/grn", { poId: multi.poId, hotelId: A2, receivedAt: TODAY, clientEventId: randomUUID(), lines: [grnLine(multi.lineIds[0], 1)] }),
      headers: tok(multiToken.token),
    });
    expect(posted.status).toBe(201);
    expect(posted.body.data.hotelId).toBe(A1);
    expect(priceKeysIn(posted.body)).toEqual([]);
    expect(JSON.stringify(posted.body)).not.toContain(String(PRICE));
    W.tokenGrn = posted.body.data;
  });

  it("a link attaches only to receipts it posted itself", async () => {
    const upload = (grnId) => send(C.anon, {
      method: "post", path: `/token/grn/${grnId}/attachments`, headers: tok(multiToken.token), fields: { kind: "CHALLAN" }, attach: pdf(),
    });
    for (const [what, id] of [["a buyer receipt of another PO", W.grnA.id], ["another company's receipt", W.grnB.id], ["no receipt", BOGUS]]) {
      const res = await upload(id);
      expect({ what, status: res.status, leaks: leaksIn(res.body) }).toEqual({ what, status: 404, leaks: [] });
    }
    const own = await upload(W.tokenGrn.id);
    expect(own.status).toBe(201);
    expect(priceKeysIn(own.body)).toEqual([]);
  });

  it("a revoked or expired link gets 401 on every token route", async () => {
    const revoked = await issueToken(W.poA.poId, { hotelId: A1, revoked: true });
    const expired = await issueToken(W.poA.poId, { hotelId: A1, expired: true });
    const routes = [
      q("get", "/token/receive-context"),
      q("post", "/token/grn", { receivedAt: TODAY, clientEventId: randomUUID(), lines: [grnLine(W.poA.lineIds[0], 1)] }),
      { method: "post", path: `/token/grn/${W.grnA.id}/attachments`, fields: { kind: "OTHER" }, attach: pdf() },
    ];
    for (const [state, t] of [["revoked", revoked], ["expired", expired]]) {
      for (const spec of routes) {
        const res = await send(C.anon, { ...spec, headers: tok(t.token) });
        expect({ state, route: spec.path, status: res.status, body: res.body })
          .toEqual({ state, route: spec.path, status: 401, body: { status: 0, message: "Invalid or expired link" } });
      }
    }
  });

  it("the legacy PO routes hold a link to its own PO and strip its prices", async () => {
    const other = await send(C.anon, { ...q("get", `/api/v1/po/${W.poB.poId}`), headers: tok(W.tokenA.token) });
    expect({ status: other.status, leaks: leaksIn(other.body, ["ISO-B"]) }).toEqual({ status: 403, leaks: [] });
    const sibling = await send(C.anon, { ...q("get", `/api/v1/po/${multi.poId}`), headers: tok(W.tokenA.token) });
    expect(sibling.status).toBe(403);
    const mark = await send(C.anon, { ...q("post", "/api/v1/po/markGRN", { po_id: W.poB.poId, remarks: "x" }), headers: tok(W.tokenA.token) });
    expect(mark.status).toBe(403);

    const own = await send(C.anon, { ...q("get", `/api/v1/po/${W.poA.poId}`), headers: tok(W.tokenA.token) });
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toContain(String(PRICE));
  });
});
