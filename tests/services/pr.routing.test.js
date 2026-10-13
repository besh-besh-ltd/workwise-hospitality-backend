// Purchase Requisitions — category review routing + routing preview (Task 5).
//
// Product-level: real HTTP through the full middleware chain against real
// Postgres; assertions read the response and the committed rows. Pattern B
// (commit + cleanup by tracked ids). The one exception is the engine-agreement
// test, which calls the production createApprovalInstance inside withTx
// (Pattern A) to prove the preview says exactly what submit will create.
//
// Personas
//   REQ       a1_eng_buyer      PR Requester at (A, A1, eng) and (A, A2, eng)
//   AP1       a1_proc_commApp   PR Approver at (A, A1, eng)
//   AP2       a1_proc_finance   PR Approver at (A, A1, eng)
//   NOBODY    a1_proc_buyer     no PR role
//   ADMIN_A   companyA_admin    company admin (user_type 7) of company A
//   ADMIN_B   companyB_admin    company admin (user_type 7) of company B
// Reviewers (granted only inside the `reviewers` block):
//   RV_A1     a1_proc_techEval  PR Technical Reviewer at (A, A1, eng); mapped to A1
//   RV_ALL    crossCompany      PR Technical Reviewer at (A, all hotels, eng); company-level mapping
//   RV_A1MAP  a1_proc_techApp   PR Technical Reviewer at (A, all hotels, eng); mapped to A1 only
//   RV_A2     multiHotel        PR Technical Reviewer at (A, A2, eng); mapped to A1 and A2
//   INACTIVE  inactive          PR Technical Reviewer at (A, A1, eng); status 0
//   RV_PROC   a1_proc_commEval  PR Technical Reviewer at (A, A1, proc)

import { httpClient } from "../helpers/http.js";
import { db, withTx } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import {
  grantPr, revokeAllPr, firstUsableVariant, cleanupPrs, makePrPolicy, dropPrPolicies, istDate, unmapAll,
} from "../helpers/prFixtures.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";

const A = IDS.hospitality.A;
const B = IDS.hospitality.B;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const B1 = IDS.hotels.B1;
const ENG = IDS.departments.eng;
const PROC = IDS.departments.proc;
const REQ = IDS.users.a1_eng_buyer;
const AP1 = IDS.users.a1_proc_commApp;
const AP2 = IDS.users.a1_proc_finance;
const NOBODY = IDS.users.a1_proc_buyer;
const ADMIN_A = IDS.users.companyA_admin;
const ADMIN_B = IDS.users.companyB_admin;
const RV_A1 = IDS.users.a1_proc_techEval;
const RV_ALL = IDS.users.crossCompany;
const RV_A1MAP = IDS.users.a1_proc_techApp;
const RV_A2 = IDS.users.multiHotel;
const INACTIVE = IDS.users.inactive;
const RV_PROC = IDS.users.a1_proc_commEval;

const BUYERS = [REQ, AP1, AP2, NOBODY];
const ADMINS = [ADMIN_A, ADMIN_B];
const REVIEWERS = [RV_A1, RV_ALL, RV_A1MAP, RV_A2, INACTIVE, RV_PROC];
const PERSONAS = [...BUYERS, ...ADMINS, ...REVIEWERS];

const prIds = [];
const categoryIds = [];
const roleIds = [];
let originalUserTypes = [];
let reqC, ap1C, nobodyC, adminAC, adminBC;
let names = new Map();
let catP, catC, catG, catGG, catGGG, catOther, catProc;

const PREVIEW = "/api/v1/pr/routing-preview";
const ROUTING = "/api/v1/pr/admin/review-routing";

async function makeCategory(title, parentId) {
  const row = await db.one(
    `INSERT INTO tbl_category (title, slug, parent_id, status, is_deleted, created_by)
     VALUES ($1, $2, $3, 1, 0, $4) RETURNING id`,
    [title, `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`, parentId, IDS.users.superAdmin]);
  categoryIds.push(Number(row.id));
  return Number(row.id);
}

/** A role holding exactly pr.read + pr.approve that nobody is granted. */
async function makeUnheldApproverRole() {
  const role = await db.one(
    `INSERT INTO tbl_roles (title, description, created_by) VALUES ($1, 'PR routing test role', $2) RETURNING id`,
    [`PR routing unheld ${Date.now()}`, IDS.users.superAdmin]);
  const roleId = Number(role.id);
  roleIds.push(roleId);
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id)
     SELECT $1, id FROM tbl_permissions WHERE resource::text = 'pr' AND action::text IN ('read', 'approve')`,
    [roleId]);
  return roleId;
}

const revokeScopes = (ids) => db.none(`DELETE FROM tbl_user_role_scopes WHERE id = ANY($1::int[])`, [ids]);
const nameOf = (id) => names.get(Number(id));
const person = (id) => ({ id: Number(id), name: nameOf(id) });
const byName = (a, b) => a.name.localeCompare(b.name) || a.id - b.id;
const codes = (problems) => problems.map((p) => p.code);

const freeLine = (categoryId, quantity = "1", price = "100.00") => ({
  category_id: categoryId, quantity, estimated_unit_price: price,
});
const previewBody = (lines, extra = {}) => ({ hotel_id: A1, department_id: ENG, lines, ...extra });
const preview = (client, body) => client.post(PREVIEW).send(body);

beforeAll(async () => {
  originalUserTypes = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS]);
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [BUYERS]);
  await db.none(`UPDATE tbl_users SET user_type = 7 WHERE id = ANY($1::int[])`, [ADMINS]);
  await revokeAllPr(PERSONAS);
  await unmapAll(A);
  await unmapAll(B);
  await dropPrPolicies();
  await grantPr(REQ, "PR Requester", { departmentId: ENG });
  await grantPr(REQ, "PR Requester", { hotelId: A2, departmentId: ENG });
  await grantPr(AP1, "PR Approver", { departmentId: ENG });
  await grantPr(AP2, "PR Approver", { departmentId: ENG });

  // A private category tree: P > C > G > GG > GGG, plus two unrelated roots.
  catP = await makeCategory("PR routing P", null);
  catC = await makeCategory("PR routing C", catP);
  catG = await makeCategory("PR routing G", catC);
  catGG = await makeCategory("PR routing GG", catG);
  catGGG = await makeCategory("PR routing GGG", catGG);
  catOther = await makeCategory("PR routing unmapped", 0);
  catProc = await makeCategory("PR routing proc", 0);

  names = new Map((await db.any(`SELECT id, name FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS]))
    .map((r) => [Number(r.id), r.name]));

  reqC = await httpClient(REQ);
  ap1C = await httpClient(AP1);
  nobodyC = await httpClient(NOBODY);
  adminAC = await httpClient(ADMIN_A);
  adminBC = await httpClient(ADMIN_B);
});

afterAll(async () => {
  await cleanupPrs(prIds);
  await dropPrPolicies();
  await unmapAll(A);
  await unmapAll(B);
  await revokeAllPr(PERSONAS);
  if (roleIds.length) {
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE role_id = ANY($1::int[])`, [roleIds]);
    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = ANY($1::int[])`, [roleIds]);
    await db.none(`DELETE FROM tbl_roles WHERE id = ANY($1::int[])`, [roleIds]);
  }
  if (categoryIds.length) await db.none(`DELETE FROM tbl_category WHERE id = ANY($1::int[])`, [categoryIds]);
  for (const u of originalUserTypes) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
  }
});

// ---------------------------------------------------------------------------
// Admin: category → reviewing department map
// ---------------------------------------------------------------------------
describe("PR review routing — admin map", () => {
  afterEach(async () => {
    await unmapAll(A);
    await unmapAll(B);
  });

  it("map.crud: create, list, upsert keeps the row, delete; another company's admin gets 404; buyers 403", async () => {
    const created = await adminAC.post(ROUTING).send({ category_id: catC, department_id: ENG });
    expect(created.status).toBe(200);
    const mapId = created.body.data.id;
    expect(mapId).toEqual(expect.any(Number));
    expect(created.body.data).toMatchObject({ category_id: catC, department_id: ENG, created: true });

    const listed = await adminAC.get(ROUTING);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([
      expect.objectContaining({
        id: mapId,
        category_id: catC,
        category_title: "PR routing C",
        parent_title: "PR routing P",
        department_id: ENG,
        department_title: expect.any(String),
        created_by_name: nameOf(ADMIN_A),
        created_at: expect.any(String),
      }),
    ]);

    // Upsert on (company, category): the same row now routes to Procurement.
    const upserted = await adminAC.post(ROUTING).send({ category_id: catC, department_id: PROC });
    expect(upserted.status).toBe(200);
    expect(upserted.body.data).toMatchObject({ id: mapId, department_id: PROC, created: false });
    const rows = await db.any(
      `SELECT id, department_id FROM tbl_pr_review_category_map WHERE hospitality_company_id = $1`, [A]);
    expect(rows).toEqual([{ id: mapId, department_id: PROC }]);

    // Company B's admin neither sees nor deletes A's mapping.
    const listB = await adminBC.get(ROUTING);
    expect(listB.status).toBe(200);
    expect(listB.body.data).toEqual([]);
    const crossDelete = await adminBC.delete(`${ROUTING}/${mapId}`);
    expect(crossDelete.status).toBe(404);
    expect(crossDelete.body.code).toBe("PR_NOT_FOUND");
    expect(await db.oneOrNone(`SELECT id FROM tbl_pr_review_category_map WHERE id = $1`, [mapId])).not.toBeNull();

    // A buyer who is not a company admin is refused on every verb.
    expect((await reqC.get(ROUTING)).status).toBe(403);
    expect((await reqC.post(ROUTING).send({ category_id: catC, department_id: ENG })).status).toBe(403);
    expect((await reqC.delete(`${ROUTING}/${mapId}`)).status).toBe(403);

    const deleted = await adminAC.delete(`${ROUTING}/${mapId}`);
    expect(deleted.status).toBe(200);
    expect(await db.oneOrNone(`SELECT id FROM tbl_pr_review_category_map WHERE id = $1`, [mapId])).toBeNull();
    expect((await adminAC.delete(`${ROUTING}/${mapId}`)).status).toBe(404);
  });

  it("map.company-from-context: a body company the admin does not administer is refused, nothing written", async () => {
    const res = await adminAC.post(ROUTING).send({ hospitality_company_id: B, category_id: catC, department_id: ENG });
    expect(res.status).toBe(404);
    const rows = await db.any(
      `SELECT hospitality_company_id FROM tbl_pr_review_category_map WHERE category_id = $1`, [catC]);
    expect(rows).toEqual([]);

    // Without a hint the admin's own (only) company is used.
    const own = await adminBC.post(ROUTING).send({ category_id: catC, department_id: ENG });
    expect(own.status).toBe(200);
    expect(await db.one(
      `SELECT hospitality_company_id FROM tbl_pr_review_category_map WHERE id = $1`, [own.body.data.id]))
      .toEqual({ hospitality_company_id: B });
  });

  it("map.validation: unknown or inactive category and unknown department → 422, nothing written", async () => {
    const inactive = await makeCategory("PR routing inactive", 0);
    await db.none(`UPDATE tbl_category SET status = 0 WHERE id = $1`, [inactive]);
    for (const body of [
      { category_id: 999999999, department_id: ENG },
      { category_id: inactive, department_id: ENG },
      { category_id: catC, department_id: 999999999 },
      { category_id: "abc", department_id: ENG },
      { category_id: catC },
    ]) {
      const res = await adminAC.post(ROUTING).send(body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("PR_VALIDATION");
    }
    expect(await db.any(`SELECT id FROM tbl_pr_review_category_map WHERE hospitality_company_id = $1`, [A])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Review groups (via the preview)
// ---------------------------------------------------------------------------
describe("PR routing preview — review groups", () => {
  afterEach(async () => {
    await unmapAll(A);
  });

  it("groups.exact-and-parent: nearest mapping wins, up to 3 levels up; unmapped categories need no review", async () => {
    await adminAC.post(ROUTING).send({ category_id: catP, department_id: ENG });

    // C, G, GG are 1-3 levels below P → eng. GGG is 4 below → no review. Other root → no review.
    let res = await preview(reqC, previewBody([
      freeLine(catC), freeLine(catG), freeLine(catGG), freeLine(catGGG), freeLine(catOther),
    ]));
    expect(res.status).toBe(200);
    expect(res.body.data.reviews.map((r) => ({ d: r.department_id, l: r.line_nos }))).toEqual([
      { d: ENG, l: [1, 2, 3] },
    ]);

    // Map C itself → proc: C and everything under it (G, GG, GGG are ≤ 3 below C) now go to proc.
    await adminAC.post(ROUTING).send({ category_id: catC, department_id: PROC });
    res = await preview(reqC, previewBody([freeLine(catP), freeLine(catC), freeLine(catG), freeLine(catGGG)]));
    expect(res.status).toBe(200);
    const groups = Object.fromEntries(res.body.data.reviews.map((r) => [r.department_id, r.line_nos]));
    expect(groups).toEqual({ [ENG]: [1], [PROC]: [2, 3, 4] });
  });

  it("groups.parallel: eng- and proc-mapped lines form two groups sorted by department title; catalog lines route by their product's category", async () => {
    const v = await firstUsableVariant();
    await adminAC.post(ROUTING).send({ category_id: catC, department_id: ENG });
    await adminAC.post(ROUTING).send({ category_id: v.category_id, department_id: PROC });
    await adminAC.post(ROUTING).send({ category_id: catProc, department_id: PROC });

    const res = await preview(reqC, previewBody([
      freeLine(catProc),
      freeLine(catC),
      // The client's category_id on a catalog line is ignored (catC would mean eng).
      { product_variant_id: v.variant_id, category_id: catC, quantity: "1", estimated_unit_price: "10.00" },
      freeLine(catOther),
      freeLine(catG),
    ]));
    expect(res.status).toBe(200);
    const titles = await db.map(
      `SELECT id, title FROM tbl_department WHERE id = ANY($1::int[])`, [[ENG, PROC]], (r) => [Number(r.id), r.title]);
    const title = new Map(titles);
    const expected = [
      { department_id: ENG, department_title: title.get(ENG), line_nos: [2, 5] },
      { department_id: PROC, department_title: title.get(PROC), line_nos: [1, 3] },
    ].sort((a, b) => a.department_title.localeCompare(b.department_title));
    expect(res.body.data.reviews.map(({ department_id, department_title, line_nos }) =>
      ({ department_id, department_title, line_nos }))).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Reviewers
// ---------------------------------------------------------------------------
describe("PR routing preview — reviewers", () => {
  const scopeIds = [];
  beforeAll(async () => {
    scopeIds.push(await grantPr(RV_A1, "PR Technical Reviewer", { hotelId: A1, departmentId: ENG }));
    scopeIds.push(await grantPr(RV_ALL, "PR Technical Reviewer", { hotelId: null, departmentId: ENG }));
    scopeIds.push(await grantPr(RV_A1MAP, "PR Technical Reviewer", { hotelId: null, departmentId: ENG }));
    scopeIds.push(await grantPr(RV_A2, "PR Technical Reviewer", { hotelId: A2, departmentId: ENG }));
    scopeIds.push(await grantPr(INACTIVE, "PR Technical Reviewer", { hotelId: A1, departmentId: ENG }));
    scopeIds.push(await grantPr(RV_PROC, "PR Technical Reviewer", { hotelId: A1, departmentId: PROC }));
    await unmapAll(A);
    await adminAC.post(ROUTING).send({ category_id: catC, department_id: ENG });
    await adminAC.post(ROUTING).send({ category_id: catProc, department_id: PROC });
  });
  afterAll(async () => {
    await revokeScopes(scopeIds);
    await unmapAll(A);
  });

  it("reviewers: pr.evaluate holders covering (company, hotel, department), active and mapped to the hotel", async () => {
    const atA1 = await preview(reqC, previewBody([freeLine(catC), freeLine(catProc)]));
    expect(atA1.status).toBe(200);
    const a1 = Object.fromEntries(atA1.body.data.reviews.map((r) => [r.department_id, r]));
    // RV_A2 is scoped to A2 only; INACTIVE has status 0.
    expect(a1[ENG].reviewers).toEqual([person(RV_A1), person(RV_ALL), person(RV_A1MAP)].sort(byName));
    expect(a1[ENG].problem).toBeNull();
    // A department grant is exact: the eng reviewers do not review proc lines.
    expect(a1[PROC].reviewers).toEqual([person(RV_PROC)]);

    // At A2: RV_A2 (scoped there) and RV_ALL (company-level mapping); not RV_A1 (scoped to A1)
    // and not RV_A1MAP (all-hotel grant, but mapped to hotel A1 only).
    const atA2 = await preview(reqC, previewBody([freeLine(catC)], { hotel_id: A2 }));
    expect(atA2.status).toBe(200);
    expect(atA2.body.data.reviews).toHaveLength(1);
    expect(atA2.body.data.reviews[0].reviewers).toEqual([person(RV_ALL), person(RV_A2)].sort(byName));
  });
});

// ---------------------------------------------------------------------------
// Approval preview
// ---------------------------------------------------------------------------
describe("PR routing preview — approval", () => {
  afterEach(async () => {
    await dropPrPolicies();
    await unmapAll(A);
  });

  it("preview.problems: no PR policy → PR_NO_POLICY", async () => {
    const res = await preview(reqC, previewBody([freeLine(catOther)]));
    expect(res.status).toBe(200);
    expect(res.body.data.approval).toMatchObject({ policy_id: null, steps: [] });
    expect(codes(res.body.data.approval.problems)).toEqual(["PR_NO_POLICY"]);
    expect(codes(res.body.data.problems)).toEqual(["PR_NO_POLICY"]);
    expect(res.body.data.problems[0].message).toEqual(expect.any(String));
  });

  it("preview.problems: a ROLE step nobody holds → PR_STEP_UNRESOLVED naming the step", async () => {
    const unheld = await makeUnheldApproverRole();
    const policyId = await makePrPolicy({ steps: [{ source: "USER", id: AP1 }, { source: "ROLE", id: unheld }] });
    const res = await preview(reqC, previewBody([freeLine(catOther)]));
    expect(res.status).toBe(200);
    const { approval } = res.body.data;
    expect(approval.policy_id).toBe(policyId);
    expect(approval.steps).toEqual([
      expect.objectContaining({ step_order: 1, applies: true, skipped_reason: null, approvers: [person(AP1)] }),
      expect.objectContaining({
        step_order: 2, approver_source_type: "ROLE", label: expect.stringMatching(/^PR routing unheld/),
        applies: true, skipped_reason: null, approvers: [],
      }),
    ]);
    expect(approval.problems).toEqual([
      expect.objectContaining({ code: "PR_STEP_UNRESOLVED", step_order: 2, reason: "NO_APPROVERS_RESOLVED" }),
    ]);
    expect(codes(res.body.data.problems)).toEqual(["PR_STEP_UNRESOLVED"]);
  });

  it("preview.problems: the only step is USER = requester → sod_self + PR_NO_INDEPENDENT_APPROVER", async () => {
    const [scope] = [await grantPr(REQ, "PR Approver", { departmentId: ENG })];
    try {
      await makePrPolicy({ steps: [{ source: "USER", id: REQ }] });
      const res = await preview(reqC, previewBody([freeLine(catOther)]));
      expect(res.status).toBe(200);
      expect(res.body.data.approval.steps).toEqual([
        expect.objectContaining({ step_order: 1, applies: false, skipped_reason: "sod_self", approvers: [] }),
      ]);
      expect(codes(res.body.data.approval.problems)).toEqual(["PR_NO_INDEPENDENT_APPROVER"]);
      expect(codes(res.body.data.problems)).toEqual(["PR_NO_INDEPENDENT_APPROVER"]);
      expect(res.body.data.problems[0].message).toMatch(/requester/);
    } finally {
      await revokeScopes([scope]);
    }
  });

  it("preview.problems: an eng-mapped line with no eng reviewer → reviews[0].problem PR_NO_REVIEWER, listed before approval problems", async () => {
    await adminAC.post(ROUTING).send({ category_id: catC, department_id: ENG });
    const res = await preview(reqC, previewBody([freeLine(catOther), freeLine(catC)]));
    expect(res.status).toBe(200);
    const [review] = res.body.data.reviews;
    expect(review).toMatchObject({ department_id: ENG, line_nos: [2], reviewers: [] });
    expect(review.problem).toMatchObject({ code: "PR_NO_REVIEWER", department_id: ENG });
    expect(review.problem.message).toContain(review.department_title);
    // No policy either: the review problem comes first (submit refuses with problems[0]).
    expect(codes(res.body.data.problems)).toEqual(["PR_NO_REVIEWER", "PR_NO_POLICY"]);
  });

  it("preview.thresholds: a min-amount step is below_threshold at 49,999.99 and applies at 50,000.00", async () => {
    await makePrPolicy({ steps: [{ source: "USER", id: AP1 }, { source: "USER", id: AP2, min_amount: "50000" }] });

    const below = await preview(reqC, previewBody([freeLine(catOther, "1", "49999.99")]));
    expect(below.status).toBe(200);
    expect(below.body.data.amount).toBe("49999.99");
    expect(below.body.data.approval.steps).toEqual([
      expect.objectContaining({ step_order: 1, min_amount: null, applies: true, skipped_reason: null, approvers: [person(AP1)] }),
      expect.objectContaining({
        step_order: 2, min_amount: "50000.00", applies: false, skipped_reason: "below_threshold", approvers: [],
      }),
    ]);
    expect(below.body.data.problems).toEqual([]);

    const at = await preview(reqC, previewBody([freeLine(catOther, "2", "25000.00")]));
    expect(at.status).toBe(200);
    expect(at.body.data.amount).toBe("50000.00");
    expect(at.body.data.approval.steps[1]).toMatchObject({
      step_order: 2, applies: true, skipped_reason: null, approvers: [person(AP2)],
    });
    expect(at.body.data.problems).toEqual([]);
  });

  it("preview.thresholds: when no step applies at this value submit is refused (PR_NO_INDEPENDENT_APPROVER), said as such", async () => {
    await makePrPolicy({ steps: [{ source: "USER", id: AP1, min_amount: "50000.00" }] });
    const res = await preview(reqC, previewBody([freeLine(catOther, "1", "100.00")]));
    expect(res.status).toBe(200);
    expect(res.body.data.approval.steps).toEqual([
      expect.objectContaining({ step_order: 1, applies: false, skipped_reason: "below_threshold" }),
    ]);
    expect(res.body.data.problems).toEqual([
      expect.objectContaining({ code: "PR_NO_INDEPENDENT_APPROVER", message: expect.stringMatching(/value/) }),
    ]);
  });

  it("preview.matches-engine: the steps that apply are exactly the instance createApprovalInstance builds", async () => {
    const scope = await grantPr(REQ, "PR Approver", { departmentId: ENG });
    try {
      await makePrPolicy({
        steps: [
          { source: "USER", id: AP1 },
          { source: "USER", id: REQ },
          { source: "USER", id: AP2, min_amount: "50000.00" },
        ],
      });
      const res = await preview(reqC, previewBody([freeLine(catOther, "1", "49999.99")]));
      expect(res.status).toBe(200);
      const steps = res.body.data.approval.steps;
      expect(steps.map((s) => [s.step_order, s.applies, s.skipped_reason])).toEqual([
        [1, true, null], [2, false, "sod_self"], [3, false, "below_threshold"],
      ]);

      // A real PR row to hang the instance on; the instance itself is rolled back.
      const draft = await reqC.post("/api/v1/pr").send({
        hotel_id: A1, department_id: ENG, title: "engine agreement", justification: "x",
        required_by_date: await istDate(7), lines: [{ free_text_name: "x", category_id: catOther, quantity: "1", uom: "nos", estimated_unit_price: "49999.99" }],
      });
      expect(draft.status).toBe(200);
      prIds.push(draft.body.data.id);

      await withTx(async (t) => {
        const created = await createApprovalInstance({
          entity_type: "PR", entity_id: draft.body.data.id, hospitality_company_id: A, hotel_id: A1,
          department_id: ENG, process_id: null, initiated_by: REQ, amount: res.body.data.amount, strictSteps: true,
        }, t);
        const approvers = await t.map(
          `SELECT s.step_order, array_agg(a.approver_user_id ORDER BY a.approver_user_id) AS ids
             FROM tbl_approval_instance_steps s
             JOIN tbl_approval_step_approvers a ON a.approval_instance_step_id = s.id
            WHERE s.approval_instance_id = $1
            GROUP BY s.step_order ORDER BY s.step_order`,
          [created.instance.id], (r) => r.ids.map(Number));
        expect(approvers).toEqual(steps.filter((s) => s.applies).map((s) => s.approvers.map((a) => a.id).sort((x, y) => x - y)));
        const skipped = created.skippedSteps.map((s) => [s.step_order, s.reason]).sort((x, y) => x[0] - y[0]);
        expect(skipped).toEqual(steps.filter((s) => !s.applies).map((s) => [s.step_order, s.skipped_reason]));
      });
    } finally {
      await revokeScopes([scope]);
    }
  });
});

// ---------------------------------------------------------------------------
// Amount, validation, authorization
// ---------------------------------------------------------------------------
describe("PR routing preview — amount, validation, authorization", () => {
  it("preview.amount-server-side: client amount fields are ignored; amount = Σ ROUND(qty × price, 2)", async () => {
    const res = await preview(reqC, previewBody([
      freeLine(catOther, "0.5", "0.01"), // 0.005 → 0.01
      freeLine(catOther, "0.5", "0.01"), // 0.005 → 0.01
      freeLine(catOther, "2", "1250000.75"),
    ], { amount: 1, estimated_total: "1.00" }));
    expect(res.status).toBe(200);
    // Per-line rounding: 0.01 + 0.01 + 2,500,001.50 (the unrounded sum would round to …1.51).
    expect(res.body.data.amount).toBe("2500001.52");
  });

  it("preview.validation: bad quantities/prices, unknown variants or categories → 422 PR_VALIDATION", async () => {
    const cases = [
      { lines: [freeLine(catOther, "0", "10.00")], field: "quantity" },
      { lines: [freeLine(catOther, "1.2345", "10.00")], field: "quantity" },
      { lines: [freeLine(catOther, "1", "10.001")], field: "estimated_unit_price" },
      { lines: [freeLine(catOther, "1", "-5")], field: "estimated_unit_price" },
      { lines: [{ quantity: "1", estimated_unit_price: "10.00" }], field: "category_id" },
      { lines: [freeLine(999999999)], field: "category_id" },
      { lines: [{ product_variant_id: 999999999, quantity: "1", estimated_unit_price: "10.00" }], field: "product_variant_id" },
    ];
    for (const c of cases) {
      const res = await preview(reqC, previewBody(c.lines));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("PR_VALIDATION");
      expect(res.body.details.map((d) => d.field)).toContain(c.field);
    }
    const noDept = await preview(reqC, { hotel_id: A1, lines: [] });
    expect(noDept.status).toBe(422);
  });

  it("preview.authz: no pr.create on the cell → 403 (another hotel's company, an unknown hotel, no role at all)", async () => {
    for (const [client, body] of [
      [nobodyC, previewBody([freeLine(catOther)])],
      [reqC, previewBody([freeLine(catOther)], { department_id: PROC })],
      [reqC, previewBody([freeLine(catOther)], { hotel_id: B1 })],
      [reqC, previewBody([freeLine(catOther)], { hotel_id: 999999999 })],
    ]) {
      const res = await preview(client, body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("PR_FORBIDDEN");
    }
  });
});

// ---------------------------------------------------------------------------
// Saved draft
// ---------------------------------------------------------------------------
describe("PR routing preview — saved draft (GET /pr/:id/routing-preview)", () => {
  let prId;
  let lineIds;
  let approverScope;
  beforeAll(async () => {
    const v = await firstUsableVariant();
    const res = await reqC.post("/api/v1/pr").send({
      hotel_id: A1, department_id: ENG, title: "Routing preview draft", justification: "spares",
      required_by_date: await istDate(7),
      lines: [
        { product_variant_id: v.variant_id, quantity: "0.5", uom: "nos", estimated_unit_price: "0.01" },
        { free_text_name: "Relay", category_id: catG, quantity: "3", uom: "nos", estimated_unit_price: "1000.10" },
      ],
    });
    if (res.status !== 200) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
    prId = res.body.data.id;
    prIds.push(prId);
    lineIds = await db.map(
      `SELECT id FROM tbl_purchase_requisition_line WHERE pr_id = $1 ORDER BY line_no`, [prId], (r) => Number(r.id));
    await unmapAll(A);
    await adminAC.post(ROUTING).send({ category_id: catP, department_id: ENG });
    await makePrPolicy({ steps: [{ source: "USER", id: AP1 }] });
  });
  afterAll(async () => {
    if (approverScope) await revokeScopes([approverScope]);
    await dropPrPolicies();
    await unmapAll(A);
  });

  it("returns the stored lines' routing, the live total and the approval chain for the requester", async () => {
    const res = await reqC.get(`/api/v1/pr/${prId}/routing-preview`);
    expect(res.status).toBe(200);
    expect(res.body.data.amount).toBe("3000.31"); // 0.005 → 0.01, + 3000.30
    expect(res.body.data.reviews).toEqual([
      expect.objectContaining({ department_id: ENG, line_nos: [2], line_ids: [lineIds[1]] }),
    ]);
    expect(res.body.data.approval.steps).toEqual([
      expect.objectContaining({ step_order: 1, applies: true, approvers: [person(AP1)] }),
    ]);
  });

  it("evaluates separation of duties against the requester, not the caller; non-readers get 404", async () => {
    // AP1 reads the PR through pr.read (PR Approver). If SoD used the caller,
    // AP1's own step would show as sod_self.
    const res = await ap1C.get(`/api/v1/pr/${prId}/routing-preview`);
    expect(res.status).toBe(200);
    expect(res.body.data.approval.steps[0]).toMatchObject({ applies: true, skipped_reason: null, approvers: [person(AP1)] });

    const hidden = await nobodyC.get(`/api/v1/pr/${prId}/routing-preview`);
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe("PR_NOT_FOUND");
    expect((await reqC.get(`/api/v1/pr/999999999/routing-preview`)).status).toBe(404);
  });
});
