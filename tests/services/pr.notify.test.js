// Purchase Requisitions — Task 11: who hears about what (spec §11) and the
// conversation thread (spec §8).
//
// Product-level: every row of the §11 matrix is performed through real HTTP
// against real Postgres, then the EXACT recipient set is read back from what
// notificationService.dispatch wrote (tbl_notifications, category 'pr') and
// from the mail handed to the SMTP transport. Pattern B (commit + cleanup by
// tracked ids).
//
// Personas
//   REQ     a1_eng_buyer      PR Requester at (A, A1, eng)
//   AP1     a1_proc_commApp   PR Approver at (A, A1, eng) AND PR Buyer at (A, A1) — the actor-exclusion probe
//   RV_ENG  a1_proc_techEval  PR Technical Reviewer at (A, A1, eng)
//   RV_PROC a1_proc_techApp   PR Technical Reviewer at (A, A1, proc)
//   BUY     a1_proc_buyer     PR Buyer at (A, A1)
//   BUY3    a1_proc_poApp     PR Buyer at (A, A1) + RFQ creator in proc (can convert)
//   OUT     a1_proc_finance   no PR role at all
//   ADM     superAdmin        platform staff (admin console token)
//
// Hotel buyers of A1 = BUY, BUY3, AP1.

import nodemailer from "nodemailer";
import { httpClient } from "../helpers/http.js";
import { loginAsInternalStaff, stampAdmin } from "../helpers/auth.js";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import {
  grantPr, revokeAllPr, firstUsableVariant, cleanupPrs, makePrPolicy, dropPrPolicies, mapCategory, unmapAll, istDate,
  submittedPr, approvedPr, cleanupRfqDrafts, rfqsOfLines,
} from "../helpers/prFixtures.js";
import { buyerPrDetail } from "../../app/services/notificationLinks.js";

const A = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const ENG = IDS.departments.eng;
const PROC = IDS.departments.proc;
const REQ = IDS.users.a1_eng_buyer;
const AP1 = IDS.users.a1_proc_commApp;
const RV_ENG = IDS.users.a1_proc_techEval;
const RV_PROC = IDS.users.a1_proc_techApp;
const BUY = IDS.users.a1_proc_buyer;
const BUY3 = IDS.users.a1_proc_poApp;
const OUT = IDS.users.a1_proc_finance;
const ADM = IDS.users.superAdmin;
const PERSONAS = [REQ, AP1, RV_ENG, RV_PROC, BUY, BUY3, OUT];
const HOTEL_BUYERS = [BUY, BUY3, AP1];
const ACTION = "/api/v1/general/hospitality/approval/action";
const ADMIN_BASE = "/api/v1/admin/pr-catalog-requests";

const prIds = [];
const rfqIds = [];
const scopeIds = [];
let originalUsers = [];
let originalHotel;
let prevAdminType;
let reqC, ap1C, engC, procC, buyC, buy3C, outC, anon, adminHeaders;
let V; // catalog variant (category CE → Engineering when routing is on)
let CE, CK, CX; // CE: V's category; CK: free-text category mapped to Procurement; CX: never mapped
let emailOf = new Map();
let idOfEmail = new Map();

// Every mail the app hands to nodemailer (jestEnv stubs the transport; this wraps the stub to record).
const mails = [];
let realCreateTransport;

// ---------------------------------------------------------------------------
// Helpers (setup + reads only)
// ---------------------------------------------------------------------------
const sorted = (ids) => [...new Set(ids.map(Number))].sort((a, b) => a - b);
const ids = (...list) => sorted(list);

const catalogLine = (extra = {}) => ({
  product_variant_id: V.variant_id, quantity: "2", uom: "nos", estimated_unit_price: "1500.00", specification: "OEM", ...extra,
});
const freeLine = (categoryId, extra = {}) => ({
  free_text_name: "Compressor relay 24V", category_id: categoryId, quantity: "4", uom: "nos", estimated_unit_price: "250.50", ...extra,
});

const admin = (method, path) => {
  let r = anon[method](path);
  for (const [k, v] of Object.entries(adminHeaders)) r = r.set(k, v);
  return r;
};

/** Review routing on: CE → Engineering, CK → Procurement. Off: nothing maps (every submit goes to approval). */
async function routing(on) {
  await unmapAll(A);
  if (on) {
    await mapCategory(A, CE, ENG);
    await mapCategory(A, CK, PROC);
  }
}

/** A draft via the API (tracked for cleanup). */
async function draft(lines, header = {}) {
  const res = await reqC.post("/api/v1/pr").send({
    hotel_id: A1, department_id: ENG, title: "Notify matrix", pr_type: "goods", urgency: "normal",
    required_by_date: await istDate(14), justification: "Matrix", lines, ...header,
  });
  expect(res.status).toBe(200);
  prIds.push(res.body.data.id);
  const lineIds = await db.map(
    `SELECT id FROM tbl_purchase_requisition_line WHERE pr_id = $1 ORDER BY line_no`, [res.body.data.id], (r) => Number(r.id));
  return { id: res.body.data.id, pr_number: res.body.data.pr_number, line_ids: lineIds };
}

/** A PR in technical review (eng review on the catalog line, proc review on the free-text line). */
async function inReview() {
  await routing(true);
  await makePrPolicy({ steps: [{ source: "USER", id: AP1 }] });
  const pr = await draft([catalogLine(), freeLine(CK)]);
  const res = await reqC.post(`/api/v1/pr/${pr.id}/submit`).send({});
  expect(res.status).toBe(200);
  expect(res.body.data.pr.status).toBe("in_review");
  const reviews = await db.any(`SELECT id, department_id FROM tbl_pr_review WHERE pr_id = $1`, [pr.id]);
  return { ...pr, eng: reviews.find((r) => r.department_id === ENG).id, proc: reviews.find((r) => r.department_id === PROC).id };
}

/** A PR waiting for AP1 (pending_approval), no review. */
async function pendingApproval() {
  await routing(false);
  const pr = await submittedPr([freeLine(CX)], { requesterId: REQ, approverId: AP1 });
  prIds.push(pr.id);
  return pr;
}

/** An approved PR (AP1 approved), no review. */
async function approved(lines = [freeLine(CX)]) {
  await routing(false);
  const pr = await approvedPr(lines, { requesterId: REQ, approverId: AP1 });
  prIds.push(pr.id);
  return pr;
}

const assignTo = (client, prId, buyerId) => client.post(`/api/v1/pr/${prId}/assign`).send({ buyer_id: buyerId });
const comment = (client, prId, body) => client.post(`/api/v1/pr/${prId}/comments`).send({ body });
const maxNotificationId = async () => Number((await db.one(`SELECT COALESCE(MAX(id), 0) AS m FROM tbl_notifications`)).m);

/**
 * Run `act`, then report what it caused for `prId`: the in-app recipients per
 * notification type, the mail recipients (user ids; raw addresses for non-users)
 * and any (type, recipient) pair written twice.
 */
async function observe(prId, act) {
  const mark = await maxNotificationId();
  const mailMark = mails.length;
  const res = await act();
  await new Promise((r) => setTimeout(r, 400)); // mail is fire-and-forget
  const rows = await db.any(
    `SELECT recipient_user_id, type, action_url FROM tbl_notifications
      WHERE id > $1 AND category = 'pr' AND additional_data->>'pr_id' = $2::text ORDER BY id`, [mark, String(prId)]);
  const inApp = {};
  const seen = new Set();
  const dupes = [];
  for (const r of rows) {
    (inApp[r.type] ||= []).push(Number(r.recipient_user_id));
    const k = `${r.type}:${r.recipient_user_id}`;
    if (seen.has(k)) dupes.push(k);
    seen.add(k);
    expect(r.action_url).toBe(buyerPrDetail(prId));
  }
  for (const t of Object.keys(inApp)) inApp[t] = sorted(inApp[t]);
  const sent = mails.slice(mailMark);
  const mailTo = sorted(sent.map((m) => idOfEmail.get(String(m.to).toLowerCase())).filter(Boolean));
  const mailOther = sent.map((m) => String(m.to)).filter((a) => !idOfEmail.has(a.toLowerCase())).sort();
  return { res, inApp, mailTo, mailOther, dupes };
}

const withRequest = async (pr, lineIdx = 0, name = "Matrix widget") => {
  const res = await buyC.post(`/api/v1/pr/${pr.id}/lines/${pr.line_ids[lineIdx]}/catalog-request`).send({ requested_name: name });
  expect(res.status).toBe(200);
  return res.body.data.id;
};

beforeAll(async () => {
  originalUsers = await db.any(`SELECT id, user_type, mobile FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS]);
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [PERSONAS]);
  await db.none(`UPDATE tbl_users SET mobile = '+91-9876543210' WHERE id = $1`, [BUY3]);
  originalHotel = await db.one(`SELECT delivery_address FROM tbl_hospitality_company_hotels WHERE id = $1`, [A1]);
  await db.none(`UPDATE tbl_hospitality_company_hotels SET delivery_address = 'Plot 7, Service Road, Mumbai' WHERE id = $1`, [A1]);
  prevAdminType = await stampAdmin(ADM, 1);
  await revokeAllPr(PERSONAS);
  await unmapAll(A);
  await dropPrPolicies();
  await grantPr(REQ, "PR Requester", { departmentId: ENG });
  await grantPr(AP1, "PR Approver", { departmentId: ENG });
  await grantPr(AP1, "PR Buyer");
  await grantPr(RV_ENG, "PR Technical Reviewer", { departmentId: ENG });
  await grantPr(RV_PROC, "PR Technical Reviewer", { departmentId: PROC });
  await grantPr(BUY, "PR Buyer");
  await grantPr(BUY3, "PR Buyer");
  scopeIds.push(await grantRoleScope(db, {
    userId: BUY3, roleId: ROLE_IDS.TENDER_CREATOR, companyId: A, hotelId: A1, departmentId: PROC,
  }));

  V = await firstUsableVariant();
  CE = V.category_id;
  [CK, CX] = await db.map(
    `SELECT id FROM tbl_category WHERE status = 1 AND is_deleted = 0 AND id <> $1 ORDER BY id LIMIT 2`, [CE], (r) => Number(r.id));

  for (const u of await db.any(`SELECT id, email FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS])) {
    emailOf.set(Number(u.id), u.email);
    idOfEmail.set(String(u.email).toLowerCase(), Number(u.id));
  }
  expect(idOfEmail.size).toBe(PERSONAS.length); // distinct addresses, or mail recipients are ambiguous

  reqC = await httpClient(REQ);
  ap1C = await httpClient(AP1);
  engC = await httpClient(RV_ENG);
  procC = await httpClient(RV_PROC);
  buyC = await httpClient(BUY);
  buy3C = await httpClient(BUY3);
  outC = await httpClient(OUT);
  anon = await httpClient(null);
  adminHeaders = (await loginAsInternalStaff(ADM)).headers;

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

afterEach(async () => {
  delete process.env.PR_CATALOG_REQUEST_EMAIL;
  await dropPrPolicies();
});

afterAll(async () => {
  nodemailer.createTransport = realCreateTransport;
  const lineIds = prIds.length
    ? await db.map(`SELECT id FROM tbl_purchase_requisition_line WHERE pr_id = ANY($1::int[])`, [prIds], (r) => Number(r.id))
    : [];
  const allRfqs = [...new Set([...rfqIds, ...(await rfqsOfLines(lineIds))])];
  if (prIds.length) {
    await db.none(
      `DELETE FROM tbl_notifications
        WHERE (category = 'pr' AND additional_data->>'pr_id' = ANY($1::text[])) OR action_url = ANY($2::text[])`,
      [prIds.map(String), prIds.map((id) => buyerPrDetail(id))]);
  }
  await cleanupRfqDrafts(allRfqs);
  await cleanupPrs(prIds);
  await dropPrPolicies();
  await unmapAll(A);
  await revokeAllPr(PERSONAS);
  await revokeRoleScopes(db, scopeIds);
  await db.none(`UPDATE tbl_hospitality_company_hotels SET delivery_address = $2 WHERE id = $1`, [A1, originalHotel.delivery_address]);
  await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [ADM, prevAdminType]);
  for (const u of originalUsers) {
    await db.none(`UPDATE tbl_users SET user_type = $2, mobile = $3 WHERE id = $1`, [u.id, u.user_type, u.mobile]);
  }
  // Release this file's test-side pool: an idle client left open is killed by
  // globalTeardown's DROP DATABASE … WITH (FORCE) and logs 57P01 after Jest ends.
  await closeDb();
});

// ---------------------------------------------------------------------------
// The §11 matrix, one row per case
// ---------------------------------------------------------------------------
describe("PR notification matrix (spec §11)", () => {
  it("submitted → review tasks: each group's reviewers, in-app + email; never the requester", async () => {
    await routing(true);
    await makePrPolicy({ steps: [{ source: "USER", id: AP1 }] });
    const pr = await draft([catalogLine(), freeLine(CK)]);
    const o = await observe(pr.id, () => reqC.post(`/api/v1/pr/${pr.id}/submit`).send({}));
    expect(o.res.status).toBe(200);
    expect(o.inApp).toEqual({ pr_review_task: ids(RV_ENG, RV_PROC) });
    expect(o.mailTo).toEqual(ids(RV_ENG, RV_PROC));
    expect(o.dupes).toEqual([]);
  });

  it("review sent back → the requester only, in-app + email", async () => {
    const pr = await inReview();
    const o = await observe(pr.id, () =>
      engC.post(`/api/v1/pr/${pr.id}/reviews/${pr.eng}/send-back`).send({ note: "Wrong model" }));
    expect(o.res.status).toBe(200);
    expect(o.inApp).toEqual({ pr_returned: ids(REQ) });
    expect(o.mailTo).toEqual(ids(REQ));
  });

  it("approval sent back → the requester only, in-app + email", async () => {
    const pr = await pendingApproval();
    const o = await observe(pr.id, () => ap1C.post(`/api/v1/pr/${pr.id}/send-back`).send({ note: "Need a second quote" }));
    expect(o.res.status).toBe(200);
    expect(o.inApp).toEqual({ pr_returned: ids(REQ) });
    expect(o.mailTo).toEqual(ids(REQ));
  });

  it("approved → the requester and the hotel's buyers (minus the approver who is also a buyer), in-app + email", async () => {
    const pr = await pendingApproval();
    const instance = Number((await db.one(`SELECT approval_instance_id AS i FROM tbl_purchase_requisition WHERE id = $1`, [pr.id])).i);
    const o = await observe(pr.id, () =>
      ap1C.post(ACTION).send({ approval_instance_id: instance, action: "APPROVE", comment: "ok" }));
    expect(o.res.status).toBe(200);
    expect(o.inApp).toEqual({ pr_approved: ids(REQ, BUY, BUY3) });
    expect(o.mailTo).toEqual(ids(REQ, BUY, BUY3));
    expect(o.dupes).toEqual([]);
  });

  it("rejected → the requester, in-app only (no email)", async () => {
    const pr = await pendingApproval();
    const instance = Number((await db.one(`SELECT approval_instance_id AS i FROM tbl_purchase_requisition WHERE id = $1`, [pr.id])).i);
    const o = await observe(pr.id, () =>
      ap1C.post(ACTION).send({ approval_instance_id: instance, action: "REJECT", comment: "no budget" }));
    expect(o.res.status).toBe(200);
    expect(o.inApp).toEqual({ pr_rejected: ids(REQ) });
    expect(o.mailTo).toEqual([]);
  });

  it("assigned → the assigned buyer (in-app + email) and the requester ('handled by', in-app)", async () => {
    const pr = await approved();
    const o = await observe(pr.id, () => assignTo(buyC, pr.id, BUY3));
    expect(o.res.status).toBe(200);
    expect(o.inApp).toEqual({ pr_assigned: ids(REQ, BUY3) });
    expect(o.mailTo).toEqual(ids(BUY3));
  });

  it("assigned to oneself → only the requester hears (the actor is never notified, no email)", async () => {
    const pr = await approved();
    const o = await observe(pr.id, () => assignTo(buyC, pr.id, BUY));
    expect(o.res.status).toBe(200);
    expect(o.inApp).toEqual({ pr_assigned: ids(REQ) });
    expect(o.mailTo).toEqual([]);
  });

  it("converted → the requester, in-app", async () => {
    const pr = await approved([catalogLine()]);
    const o = await observe(pr.id, async () => {
      const res = await buy3C.post("/api/v1/pr/convert").send({ line_ids: pr.line_ids, department_id: PROC });
      if (res.status === 200 && res.body?.data?.rfq_id) rfqIds.push(Number(res.body.data.rfq_id));
      return res;
    });
    expect(o.res.status).toBe(200);
    expect(o.inApp).toEqual({ pr_converted: ids(REQ) });
    expect(o.mailTo).toEqual([]);
  });

  it("line closed by a buyer → the requester, in-app", async () => {
    const pr = await approved();
    const o = await observe(pr.id, () =>
      buyC.post(`/api/v1/pr/${pr.id}/lines/${pr.line_ids[0]}/close`).send({ reason: "Not stocked anywhere" }));
    expect(o.res.status).toBe(200);
    expect(o.inApp).toEqual({ pr_line_closed: ids(REQ) });
    expect(o.mailTo).toEqual([]);
  });

  it("line cancelled by the requester → the assigned buyer only; nobody while unassigned", async () => {
    const pr = await approved([freeLine(CX), freeLine(CX, { free_text_name: "Second part" })]);
    const first = await observe(pr.id, () =>
      reqC.post(`/api/v1/pr/${pr.id}/lines/${pr.line_ids[0]}/cancel`).send({ reason: "No longer needed" }));
    expect(first.res.status).toBe(200);
    expect(first.inApp).toEqual({}); // unassigned: no buyer to tell, and the pool is not paged

    expect((await assignTo(buyC, pr.id, BUY3)).status).toBe(200);
    const second = await observe(pr.id, () =>
      reqC.post(`/api/v1/pr/${pr.id}/lines/${pr.line_ids[1]}/cancel`).send({ reason: "Bought elsewhere" }));
    expect(second.res.status).toBe(200);
    expect(second.inApp).toEqual({ pr_line_cancelled: ids(BUY3) });
    expect(second.mailTo).toEqual([]);
  });

  it("line cancelled: an assigned buyer who has since lost pr.convert (cannot read the PR) is not told (B-M2)", async () => {
    const pr = await approved();
    expect((await assignTo(buyC, pr.id, BUY3)).status).toBe(200);
    await revokeAllPr([BUY3]);
    try {
      expect((await buy3C.get(`/api/v1/pr/${pr.id}`)).status).toBe(404); // really cannot read it any more
      const o = await observe(pr.id, () =>
        reqC.post(`/api/v1/pr/${pr.id}/lines/${pr.line_ids[0]}/cancel`).send({ reason: "No longer needed" }));
      expect(o.res.status).toBe(200);
      expect(o.inApp).toEqual({});
    } finally {
      await grantPr(BUY3, "PR Buyer");
    }
  });

  it("catalog request resolved: the buyer who filed it but has since lost pr.convert is not told; the rest are (B-M2)", async () => {
    const pr = await approved();
    expect((await assignTo(ap1C, pr.id, BUY3)).status).toBe(200);
    const requestId = await withRequest(pr); // filed by BUY
    await revokeAllPr([BUY]);
    try {
      expect((await buyC.get(`/api/v1/pr/${pr.id}`)).status).toBe(404);
      const o = await observe(pr.id, () => admin("post", `${ADMIN_BASE}/${requestId}/reject`).send({ note: "Not sold anymore" }));
      expect(o.res.status).toBe(200);
      expect(o.inApp).toEqual({ pr_catalog_rejected: ids(REQ, BUY3) });
    } finally {
      await grantPr(BUY, "PR Buyer");
    }
  });

  it("catalog request created → the platform's address list by email; nobody in-app", async () => {
    process.env.PR_CATALOG_REQUEST_EMAIL = "platform-a@example.test, platform-b@example.test";
    const pr = await approved();
    const o = await observe(pr.id, () =>
      buyC.post(`/api/v1/pr/${pr.id}/lines/${pr.line_ids[0]}/catalog-request`).send({ requested_name: "Matrix widget" }));
    expect(o.res.status).toBe(200);
    expect(o.inApp).toEqual({});
    expect(o.mailTo).toEqual([]);
    expect(o.mailOther).toEqual(["platform-a@example.test", "platform-b@example.test"]);
  });

  it("catalog request fulfilled → requester, the buyer who filed it and the assigned buyer; in-app", async () => {
    const pr = await approved();
    expect((await assignTo(ap1C, pr.id, BUY3)).status).toBe(200);
    const requestId = await withRequest(pr);
    const other = (await db.one(`SELECT id FROM tbl_product_variant WHERE id <> $1 AND is_approve = 1 ORDER BY id DESC LIMIT 1`, [V.variant_id])).id;
    const o = await observe(pr.id, () => admin("post", `${ADMIN_BASE}/${requestId}/fulfil`).send({ variant_id: Number(other) }));
    expect(o.res.status).toBe(200);
    expect(o.inApp).toEqual({ pr_catalog_fulfilled: ids(REQ, BUY, BUY3) });
    expect(o.mailTo).toEqual([]);
  });

  it("catalog request rejected on an unassigned PR → requester, the filer and every hotel buyer; in-app", async () => {
    const pr = await approved();
    const requestId = await withRequest(pr);
    const o = await observe(pr.id, () => admin("post", `${ADMIN_BASE}/${requestId}/reject`).send({ note: "Not sold anymore" }));
    expect(o.res.status).toBe(200);
    expect(o.inApp).toEqual({ pr_catalog_rejected: ids(REQ, ...HOTEL_BUYERS) });
    expect(o.mailTo).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------
describe("PR conversation: POST /pr/:id/comments", () => {
  it("comment.in-review: reviewers (eligible and acted) and the requester are told, never the author; in-app only", async () => {
    const pr = await inReview();
    // The Engineering reviewer completes their review: they have acted, the Procurement review is still pending.
    expect((await engC.post(`/api/v1/pr/${pr.id}/reviews/${pr.eng}/complete`).send({})).status).toBe(200);

    const byReq = await observe(pr.id, () => comment(reqC, pr.id, "Can the oven be 400V?"));
    expect(byReq.res.status).toBe(200);
    expect(byReq.inApp).toEqual({ pr_comment: ids(RV_ENG, RV_PROC) }); // acted + eligible; not the author
    expect(byReq.mailTo).toEqual([]);
    expect(byReq.dupes).toEqual([]);

    // A reviewer answers: the requester is told, and the other reviewer; the prior commenter (REQ) is one of them already.
    const byProc = await observe(pr.id, () => comment(procC, pr.id, "Yes, 400V is fine"));
    expect(byProc.res.status).toBe(200);
    expect(byProc.inApp).toEqual({ pr_comment: ids(REQ, RV_ENG) });
  });

  it("comment.lost-access: a reviewer who acted, then lost pr.evaluate, can no longer read the PR → gets no comment snippet", async () => {
    const pr = await inReview();
    expect((await engC.post(`/api/v1/pr/${pr.id}/reviews/${pr.eng}/complete`).send({})).status).toBe(200);
    await revokeAllPr([RV_ENG]);
    try {
      expect((await engC.get(`/api/v1/pr/${pr.id}`)).status).toBe(404); // really cannot read it any more
      const byReq = await observe(pr.id, () => comment(reqC, pr.id, "Budget code is 4410"));
      expect(byReq.res.status).toBe(200);
      expect(byReq.inApp).toEqual({ pr_comment: ids(RV_PROC) }); // the pending reviewer still hears; RV_ENG does not
    } finally {
      await grantPr(RV_ENG, "PR Technical Reviewer", { departmentId: ENG });
    }
  });

  it("comment.pending-approval: the current-step approver and the requester; an unrelated user is not", async () => {
    const pr = await pendingApproval();
    const byReq = await observe(pr.id, () => comment(reqC, pr.id, "Urgent please"));
    expect(byReq.res.status).toBe(200);
    expect(byReq.inApp).toEqual({ pr_comment: ids(AP1) });
    const byAp = await observe(pr.id, () => comment(ap1C, pr.id, "Looking now"));
    expect(byAp.inApp).toEqual({ pr_comment: ids(REQ) });
    // A user with no stake in the PR never hears about it.
    expect([...byReq.inApp.pr_comment, ...byAp.inApp.pr_comment]).not.toContain(OUT);
  });

  it("comment.approved: requester, assigned buyer and prior commenters; buyers who never took part are not told", async () => {
    const pr = await approved();
    expect((await assignTo(buyC, pr.id, BUY3)).status).toBe(200);
    // BUY (not assigned) joins the thread: from now on BUY is a prior commenter.
    const byBuy = await observe(pr.id, () => comment(buyC, pr.id, "Which brand?"));
    expect(byBuy.res.status).toBe(200);
    expect(byBuy.inApp).toEqual({ pr_comment: ids(REQ, BUY3) });
    const byReq = await observe(pr.id, () => comment(reqC, pr.id, "Any brand with a 1-year warranty"));
    expect(byReq.inApp).toEqual({ pr_comment: ids(BUY, BUY3) }); // BUY: prior commenter; AP1 (hotel buyer, silent) is not
  });

  it("comment.detail: comments[] ascending with author names; a comment_added event is recorded", async () => {
    const pr = await pendingApproval();
    const first = await comment(reqC, pr.id, "  first  ");
    const second = await comment(ap1C, pr.id, "second");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const d = (await reqC.get(`/api/v1/pr/${pr.id}`)).body.data;
    expect(d.comments).toEqual([
      { id: expect.any(Number), author_id: REQ, author_name: expect.any(String), body: "first", created_at: expect.any(String) },
      { id: expect.any(Number), author_id: AP1, author_name: expect.any(String), body: "second", created_at: expect.any(String) },
    ]);
    expect(d.comments[0].id).toBeLessThan(d.comments[1].id);
    const events = await db.any(
      `SELECT event_type, actor_id, payload FROM tbl_pr_event WHERE pr_id = $1 AND event_type = 'comment_added' ORDER BY id`, [pr.id]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ actor_id: REQ, payload: { comment_id: d.comments[0].id } });
  });

  it("comment.validation: 1..4000 characters after trimming, else 422 and nothing is written", async () => {
    const pr = await pendingApproval();
    for (const body of ["", "   ", undefined, null, 5, "x".repeat(4001)]) {
      const res = await reqC.post(`/api/v1/pr/${pr.id}/comments`).send({ body });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("PR_VALIDATION");
    }
    expect((await reqC.post(`/api/v1/pr/${pr.id}/comments`).send({})).status).toBe(422);
    expect(Number((await db.one(`SELECT count(*) AS n FROM tbl_pr_comment WHERE pr_id = $1`, [pr.id])).n)).toBe(0);
    expect((await comment(reqC, pr.id, "x".repeat(4000))).status).toBe(200);
    expect((await comment(reqC, pr.id, `  ${"y".repeat(4000)}  `)).status).toBe(200);
  });

  it("comment.non-reader: a user who cannot read the PR gets 404 and writes nothing, tells no one", async () => {
    const pr = await pendingApproval();
    const o = await observe(pr.id, () => comment(outC, pr.id, "I should not be here"));
    expect(o.res.status).toBe(404);
    expect(o.res.body.code).toBe("PR_NOT_FOUND");
    expect(o.inApp).toEqual({});
    expect(Number((await db.one(`SELECT count(*) AS n FROM tbl_pr_comment WHERE pr_id = $1`, [pr.id])).n)).toBe(0);
    expect((await comment(reqC, 999999999, "nope")).status).toBe(404);
  });

  it("comment.cancelled: a readable PR in any status still takes comments", async () => {
    const pr = await draft([freeLine(CX)]);
    expect((await reqC.post(`/api/v1/pr/${pr.id}/cancel`).send({ reason: "Not needed" })).status).toBe(200);
    expect((await comment(reqC, pr.id, "Why was this cancelled?")).status).toBe(200);
  });
});
