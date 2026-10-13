// Purchase Requisitions — the buyer pool (Task 8, spec §9): the pool list,
// buyers picker, assignment, mapping free text to the catalog, catalog
// requests, closing a line (buyer) and cancelling a line (requester).
//
// Product-level: real HTTP through the full middleware chain against real
// Postgres; assertions read the response and the committed rows. Pattern B
// (commit + cleanup by tracked ids). Every PR here is approved through the API
// (approvedPr: create → submit under a USER-step policy → approve).
//
// Personas
//   REQ   a1_eng_buyer      PR Requester at (A, A1, eng) and (A, A2, eng) — no pr.convert
//   AP    crossCompany      PR Approver at (A, all, all) and (B, all, all) — company-level mapped to A and B
//   BUY   a1_proc_buyer     PR Buyer at (A, A1, all departments)
//   BUY2  dualRole          PR Buyer at (A, A2, all departments) only
//   BUY3  a1_proc_techApp   PR Buyer at (A, A1, all departments)
//   XCO   companyB_admin    PR Requester at (B, B1, eng)
//
// No category is mapped for review (A and B), so every submit goes straight to
// approval.

import nodemailer from "nodemailer";
import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import {
  grantPr, revokeAllPr, firstUsableVariant, cleanupPrs, makePrPolicy, dropPrPolicies, unmapAll, istDate, draftBody,
  approvedPr,
} from "../helpers/prFixtures.js";
import { makeRFQ } from "../factories/rfq.js";
import { buyerPrDetail } from "../../app/services/notificationLinks.js";

const A = IDS.hospitality.A;
const B = IDS.hospitality.B;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const B1 = IDS.hotels.B1;
const ENG = IDS.departments.eng;
const PROC = IDS.departments.proc;
const REQ = IDS.users.a1_eng_buyer;
const AP = IDS.users.crossCompany;
const BUY = IDS.users.a1_proc_buyer;
const BUY2 = IDS.users.dualRole;
const BUY3 = IDS.users.a1_proc_techApp;
const XCO = IDS.users.companyB_admin;
const PERSONAS = [REQ, AP, BUY, BUY2, BUY3, XCO];

const prIds = [];
const rfqIds = [];
let originalUserTypes = [];
let reqC, buyC, buy2C, buy3C, xcoC;
let V; // the catalog variant of catalog lines
let W; // a second usable variant (mapping target)
let K; // a third usable variant (put on contract in one block)
let U; // a fourth usable variant (made unusable in one test)
let CAT; // the free-text lines' category
let names = new Map();

// Every mail the app hands to nodemailer (jestEnv stubs the transport; this
// wraps the stub to record what was sent). Other flows mail asynchronously, so
// assertions look only at catalog-request mails.
const mails = [];
let realCreateTransport;
const catalogMails = () => mails.filter((m) => /^Catalog request/.test(m.subject || ""));

// ---------------------------------------------------------------------------
// Helpers (setup + reads only)
// ---------------------------------------------------------------------------
const catalogLine = (variantId, extra = {}) => ({
  product_variant_id: variantId, quantity: "2", uom: "nos", estimated_unit_price: "1500.00", specification: "OEM", ...extra,
});
const freeLine = (extra = {}) => ({
  free_text_name: "Compressor relay 24V", category_id: CAT, quantity: "4", uom: "nos", estimated_unit_price: "250.50", ...extra,
});

/** An approved PR raised by REQ (or `requesterId`), approved by AP; tracked for cleanup. */
async function approved(lines, opts = {}) {
  const pr = await approvedPr(lines, { requesterId: REQ, approverId: AP, ...opts });
  prIds.push(pr.id);
  return pr;
}

const pool = (client, qs = "") => client.get(`/api/v1/pr/pool${qs ? `?${qs}` : ""}`);
/** The caller's pool rows of one PR (searched by its number), in pool order. */
const poolOf = async (client, pr, qs = "") => {
  const res = await pool(client, `q=${encodeURIComponent(pr.pr_number)}&page_size=200${qs ? `&${qs}` : ""}`);
  expect(res.status).toBe(200);
  return res.body.data.rows;
};
const poolRow = async (client, pr, lineId) => (await poolOf(client, pr)).find((r) => r.line_id === lineId);

const assign = (client, prId, buyerId) => client.post(`/api/v1/pr/${prId}/assign`).send({ buyer_id: buyerId });
const mapLine = (client, prId, lineId, variantId) =>
  client.post(`/api/v1/pr/${prId}/lines/${lineId}/map`).send({ variant_id: variantId });
const requestCatalog = (client, prId, lineId, body = {}) =>
  client.post(`/api/v1/pr/${prId}/lines/${lineId}/catalog-request`).send(body);
const closeLine = (client, prId, lineId, reason) =>
  client.post(`/api/v1/pr/${prId}/lines/${lineId}/close`).send({ reason });
const cancelLine = (client, prId, lineId, reason) =>
  client.post(`/api/v1/pr/${prId}/lines/${lineId}/cancel`).send({ reason });
const detail = (id, client = reqC) => client.get(`/api/v1/pr/${id}`);
const lineOf = (detailRes, lineId) => detailRes.body.data.lines.find((l) => l.id === lineId);

const lineRow = (id) => db.one(
  `SELECT id, status, close_reason, closed_by, closed_at, mapped_variant_id, mapped_by, mapped_at
     FROM tbl_purchase_requisition_line WHERE id = $1`, [id]);
const eventsOf = (id) => db.any(
  `SELECT event_type, actor_id, pr_line_id, revision, payload FROM tbl_pr_event WHERE pr_id = $1 ORDER BY id`, [id]);
const lastEvent = async (id) => (await eventsOf(id)).at(-1);
const catalogRequests = (lineId) => db.any(
  `SELECT id, hospitality_company_id, pr_line_id, requested_name, description, category_id, status, requested_by,
          resolved_by, resolved_at, resolution_note, resolved_variant_id
     FROM tbl_pr_catalog_request WHERE pr_line_id = $1 ORDER BY id`, [lineId]);
const prNotifications = (prId, type) => db.any(
  `SELECT recipient_user_id, type, title, message, action_url FROM tbl_notifications
    WHERE category = 'pr' AND additional_data->>'pr_id' = $1::text AND ($2::text IS NULL OR type = $2)
    ORDER BY id`, [prId, type ?? null]);
const recipientsOf = async (prId, type) =>
  [...new Set((await prNotifications(prId, type)).map((n) => Number(n.recipient_user_id)))].sort((a, b) => a - b);
const sorted = (ids) => [...ids].sort((a, b) => a - b);

/**
 * Usable variants other than V whose product has a category (so the catalog
 * search lists them), highest id first (so they differ from other suites' picks).
 */
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

/** A live RFQ link for `lineId` (an open, published RFQ with one product). Returns the RFQ id. */
async function linkLine(lineId, variantId, { status = 1 } = {}) {
  const rfq = await makeRFQ(db, { createdBy: BUY, status, is_published: 1, hospitality: A, hotel: A1 });
  rfqIds.push(rfq.rfq_id);
  const rp = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
     VALUES ($1, '', '0', '', '', $2, 1) RETURNING id`, [rfq.rfq_id, variantId]);
  await db.none(
    `INSERT INTO tbl_pr_line_rfq (pr_line_id, rfq_id, rfq_product_id, quantity, converted_by) VALUES ($1, $2, $3, 1, $4)`,
    [lineId, rfq.rfq_id, rp.id, BUY]);
  return rfq.rfq_id;
}

beforeAll(async () => {
  originalUserTypes = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS]);
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [PERSONAS]);
  await revokeAllPr(PERSONAS);
  await unmapAll(A);
  await unmapAll(B);
  await dropPrPolicies();
  await grantPr(REQ, "PR Requester", { departmentId: ENG });
  await grantPr(REQ, "PR Requester", { hotelId: A2, departmentId: ENG });
  await grantPr(AP, "PR Approver", { hotelId: null });
  await grantPr(AP, "PR Approver", { companyId: B, hotelId: null });
  await grantPr(BUY, "PR Buyer");
  await grantPr(BUY2, "PR Buyer", { hotelId: A2 });
  await grantPr(BUY3, "PR Buyer");
  await grantPr(XCO, "PR Requester", { companyId: B, hotelId: B1, departmentId: ENG });

  V = await firstUsableVariant();
  [W, K, U] = await otherUsableVariants(3);
  CAT = Number((await db.one(
    `SELECT id FROM tbl_category WHERE status = 1 AND is_deleted = 0 AND id <> $1 ORDER BY id LIMIT 1`,
    [V.category_id])).id);
  names = new Map((await db.any(`SELECT id, name FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS]))
    .map((r) => [Number(r.id), r.name]));

  reqC = await httpClient(REQ);
  buyC = await httpClient(BUY);
  buy2C = await httpClient(BUY2);
  buy3C = await httpClient(BUY3);
  xcoC = await httpClient(XCO);

  realCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = (...args) => {
    const transport = realCreateTransport(...args);
    return {
      ...transport,
      sendMail(options, cb) {
        mails.push(options);
        return transport.sendMail(options, cb);
      },
    };
  };
});

afterAll(async () => {
  nodemailer.createTransport = realCreateTransport;
  delete process.env.PR_CATALOG_REQUEST_EMAIL;
  if (prIds.length) {
    await db.none(
      `DELETE FROM tbl_notifications
        WHERE (category = 'pr' AND additional_data->>'pr_id' = ANY($1::text[]))
           OR action_url = ANY($2::text[])`,
      [prIds.map(String), prIds.map((id) => buyerPrDetail(id))]);
  }
  await cleanupPrs(prIds);
  if (rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);
  }
  await dropPrPolicies();
  await revokeAllPr(PERSONAS);
  for (const u of originalUserTypes) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
  }
});

// ---------------------------------------------------------------------------
// The pool list
// ---------------------------------------------------------------------------
describe("PR pool — scope, rows, age, order, filters", () => {
  let a1;
  let a2;
  beforeAll(async () => {
    a1 = await approved([catalogLine(V.variant_id), freeLine()], { title: "pool-scope-a1" });
    a2 = await approved([freeLine({ free_text_name: "A2 boiler gasket" })], { hotelId: A2, title: "pool-scope-a2" });
  });

  it("pool.scope: BUY sees the A1 lines, BUY2 only A2's, a requester without pr.convert → 403", async () => {
    const asBuy = await pool(buyC, "page_size=200");
    expect(asBuy.status).toBe(200);
    const buyLines = asBuy.body.data.rows.map((r) => r.line_id);
    expect(buyLines).toEqual(expect.arrayContaining(a1.line_ids));
    expect(buyLines).not.toContain(a2.line_ids[0]);
    expect(asBuy.body.data.rows.every((r) => r.hotel_id === A1)).toBe(true);
    expect(asBuy.body.data.hotels).toEqual([{ id: A1, name: expect.any(String) }]);

    const asBuy2 = await pool(buy2C, "page_size=200");
    expect(asBuy2.status).toBe(200);
    const buy2Lines = asBuy2.body.data.rows.map((r) => r.line_id);
    expect(buy2Lines).toContain(a2.line_ids[0]);
    for (const id of a1.line_ids) expect(buy2Lines).not.toContain(id);
    expect(asBuy2.body.data.hotels).toEqual([{ id: A2, name: expect.any(String) }]);

    const asReq = await pool(reqC);
    expect(asReq.status).toBe(403);
    expect(asReq.body).toMatchObject({ status: 0, code: "PR_FORBIDDEN" });
  });

  it("row shape: one row per active line, money as exact strings, progress from the shared SQL", async () => {
    const rows = await poolOf(buyC, a1);
    expect(rows).toHaveLength(2);
    const [catRow, freeRow] = [a1.line_ids[0], a1.line_ids[1]].map((id) => rows.find((r) => r.line_id === id));
    expect(catRow).toEqual({
      line_id: a1.line_ids[0], pr_id: a1.id, pr_number: a1.pr_number, pr_title: "pool-scope-a1",
      hotel_id: A1, hotel_name: expect.any(String), department_id: ENG, department_title: expect.any(String),
      line_no: 1, line_kind: "catalog", item_name: V.variant_name, free_text_name: null,
      effective_variant_id: V.variant_id, category_id: V.category_id, category_title: expect.any(String),
      quantity: "2.000", uom: "nos", estimated_unit_price: "1500.00", line_value: "3000.00",
      required_by_date: await istDate(14), urgency: "normal", approved_at: expect.any(String),
      age_days: 0, age_band: "ok", assigned_buyer_id: null, assigned_buyer_name: null,
      progress: "in_pool", duplicate_count: expect.any(Number), clause_count: 0, attachment_count: 0,
      open_catalog_request_id: null,
    });
    expect(freeRow).toMatchObject({
      line_kind: "free_text", item_name: "Compressor relay 24V", free_text_name: "Compressor relay 24V",
      effective_variant_id: null, category_id: CAT, quantity: "4.000", estimated_unit_price: "250.50",
      line_value: "1002.00", progress: "needs_mapping", duplicate_count: 0,
    });
  });

  it("pool.progress+age: IST calendar days since approval; ok < 3, amber 3–6, red ≥ 7", async () => {
    const lineId = a1.line_ids[0];
    const before = await db.one(`SELECT approved_at FROM tbl_purchase_requisition WHERE id = $1`, [a1.id]);
    try {
      for (const [days, band] of [[0, "ok"], [2, "ok"], [3, "amber"], [6, "amber"], [7, "red"], [8, "red"]]) {
        await db.none(
          `UPDATE tbl_purchase_requisition SET approved_at = NOW() - make_interval(days => $2) WHERE id = $1`,
          [a1.id, days]);
        const row = await poolRow(buyC, a1, lineId);
        expect({ days, age_days: row.age_days, age_band: row.age_band }).toEqual({ days, age_days: days, age_band: band });
      }
      // Calendar days in IST, whatever the session timezone: one minute before
      // IST midnight is "yesterday" (1 day), thirty seconds after it is today.
      await db.none(
        `UPDATE tbl_purchase_requisition
            SET approved_at = (((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date)::timestamp - INTERVAL '1 minute')
                              AT TIME ZONE 'Asia/Kolkata'
          WHERE id = $1`, [a1.id]);
      expect((await poolRow(buyC, a1, lineId)).age_days).toBe(1);
      await db.none(
        `UPDATE tbl_purchase_requisition
            SET approved_at = (((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date)::timestamp + INTERVAL '30 seconds')
                              AT TIME ZONE 'Asia/Kolkata'
          WHERE id = $1`, [a1.id]);
      expect((await poolRow(buyC, a1, lineId)).age_days).toBe(0);
    } finally {
      await db.none(`UPDATE tbl_purchase_requisition SET approved_at = $2 WHERE id = $1`, [a1.id, before.approved_at]);
    }
  });

  it("pool.order: urgent first, then need-by date, then approval time", async () => {
    const late = await approved([catalogLine(V.variant_id)], { title: "pool-order-late", required_by_date: await istDate(20) });
    const urgent = await approved([catalogLine(V.variant_id)], {
      title: "pool-order-urgent", urgency: "urgent", required_by_date: await istDate(30),
    });
    const soon = await approved([catalogLine(V.variant_id)], { title: "pool-order-soon", required_by_date: await istDate(10) });
    const soonOlder = await approved([catalogLine(V.variant_id)], { title: "pool-order-soon-older", required_by_date: await istDate(10) });
    await db.none(`UPDATE tbl_purchase_requisition SET approved_at = NOW() - INTERVAL '2 days' WHERE id = $1`, [soonOlder.id]);

    const res = await pool(buyC, "q=pool-order&page_size=200");
    expect(res.status).toBe(200);
    expect(res.body.data.rows.map((r) => r.pr_id)).toEqual([urgent.id, soonOlder.id, soon.id, late.id]);
    expect(res.body.data.total).toBe(4);

    // duplicate_count is what the duplicate hint lists for the item, minus the row's own PR.
    const hint = await buyC.get(`/api/v1/pr/duplicates?hotel_id=${A1}&variant_id=${V.variant_id}`);
    expect(hint.status).toBe(200);
    expect(hint.body.data.items.filter((i) => i.kind === "pr").map((i) => i.id))
      .toEqual(expect.arrayContaining([a1.id, late.id, urgent.id, soon.id, soonOlder.id]));
    for (const row of res.body.data.rows) expect(row.duplicate_count).toBe(hint.body.data.count - 1);
  });

  it("pool.filters: department, category, progress (one or several), assigned, paging; invalid values → 422", async () => {
    const ids = async (qs) => (await poolOf(buyC, a1, qs)).map((r) => r.line_id);
    expect(await ids("progress=needs_mapping")).toEqual([a1.line_ids[1]]);
    expect(sorted(await ids("progress=in_pool,needs_mapping"))).toEqual(sorted(a1.line_ids));
    expect(await ids("progress=awaiting_catalog")).toEqual([]);
    expect(await ids(`category_id=${CAT}`)).toEqual([a1.line_ids[1]]);
    expect(await ids(`department_id=${PROC}`)).toEqual([]);
    expect(sorted(await ids(`department_id=${ENG}&hotel_id=${A1}`))).toEqual(sorted(a1.line_ids));
    // A hotel outside the caller's pool scope narrows to nothing; it never widens.
    expect(await ids(`hotel_id=${A2}`)).toEqual([]);
    expect(sorted(await ids("assigned=unassigned"))).toEqual(sorted(a1.line_ids));
    expect(await ids("assigned=me")).toEqual([]);
    expect(sorted(await ids("assigned=any"))).toEqual(sorted(a1.line_ids));

    const page = await pool(buyC, `q=${a1.pr_number}&page_size=1&page=2`);
    expect(page.body.data.rows).toHaveLength(1);
    expect(page.body.data.total).toBe(2);

    for (const qs of ["progress=ordered", "progress=in_pool,closed", "progress[x]=in_pool", "assigned=someone", "hotel_id=abc", "page=0"]) {
      const bad = await pool(buyC, qs);
      expect({ qs, status: bad.status, code: bad.body.code }).toEqual({ qs, status: 422, code: "PR_VALIDATION" });
    }
  });

  it("pool.excludes-non-approved: drafts and PRs pending approval never appear", async () => {
    const draft = await reqC.post("/api/v1/pr").send(await draftBody({ title: "pool-not-approved-draft" }));
    expect(draft.status).toBe(200);
    prIds.push(draft.body.data.id);

    const pending = await reqC.post("/api/v1/pr").send(await draftBody({ title: "pool-not-approved-pending" }));
    expect(pending.status).toBe(200);
    prIds.push(pending.body.data.id);
    const policyId = await makePrPolicy({ hotelId: A1, steps: [{ source: "USER", id: AP }] });
    try {
      const sub = await reqC.post(`/api/v1/pr/${pending.body.data.id}/submit`).send({});
      expect(sub.body.data.pr.status).toBe("pending_approval");
    } finally {
      await db.none(`UPDATE tbl_approval_policies SET is_active = false WHERE id = $1`, [policyId]);
    }

    const res = await pool(buyC, "q=pool-not-approved&page_size=200");
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Buyers + assignment
// ---------------------------------------------------------------------------
describe("PR pool — buyers and assignment", () => {
  let pr;
  beforeAll(async () => {
    pr = await approved([catalogLine(V.variant_id)], { title: "pool-assign" });
  });

  it("buyers: the hotel's pr.convert holders, for a caller who holds it there", async () => {
    const res = await buyC.get(`/api/v1/pr/buyers?hotel_id=${A1}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining([BUY, BUY3]));
    expect(ids).not.toContain(BUY2);
    expect(ids).not.toContain(REQ);
    expect(res.body.data.find((b) => b.id === BUY3)).toEqual({ id: BUY3, name: names.get(BUY3) });

    expect((await buy2C.get(`/api/v1/pr/buyers?hotel_id=${A2}`)).body.data.map((b) => b.id)).toContain(BUY2);
    expect((await reqC.get(`/api/v1/pr/buyers?hotel_id=${A1}`)).status).toBe(403);
    expect((await buyC.get(`/api/v1/pr/buyers?hotel_id=${A2}`)).status).toBe(403);
    expect((await buyC.get(`/api/v1/pr/buyers?hotel_id=${B1}`)).status).toBe(403);
    const missing = await buyC.get("/api/v1/pr/buyers");
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe("PR_VALIDATION");
  });

  it("assign: BUY → BUY3; the requester sees who handles it; BUY3 and the requester are notified, BUY is not", async () => {
    const res = await assign(buyC, pr.id, BUY3);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: pr.id, assigned_buyer_id: BUY3, assigned_buyer_name: names.get(BUY3) });

    const asReq = (await detail(pr.id)).body.data.pr;
    expect(asReq.assigned_buyer_id).toBe(BUY3);
    expect(asReq.assigned_buyer_name).toBe(names.get(BUY3));
    expect(asReq.assigned_at).not.toBeNull();
    expect(asReq.now_with).toBe(names.get(BUY3));

    expect(await lastEvent(pr.id)).toMatchObject({
      event_type: "assigned", actor_id: BUY, payload: { from: null, to: BUY3, to_name: names.get(BUY3) },
    });
    const notes = await prNotifications(pr.id, "pr_assigned");
    expect(sorted(notes.map((n) => Number(n.recipient_user_id)))).toEqual(sorted([BUY3, REQ]));
    expect(notes.find((n) => Number(n.recipient_user_id) === REQ).message).toContain(names.get(BUY3));
    for (const n of notes) expect(n.action_url).toBe(buyerPrDetail(pr.id));

    const row = await poolRow(buyC, pr, pr.line_ids[0]);
    expect(row).toMatchObject({ assigned_buyer_id: BUY3, assigned_buyer_name: names.get(BUY3) });
    expect((await poolOf(buy3C, pr, "assigned=me")).map((r) => r.line_id)).toEqual(pr.line_ids);
    expect(await poolOf(buyC, pr, "assigned=me")).toEqual([]);
    expect(await poolOf(buyC, pr, "assigned=unassigned")).toEqual([]);

    // Re-assigning to the same buyer changes nothing and tells nobody again.
    expect((await assign(buyC, pr.id, BUY3)).status).toBe(200);
    expect((await prNotifications(pr.id, "pr_assigned"))).toHaveLength(2);
    expect((await eventsOf(pr.id)).filter((e) => e.event_type === "assigned")).toHaveLength(1);
  });

  it("assign: taking it yourself tells the requester only; the event records who it moved from", async () => {
    const before = (await prNotifications(pr.id, "pr_assigned")).length;
    expect((await assign(buyC, pr.id, BUY)).status).toBe(200);
    const added = (await prNotifications(pr.id, "pr_assigned")).slice(before);
    expect(added.map((n) => Number(n.recipient_user_id))).toEqual([REQ]);
    expect(await lastEvent(pr.id)).toMatchObject({ event_type: "assigned", payload: { from: BUY3, to: BUY } });
  });

  it("assign refusals: assignee without pr.convert on the hotel → 422; caller without it → 403; PR not approved → 409", async () => {
    for (const target of [BUY2, REQ, "abc", null]) {
      const res = await assign(buyC, pr.id, target);
      expect({ target, status: res.status, code: res.body.code }).toEqual({ target, status: 422, code: "PR_VALIDATION" });
    }
    const asReq = await assign(reqC, pr.id, BUY);
    expect(asReq.status).toBe(403);
    expect(asReq.body.code).toBe("PR_FORBIDDEN");

    const draft = await reqC.post("/api/v1/pr").send(await draftBody({ title: "pool-assign-draft" }));
    prIds.push(draft.body.data.id);
    const res = await assign(buyC, draft.body.data.id, BUY);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: 0, code: "PR_STATE_CONFLICT" });
    expect((await db.one(`SELECT assigned_buyer_id FROM tbl_purchase_requisition WHERE id = $1`, [draft.body.data.id]))
      .assigned_buyer_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mapping free text to the catalog
// ---------------------------------------------------------------------------
describe("PR pool — map a free-text line", () => {
  let pr;
  let catalogId;
  let freeId;
  beforeAll(async () => {
    pr = await approved([catalogLine(V.variant_id), freeLine({ free_text_name: "Map me widget" })], { title: "pool-map" });
    [catalogId, freeId] = pr.line_ids;
  });

  it("map: free text → a usable variant joins the pool as that variant; re-mapping is allowed until it is sourced", async () => {
    const res = await mapLine(buyC, pr.id, freeId, W.variant_id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ line_id: freeId, mapped_variant_id: W.variant_id, progress: "in_pool" });

    expect(await poolRow(buyC, pr, freeId)).toMatchObject({
      progress: "in_pool", effective_variant_id: W.variant_id, item_name: W.variant_name, free_text_name: "Map me widget",
    });
    const row = await lineRow(freeId);
    expect(row).toMatchObject({ mapped_variant_id: W.variant_id, mapped_by: BUY });
    expect(row.mapped_at).not.toBeNull();
    expect(await lastEvent(pr.id)).toMatchObject({
      event_type: "line_mapped", actor_id: BUY, pr_line_id: freeId, payload: { line_no: 2, from: null, to: W.variant_id },
    });

    const again = await mapLine(buyC, pr.id, freeId, V.variant_id);
    expect(again.status).toBe(200);
    expect((await lineRow(freeId)).mapped_variant_id).toBe(V.variant_id);
    expect(await lastEvent(pr.id)).toMatchObject({
      event_type: "line_mapped", payload: { from: W.variant_id, to: V.variant_id },
    });
    expect(lineOf(await detail(pr.id), freeId)).toMatchObject({ mapped_variant_id: V.variant_id, mapped_variant_name: V.variant_name });
  });

  it("map refusals: a catalog line → 409; unusable / unknown variant → 422; no pr.convert → 403; unknown line → 404", async () => {
    const catalog = await mapLine(buyC, pr.id, catalogId, W.variant_id);
    expect(catalog.status).toBe(409);
    expect(catalog.body).toMatchObject({ status: 0, code: "PR_STATE_CONFLICT", details: { line_id: catalogId, reason: "not_free_text" } });

    await db.none(`UPDATE tbl_product_variant SET is_approve = 0 WHERE id = $1`, [U.variant_id]);
    try {
      const unusable = await mapLine(buyC, pr.id, freeId, U.variant_id);
      expect(unusable.status).toBe(422);
      expect(unusable.body.code).toBe("PR_VARIANT_NOT_USABLE");
    } finally {
      await db.none(`UPDATE tbl_product_variant SET is_approve = 1 WHERE id = $1`, [U.variant_id]);
    }
    const maxId = Number((await db.one(`SELECT MAX(id) AS m FROM tbl_product_variant`)).m);
    const unknown = await mapLine(buyC, pr.id, freeId, maxId + 1000);
    expect(unknown.status).toBe(422);
    expect(unknown.body.code).toBe("PR_VALIDATION");
    const noId = await buyC.post(`/api/v1/pr/${pr.id}/lines/${freeId}/map`).send({});
    expect(noId.status).toBe(422);

    expect((await mapLine(reqC, pr.id, freeId, W.variant_id)).status).toBe(403);
    expect((await mapLine(buyC, pr.id, 999999999, W.variant_id)).status).toBe(404);
    const otherPrLine = (await approved([freeLine()], { title: "pool-map-other" })).line_ids[0];
    expect((await mapLine(buyC, pr.id, otherPrLine, W.variant_id)).status).toBe(404);
    // Nothing above changed the mapping.
    expect((await lineRow(freeId)).mapped_variant_id).toBe(V.variant_id);
  });

  describe("with a live rate contract for K at (A1, eng)", () => {
    let arcId;
    let contractId;
    let itemId;
    beforeAll(async () => {
      const arc = await db.one(
        `INSERT INTO tbl_arc
           (arc_number, title, category_id, hospitality_company_id, hotel_id,
            department_id, process_id, status,
            submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
         VALUES ('ARC-TEST-PR-POOL', 'PR pool contract', $1, $2, $3, $4, $5, 'contract_active',
                 NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days',
                 NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $6) RETURNING id`,
        [V.category_id, A, A1, ENG, IDS.processes.A_P1, REQ]);
      arcId = Number(arc.id);
      itemId = Number((await db.one(
        `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 1000, 'nos') RETURNING id`,
        [arcId, K.variant_id])).id);
      contractId = Number((await db.one(
        `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`,
        [arcId, IDS.users.vendor_alpha])).id);
      await db.none(
        `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
         VALUES ($1, $2, 90, 5, 1000)`, [contractId, itemId]);
    });

    afterAll(async () => {
      await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractId]);
      await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contractId]);
      await db.none(`DELETE FROM tbl_arc_item WHERE id = $1`, [itemId]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    });

    it("map to an on-contract variant → 422 PR_LINE_ON_CONTRACT naming the ARC; the mapping is unchanged", async () => {
      const res = await mapLine(buyC, pr.id, freeId, K.variant_id);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        code: "PR_LINE_ON_CONTRACT",
        details: { line_id: freeId, variant_id: K.variant_id, arc_number: "ARC-TEST-PR-POOL", arc_contract_id: contractId },
      });
      expect((await lineRow(freeId)).mapped_variant_id).toBe(V.variant_id);
    });

    it("search-items (R20): a pure PR Buyer of the hotel searches the catalog, on-contract flagged for the PR's department", async () => {
      const search = (client, hotelId, departmentId, q = K.variant_name) => client.get(
        `/api/v1/pr/search-items?hotel_id=${hotelId}&department_id=${departmentId}&limit=50&q=${encodeURIComponent(q)}`);
      const hitOf = (res) => res.body.data.items.find((i) => i.variant_id === K.variant_id);

      // BUY holds pr.convert at A1 and no pr.create anywhere.
      const eng = await search(buyC, A1, ENG);
      expect(eng.status).toBe(200);
      expect(hitOf(eng)).toMatchObject({
        variant_id: K.variant_id, on_contract: true, arc_number: "ARC-TEST-PR-POOL", arc_contract_id: contractId,
      });
      // The flag is for the department passed: the contract is (A1, eng) only.
      const proc = await search(buyC, A1, PROC);
      expect(proc.status).toBe(200);
      expect(hitOf(proc)).toMatchObject({ on_contract: false, arc_number: null });

      // The department must be a real one (the buyer passes the PR's).
      const unknownDept = await search(buyC, A1, 999999);
      expect(unknownDept.status).toBe(422);
      expect(unknownDept.body.code).toBe("PR_VALIDATION");
      expect((await buyC.get(`/api/v1/pr/search-items?hotel_id=${A1}&q=ab`)).status).toBe(422);

      // pr.convert at A2 only does not open A1's catalog search; nor does another company's hotel.
      const otherHotel = await search(buy2C, A1, ENG);
      expect(otherHotel.status).toBe(403);
      expect(otherHotel.body.code).toBe("PR_FORBIDDEN");
      expect((await search(buyC, B1, ENG)).status).toBe(403);

      // The requester path is unchanged: pr.create on the cell, else 403.
      const asReq = await search(reqC, A1, ENG);
      expect(asReq.status).toBe(200);
      expect(hitOf(asReq)).toMatchObject({ on_contract: true });
      expect((await search(reqC, A1, PROC)).status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// Catalog requests
// ---------------------------------------------------------------------------
describe("PR pool — catalog requests", () => {
  afterEach(() => {
    delete process.env.PR_CATALOG_REQUEST_EMAIL;
  });

  it("catalog-request: awaiting_catalog; a second one → 409; platform email; a buyer mapping fulfils it", async () => {
    process.env.PR_CATALOG_REQUEST_EMAIL = "catalog-team@test.local, second@test.local";
    const pr = await approved([freeLine({ free_text_name: "Ozone generator 5g" })], { title: "pool-catreq" });
    const lineId = pr.line_ids[0];
    const mailsBefore = catalogMails().length;

    const res = await requestCatalog(buyC, pr.id, lineId, { requested_name: "Ozone generator 5 g/h", description: "Wall mounted" });
    expect(res.status).toBe(200);
    const [req] = await catalogRequests(lineId);
    expect(res.body.data).toMatchObject({ id: req.id, line_id: lineId, status: "open", requested_name: "Ozone generator 5 g/h" });
    expect(req).toMatchObject({
      hospitality_company_id: A, pr_line_id: lineId, requested_name: "Ozone generator 5 g/h", description: "Wall mounted",
      category_id: CAT, status: "open", requested_by: BUY, resolved_by: null,
    });
    expect(await poolRow(buyC, pr, lineId)).toMatchObject({ progress: "awaiting_catalog", open_catalog_request_id: req.id });
    expect(await lastEvent(pr.id)).toMatchObject({
      event_type: "catalog_requested", actor_id: BUY, pr_line_id: lineId,
      payload: { request_id: req.id, requested_name: "Ozone generator 5 g/h" },
    });
    const sent = catalogMails().slice(mailsBefore);
    expect(sent.map((m) => m.to).sort()).toEqual(["catalog-team@test.local", "second@test.local"]);
    expect(sent[0].subject).toContain("Ozone generator 5 g/h");
    expect(sent[0].subject).toContain(pr.pr_number);

    const second = await requestCatalog(buyC, pr.id, lineId, { requested_name: "again" });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: "PR_STATE_CONFLICT", details: { reason: "catalog_request_open" } });
    expect(await catalogRequests(lineId)).toHaveLength(1);

    // The buyer finds it in the catalog after all: mapping fulfils the request.
    expect((await mapLine(buyC, pr.id, lineId, W.variant_id)).status).toBe(200);
    const [done] = await catalogRequests(lineId);
    expect(done).toMatchObject({
      status: "fulfilled", resolved_by: BUY, resolved_variant_id: W.variant_id, resolution_note: "Mapped by buyer",
    });
    expect(done.resolved_at).not.toBeNull();
    const types = (await eventsOf(pr.id)).map((e) => e.event_type);
    expect(types.slice(-2)).toEqual(["line_mapped", "catalog_fulfilled"]);
    expect(await lastEvent(pr.id)).toMatchObject({
      payload: { request_id: req.id, variant_id: W.variant_id, resolved_by: "buyer" },
    });
    expect(await poolRow(buyC, pr, lineId)).toMatchObject({ progress: "in_pool", open_catalog_request_id: null });
  });

  it("catalog-request refusals: catalog or mapped line → 409; no pr.convert → 403; name defaults to the free text, too long → 422", async () => {
    const pr = await approved([catalogLine(V.variant_id), freeLine({ free_text_name: "Default name item" }), freeLine()], {
      title: "pool-catreq-refusals",
    });
    const [catalogId, freeId, mappedId] = pr.line_ids;
    expect((await mapLine(buyC, pr.id, mappedId, W.variant_id)).status).toBe(200);

    const catalog = await requestCatalog(buyC, pr.id, catalogId);
    expect(catalog.status).toBe(409);
    expect(catalog.body.details).toMatchObject({ reason: "not_free_text" });
    const mapped = await requestCatalog(buyC, pr.id, mappedId);
    expect(mapped.status).toBe(409);
    expect(mapped.body.details).toMatchObject({ reason: "already_mapped" });
    expect((await requestCatalog(reqC, pr.id, freeId)).status).toBe(403);
    const long = await requestCatalog(buyC, pr.id, freeId, { requested_name: "x".repeat(301) });
    expect(long.status).toBe(422);
    expect(long.body.code).toBe("PR_VALIDATION");

    // No platform address configured: the request still goes in, nothing is mailed.
    const mailsBefore = catalogMails().length;
    const ok = await requestCatalog(buyC, pr.id, freeId, {});
    expect(ok.status).toBe(200);
    expect((await catalogRequests(freeId))[0]).toMatchObject({ requested_name: "Default name item", description: null });
    expect(catalogMails().length).toBe(mailsBefore);
  });

  it("catalog-request: two at once for one line → exactly one is opened, the other is 409", async () => {
    const pr = await approved([freeLine({ free_text_name: "Race item" })], { title: "pool-catreq-race" });
    const lineId = pr.line_ids[0];
    const results = await Promise.all([
      requestCatalog(buyC, pr.id, lineId, { requested_name: "one" }),
      requestCatalog(buy3C, pr.id, lineId, { requested_name: "two" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await catalogRequests(lineId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Closing a line (buyer) and cancelling one (requester)
// ---------------------------------------------------------------------------
describe("PR pool — close line (buyer)", () => {
  it("close: a reason is required (422); closed lines leave the pool; the requester is notified; closing again → 409", async () => {
    const pr = await approved([catalogLine(V.variant_id), freeLine()], { title: "pool-close" });
    const [lineId, otherId] = pr.line_ids;

    for (const reason of ["", "   ", undefined, "x".repeat(2001)]) {
      const res = await closeLine(buyC, pr.id, lineId, reason);
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 422, code: "PR_VALIDATION" });
    }
    expect((await closeLine(reqC, pr.id, lineId, "no")).status).toBe(403);
    expect((await lineRow(lineId)).status).toBe("active");

    const res = await closeLine(buyC, pr.id, lineId, "  Bought locally  ");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ line_id: lineId, status: "closed", progress: "closed" });
    const row = await lineRow(lineId);
    expect(row).toMatchObject({ status: "closed", close_reason: "Bought locally", closed_by: BUY });
    expect(row.closed_at).not.toBeNull();
    expect(lineOf(await detail(pr.id), lineId).progress).toBe("closed");
    expect((await poolOf(buyC, pr)).map((r) => r.line_id)).toEqual([otherId]);
    expect(await lastEvent(pr.id)).toMatchObject({
      event_type: "line_closed", actor_id: BUY, pr_line_id: lineId, payload: { line_no: 1, reason: "Bought locally" },
    });
    expect(await recipientsOf(pr.id, "pr_line_closed")).toEqual([REQ]);
    // No catalog request was open: nothing else happened.
    expect((await eventsOf(pr.id)).map((e) => e.event_type)).not.toContain("catalog_rejected");

    const again = await closeLine(buyC, pr.id, lineId, "again");
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ line_id: lineId, reason: "not_active" });
  });
});

describe("PR pool — cancel line (requester)", () => {
  it("cancel-line: the requester cancels an approved line; it leaves the pool; the assigned buyer is told", async () => {
    const pr = await approved([catalogLine(V.variant_id), freeLine()], { title: "pool-cancel" });
    const [lineId, otherId] = pr.line_ids;
    expect((await assign(buyC, pr.id, BUY3)).status).toBe(200);

    const caps = (await detail(pr.id)).body.data.capabilities;
    expect(sorted(caps.can_cancel_lines)).toEqual(sorted(pr.line_ids));
    expect((await detail(pr.id, buyC)).body.data.capabilities.can_cancel_lines).toEqual([]);

    expect((await cancelLine(reqC, pr.id, lineId, "")).status).toBe(422);
    const res = await cancelLine(reqC, pr.id, lineId, "Not needed any more");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ line_id: lineId, status: "cancelled", progress: "cancelled" });
    const row = await lineRow(lineId);
    expect(row).toMatchObject({ status: "cancelled", close_reason: "Not needed any more", closed_by: REQ });
    expect(lineOf(await detail(pr.id), lineId).progress).toBe("cancelled");
    expect((await detail(pr.id)).body.data.capabilities.can_cancel_lines).toEqual([otherId]);
    expect((await poolOf(buyC, pr)).map((r) => r.line_id)).toEqual([otherId]);
    expect(await lastEvent(pr.id)).toMatchObject({
      event_type: "line_cancelled", actor_id: REQ, pr_line_id: lineId, payload: { line_no: 1, reason: "Not needed any more" },
    });
    expect(await recipientsOf(pr.id, "pr_line_cancelled")).toEqual([BUY3]);
    expect((await eventsOf(pr.id)).map((e) => e.event_type)).not.toContain("catalog_rejected");
    // The PR itself stays approved.
    expect((await db.one(`SELECT status FROM tbl_purchase_requisition WHERE id = $1`, [pr.id])).status).toBe("approved");

    const again = await cancelLine(reqC, pr.id, lineId, "again");
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ reason: "not_active" });
  });

  it("cancel-line refusals: anyone but the requester → 404; a PR that is not approved → 409", async () => {
    const pr = await approved([catalogLine(V.variant_id)], { title: "pool-cancel-refusals" });
    const asBuyer = await cancelLine(buyC, pr.id, pr.line_ids[0], "mine now");
    expect(asBuyer.status).toBe(404);
    expect(asBuyer.body.code).toBe("PR_NOT_FOUND");

    const draft = await reqC.post("/api/v1/pr").send(await draftBody({ title: "pool-cancel-draft" }));
    prIds.push(draft.body.data.id);
    const draftLine = Number((await db.one(
      `SELECT id FROM tbl_purchase_requisition_line WHERE pr_id = $1 ORDER BY line_no LIMIT 1`, [draft.body.data.id])).id);
    const res = await cancelLine(reqC, draft.body.data.id, draftLine, "too early");
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ reason: "not_approved" });
    expect((await detail(draft.body.data.id)).body.data.capabilities.can_cancel_lines).toEqual([]);
  });
});

describe("PR pool — ending a line withdraws its open catalog request (R21)", () => {
  it("close: the open request is rejected 'Line closed — no longer needed' by the buyer, in the same change", async () => {
    const pr = await approved([freeLine({ free_text_name: "Close me gadget" })], { title: "pool-close-catreq" });
    const lineId = pr.line_ids[0];
    expect((await requestCatalog(buyC, pr.id, lineId, { requested_name: "Close me gadget" })).status).toBe(200);

    expect((await closeLine(buy3C, pr.id, lineId, "Bought locally")).status).toBe(200);
    const [req] = await catalogRequests(lineId);
    expect(req).toMatchObject({
      status: "rejected", resolution_note: "Line closed — no longer needed", resolved_by: BUY3, resolved_variant_id: null,
    });
    expect(req.resolved_at).not.toBeNull();
    const events = (await eventsOf(pr.id)).slice(-2);
    expect(events.map((e) => e.event_type)).toEqual(["line_closed", "catalog_rejected"]);
    expect(events[1]).toMatchObject({
      actor_id: BUY3, pr_line_id: lineId,
      payload: { request_id: req.id, reason: "line_closed", note: "Line closed — no longer needed" },
    });
    expect((await lineOf(await detail(pr.id), lineId)).progress).toBe("closed");
  });

  it("cancel: the open request is rejected 'Line cancelled — no longer needed' by the requester", async () => {
    const pr = await approved([freeLine({ free_text_name: "Cancel me gadget" })], { title: "pool-cancel-catreq" });
    const lineId = pr.line_ids[0];
    expect((await requestCatalog(buyC, pr.id, lineId, {})).status).toBe(200);

    expect((await cancelLine(reqC, pr.id, lineId, "Not needed")).status).toBe(200);
    const [req] = await catalogRequests(lineId);
    expect(req).toMatchObject({ status: "rejected", resolution_note: "Line cancelled — no longer needed", resolved_by: REQ });
    expect(req.resolved_at).not.toBeNull();
    expect(await lastEvent(pr.id)).toMatchObject({
      event_type: "catalog_rejected", actor_id: REQ, pr_line_id: lineId,
      payload: { request_id: req.id, reason: "line_cancelled", note: "Line cancelled — no longer needed" },
    });
  });

  it("a request that is no longer open (fulfilled by a mapping) is left as it is", async () => {
    const pr = await approved([freeLine({ free_text_name: "Mapped then closed" })], { title: "pool-close-fulfilled" });
    const lineId = pr.line_ids[0];
    expect((await requestCatalog(buyC, pr.id, lineId, {})).status).toBe(200);
    expect((await mapLine(buyC, pr.id, lineId, W.variant_id)).status).toBe(200);
    expect((await closeLine(buyC, pr.id, lineId, "Done")).status).toBe(200);
    expect((await catalogRequests(lineId)).map((r) => r.status)).toEqual(["fulfilled"]);
    expect((await eventsOf(pr.id)).map((e) => e.event_type)).not.toContain("catalog_rejected");
  });
});

describe("PR pool — a live RFQ link blocks line actions", () => {
  it("a sourced line cannot be cancelled, closed or re-mapped (409); once its RFQ is withdrawn it can", async () => {
    const pr = await approved([catalogLine(V.variant_id), freeLine()], { title: "pool-linked" });
    const [catalogId, freeId] = pr.line_ids;
    expect((await mapLine(buyC, pr.id, freeId, W.variant_id)).status).toBe(200);
    const rfqCatalog = await linkLine(catalogId, V.variant_id);
    await linkLine(freeId, W.variant_id);

    expect(await poolOf(buyC, pr)).toEqual([]); // in_sourcing: not in the pool
    const cancel = await cancelLine(reqC, pr.id, catalogId, "stop");
    expect(cancel.status).toBe(409);
    expect(cancel.body).toMatchObject({ code: "PR_STATE_CONFLICT", details: { line_id: catalogId, reason: "already_sourced" } });
    expect((await closeLine(buyC, pr.id, catalogId, "stop")).body.details).toMatchObject({ reason: "already_sourced" });
    const remap = await mapLine(buyC, pr.id, freeId, V.variant_id);
    expect(remap.status).toBe(409);
    expect(remap.body.details).toMatchObject({ reason: "already_sourced" });
    expect((await detail(pr.id)).body.data.capabilities.can_cancel_lines).toEqual([]);
    expect((await lineRow(catalogId)).status).toBe("active");
    expect((await lineRow(freeId)).mapped_variant_id).toBe(W.variant_id);

    // RFQ withdrawn without a PO → the link is dead → the line is back in the pool.
    await db.none(`UPDATE tbl_rfq SET status = 5 WHERE id = $1`, [rfqCatalog]);
    expect((await poolOf(buyC, pr)).map((r) => r.line_id)).toEqual([catalogId]);
    expect((await cancelLine(reqC, pr.id, catalogId, "stop")).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------
describe("PR pool — tenant isolation", () => {
  it("tenant: BUY acting on a company B PR → 404 everywhere; B lines never reach A's pool", async () => {
    const bPr = await approved([freeLine()], {
      requesterId: XCO, companyId: B, hotelId: B1, departmentId: ENG, title: "pool-tenant-b",
    });
    const lineId = bPr.line_ids[0];
    const attempts = [
      await assign(buyC, bPr.id, BUY),
      await mapLine(buyC, bPr.id, lineId, W.variant_id),
      await requestCatalog(buyC, bPr.id, lineId, { requested_name: "x" }),
      await closeLine(buyC, bPr.id, lineId, "x"),
      await cancelLine(buyC, bPr.id, lineId, "x"),
    ];
    for (const res of attempts) {
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 404, code: "PR_NOT_FOUND" });
    }
    expect(await poolOf(buyC, bPr)).toEqual([]);
    const line = await lineRow(lineId);
    expect(line).toMatchObject({ status: "active", mapped_variant_id: null });
    expect(await catalogRequests(lineId)).toEqual([]);
    expect((await db.one(`SELECT assigned_buyer_id FROM tbl_purchase_requisition WHERE id = $1`, [bPr.id]))
      .assigned_buyer_id).toBeNull();
  });
});
