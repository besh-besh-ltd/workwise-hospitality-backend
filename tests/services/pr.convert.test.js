// Purchase Requisitions — conversion (Task 9, spec §9): a buyer turns approved
// pool lines (one or many PRs, one hotel) into ONE RFQ draft that opens in the
// existing RFQ wizard; the PR lines link to the RFQ products.
//
// Product-level: real HTTP through the full middleware chain against real
// Postgres; assertions read the response and the committed rows. Pattern B
// (commit + cleanup by tracked ids). Every PR here is approved through the API
// (approvedPr: create → submit under a USER-step policy → approve).
//
// Personas
//   REQ   a1_eng_buyer       PR Requester at (A, A1, eng) and (A, A2, eng)
//   REQ2  midFlightApprover  PR Requester at (A, A1, eng)
//   AP    crossCompany       PR Approver at (A, all, all) and (B, all, all)
//   BUY   a1_proc_buyer      PR Buyer at (A, A1, all); fixture RFQ creator (rfq.create) at (A, A1, proc)
//   BUY2  dualRole           PR Buyer at (A, A2, all) only (its fixture rfq.create at A1/proc is irrelevant)
//   BUY3  a1_proc_techApp    PR Buyer at (A, A1, all) + RFQ creator at (A, A1, proc), granted here
//   XCO   companyB_admin     PR Requester at (B, B1, eng)
//
// No category is mapped for review (A and B), so every submit goes straight to
// approval. Vendor eligibility for V at A1 is seeded (variant mapping +
// category and hotel subscriptions) so the vendor list is not trivially empty.

import { httpClient } from "../helpers/http.js";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import {
  grantPr, revokeAllPr, firstUsableVariant, cleanupPrs, dropPrPolicies, unmapAll,
  approvedPr, submittedPr, cleanupRfqDrafts, rfqsOfLines,
} from "../helpers/prFixtures.js";
import hospitalityModel from "../../app/models/hospitalityModel.js";
import appDb, { pgp } from "../../app/config/dbConn.js";
import { buyerPrDetail } from "../../app/services/notificationLinks.js";
import { rfqContactNumber } from "../../app/services/pr/prConversion.js";

const A = IDS.hospitality.A;
const B = IDS.hospitality.B;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const B1 = IDS.hotels.B1;
const ENG = IDS.departments.eng;
const PROC = IDS.departments.proc;
const REQ = IDS.users.a1_eng_buyer;
const REQ2 = IDS.users.midFlightApprover;
const AP = IDS.users.crossCompany;
const BUY = IDS.users.a1_proc_buyer;
const BUY2 = IDS.users.dualRole;
const BUY3 = IDS.users.a1_proc_techApp;
const XCO = IDS.users.companyB_admin;
const PERSONAS = [REQ, REQ2, AP, BUY, BUY2, BUY3, XCO];
const BUY_MOBILE = "+91-9876543210";
const A1_DELIVERY_ADDRESS = "Plot 7, Service Road, Andheri East, Mumbai";

const prIds = [];
const rfqIds = [];
const scopeIds = [];
const seeded = { variantVendorIds: [], subscriptionIds: [] };
let originalUsers = [];
let originalHotel;
let buyC, buy2C, buy3C, reqC;
let V; // the main catalog variant (vendor-eligible at A1)
let W; // a second usable variant
let K; // a third usable variant (put on contract in one test)
let U; // a fourth usable variant (deactivated in one test)
let CAT; // the free-text lines' category

// ---------------------------------------------------------------------------
// Helpers (setup + reads only)
// ---------------------------------------------------------------------------
const catalogLine = (variantId, extra = {}) => ({
  product_variant_id: variantId, quantity: "2", uom: "nos", estimated_unit_price: "1500.00", specification: "OEM", ...extra,
});
const freeLine = (extra = {}) => ({
  free_text_name: "Compressor relay 24V", category_id: CAT, quantity: "4", uom: "nos", estimated_unit_price: "250.50", ...extra,
});

async function approved(lines, opts = {}) {
  const pr = await approvedPr(lines, { requesterId: REQ, approverId: AP, ...opts });
  prIds.push(pr.id);
  return pr;
}

const convert = async (client, body) => {
  const res = await client.post("/api/v1/pr/convert").send(body);
  if (res.status === 200 && res.body?.data?.rfq_id) rfqIds.push(Number(res.body.data.rfq_id));
  return res;
};
const rfqCount = async () => Number((await db.one(`SELECT count(*) AS n FROM tbl_rfq`)).n);
const linkCount = async () => Number((await db.one(`SELECT count(*) AS n FROM tbl_pr_line_rfq`)).n);
const linksOf = (lineIds) => db.any(
  `SELECT pr_line_id, rfq_id, rfq_product_id, quantity, converted_by FROM tbl_pr_line_rfq
    WHERE pr_line_id = ANY($1::int[]) ORDER BY pr_line_id, id`, [lineIds]);
const rfqProducts = (rfqId) => db.any(
  `SELECT id, product_variant_id, variant, comment, spec_file, qap_file, datasheet, qap, datasheet_file, sheet_id
     FROM tbl_rfq_products WHERE rfq_id = $1 ORDER BY id`, [rfqId]);
const specsOf = async (rfqId, variantId) => Object.fromEntries((await db.any(
  `SELECT title, value FROM tbl_rfq_products_specs WHERE rfq_id = $1 AND product_variant_id = $2 ORDER BY id`,
  [rfqId, variantId])).map((r) => [r.title, r.value]));
const prNotifications = (prId, type) => db.any(
  `SELECT recipient_user_id, type, title, message, action_url FROM tbl_notifications
    WHERE category = 'pr' AND additional_data->>'pr_id' = $1::text AND ($2::text IS NULL OR type = $2)
    ORDER BY id`, [prId, type ?? null]);
const eventsOf = (prId, type) => db.any(
  `SELECT event_type, actor_id, pr_line_id, payload FROM tbl_pr_event
    WHERE pr_id = $1 AND ($2::text IS NULL OR event_type = $2) ORDER BY id`, [prId, type ?? null]);
const detail = (client, id) => client.get(`/api/v1/pr/${id}`);
const lineOf = (detailRes, lineId) => detailRes.body.data.lines.find((l) => l.id === lineId);
const sorted = (ids) => [...ids].map(Number).sort((a, b) => a - b);

/**
 * Run `fn` and record every statement the APP's pool issues, in issue order, as
 * {client, text} (the test harness's own pool and the per-connection audit
 * stamp are left out — same filter as helpers/queryCounter.js). Read-only probe.
 */
async function recordAppStatements(fn) {
  const proto = pgp.pg.Client.prototype;
  const original = proto.query;
  const log = [];
  const isAppClient = (client) => {
    const pool = appDb.$pool;
    const clients = pool && (pool._clients || pool.clients);
    return Array.isArray(clients) && clients.includes(client);
  };
  proto.query = function recordingQuery(...args) {
    const config = args[0];
    const text = String((typeof config === "string" ? config : config && config.text) || "").trim();
    if (isAppClient(this) && !/set_config\('app\.actor_id'/.test(text)) log.push({ client: this, text });
    return original.apply(this, args);
  };
  try {
    return { result: await fn(), log };
  } finally {
    proto.query = original;
  }
}

/** Usable variants other than V whose product has a category, highest id first. */
async function otherUsableVariants(n) {
  return db.map(
    `SELECT pv.id, pv.name
       FROM tbl_product_variant pv JOIN tbl_product p ON p.id = pv.product_id
      WHERE p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve = 1 AND pv.is_approve = 1
        AND pv.id <> $1
        AND EXISTS (SELECT 1 FROM tbl_product_categories pc JOIN tbl_category c ON c.id = pc.category_id
                     WHERE pc.product_id = p.id)
      ORDER BY pv.id DESC LIMIT $2`, [V.variant_id, n], (r) => ({ variant_id: Number(r.id), variant_name: r.name }));
}

/** Make `vendorId` eligible for `variantId` at A1 (variant mapping + category and hotel subscriptions). */
async function makeEligible(vendorId, variantId, categoryId) {
  const m = await db.oneOrNone(
    `INSERT INTO tbl_product_variant_vendor_mapping
       (product_variant_id, vendor_id, status, is_approved, created_by, created_at, updated_at)
     VALUES ($1, $2, true, true, $2, now(), now())
     ON CONFLICT DO NOTHING RETURNING id`, [variantId, vendorId]);
  if (m) seeded.variantVendorIds.push(Number(m.id));
  for (const [type, item] of [["category", categoryId], ["hotel", A1]]) {
    const s = await db.oneOrNone(
      `INSERT INTO tbl_vendor_hotel_category_subscription
         (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
       VALUES ($1, $2, $3, 500, (now() - interval '30 days')::date, (now() + interval '335 days')::date, 'active')
       ON CONFLICT ON CONSTRAINT uq_vendor_hotel_category_subscription DO NOTHING
       RETURNING id`, [vendorId, type, item]);
    if (s) seeded.subscriptionIds.push(Number(s.id));
  }
}

/** A live rate contract covering `variantId` at (A1, eng). Returns a remover. */
async function contractFor(variantId) {
  const arc = await db.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id,
        department_id, process_id, status,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
     VALUES ('ARC-TEST-PR-CONVERT', 'PR convert contract', $1, $2, $3, $4, $5, 'contract_active',
             NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days',
             NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $6) RETURNING id`,
    [V.category_id, A, A1, ENG, IDS.processes.A_P1, REQ]);
  const item = await db.one(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 1000, 'nos') RETURNING id`,
    [arc.id, variantId]);
  const contract = await db.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`,
    [arc.id, IDS.users.vendor_alpha]);
  await db.none(
    `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
     VALUES ($1, $2, 90, 5, 1000)`, [contract.id, item.id]);
  return async () => {
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contract.id]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contract.id]);
    await db.none(`DELETE FROM tbl_arc_item WHERE id = $1`, [item.id]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arc.id]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arc.id]);
  };
}

beforeAll(async () => {
  originalUsers = await db.any(`SELECT id, user_type, mobile FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS]);
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [PERSONAS]);
  await db.none(`UPDATE tbl_users SET mobile = $2 WHERE id = $1`, [BUY, BUY_MOBILE]);
  originalHotel = await db.one(`SELECT delivery_address FROM tbl_hospitality_company_hotels WHERE id = $1`, [A1]);
  await db.none(`UPDATE tbl_hospitality_company_hotels SET delivery_address = $2 WHERE id = $1`, [A1, A1_DELIVERY_ADDRESS]);
  await revokeAllPr(PERSONAS);
  await unmapAll(A);
  await unmapAll(B);
  await dropPrPolicies();
  await grantPr(REQ, "PR Requester", { departmentId: ENG });
  await grantPr(REQ, "PR Requester", { hotelId: A2, departmentId: ENG });
  await grantPr(REQ2, "PR Requester", { departmentId: ENG });
  await grantPr(AP, "PR Approver", { hotelId: null });
  await grantPr(AP, "PR Approver", { companyId: B, hotelId: null });
  await grantPr(BUY, "PR Buyer");
  await grantPr(BUY2, "PR Buyer", { hotelId: A2 });
  await grantPr(BUY3, "PR Buyer");
  await grantPr(XCO, "PR Requester", { companyId: B, hotelId: B1, departmentId: ENG });
  scopeIds.push(await grantRoleScope(db, {
    userId: BUY3, roleId: ROLE_IDS.TENDER_CREATOR, companyId: A, hotelId: A1, departmentId: PROC,
  }));

  V = await firstUsableVariant();
  [W, K, U] = await otherUsableVariants(3);
  CAT = Number((await db.one(
    `SELECT id FROM tbl_category WHERE status = 1 AND is_deleted = 0 AND id <> $1 ORDER BY id LIMIT 1`,
    [V.category_id])).id);
  await makeEligible(IDS.users.vendor_alpha, V.variant_id, V.category_id);
  await makeEligible(IDS.users.vendor_beta, V.variant_id, V.category_id);

  buyC = await httpClient(BUY);
  buy2C = await httpClient(BUY2);
  buy3C = await httpClient(BUY3);
  reqC = await httpClient(REQ);
});

afterAll(async () => {
  const allRfqs = [...new Set([...rfqIds, ...(await rfqsOfLines(
    (await db.map(`SELECT id FROM tbl_purchase_requisition_line WHERE pr_id = ANY($1::int[])`, [prIds], (r) => Number(r.id)))))])];
  if (prIds.length) {
    await db.none(
      `DELETE FROM tbl_notifications
        WHERE (category = 'pr' AND additional_data->>'pr_id' = ANY($1::text[]))
           OR action_url = ANY($2::text[])`,
      [prIds.map(String), prIds.map((id) => buyerPrDetail(id))]);
  }
  await cleanupRfqDrafts(allRfqs);
  await cleanupPrs(prIds);
  await dropPrPolicies();
  await revokeAllPr(PERSONAS);
  await revokeRoleScopes(db, scopeIds);
  if (seeded.subscriptionIds.length) {
    await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE id = ANY($1::int[])`, [seeded.subscriptionIds]);
  }
  if (seeded.variantVendorIds.length) {
    await db.none(`DELETE FROM tbl_product_variant_vendor_mapping WHERE id = ANY($1::int[])`, [seeded.variantVendorIds]);
  }
  await db.none(`UPDATE tbl_hospitality_company_hotels SET delivery_address = $2 WHERE id = $1`, [A1, originalHotel.delivery_address]);
  for (const u of originalUsers) {
    await db.none(`UPDATE tbl_users SET user_type = $2, mobile = $3 WHERE id = $1`, [u.id, u.user_type, u.mobile]);
  }
  // Release this file's test-side pool: an idle client left open is killed by
  // globalTeardown's DROP DATABASE … WITH (FORCE) and logs 57P01 after Jest ends.
  await closeDb();
});

// ---------------------------------------------------------------------------
// The merge: PR1 (V ×2 nos, W ×1 kg + 2 clauses + datasheet) + PR2 (V ×3.5 Nos)
// ---------------------------------------------------------------------------
describe("PR convert — one RFQ draft from many PRs", () => {
  let pr1;
  let pr2;
  let res;
  beforeAll(async () => {
    pr1 = await approved([
      catalogLine(V.variant_id, {
        quantity: "2", uom: "nos", specification: "Stainless, 2 inch", suggested_vendor_note: "Try Acme Traders",
      }),
      catalogLine(W.variant_id, { quantity: "1", uom: "kg", specification: "Food grade" }),
    ], { title: "convert-merge-1" });
    pr2 = await approved([catalogLine(V.variant_id, { quantity: "3.5", uom: "Nos", specification: "Spare stock" })],
      { requesterId: REQ2, title: "convert-merge-2" });
    // Reviewer-added clauses and files on the approved lines (setup rows; Task 7 owns their API).
    await db.none(
      `INSERT INTO tbl_pr_line_clause (pr_line_id, clause_text, clause_type, weightage, added_by)
       VALUES ($1, 'FSSAI certificate', 'clause', 60, $2), ($1, 'Send a 1 kg sample', 'sampling', 40, $2)`,
      [pr1.line_ids[1], AP]);
    await db.none(
      `INSERT INTO tbl_pr_attachment (pr_id, pr_line_id, kind, file_url, file_name, uploaded_by) VALUES
         ($1, $2, 'datasheet', 'https://bucket.s3.amazonaws.com/pr/w-datasheet.pdf', 'w-datasheet.pdf', $4),
         ($3, $5, 'qap', 'https://bucket.s3.amazonaws.com/pr/v-qap.pdf', 'v-qap.pdf', $4),
         ($3, $5, 'other', 'https://bucket.s3.amazonaws.com/pr/v-photo.jpg', 'v-photo.jpg', $4),
         ($1, $6, 'spec', 'https://bucket.s3.amazonaws.com/pr/v-spec.pdf', 'v-spec.pdf', $4)`,
      [pr1.id, pr1.line_ids[1], pr2.id, REQ, pr2.line_ids[0], pr1.line_ids[0]]);
    res = await convert(buyC, { line_ids: [pr2.line_ids[0], ...pr1.line_ids], department_id: PROC });
  });

  it("convert.merge: 200 with the wizard redirect; one draft RFQ owned by the buyer", async () => {
    expect(res.status).toBe(200);
    const { rfq_id: rfqId, rfq_no: rfqNo, redirect } = res.body.data;
    expect(redirect).toBe(`/dashboard/buyer/rfq-management?tab=create-rfq&draft_id=${rfqId}`);

    const rfq = await db.one(`SELECT * FROM tbl_rfq WHERE id = $1`, [rfqId]);
    const company = await db.one(`SELECT name FROM tbl_hospitality_companies WHERE id = $1`, [A]);
    expect(rfq).toMatchObject({
      rfq_no: rfqNo, status: 1, is_published: 0, hotel_id: A1, hospitality_company_id: A, department_id: PROC,
      process_id: null, created_by: BUY, updated_by: BUY, bid_end_date: "", company_name: company.name,
      contact_name: "A1 Proc Buyer", contact_number: BUY_MOBILE, response_email: "a1.proc.buyer@test.local",
      location: A1_DELIVERY_ADDRESS, is_tender: 0,
      // R25: the vendor-facing title is the first PR's title, never internal PR numbers.
      title: "convert-merge-1 & 1 more",
      // R22: tbl_rfq.comment is the buyer's vendor-visible "Additional Terms & Conditions"
      // (merged into the PO's T&C) — conversion leaves it empty.
      comment: "",
    });
    const mappings = await db.any(`SELECT hotel_id, created_by FROM tbl_rfq_hotel_mappings WHERE rfq_id = $1`, [rfqId]);
    expect(mappings).toEqual([{ hotel_id: A1, created_by: BUY }]);
  });

  it("convert.merge: one product per variant; V's Quantity is the exact sum, Unit as first entered", async () => {
    const rfqId = res.body.data.rfq_id;
    const products = await rfqProducts(rfqId);
    expect(products.map((p) => p.product_variant_id)).toEqual([V.variant_id, W.variant_id]);
    for (const p of products) {
      expect(p).toMatchObject({ variant: 0, spec_file: "", qap_file: "", sheet_id: null });
    }
    expect(await specsOf(rfqId, V.variant_id)).toEqual({ Quantity: "5.5", Unit: "nos" });
    expect(await specsOf(rfqId, W.variant_id)).toEqual({ Quantity: "1", Unit: "kg" });

    // The merged specification: one tagged block per source line.
    const [vp, wp] = products;
    expect(vp.comment).toContain(`[${pr1.pr_number} · `);
    expect(vp.comment).toContain(" · 2 nos] Stainless, 2 inch");
    expect(vp.comment).toContain(`[${pr2.pr_number} · `);
    expect(vp.comment).toContain(" · 3.5 Nos] Spare stock");
    // R26: one distinct specification → that text alone, no tag.
    expect(wp.comment).toBe("Food grade");
    // R22: vendor-visible text — never requester names, never the suggested-vendor note.
    for (const p of products) {
      for (const hidden of ["A1 Eng Buyer", "Mid-Flight Approver", "Acme"]) expect(p.comment).not.toContain(hidden);
    }
  });

  it("convert.merge: W carries a tech evaluation with both clauses; files are mapped by kind", async () => {
    const rfqId = res.body.data.rfq_id;
    const [vp, wp] = await rfqProducts(rfqId);
    const evals = await db.any(
      `SELECT id, tbl_rfq_product_id, minimum_passing_score FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = $1`, [rfqId]);
    expect(evals).toEqual([{ id: expect.any(Number), tbl_rfq_product_id: wp.id, minimum_passing_score: 0 }]);
    const clauses = await db.any(
      `SELECT clause_text, clause_type, weightage FROM tbl_rfq_product_tech_evaluation_clauses
        WHERE tbl_rfq_product_tech_evaluation_id = $1 ORDER BY id`, [evals[0].id]);
    expect(clauses).toEqual([
      { clause_text: "FSSAI certificate", clause_type: "clause", weightage: 60 },
      { clause_text: "Send a 1 kg sample", clause_type: "sampling", weightage: 40 },
    ]);
    const files = await db.any(
      `SELECT rfq_product_id, file_type, file_url FROM tbl_rfq_product_files
        WHERE rfq_product_id = ANY($1::int[]) ORDER BY rfq_product_id, file_type, file_url`, [[vp.id, wp.id]]);
    expect(files).toEqual([
      { rfq_product_id: vp.id, file_type: "QAP", file_url: "https://bucket.s3.amazonaws.com/pr/v-qap.pdf" },
      { rfq_product_id: vp.id, file_type: "SPEC", file_url: "https://bucket.s3.amazonaws.com/pr/v-photo.jpg" },
      { rfq_product_id: vp.id, file_type: "SPEC", file_url: "https://bucket.s3.amazonaws.com/pr/v-spec.pdf" },
      { rfq_product_id: wp.id, file_type: "TDS", file_url: "https://bucket.s3.amazonaws.com/pr/w-datasheet.pdf" },
    ]);
  });

  it("convert.merge: the eligible vendors of each variant are invited (the RFQ's own resolver)", async () => {
    const rfqId = res.body.data.rfq_id;
    for (const variant of [V, W]) {
      const expected = sorted((await hospitalityModel.getEligibleVendorsForVariant(variant.variant_id, [A1]))
        .map((v) => v.vendor_id));
      const rows = await db.any(
        `SELECT user_id, variant, is_rfq_viewed FROM tbl_rfq_product_vendors
          WHERE rfq_id = $1 AND product_variant_id = $2 ORDER BY user_id`, [rfqId, variant.variant_id]);
      expect(rows.map((r) => Number(r.user_id))).toEqual(expected);
      for (const r of rows) expect(r).toMatchObject({ variant: 0, is_rfq_viewed: 0 });
    }
    const vVendors = (await hospitalityModel.getEligibleVendorsForVariant(V.variant_id, [A1])).map((v) => Number(v.vendor_id));
    expect(vVendors).toEqual(expect.arrayContaining([IDS.users.vendor_alpha, IDS.users.vendor_beta]));
  });

  it("convert.merge: one link per source line, a converted event per line, each requester told", async () => {
    const { rfq_id: rfqId, rfq_no: rfqNo } = res.body.data;
    const [vp, wp] = await rfqProducts(rfqId);
    const links = await linksOf([...pr1.line_ids, ...pr2.line_ids]);
    expect(links).toEqual(sorted([...pr1.line_ids, ...pr2.line_ids]).map((lineId) => ({
      pr_line_id: lineId,
      rfq_id: rfqId,
      rfq_product_id: lineId === pr1.line_ids[1] ? wp.id : vp.id,
      quantity: { [pr1.line_ids[0]]: "2.000", [pr1.line_ids[1]]: "1.000", [pr2.line_ids[0]]: "3.500" }[lineId],
      converted_by: BUY,
    })));

    const ev1 = await eventsOf(pr1.id, "converted");
    expect(ev1.map((e) => e.pr_line_id).sort()).toEqual(sorted(pr1.line_ids));
    expect(ev1.find((e) => e.pr_line_id === pr1.line_ids[1])).toMatchObject({
      actor_id: BUY, payload: { rfq_id: rfqId, rfq_no: rfqNo, rfq_product_id: wp.id },
    });
    const ev2 = await eventsOf(pr2.id, "converted");
    expect(ev2).toEqual([{
      event_type: "converted", actor_id: BUY, pr_line_id: pr2.line_ids[0],
      payload: { rfq_id: rfqId, rfq_no: rfqNo, rfq_product_id: vp.id },
    }]);

    for (const [pr, requester] of [[pr1, REQ], [pr2, REQ2]]) {
      const notes = await prNotifications(pr.id, "pr_converted");
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ recipient_user_id: requester, action_url: buyerPrDetail(pr.id) });
      expect(notes[0].title).toContain(pr.pr_number);
      expect(notes[0].title).toContain(`RFQ #${rfqNo}`);
    }
  });

  it("convert.wizard-opens: the buyer's GET /rfq/get-draft-by-id returns the products, specs, contact and hotel", async () => {
    const rfqId = res.body.data.rfq_id;
    const draft = await buyC.get(`/api/v1/rfq/get-draft-by-id/${rfqId}`);
    expect(draft.status).toBe(200);
    const data = draft.body.data;
    expect(data.rfq_id).toBe(rfqId);
    expect(data.rfq_form_data).toMatchObject({
      is_published: 0, contact_name: "A1 Proc Buyer", contact_number: BUY_MOBILE,
      response_email: "a1.proc.buyer@test.local", hotel_id: A1, department_id: PROC, hospitality_company_id: A,
      created_by: BUY, bid_end_date: null, location: A1_DELIVERY_ADDRESS,
    });
    expect(data.mappedHotels.map((h) => h.hotel_id)).toEqual([A1]);
    expect(data.rfq_products).toHaveLength(2);
    const vProduct = data.rfq_products.find((p) => p.product_id === V.variant_id);
    expect(vProduct.spec).toEqual(expect.arrayContaining([
      { title: "Quantity", value: "5.5" }, { title: "Unit", value: "nos" },
    ]));
    expect(vProduct.vendor_count).toBeGreaterThanOrEqual(2);
    const wProduct = data.rfq_products.find((p) => p.product_id === W.variant_id);
    expect(wProduct.datasheet_file).toEqual(["https://bucket.s3.amazonaws.com/pr/w-datasheet.pdf"]);
  });

  it("convert.progress: the lines leave the pool; the detail shows in_sourcing with the RFQ link", async () => {
    const { rfq_id: rfqId, rfq_no: rfqNo } = res.body.data;
    const pool = await buyC.get(`/api/v1/pr/pool?q=${encodeURIComponent(pr1.pr_number)}&page_size=200`);
    expect(pool.status).toBe(200);
    expect(pool.body.data.rows).toEqual([]);

    const d = await detail(reqC, pr1.id);
    expect(d.status).toBe(200);
    for (const lineId of pr1.line_ids) {
      const line = lineOf(d, lineId);
      expect(line.progress).toBe("in_sourcing");
      expect(line.links).toEqual([{ rfq_id: rfqId, rfq_no: rfqNo, rfq_status_label: "Draft", live: true, po: [] }]);
    }
    const list = await reqC.get(`/api/v1/pr?tab=mine&q=${encodeURIComponent(pr1.pr_number)}`);
    expect(list.body.data.rows[0].header_progress).toBe("in_sourcing");
  });
});

// ---------------------------------------------------------------------------
// Files for the whole PR (R41): pr_line_id NULL. The RFQ has no vendor-visible
// RFQ-level document slot (tbl_rfq_files holds only the buyer's T&C files), so
// each PR-level file goes onto every RFQ product built from that PR's lines,
// kind-mapped like line files and deduped by URL per product.
// ---------------------------------------------------------------------------
describe("PR convert — files for the whole PR (R41)", () => {
  const DRAWING = "https://bucket.s3.amazonaws.com/pr/whole-pr-drawing.pdf";
  const BOQ = "https://bucket.s3.amazonaws.com/pr/whole-pr-boq.xlsx";
  const QAP = "https://bucket.s3.amazonaws.com/pr/whole-pr-qap.pdf";
  const SHARED = "https://bucket.s3.amazonaws.com/pr/shared-spec.pdf";
  const prFile = (prId, kind, url) => db.none(
    `INSERT INTO tbl_pr_attachment (pr_id, pr_line_id, kind, file_url, file_name, uploaded_by)
     VALUES ($1, NULL, $2, $3, 'whole-pr', $4)`, [prId, kind, url, REQ]);
  const filesOf = (productIds) => db.any(
    `SELECT rfq_product_id, file_type, file_url FROM tbl_rfq_product_files
      WHERE rfq_product_id = ANY($1::int[]) ORDER BY rfq_product_id, file_type, file_url`, [productIds]);

  it("convert.pr-files: one PR-level file → every product built from the PR's lines carries it, kind-mapped; the wizard shows it", async () => {
    const pr = await approved([
      catalogLine(V.variant_id),
      catalogLine(W.variant_id, { quantity: "1", uom: "kg" }),
    ], { title: "convert-pr-files" });
    await prFile(pr.id, "datasheet", DRAWING);
    await prFile(pr.id, "other", BOQ);

    const r = await convert(buyC, { line_ids: pr.line_ids, department_id: PROC });
    expect(r.status).toBe(200);
    const rfqId = r.body.data.rfq_id;
    const [vp, wp] = await rfqProducts(rfqId);
    expect(await filesOf([vp.id, wp.id])).toEqual([
      { rfq_product_id: vp.id, file_type: "SPEC", file_url: BOQ },
      { rfq_product_id: vp.id, file_type: "TDS", file_url: DRAWING },
      { rfq_product_id: wp.id, file_type: "SPEC", file_url: BOQ },
      { rfq_product_id: wp.id, file_type: "TDS", file_url: DRAWING },
    ]);

    const draft = await buyC.get(`/api/v1/rfq/get-draft-by-id/${rfqId}`);
    expect(draft.status).toBe(200);
    for (const variant of [V, W]) {
      const p = draft.body.data.rfq_products.find((x) => x.product_id === variant.variant_id);
      expect(p.datasheet_file).toEqual([DRAWING]);
      expect(p.spec_file).toEqual([BOQ]);
    }
  });

  it("convert.pr-files-dedup: two PRs merged into one product, same PR-level URL → one file row; a URL a line file already put there is not added again", async () => {
    const p1 = await approved([catalogLine(V.variant_id)], { title: "convert-pr-files-dedup-1" });
    const p2 = await approved([catalogLine(V.variant_id)], { requesterId: REQ2, title: "convert-pr-files-dedup-2" });
    await prFile(p1.id, "qap", QAP);
    await prFile(p2.id, "qap", QAP);
    // SHARED is a line file (spec) on p1's line and a PR-level datasheet on p2.
    await db.none(
      `INSERT INTO tbl_pr_attachment (pr_id, pr_line_id, kind, file_url, file_name, uploaded_by)
       VALUES ($1, $2, 'spec', $3, 'line', $4)`, [p1.id, p1.line_ids[0], SHARED, REQ]);
    await prFile(p2.id, "datasheet", SHARED);

    const r = await convert(buyC, { line_ids: [p1.line_ids[0], p2.line_ids[0]], department_id: PROC });
    expect(r.status).toBe(200);
    const [vp] = await rfqProducts(r.body.data.rfq_id);
    expect(await filesOf([vp.id])).toEqual([
      { rfq_product_id: vp.id, file_type: "QAP", file_url: QAP },
      { rfq_product_id: vp.id, file_type: "SPEC", file_url: SHARED },
    ]);
  });

  it("convert.pr-files-own-pr-only: a PR's whole-PR files never reach a product built only from another PR's lines", async () => {
    const p1 = await approved([catalogLine(V.variant_id)], { title: "convert-pr-files-own-1" });
    const p2 = await approved([catalogLine(W.variant_id, { quantity: "1", uom: "kg" })], { requesterId: REQ2, title: "convert-pr-files-own-2" });
    await prFile(p1.id, "spec", DRAWING);

    const r = await convert(buyC, { line_ids: [p1.line_ids[0], p2.line_ids[0]], department_id: PROC });
    expect(r.status).toBe(200);
    const [vp, wp] = await rfqProducts(r.body.data.rfq_id);
    expect(await filesOf([vp.id, wp.id])).toEqual([{ rfq_product_id: vp.id, file_type: "SPEC", file_url: DRAWING }]);
  });
});

// ---------------------------------------------------------------------------
// One pooled connection per conversion (final review B-M6)
// ---------------------------------------------------------------------------
describe("PR convert — one pooled connection while the transaction holds its locks", () => {
  it("convert.one-connection: between the convert transaction's BEGIN and COMMIT, no statement runs on another pooled connection", async () => {
    const pr = await approved([catalogLine(V.variant_id), catalogLine(W.variant_id, { quantity: "1", uom: "kg" })],
      { title: "convert-one-connection" });
    const { result: r, log } = await recordAppStatements(() => convert(buyC, { line_ids: pr.line_ids, department_id: PROC }));
    expect(r.status).toBe(200);

    const insertAt = log.findIndex((x) => /^INSERT INTO tbl_rfq\s*\(/i.test(x.text));
    expect(insertAt).toBeGreaterThan(-1);
    const txClient = log[insertAt].client;
    let beginAt = insertAt;
    while (beginAt >= 0 && !(log[beginAt].client === txClient && /^begin\b/i.test(log[beginAt].text))) beginAt -= 1;
    let commitAt = insertAt;
    while (commitAt < log.length && !(log[commitAt].client === txClient && /^commit\b/i.test(log[commitAt].text))) commitAt += 1;
    expect(beginAt).toBeGreaterThan(-1);
    expect(commitAt).toBeLessThan(log.length);

    // The user-context check and every product's vendor eligibility run on the
    // transaction's own connection: a convert holds ONE pooled connection.
    const elsewhere = log.slice(beginAt, commitAt + 1)
      .filter((x) => x.client !== txClient)
      .map((x) => x.text.replace(/\s+/g, " ").slice(0, 120));
    expect(elsewhere).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------
describe("PR convert — refusals", () => {
  it("convert.hotel-mismatch: an A1 line + an A2 line → 422 PR_HOTEL_MISMATCH; nothing inserted", async () => {
    const a1 = await approved([catalogLine(V.variant_id)], { title: "convert-hotel-a1" });
    const a2 = await approved([catalogLine(V.variant_id)], { hotelId: A2, title: "convert-hotel-a2" });
    const [rfqsBefore, linksBefore] = [await rfqCount(), await linkCount()];
    const r = await convert(buyC, { line_ids: [a1.line_ids[0], a2.line_ids[0]], department_id: PROC });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({
      status: 0, code: "PR_HOTEL_MISMATCH",
      details: [{ hotel_id: A1, line_ids: [a1.line_ids[0]] }, { hotel_id: A2, line_ids: [a2.line_ids[0]] }],
    });
    expect([await rfqCount(), await linkCount()]).toEqual([rfqsBefore, linksBefore]);
  });

  it("convert.unit-mismatch: V in nos + V in box → 422 PR_UNIT_MISMATCH naming the variant, units and lines", async () => {
    const p1 = await approved([catalogLine(V.variant_id, { uom: "nos" })], { title: "convert-unit-1" });
    const p2 = await approved([catalogLine(V.variant_id, { uom: "box" })], { title: "convert-unit-2" });
    const rfqsBefore = await rfqCount();
    const r = await convert(buyC, { line_ids: [p1.line_ids[0], p2.line_ids[0]], department_id: PROC });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({
      status: 0, code: "PR_UNIT_MISMATCH",
      details: [{ variant_id: V.variant_id, units: ["nos", "box"], line_ids: sorted([p1.line_ids[0], p2.line_ids[0]]) }],
    });
    expect(await rfqCount()).toBe(rfqsBefore);
  });

  it("convert.not-convertible: sourced, cancelled, unmapped, awaiting-catalog and pending lines → 409, one detail each", async () => {
    const sourced = await approved([catalogLine(V.variant_id)], { title: "convert-nc-sourced" });
    expect((await convert(buyC, { line_ids: sourced.line_ids, department_id: PROC })).status).toBe(200);
    const mixed = await approved([catalogLine(V.variant_id), freeLine(), freeLine({ free_text_name: "Gasket kit" })],
      { title: "convert-nc-mixed" });
    const [cancelId, freeId, awaitingId] = mixed.line_ids;
    expect((await reqC.post(`/api/v1/pr/${mixed.id}/lines/${cancelId}/cancel`).send({ reason: "Not needed" })).status).toBe(200);
    expect((await buyC.post(`/api/v1/pr/${mixed.id}/lines/${awaitingId}/catalog-request`).send({})).status).toBe(200);
    const pending = await submittedPr([catalogLine(V.variant_id)], { requesterId: REQ, approverId: AP, title: "convert-nc-pending" });
    prIds.push(pending.id);

    const [rfqsBefore, linksBefore] = [await rfqCount(), await linkCount()];
    const ids = [sourced.line_ids[0], cancelId, freeId, awaitingId, pending.line_ids[0]];
    const r = await convert(buyC, { line_ids: ids, department_id: PROC });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("PR_LINE_NOT_CONVERTIBLE");
    expect(r.body.details).toEqual(sorted(ids).map((lineId) => ({
      line_id: lineId,
      pr_number: lineId === sourced.line_ids[0] ? sourced.pr_number : lineId === pending.line_ids[0] ? pending.pr_number : mixed.pr_number,
      line_no: lineId === freeId ? 2 : lineId === awaitingId ? 3 : 1,
      reason: {
        [sourced.line_ids[0]]: "already_sourced", [cancelId]: "not_active", [freeId]: "needs_mapping",
        [awaitingId]: "awaiting_catalog", [pending.line_ids[0]]: "not_approved",
      }[lineId],
    })));
    expect([await rfqCount(), await linkCount()]).toEqual([rfqsBefore, linksBefore]);
  });

  it("convert.concurrent: BUY and BUY3 convert the same line at once → one 200, one 409; exactly one link", async () => {
    const pr = await approved([catalogLine(V.variant_id)], { title: "convert-concurrent" });
    const rfqsBefore = await rfqCount();
    const results = await Promise.all([
      convert(buyC, { line_ids: pr.line_ids, department_id: PROC }),
      convert(buy3C, { line_ids: pr.line_ids, department_id: PROC }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(loser.body).toMatchObject({
      code: "PR_LINE_NOT_CONVERTIBLE", details: [{ line_id: pr.line_ids[0], reason: "already_sourced" }],
    });
    expect(await linksOf(pr.line_ids)).toHaveLength(1);
    expect(await rfqCount()).toBe(rfqsBefore + 1);
  });

  it("convert.variant-deactivated: a variant deactivated after approval → 409 variant_not_usable", async () => {
    const pr = await approved([catalogLine(U.variant_id)], { title: "convert-deactivated" });
    await db.none(`UPDATE tbl_product_variant SET is_approve = 0 WHERE id = $1`, [U.variant_id]);
    try {
      const r = await convert(buyC, { line_ids: pr.line_ids, department_id: PROC });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({
        code: "PR_LINE_NOT_CONVERTIBLE",
        details: [{ line_id: pr.line_ids[0], pr_number: pr.pr_number, line_no: 1, reason: "variant_not_usable" }],
      });
    } finally {
      await db.none(`UPDATE tbl_product_variant SET is_approve = 1 WHERE id = $1`, [U.variant_id]);
    }
    expect(await linksOf(pr.line_ids)).toEqual([]);
  });

  it("convert.on-contract-now: a rate contract that appeared after approval → 409 on_contract", async () => {
    const pr = await approved([catalogLine(K.variant_id)], { title: "convert-on-contract" });
    const removeContract = await contractFor(K.variant_id);
    try {
      const r = await convert(buyC, { line_ids: pr.line_ids, department_id: PROC });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({
        code: "PR_LINE_NOT_CONVERTIBLE",
        details: [{ line_id: pr.line_ids[0], pr_number: pr.pr_number, line_no: 1, reason: "on_contract" }],
      });
    } finally {
      await removeContract();
    }
    expect(await linksOf(pr.line_ids)).toEqual([]);
  });

  it("convert.authz: no rfq.create on the chosen department → 403; BUY2 (A2 only) on A1 lines → 403; a company B line → 404", async () => {
    const pr = await approved([catalogLine(V.variant_id)], { title: "convert-authz" });
    const prB = await approved([catalogLine(V.variant_id)], {
      requesterId: XCO, companyId: B, hotelId: B1, title: "convert-authz-b",
    });
    const rfqsBefore = await rfqCount();

    const noRfqCreate = await convert(buyC, { line_ids: pr.line_ids, department_id: ENG });
    expect(noRfqCreate.status).toBe(403);
    expect(noRfqCreate.body).toMatchObject({ status: 0, code: "PR_FORBIDDEN" });
    const otherHotelBuyer = await convert(buy2C, { line_ids: pr.line_ids, department_id: PROC });
    expect(otherHotelBuyer.status).toBe(403);
    expect(otherHotelBuyer.body.code).toBe("PR_FORBIDDEN");
    const requester = await convert(reqC, { line_ids: pr.line_ids, department_id: PROC });
    expect(requester.status).toBe(403);

    const companyB = await convert(buyC, { line_ids: prB.line_ids, department_id: PROC });
    expect(companyB.status).toBe(404);
    expect(companyB.body.code).toBe("PR_NOT_FOUND");
    const mixed = await convert(buyC, { line_ids: [pr.line_ids[0], prB.line_ids[0]], department_id: PROC });
    expect(mixed.status).toBe(404);
    const unknown = await convert(buyC, { line_ids: [pr.line_ids[0], 2000000000], department_id: PROC });
    expect(unknown.status).toBe(404);

    expect(await rfqCount()).toBe(rfqsBefore);
    expect(await linksOf([...pr.line_ids, ...prB.line_ids])).toEqual([]);
  });

  it("convert.tenant-before-locks: a foreign caller gets 404 without waiting on (or locking) the other tenant's rows", async () => {
    const prB = await approved([catalogLine(V.variant_id)], {
      requesterId: XCO, companyId: B, hotelId: B1, title: "convert-tenant-locks",
    });
    // Company B's PR row is locked by someone else; BUY's request must not queue behind it.
    const res = await db.tx(async (t) => {
      await t.one(`SELECT id FROM tbl_purchase_requisition WHERE id = $1 FOR UPDATE`, [prB.id]);
      let timer;
      const waited = new Promise((resolve) => { timer = setTimeout(() => resolve("blocked"), 5000); });
      const answer = await Promise.race([convert(buyC, { line_ids: prB.line_ids, department_id: PROC }), waited]);
      clearTimeout(timer);
      return answer;
    });
    expect(res).not.toBe("blocked");
    expect(res.status).toBe(404);
  });

  it("convert.validation: line_ids 1..200 positive ints, a real department, an active process of the company → else 422", async () => {
    const pr = await approved([catalogLine(V.variant_id)], { title: "convert-validation" });
    for (const body of [
      {},
      { line_ids: [], department_id: PROC },
      { line_ids: "1,2", department_id: PROC },
      { line_ids: [pr.line_ids[0], "x"], department_id: PROC },
      { line_ids: Array.from({ length: 201 }, (_, i) => i + 1), department_id: PROC },
      { line_ids: pr.line_ids },
      { line_ids: pr.line_ids, department_id: "proc" },
      { line_ids: pr.line_ids, department_id: PROC, process_id: -1 },
    ]) {
      const r = await convert(buyC, body);
      expect({ body, status: r.status, code: r.body.code }).toEqual({ body, status: 422, code: "PR_VALIDATION" });
    }
    const maxDept = Number((await db.one(`SELECT COALESCE(MAX(id), 0) AS m FROM tbl_department`)).m);
    const noDept = await convert(buyC, { line_ids: pr.line_ids, department_id: maxDept + 1000 });
    expect(noDept.status).toBe(422);
    const otherCompanyProcess = await convert(buyC, { line_ids: pr.line_ids, department_id: PROC, process_id: IDS.processes.B_P1 });
    expect(otherCompanyProcess.status).toBe(422);
    expect(await linksOf(pr.line_ids)).toEqual([]);
  });

  it("convert.process: rfq.create is checked WITH the process; the RFQ stores it", async () => {
    // REQ2 works A1's pool and may create RFQs only under process A_P1.
    const grants = [
      await grantPr(REQ2, "PR Buyer"),
      await grantRoleScope(db, {
        userId: REQ2, roleId: ROLE_IDS.TENDER_CREATOR, companyId: A, hotelId: A1, departmentId: PROC, processId: IDS.processes.A_P1,
      }),
    ];
    try {
      const req2C = await httpClient(REQ2);
      const pr = await approved([catalogLine(V.variant_id)], { title: "convert-process" });
      const otherProcess = await convert(req2C, { line_ids: pr.line_ids, department_id: PROC, process_id: IDS.processes.A_P2 });
      expect(otherProcess.status).toBe(403);
      const noProcess = await convert(req2C, { line_ids: pr.line_ids, department_id: PROC });
      expect(noProcess.status).toBe(403);
      expect(await linksOf(pr.line_ids)).toEqual([]);

      const ok = await convert(req2C, { line_ids: pr.line_ids, department_id: PROC, process_id: IDS.processes.A_P1 });
      expect(ok.status).toBe(200);
      expect(await db.one(`SELECT process_id, department_id, created_by FROM tbl_rfq WHERE id = $1`, [ok.body.data.rfq_id]))
        .toEqual({ process_id: IDS.processes.A_P1, department_id: PROC, created_by: REQ2 });
    } finally {
      await revokeRoleScopes(db, grants);
    }
  });
});

// ---------------------------------------------------------------------------
// Exact quantities, mapped free text
// ---------------------------------------------------------------------------
describe("PR convert — quantities and mapped free text", () => {
  it("convert.fractional-sum: 0.125 + 0.375 → '0.5'; 1000000.5 + 0.5 → '1000001'; 0.1 + 0.2 → '0.3' (exact NUMERIC)", async () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point: only an exact sum gives '0.3'.
    for (const [q1, q2, expected] of [["0.125", "0.375", "0.5"], ["1000000.5", "0.5", "1000001"], ["0.1", "0.2", "0.3"]]) {
      const p1 = await approved([catalogLine(V.variant_id, { quantity: q1, estimated_unit_price: "1.00" })], { title: "convert-frac-1" });
      const p2 = await approved([catalogLine(V.variant_id, { quantity: q2, estimated_unit_price: "1.00" })], { title: "convert-frac-2" });
      const r = await convert(buyC, { line_ids: [p1.line_ids[0], p2.line_ids[0]], department_id: PROC });
      expect(r.status).toBe(200);
      expect(await specsOf(r.body.data.rfq_id, V.variant_id)).toEqual({ Quantity: expected, Unit: "nos" });
    }
  });

  it("convert.spec-dedup (R23/R26): identical specifications of one item → that specification alone, no PR tags", async () => {
    const spec = `Spec ${"y".repeat(595)}`; // 600 characters
    const p1 = await approved([catalogLine(V.variant_id, { specification: spec })], { title: "convert-dedup-1" });
    const p2 = await approved([catalogLine(V.variant_id, { specification: `  ${spec}  ` })], { title: "convert-dedup-2" });
    const r = await convert(buyC, { line_ids: [p1.line_ids[0], p2.line_ids[0]], department_id: PROC });
    expect(r.status).toBe(200);
    const [product] = await rfqProducts(r.body.data.rfq_id);
    expect(product.comment).toBe(spec);
  });

  it("convert.spec-1000 (R26): a 1000-character specification always converts — alone or merged with an identical one", async () => {
    const spec = `Full spec ${"z".repeat(990)}`;
    expect(spec).toHaveLength(1000);
    const single = await approved([catalogLine(V.variant_id, { specification: spec })], { title: "convert-1000-single" });
    const one = await convert(buyC, { line_ids: single.line_ids, department_id: PROC });
    expect(one.status).toBe(200);
    expect((await rfqProducts(one.body.data.rfq_id))[0].comment).toBe(spec);

    const p1 = await approved([catalogLine(V.variant_id, { specification: spec })], { title: "convert-1000-a" });
    const p2 = await approved([catalogLine(V.variant_id, { specification: spec, quantity: "3" })], { title: "convert-1000-b" });
    const both = await convert(buyC, { line_ids: [p1.line_ids[0], p2.line_ids[0]], department_id: PROC });
    expect(both.status).toBe(200);
    const [product] = await rfqProducts(both.body.data.rfq_id);
    expect(product.comment).toBe(spec);
    expect(await specsOf(both.body.data.rfq_id, V.variant_id)).toEqual({ Quantity: "5", Unit: "nos" });
  });

  it("convert.spec-empty (R26): lines without a specification → an empty product specification, no tags", async () => {
    const p1 = await approved([catalogLine(V.variant_id, { specification: "" })], { title: "convert-empty-1" });
    const p2 = await approved([catalogLine(V.variant_id, { specification: "   " })], { title: "convert-empty-2" });
    const r = await convert(buyC, { line_ids: [p1.line_ids[0], p2.line_ids[0]], department_id: PROC });
    expect(r.status).toBe(200);
    expect((await rfqProducts(r.body.data.rfq_id))[0].comment).toBe("");
  });

  it("convert.spec-one-plus-empty (R26): one specification next to a line without one → that specification alone, no tags", async () => {
    const spec = `Spec ${"s".repeat(945)}`; // 950 characters: tags would push it past 1000
    const p1 = await approved([catalogLine(V.variant_id, { specification: spec })], { title: "convert-one-empty-1" });
    const p2 = await approved([catalogLine(V.variant_id, { specification: "" })], { title: "convert-one-empty-2" });
    const r = await convert(buyC, { line_ids: [p1.line_ids[0], p2.line_ids[0]], department_id: PROC });
    expect(r.status).toBe(200);
    const [product] = await rfqProducts(r.body.data.rfq_id);
    expect(product.comment).toBe(spec);
    expect(await specsOf(r.body.data.rfq_id, V.variant_id)).toEqual({ Quantity: "4", Unit: "nos" });
  });

  it("convert.spec-free-text-shares (R26): a mapped free-text line and a catalog line sharing one specification → that specification alone", async () => {
    const spec = `Mop ${"q".repeat(946)}`; // 950 characters
    const free = await approved([freeLine({ free_text_name: "Blue mop head 450mm", specification: spec })],
      { title: "convert-shared-free" });
    expect((await buyC.post(`/api/v1/pr/${free.id}/lines/${free.line_ids[0]}/map`).send({ variant_id: W.variant_id })).status)
      .toBe(200);
    const cat = await approved([catalogLine(W.variant_id, { specification: spec, quantity: "4" })], { title: "convert-shared-cat" });
    const r = await convert(buyC, { line_ids: [free.line_ids[0], cat.line_ids[0]], department_id: PROC });
    expect(r.status).toBe(200);
    const [product] = await rfqProducts(r.body.data.rfq_id);
    expect(product.product_variant_id).toBe(W.variant_id);
    expect(product.comment).toBe(spec);
    expect(await specsOf(r.body.data.rfq_id, W.variant_id)).toEqual({ Quantity: "8", Unit: "nos" });
  });

  it("convert.spec-too-long (R23): one item's merged specifications over 1000 characters → 422 PR_SPEC_TOO_LONG, nothing inserted", async () => {
    const p1 = await approved([catalogLine(V.variant_id, { specification: `A ${"a".repeat(598)}` })], { title: "convert-long-1" });
    const p2 = await approved([catalogLine(V.variant_id, { specification: `B ${"b".repeat(598)}` })], { title: "convert-long-2" });
    const [rfqsBefore, linksBefore] = [await rfqCount(), await linkCount()];
    const ids = [p1.line_ids[0], p2.line_ids[0]];
    const r = await convert(buyC, { line_ids: ids, department_id: PROC });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({
      status: 0, code: "PR_SPEC_TOO_LONG",
      details: [{ variant_id: V.variant_id, length: expect.any(Number), line_ids: sorted(ids) }],
    });
    expect(r.body.details[0].length).toBeGreaterThan(1000);
    expect(r.body.message).toMatch(/separate RFQs/);
    expect([await rfqCount(), await linkCount()]).toEqual([rfqsBefore, linksBefore]);
  });

  it("convert.free-text-mapped: a mapped free-text line converts as the mapped variant; the comment keeps the text", async () => {
    const pr = await approved([freeLine({ free_text_name: "Blue mop head 450mm", specification: "Cotton" })],
      { title: "convert-mapped" });
    const lineId = pr.line_ids[0];
    expect((await buyC.post(`/api/v1/pr/${pr.id}/lines/${lineId}/map`).send({ variant_id: W.variant_id })).status).toBe(200);
    const r = await convert(buyC, { line_ids: [lineId], department_id: PROC });
    expect(r.status).toBe(200);
    const [product] = await rfqProducts(r.body.data.rfq_id);
    expect((await db.one(`SELECT title FROM tbl_rfq WHERE id = $1`, [r.body.data.rfq_id])).title).toBe("convert-mapped");
    expect(product.product_variant_id).toBe(W.variant_id);
    // R26: one specification → no tag; the mapped line keeps what was asked for, then its specification.
    expect(product.comment).toBe("Blue mop head 450mm — Cotton");
    expect(await specsOf(r.body.data.rfq_id, W.variant_id)).toEqual({ Quantity: "4", Unit: "nos" });
    expect(await linksOf([lineId])).toEqual([expect.objectContaining({ rfq_id: r.body.data.rfq_id, rfq_product_id: product.id })]);
  });

  it("convert.free-text-long-spec (R26): when the free-text name would push a lone specification past 1000, the name is dropped — never refused", async () => {
    const spec = `Mop spec ${"m".repeat(991)}`;
    expect(spec).toHaveLength(1000);
    const pr = await approved([freeLine({ free_text_name: "Blue mop head 450mm", specification: spec })],
      { title: "convert-mapped-long" });
    const lineId = pr.line_ids[0];
    expect((await buyC.post(`/api/v1/pr/${pr.id}/lines/${lineId}/map`).send({ variant_id: W.variant_id })).status).toBe(200);
    const r = await convert(buyC, { line_ids: [lineId], department_id: PROC });
    expect(r.status).toBe(200);
    expect((await rfqProducts(r.body.data.rfq_id))[0].comment).toBe(spec);
  });
});

// ---------------------------------------------------------------------------
// Browser pass 19b: a buyer whose mobile is stored without a country code
// ("9000096018") got a draft whose contact number the RFQ wizard rebuilt as
// "-9000096018", and Submit failed with "Contact number must be in the format
// +<country_code>-<mobile_number>". The draft now carries the wizard's own
// "+CC-NNN" shape.
// ---------------------------------------------------------------------------
describe("PR convert — the draft's contact number is in the wizard's +CC-number shape", () => {
  it.each([
    ["+91-9876543210", "+91-9876543210"],
    ["+44-7700900123", "+44-7700900123"],
    [" +91 98765 43210 ", "+91-9876543210"],
    ["9000096018", "+91-9000096018"],
    ["09000096018", "+91-9000096018"],
    ["919000096018", "+91-9000096018"],
    ["9317222403-", "+91-9317222403"],
    ["+919876543210", "+91-9876543210"],
    ["+4477009001234", ""],
    // 19b review: the country code is 1-4 digits (the RFQ Joi regex) …
    ["+1-2025550123", "+1-2025550123"],
    ["+1234-9876543210", "+1234-9876543210"],
    ["+12345-9876543210", ""],
    ["+123456 98765 43210", ""],
    // … a bare number's international 00 prefix is dropped before +91 applies …
    ["0091 98765 43210", "+91-9876543210"],
    ["00919876543210", "+91-9876543210"],
    // … and the result fits the 20 characters RFQ create allows.
    ["+91-123456789012345", "+91-123456789012345"],
    ["+1234-123456789012345", ""],
    ["", ""],
    [null, ""],
    ["12345", ""],
    ["not a number", ""],
  ])("rfqContactNumber(%j) = %j", (mobile, expected) => {
    expect(rfqContactNumber(mobile)).toBe(expected);
  });

  it("a buyer with a bare 10-digit mobile gets +91-<number> on the draft", async () => {
    await db.none(`UPDATE tbl_users SET mobile = '9000096018' WHERE id = $1`, [BUY]);
    try {
      const pr = await approved([catalogLine(V.variant_id, { quantity: "1", uom: "nos" })], { title: "convert-contact" });
      const out = await convert(buyC, { line_ids: pr.line_ids, department_id: PROC });
      expect(out.status).toBe(200);
      const rfq = await db.one(`SELECT contact_number FROM tbl_rfq WHERE id = $1`, [out.body.data.rfq_id]);
      expect(rfq.contact_number).toBe("+91-9000096018");
    } finally {
      await db.none(`UPDATE tbl_users SET mobile = $2 WHERE id = $1`, [BUY, BUY_MOBILE]);
    }
  });
});
