// Purchase Requisitions — the Company Administrator system role holds pr.read
// ONLY (ruling R40, final review B-M3 / A note).
//
// In production the Company Administrator (role 34) is a non-operational admin
// role: company.admin, dashboard.* and reports.* — no RFQ / PO operational
// permission. Every PR audience is resolved from permissions (reviewers from
// pr.evaluate, the hotel's buyers from pr.convert, approvers from pr.approve),
// so a CA holding all of pr.* was silently made an eligible reviewer for every
// department (PR_NO_REVIEWER could never fire), an assignable buyer, and the
// recipient of every review task and every approved-PR buyer mail. With
// pr.read only, the CA keeps company-wide oversight (GET /pr, GET /pr/:id) and
// administers review routing through company.admin, not pr.*.
//
// Product-level: real HTTP against real Postgres; recipients read back from
// tbl_notifications. Pattern B (commit + cleanup by tracked ids).
//
// Personas
//   CA    companyA_admin    Company Administrator, company-wide at A (mapped company-level); no PR role
//   REQ   a1_eng_buyer      PR Requester at (A, A1, eng)
//   AP    a1_proc_commApp   PR Approver at (A, A1, eng)
//   RV    a1_proc_techEval  PR Technical Reviewer at (A, A1, eng)
//   BUY   a1_proc_buyer     PR Buyer at (A, A1)

import { httpClient } from "../helpers/http.js";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import {
  grantPr, revokeAllPr, cleanupPrs, makePrPolicy, dropPrPolicies, mapCategory, unmapAll, draftBody, approvedPr,
} from "../helpers/prFixtures.js";
import { buyerPrDetail } from "../../app/services/notificationLinks.js";

const A = IDS.hospitality.A;
const B = IDS.hospitality.B;
const A1 = IDS.hotels.A1;
const B1 = IDS.hotels.B1;
const ENG = IDS.departments.eng;
const FB = IDS.departments.fb;
const CA = IDS.users.companyA_admin;
const REQ = IDS.users.a1_eng_buyer;
const AP = IDS.users.a1_proc_commApp;
const RV = IDS.users.a1_proc_techEval;
const BUY = IDS.users.a1_proc_buyer;
const XCO = IDS.users.companyB_admin;
const PERSONAS = [CA, REQ, AP, RV, BUY, XCO];

const prIds = [];
const scopeIds = [];
let originalUsers = [];
let caC, reqC, buyC;
let CAT_REVIEW; // a free-text category routed for review (to F&B or Engineering per test)
let CAT_PLAIN; // a free-text category never routed

const freeLine = (categoryId, name = "Ice machine compressor") => ({
  free_text_name: name, category_id: categoryId, quantity: "1", uom: "nos", estimated_unit_price: "500.00",
});
const prNotes = (prId, type) => db.map(
  `SELECT DISTINCT recipient_user_id FROM tbl_notifications
    WHERE category = 'pr' AND additional_data->>'pr_id' = $1::text AND type = $2
    ORDER BY recipient_user_id`, [String(prId), type], (r) => Number(r.recipient_user_id));

async function draft(lines, header = {}) {
  const res = await reqC.post("/api/v1/pr").send(await draftBody({ lines, ...header }));
  expect(res.status).toBe(200);
  prIds.push(res.body.data.id);
  return res.body.data;
}

beforeAll(async () => {
  originalUsers = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS]);
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [PERSONAS]);
  await revokeAllPr(PERSONAS);
  await unmapAll(A);
  await dropPrPolicies();
  const caRole = await db.one(`SELECT id FROM tbl_roles WHERE title = 'Company Administrator' AND created_by IS NULL`);
  scopeIds.push(await grantRoleScope(db, { userId: CA, roleId: Number(caRole.id), companyId: A, hotelId: null, departmentId: null }));
  await grantPr(REQ, "PR Requester", { departmentId: ENG });
  await grantPr(XCO, "PR Requester", { companyId: B, hotelId: B1, departmentId: ENG });
  await grantPr(AP, "PR Approver", { departmentId: ENG });
  await grantPr(RV, "PR Technical Reviewer", { departmentId: ENG });
  await grantPr(BUY, "PR Buyer");
  [CAT_REVIEW, CAT_PLAIN] = await db.map(
    `SELECT id FROM tbl_category WHERE status = 1 AND is_deleted = 0 ORDER BY id LIMIT 2`, [], (r) => Number(r.id));
  caC = await httpClient(CA);
  reqC = await httpClient(REQ);
  buyC = await httpClient(BUY);
});

afterEach(async () => {
  await unmapAll(A);
  await dropPrPolicies();
});

afterAll(async () => {
  if (prIds.length) {
    await db.none(
      `DELETE FROM tbl_notifications
        WHERE (category = 'pr' AND additional_data->>'pr_id' = ANY($1::text[])) OR action_url = ANY($2::text[])`,
      [prIds.map(String), prIds.map((id) => buyerPrDetail(id))]);
  }
  await cleanupPrs(prIds);
  await dropPrPolicies();
  await unmapAll(A);
  await revokeAllPr(PERSONAS);
  await revokeRoleScopes(db, scopeIds);
  for (const u of originalUsers) await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
  await closeDb();
});

describe("Company Administrator = pr.read only (R40)", () => {
  it("is never a reviewer candidate: a department with no real reviewer → preview and submit say PR_NO_REVIEWER", async () => {
    await mapCategory(A, CAT_REVIEW, FB); // F&B has no PR Technical Reviewer — only the company-wide CA
    await makePrPolicy({ steps: [{ source: "USER", id: AP }] });

    const preview = await reqC.post("/api/v1/pr/routing-preview")
      .send({ hotel_id: A1, department_id: ENG, lines: [freeLine(CAT_REVIEW)] });
    expect(preview.status).toBe(200);
    const [review] = preview.body.data.reviews;
    expect(review).toMatchObject({ department_id: FB, reviewers: [] });
    expect(review.problem).toMatchObject({ code: "PR_NO_REVIEWER", department_id: FB });

    const pr = await draft([freeLine(CAT_REVIEW)]);
    const submit = await reqC.post(`/api/v1/pr/${pr.id}/submit`).send({});
    expect(submit.status).toBe(422);
    expect(submit.body.code).toBe("PR_NO_REVIEWER");
    const row = await db.one(`SELECT status FROM tbl_purchase_requisition WHERE id = $1`, [pr.id]);
    expect(row.status).toBe("draft");
  });

  it("gets no review task: a PR routed to Engineering tells the real reviewer only; the CA's awaiting_me stays 0", async () => {
    await mapCategory(A, CAT_REVIEW, ENG);
    await makePrPolicy({ steps: [{ source: "USER", id: AP }] });
    const pr = await draft([freeLine(CAT_REVIEW)]);
    const submit = await reqC.post(`/api/v1/pr/${pr.id}/submit`).send({});
    expect(submit.status).toBe(200);
    expect(submit.body.data.pr.status).toBe("in_review");

    expect(await prNotes(pr.id, "pr_review_task")).toEqual([RV]);
    const kpis = await caC.get("/api/v1/pr/kpis");
    expect(kpis.status).toBe(200);
    expect(kpis.body.data.awaiting_me).toBe(0);
    const queue = await caC.get("/api/v1/pr/review-queue");
    expect(queue.status).toBe(200);
    expect(queue.body.data.items.map((i) => i.pr_id)).not.toContain(pr.id);
  });

  it("is not an assignable buyer and is not told about approved PRs; the hotel's real buyers are", async () => {
    const buyers = await buyC.get(`/api/v1/pr/buyers?hotel_id=${A1}`);
    expect(buyers.status).toBe(200);
    const ids = buyers.body.data.map((b) => Number(b.id));
    expect(ids).toContain(BUY);
    expect(ids).not.toContain(CA);

    const pr = await approvedPr([freeLine(CAT_PLAIN)], { requesterId: REQ, approverId: AP });
    prIds.push(pr.id);
    const told = await prNotes(pr.id, "pr_approved");
    expect(told).toEqual(expect.arrayContaining([REQ, BUY]));
    expect(told).not.toContain(CA);
    expect((await caC.get("/api/v1/pr/pool")).status).toBe(403);
  });

  it("cannot raise a PR (no pr.create)", async () => {
    const res = await caC.post("/api/v1/pr").send(await draftBody({ lines: [freeLine(CAT_PLAIN)] }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PR_FORBIDDEN");
  });

  it("keeps company-wide oversight: GET /pr?tab=all and GET /pr/:id for any PR of the company; another company's PR is 404", async () => {
    const pr = await draft([freeLine(CAT_PLAIN)], { title: "CA oversight probe" });
    const list = await caC.get(`/api/v1/pr?tab=all&q=${encodeURIComponent(pr.pr_number)}`);
    expect(list.status).toBe(200);
    expect(list.body.data.rows.map((r) => r.id)).toEqual([pr.id]);
    expect((await caC.get(`/api/v1/pr/${pr.id}`)).status).toBe(200);

    const xco = await httpClient(XCO);
    const foreign = await xco.post("/api/v1/pr").send(await draftBody({
      hotel_id: B1, department_id: ENG, lines: [freeLine(CAT_PLAIN)],
    }));
    expect(foreign.status).toBe(200);
    prIds.push(foreign.body.data.id);
    expect((await caC.get(`/api/v1/pr/${foreign.body.data.id}`)).status).toBe(404);
  });

  it("still administers review routing — that is company.admin, not pr.*", async () => {
    const res = await caC.get("/api/v1/pr/admin/review-routing");
    expect(res.status).toBe(200);
  });
});
