// Purchase Requisitions — Task 10: the platform team's catalog-request queue
// (admin API, jwtAdm). A buyer who cannot map a free-text line files a catalog
// request (Task 8); the platform fulfils it with a variant (which maps the
// line) or rejects it.
//
// Product-level: real HTTP through the admin middleware chain against real
// Postgres; assertions read responses and committed rows. Pattern B.
//
// Personas
//   REQ   a1_eng_buyer   PR Requester at (A, A1, eng)
//   AP    crossCompany   PR Approver
//   BUY   a1_proc_buyer  PR Buyer at (A, A1)   — files the catalog requests
//   BUY2  dualRole       PR Buyer at (A, A2) only
//   BUY3  a1_proc_techApp PR Buyer at (A, A1)
//   ADM   superAdmin     platform staff (admin console token)

import { httpClient } from "../helpers/http.js";
import { loginAsInternalStaff, stampAdmin } from "../helpers/auth.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import {
  grantPr, revokeAllPr, firstUsableVariant, cleanupPrs, dropPrPolicies, unmapAll, approvedPr,
} from "../helpers/prFixtures.js";
import { makeRFQ } from "../factories/rfq.js";
import { buyerPrDetail } from "../../app/services/notificationLinks.js";

const A = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const ENG = IDS.departments.eng;
const REQ = IDS.users.a1_eng_buyer;
const AP = IDS.users.crossCompany;
const BUY = IDS.users.a1_proc_buyer;
const BUY2 = IDS.users.dualRole;
const BUY3 = IDS.users.a1_proc_techApp;
const ADM = IDS.users.superAdmin;
const PERSONAS = [REQ, AP, BUY, BUY2, BUY3];
const BASE = "/api/v1/admin/pr-catalog-requests";

const prIds = [];
const rfqIds = [];
let originalUserTypes = [];
let prevAdminType;
let reqC, buyC, buy3C, buy2C, adminHeaders, anon;
let V; // a usable variant
let W; // a second usable variant (fulfil target)
let K; // a usable variant put on contract in one test
let U; // a usable variant made unusable in one test
let CAT;

const freeLine = (extra = {}) => ({
  free_text_name: "Compressor relay 24V", category_id: CAT, quantity: "4", uom: "nos", estimated_unit_price: "250.50", ...extra,
});

async function approved(lines, opts = {}) {
  const pr = await approvedPr(lines, { requesterId: REQ, approverId: AP, ...opts });
  prIds.push(pr.id);
  return pr;
}

/** An approved PR with one free-text line and an open catalog request filed by `client`. */
async function withRequest(title, { client = buyC, name = `Item ${title}` } = {}) {
  const pr = await approved([freeLine({ free_text_name: name })], { title });
  const lineId = pr.line_ids[0];
  const res = await client.post(`/api/v1/pr/${pr.id}/lines/${lineId}/catalog-request`).send({ requested_name: name });
  expect(res.status).toBe(200);
  return { pr, lineId, requestId: res.body.data.id };
}

const admin = (method, path) => {
  let req = anon[method](path);
  for (const [k, v] of Object.entries(adminHeaders)) req = req.set(k, v);
  return req;
};
const list = (qs = "") => admin("get", `${BASE}${qs ? `?${qs}` : ""}`);
const fulfil = (id, body) => admin("post", `${BASE}/${id}/fulfil`).send(body);
const reject = (id, body) => admin("post", `${BASE}/${id}/reject`).send(body);

const requestRow = (id) => db.one(`SELECT * FROM tbl_pr_catalog_request WHERE id = $1`, [id]);
const lineRow = (id) => db.one(
  `SELECT status, mapped_variant_id, mapped_by, mapped_at FROM tbl_purchase_requisition_line WHERE id = $1`, [id]);
const eventsOf = (id) => db.any(
  `SELECT event_type, actor_id, pr_line_id, payload FROM tbl_pr_event WHERE pr_id = $1 ORDER BY id`, [id]);
const progressOf = async (client, pr, lineId) => {
  const res = await client.get(`/api/v1/pr/pool?q=${encodeURIComponent(pr.pr_number)}&page_size=200`);
  expect(res.status).toBe(200);
  return res.body.data.rows.find((r) => r.line_id === lineId);
};
const notificationsOf = (prId, type) => db.any(
  `SELECT recipient_user_id, type, title, message FROM tbl_notifications
    WHERE category = 'pr' AND additional_data->>'pr_id' = $1::text AND type = $2 ORDER BY id`, [String(prId), type]);

beforeAll(async () => {
  originalUserTypes = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS]);
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [PERSONAS]);
  prevAdminType = await stampAdmin(ADM, 1);
  await revokeAllPr(PERSONAS);
  await unmapAll(A);
  await dropPrPolicies();
  await grantPr(REQ, "PR Requester", { departmentId: ENG });
  await grantPr(AP, "PR Approver", { hotelId: null });
  await grantPr(BUY, "PR Buyer");
  await grantPr(BUY2, "PR Buyer", { hotelId: A2 });
  await grantPr(BUY3, "PR Buyer");

  V = await firstUsableVariant();
  const others = await db.map(
    `SELECT pv.id, pv.name
       FROM tbl_product_variant pv JOIN tbl_product p ON p.id = pv.product_id
      WHERE p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve = 1 AND pv.is_approve = 1
        AND pv.id <> $1
        AND EXISTS (SELECT 1 FROM tbl_product_categories pc WHERE pc.product_id = p.id)
      ORDER BY pv.id DESC LIMIT 3`, [V.variant_id], (r) => ({ variant_id: Number(r.id), variant_name: r.name }));
  [W, K, U] = others;
  CAT = Number((await db.one(
    `SELECT id FROM tbl_category WHERE status = 1 AND is_deleted = 0 AND id <> $1 ORDER BY id LIMIT 1`,
    [V.category_id])).id);

  reqC = await httpClient(REQ);
  buyC = await httpClient(BUY);
  buy2C = await httpClient(BUY2);
  buy3C = await httpClient(BUY3);
  anon = await httpClient(null);
  adminHeaders = (await loginAsInternalStaff(ADM)).headers;
});

afterAll(async () => {
  if (prIds.length) {
    await db.none(
      `DELETE FROM tbl_notifications
        WHERE (category = 'pr' AND additional_data->>'pr_id' = ANY($1::text[])) OR action_url = ANY($2::text[])`,
      [prIds.map(String), prIds.map((id) => buyerPrDetail(id))]);
  }
  await cleanupPrs(prIds);
  if (rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);
  }
  await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [ADM, prevAdminType]);
  await dropPrPolicies();
  await revokeAllPr(PERSONAS);
  for (const u of originalUserTypes) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
  }
});

describe("admin catalog requests — list", () => {
  it("list.filters: status / q / page, with company, hotel, PR, line, requester, line status and resolved variant", async () => {
    const a = await withRequest("catreq-list-a", { name: "Zeta gizmo list" });
    const b = await withRequest("catreq-list-b", { name: "Zeta gizmo list B" });
    expect((await fulfil(b.requestId, { variant_id: W.variant_id })).status).toBe(200);

    const open = await list(`status=open&q=${encodeURIComponent(a.pr.pr_number)}`);
    expect(open.status).toBe(200);
    expect(open.body.data.total).toBe(1);
    const row = open.body.data.rows[0];
    expect(row).toMatchObject({
      id: a.requestId, requested_name: "Zeta gizmo list", status: "open",
      pr_id: a.pr.id, pr_number: a.pr.pr_number, line_no: 1, requested_by_name: expect.any(String),
      company_name: expect.any(String), hotel_name: expect.any(String), line_status: "active",
      resolved_variant_id: null, resolved_variant_name: null, resolution_note: null,
    });
    expect(row).toHaveProperty("category_title");
    expect(row).toHaveProperty("description");
    expect(row.requested_at).toBeTruthy();

    const done = await list(`status=fulfilled&q=${encodeURIComponent(b.pr.pr_number)}`);
    expect(done.body.data.rows).toHaveLength(1);
    expect(done.body.data.rows[0]).toMatchObject({
      id: b.requestId, status: "fulfilled", resolved_variant_id: W.variant_id, resolved_variant_name: W.variant_name,
    });
    expect((await list(`status=rejected&q=${encodeURIComponent(b.pr.pr_number)}`)).body.data.total).toBe(0);
    // q also matches the requested name: both of this test's requests, open and fulfilled
    const byName = (await list("q=Zeta%20gizmo%20list")).body.data.rows
      .filter((r) => [a.pr.pr_number, b.pr.pr_number].includes(r.pr_number));
    expect(byName.map((r) => [r.id, r.requested_name, r.status]).sort((x, y) => x[0] - y[0])).toEqual([
      [a.requestId, "Zeta gizmo list", "open"],
      [b.requestId, "Zeta gizmo list B", "fulfilled"],
    ].sort((x, y) => x[0] - y[0]));
    // page 2 of a 1-row filter is empty but total is stable
    const p2 = await list(`status=open&q=${encodeURIComponent(a.pr.pr_number)}&page=2`);
    expect(p2.body.data.rows).toEqual([]);
    expect(p2.body.data.total).toBe(1);
    // bad filters
    expect((await list("status=bogus")).status).toBe(422);
  });

  it("list shows the line's status so the platform sees closed lines (R21 auto-rejects them)", async () => {
    const a = await withRequest("catreq-list-closed");
    const closed = await buyC.post(`/api/v1/pr/${a.pr.id}/lines/${a.lineId}/close`).send({ reason: "bought locally" });
    expect(closed.status).toBe(200);
    const res = await list(`status=rejected&q=${encodeURIComponent(a.pr.pr_number)}`);
    expect(res.body.data.rows[0]).toMatchObject({ id: a.requestId, status: "rejected", line_status: "closed" });
    const again = await fulfil(a.requestId, { variant_id: W.variant_id });
    expect(again.status).toBe(409);
  });
});

describe("admin catalog requests — fulfil", () => {
  it("fulfil.maps-line: request fulfilled, line mapped by the platform, pool shows in_pool with the variant", async () => {
    const { pr, lineId, requestId } = await withRequest("catreq-fulfil");
    expect((await progressOf(buyC, pr, lineId)).progress).toBe("awaiting_catalog");

    const res = await fulfil(requestId, { variant_id: W.variant_id, note: "Added as a new item" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 1, data: { id: requestId, status: "fulfilled", line_mapped: true } });

    expect(await requestRow(requestId)).toMatchObject({
      status: "fulfilled", resolved_by: ADM, resolved_variant_id: W.variant_id, resolution_note: "Added as a new item",
    });
    const line = await lineRow(lineId);
    expect(line).toMatchObject({ mapped_variant_id: W.variant_id, mapped_by: null });
    expect(line.mapped_at).not.toBeNull();
    expect(await progressOf(buyC, pr, lineId)).toMatchObject({ progress: "in_pool", effective_variant_id: W.variant_id });

    const events = (await eventsOf(pr.id)).slice(-2);
    expect(events.map((e) => e.event_type)).toEqual(["line_mapped", "catalog_fulfilled"]);
    expect(events[1]).toMatchObject({
      pr_line_id: lineId,
      payload: { request_id: requestId, variant_id: W.variant_id, line_mapped: true, admin_id: ADM },
    });

    // a second fulfil is a conflict and changes nothing
    const second = await fulfil(requestId, { variant_id: V.variant_id });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ status: 0, code: "PR_STATE_CONFLICT" });
    expect((await lineRow(lineId)).mapped_variant_id).toBe(W.variant_id);
    const rej = await reject(requestId, { note: "too late" });
    expect(rej.status).toBe(409);
  });

  it("fulfil.unusable: an unusable variant → 422 PR_VARIANT_NOT_USABLE and the request stays open; missing/unknown → 422", async () => {
    const { pr, lineId, requestId } = await withRequest("catreq-unusable");
    await db.none(`UPDATE tbl_product_variant SET is_approve = 0 WHERE id = $1`, [U.variant_id]);
    try {
      const res = await fulfil(requestId, { variant_id: U.variant_id });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ status: 0, code: "PR_VARIANT_NOT_USABLE" });
    } finally {
      await db.none(`UPDATE tbl_product_variant SET is_approve = 1 WHERE id = $1`, [U.variant_id]);
    }
    for (const body of [{}, { variant_id: "abc" }, { variant_id: 2147483646 }]) {
      const r = await fulfil(requestId, body);
      expect(r.status).toBe(422);
      expect(r.body.code).toBe("PR_VALIDATION");
    }
    const long = await fulfil(requestId, { variant_id: W.variant_id, note: "x".repeat(2001) });
    expect(long.status).toBe(422);
    expect((await requestRow(requestId)).status).toBe("open");
    expect((await lineRow(lineId)).mapped_variant_id).toBeNull();
    expect((await eventsOf(pr.id)).some((e) => e.event_type === "catalog_fulfilled")).toBe(false);
    expect((await fulfil(987654321, { variant_id: W.variant_id })).status).toBe(404);
    expect((await fulfil("abc", { variant_id: W.variant_id })).status).toBe(404);
  });

  it("fulfil.already-mapped-by-buyer: request fulfilled, the buyer's mapping is untouched, event says why", async () => {
    const { pr, lineId, requestId } = await withRequest("catreq-already");
    // Simulate a mapping that landed without resolving the request (legacy / race).
    await db.none(`UPDATE tbl_purchase_requisition_line SET mapped_variant_id = $2, mapped_by = $3, mapped_at = NOW() WHERE id = $1`,
      [lineId, V.variant_id, BUY]);
    const res = await fulfil(requestId, { variant_id: W.variant_id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "fulfilled", line_mapped: false, reason: "already_mapped" });
    expect(await requestRow(requestId)).toMatchObject({ status: "fulfilled", resolved_variant_id: W.variant_id });
    expect(await lineRow(lineId)).toMatchObject({ mapped_variant_id: V.variant_id, mapped_by: BUY });
    const events = await eventsOf(pr.id);
    expect(events.at(-1)).toMatchObject({
      event_type: "catalog_fulfilled", payload: { line_mapped: false, reason: "already_mapped", variant_id: W.variant_id },
    });
    expect(events.some((e) => e.event_type === "line_mapped")).toBe(false);
  });

  it("fulfil.pr-not-approved: the PR is no longer approved → request fulfilled, line left unmapped, reason pr_not_approved", async () => {
    const { pr, lineId, requestId } = await withRequest("catreq-not-approved");
    // The PR left 'approved' out of band (a data fix); the buyer paths refuse its lines (lineBlocker).
    await db.none(`UPDATE tbl_purchase_requisition SET status = 'cancelled' WHERE id = $1`, [pr.id]);
    const res = await fulfil(requestId, { variant_id: W.variant_id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "fulfilled", line_mapped: false, reason: "pr_not_approved" });
    expect(await requestRow(requestId)).toMatchObject({ status: "fulfilled", resolved_variant_id: W.variant_id });
    expect((await lineRow(lineId)).mapped_variant_id).toBeNull();
    const events = await eventsOf(pr.id);
    expect(events.at(-1)).toMatchObject({
      event_type: "catalog_fulfilled", payload: { line_mapped: false, reason: "pr_not_approved", variant_id: W.variant_id },
    });
    expect(events.some((e) => e.event_type === "line_mapped")).toBe(false);
  });

  it("fulfil leaves the line unmapped when the variant is on contract for the PR cell, or the line already has a live RFQ link", async () => {
    const onContract = await withRequest("catreq-contract");
    // A live rate contract for K at (A, A1, eng) — the cell of the PR.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-TEST-PR-CATREQ', 'PR catreq contract', $1, $2, $3, $4, $5, 'contract_active',
               NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days',
               NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $6) RETURNING id`,
      [V.category_id, A, A1, ENG, IDS.processes.A_P1, REQ]);
    const arcId = Number(arc.id);
    const itemId = Number((await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 1000, 'nos') RETURNING id`,
      [arcId, K.variant_id])).id);
    const contractId = Number((await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`,
      [arcId, IDS.users.vendor_alpha])).id);
    await db.none(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1, $2, 90, 5, 1000)`, [contractId, itemId]);
    try {
      const res = await fulfil(onContract.requestId, { variant_id: K.variant_id });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: "fulfilled", line_mapped: false, reason: "on_contract" });
      expect((await lineRow(onContract.lineId)).mapped_variant_id).toBeNull();
      expect((await eventsOf(onContract.pr.id)).at(-1).payload).toMatchObject({ line_mapped: false, reason: "on_contract" });
    } finally {
      await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractId]);
      await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contractId]);
      await db.none(`DELETE FROM tbl_arc_item WHERE id = $1`, [itemId]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    }

    const live = await withRequest("catreq-livelink");
    const rfq = await makeRFQ(db, { createdBy: BUY, status: 1, is_published: 1, hospitality: A, hotel: A1 });
    rfqIds.push(rfq.rfq_id);
    const rp = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
       VALUES ($1, '', '0', '', '', $2, 1) RETURNING id`, [rfq.rfq_id, V.variant_id]);
    await db.none(
      `INSERT INTO tbl_pr_line_rfq (pr_line_id, rfq_id, rfq_product_id, quantity, converted_by) VALUES ($1, $2, $3, 1, $4)`,
      [live.lineId, rfq.rfq_id, rp.id, BUY]);
    const res = await fulfil(live.requestId, { variant_id: W.variant_id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "fulfilled", line_mapped: false, reason: "live_link" });
    expect((await lineRow(live.lineId)).mapped_variant_id).toBeNull();
    expect((await eventsOf(live.pr.id)).at(-1).payload).toMatchObject({ line_mapped: false, reason: "live_link" });
  });

  it("fulfil notifies the requester, the filer and the assigned buyer (never the admin, once each); unassigned → every hotel buyer", async () => {
    const assigned = await withRequest("catreq-notify-assigned", { client: buy3C });
    expect((await buyC.post(`/api/v1/pr/${assigned.pr.id}/assign`).send({ buyer_id: BUY })).status).toBe(200);
    expect((await fulfil(assigned.requestId, { variant_id: W.variant_id })).status).toBe(200);
    const got = (await notificationsOf(assigned.pr.id, "pr_catalog_fulfilled")).map((n) => Number(n.recipient_user_id));
    expect([...got].sort((x, y) => x - y)).toEqual([REQ, BUY, BUY3].sort((x, y) => x - y));
    expect(got).not.toContain(ADM);
    expect(got).not.toContain(BUY2);

    const open = await withRequest("catreq-notify-unassigned");
    expect((await fulfil(open.requestId, { variant_id: W.variant_id })).status).toBe(200);
    const all = (await notificationsOf(open.pr.id, "pr_catalog_fulfilled")).map((n) => Number(n.recipient_user_id));
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort((x, y) => x - y)).toEqual([REQ, BUY, BUY3].sort((x, y) => x - y));
  });

  it("two admins fulfilling at once: exactly one wins, the other gets 409", async () => {
    const { requestId } = await withRequest("catreq-race");
    const results = await Promise.all([
      fulfil(requestId, { variant_id: W.variant_id }),
      fulfil(requestId, { variant_id: V.variant_id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe("admin catalog requests — reject", () => {
  it("reject.note-required then reject: line returns to needs_mapping; requester + buyers notified", async () => {
    const { pr, lineId, requestId } = await withRequest("catreq-reject");
    for (const note of [undefined, "", "   ", "x".repeat(2001)]) {
      const res = await reject(requestId, { note });
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 422, code: "PR_VALIDATION" });
    }
    expect((await requestRow(requestId)).status).toBe("open");

    const res = await reject(requestId, { note: "Use the existing HVAC relay item" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 1, data: { id: requestId, status: "rejected" } });
    expect(await requestRow(requestId)).toMatchObject({
      status: "rejected", resolved_by: ADM, resolution_note: "Use the existing HVAC relay item", resolved_variant_id: null,
    });
    expect((await lineRow(lineId)).mapped_variant_id).toBeNull();
    expect((await progressOf(buyC, pr, lineId)).progress).toBe("needs_mapping");
    expect((await eventsOf(pr.id)).at(-1)).toMatchObject({
      event_type: "catalog_rejected", pr_line_id: lineId,
      payload: { request_id: requestId, note: "Use the existing HVAC relay item", admin_id: ADM },
    });
    const got = (await notificationsOf(pr.id, "pr_catalog_rejected")).map((n) => Number(n.recipient_user_id));
    expect([...got].sort((x, y) => x - y)).toEqual([REQ, BUY, BUY3].sort((x, y) => x - y));

    expect((await reject(requestId, { note: "again" })).status).toBe(409);
    expect((await reject(987654321, { note: "x" })).status).toBe(404);
    // the buyer can file a fresh request after a rejection
    const again = await buyC.post(`/api/v1/pr/${pr.id}/lines/${lineId}/catalog-request`).send({ requested_name: "retry" });
    expect(again.status).toBe(200);
  });
});

describe("admin catalog requests — authz", () => {
  it("authz: no token, a buyer/requester user JWT (no admin claim) are all refused with 401/403 and change nothing", async () => {
    const { requestId } = await withRequest("catreq-authz");
    const before = await requestRow(requestId);
    for (const client of [anon, buyC, reqC, buy2C]) {
      const calls = [
        client.get(BASE),
        client.post(`${BASE}/${requestId}/fulfil`).send({ variant_id: W.variant_id }),
        client.post(`${BASE}/${requestId}/reject`).send({ note: "no" }),
      ];
      for (const call of calls) {
        const res = await call;
        expect([401, 403]).toContain(res.status);
      }
    }
    expect(await requestRow(requestId)).toEqual(before);
  });
});
