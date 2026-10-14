// Purchase Requisitions — list, facets, KPIs, duplicate hints (Task 4).
//
// Product-level: real HTTP, real Postgres, Pattern B cleanup by tracked ids.
//
//   REQ    a1_eng_buyer      PR Requester at (A, A1, eng) [+ (A, A1, proc) for the proc PRs]
//   REQ2   a1_proc_techEval  PR Requester at (A, A1, eng) and (A, A2, eng); eng reviewer in one test
//   OTHER  a1_proc_buyer     PR Approver (pr.read) at (A, A1, eng) — reads eng PRs only
//   NOBODY a1_proc_techApp   no PR role at all
//   XCO    companyB_admin    PR Requester at (B, B1, eng)

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import {
  grantPr, revokeAllPr, draftBody, firstUsableVariant, cleanupPrs, dropPrPolicies, makePrPolicy, istDate,
} from "../helpers/prFixtures.js";
import { makeRFQ } from "../factories/rfq.js";
import { makePO } from "../helpers/dashboardSeed.js";

const A = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const B1 = IDS.hotels.B1;
const ENG = IDS.departments.eng;
const PROC = IDS.departments.proc;
const REQ = IDS.users.a1_eng_buyer;
const REQ2 = IDS.users.a1_proc_techEval;
const OTHER = IDS.users.a1_proc_buyer;
const NOBODY = IDS.users.a1_proc_techApp;
const XCO = IDS.users.companyB_admin;
const VENDOR = IDS.users.vendor_alpha;
const PERSONAS = [REQ, REQ2, OTHER, NOBODY, XCO];

const prIds = [];
const rfqIds = [];
const poIds = [];
let originalUserTypes = [];
let reqC, req2C, otherC, nobodyC, xcoC;

async function createAs(client, body) {
  const res = await client.post("/api/v1/pr").send(body);
  if (res.status !== 200) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  prIds.push(res.body.data.id);
  return res.body.data;
}
const setStatus = (id, status, extra = "") =>
  db.none(`UPDATE tbl_purchase_requisition SET status = $2 ${extra} WHERE id = $1`, [id, status]);
const list = (client, qs = "") => client.get(`/api/v1/pr${qs ? `?${qs}` : ""}`);
const idsOf = (res) => res.body.data.rows.map((r) => r.id);

/** A usable variant that draftBody()'s lines do not use (so duplicate counts are isolated). */
async function otherVariant() {
  const first = await firstUsableVariant();
  const row = await db.one(
    `SELECT pv.id AS variant_id, cat.category_id
       FROM tbl_product_variant pv JOIN tbl_product p ON p.id = pv.product_id
       CROSS JOIN LATERAL (SELECT pc.category_id FROM tbl_product_categories pc
                             JOIN tbl_category c ON c.id = pc.category_id
                            WHERE pc.product_id = p.id ORDER BY pc.category_id LIMIT 1) cat
      WHERE p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve = 1 AND pv.is_approve = 1
        AND pv.id <> $1
      ORDER BY pv.id DESC LIMIT 1`, [first.variant_id]);
  return { variant_id: Number(row.variant_id), category_id: Number(row.category_id) };
}

const oneLine = (extra = {}) => ({
  free_text_name: "Unique widget", category_id: null, quantity: "1", uom: "nos", estimated_unit_price: "10.00", ...extra,
});

beforeAll(async () => {
  originalUserTypes = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS]);
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [PERSONAS]);
  await revokeAllPr(PERSONAS);
  await grantPr(REQ, "PR Requester", { departmentId: ENG });
  await grantPr(REQ, "PR Requester", { departmentId: PROC });
  await grantPr(REQ2, "PR Requester", { departmentId: ENG });
  await grantPr(REQ2, "PR Requester", { hotelId: A2, departmentId: ENG });
  await grantPr(OTHER, "PR Approver", { departmentId: ENG });
  await grantPr(XCO, "PR Requester", { companyId: IDS.hospitality.B, hotelId: B1, departmentId: ENG });
  reqC = await httpClient(REQ);
  req2C = await httpClient(REQ2);
  otherC = await httpClient(OTHER);
  nobodyC = await httpClient(NOBODY);
  xcoC = await httpClient(XCO);
});

afterAll(async () => {
  if (poIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1)`, [poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1)`, [poIds]);
  }
  await cleanupPrs(prIds);
  if (rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1)`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1)`, [rfqIds]);
  }
  await dropPrPolicies();
  await revokeAllPr(PERSONAS);
  for (const u of originalUserTypes) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
  }
});

describe("PR list — scope", () => {
  let engPr, procPr, req2Pr;
  beforeAll(async () => {
    engPr = await createAs(reqC, await draftBody({ title: "scope-eng" }));
    procPr = await createAs(reqC, await draftBody({ title: "scope-proc", department_id: PROC }));
    req2Pr = await createAs(req2C, await draftBody({ title: "scope-req2" }));
  });

  it("mine-vs-all: mine = raised by me; all = readable set; unrelated users see nothing", async () => {
    const mine = await list(reqC, "tab=mine&q=scope-");
    expect(mine.status).toBe(200);
    expect(idsOf(mine).sort()).toEqual([engPr.id, procPr.id].sort());

    // REQ holds read on eng and proc, so `all` adds REQ2's eng PR.
    const all = await list(reqC, "tab=all&q=scope-");
    expect(idsOf(all).sort()).toEqual([engPr.id, procPr.id, req2Pr.id].sort());

    // OTHER: pr.read on (A1, eng) only → the eng PRs, not the proc one; `mine` is empty.
    const other = await list(otherC, "tab=all&q=scope-");
    expect(idsOf(other).sort()).toEqual([engPr.id, req2Pr.id].sort());
    expect(idsOf(other)).not.toContain(procPr.id);
    expect(idsOf(await list(otherC, "tab=mine&q=scope-"))).toEqual([]);

    const nobody = await list(nobodyC, "tab=all&q=scope-");
    expect(nobody.status).toBe(200);
    expect(nobody.body.data.rows).toEqual([]);
    expect(nobody.body.data.total).toBe(0);
  });

  it("row shape: header labels, live draft total, strings at the edge", async () => {
    const res = await list(reqC, "tab=mine&q=scope-eng");
    const row = res.body.data.rows[0];
    expect(row).toMatchObject({
      id: engPr.id, pr_number: engPr.pr_number, title: "scope-eng", status: "draft", header_progress: null,
      hotel_name: expect.any(String), department_name: expect.any(String), raised_by_name: expect.any(String),
      line_count: 2, urgency: "normal", pr_type: "goods", submitted_at: null, approved_at: null, now_with: "You",
    });
    expect(Number(row.estimated_total)).toBe(2 * 1500 + 4 * 250.5);
    expect(row.required_by_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("invalid tab/filters are refused with 422", async () => {
    expect((await list(reqC, "tab=nope")).status).toBe(422);
    expect((await list(reqC, "tab=all&status=bogus")).status).toBe(422);
    expect((await list(reqC, "tab=all&progress=bogus")).status).toBe(422);
  });

  it("tenant isolation: a company B PR never appears for company A users (list, facets, duplicates)", async () => {
    const v = await otherVariant();
    const bPr = await createAs(xcoC, await draftBody({
      title: "scope-companyB", hotel_id: B1,
      lines: [{ product_variant_id: v.variant_id, quantity: "1", uom: "nos", estimated_unit_price: "5.00" }],
    }));
    for (const c of [reqC, req2C, otherC, nobodyC]) {
      for (const tab of ["mine", "all"]) {
        const res = await list(c, `tab=${tab}&q=scope-`);
        expect(idsOf(res)).not.toContain(bPr.id);
        const f = res.body.data.facets;
        const sum = Object.values(f.status).reduce((a, b) => a + b, 0);
        expect(sum).toBe(res.body.data.total);
      }
      const dup = await c.get(`/api/v1/pr/duplicates?hotel_id=${A1}&variant_id=${v.variant_id}`);
      if (c === nobodyC) {
        expect(dup.status).toBe(403);
      } else {
        expect(dup.status).toBe(200);
        expect(dup.body.data.items.map((i) => i.id)).not.toContain(bPr.id);
      }
    }
    // ...and B's own user sees only B.
    expect(idsOf(await list(xcoC, "tab=all&q=scope-"))).toEqual([bPr.id]);
  });
});

describe("PR list — facets, search, pagination", () => {
  let d1, d2, inRev, urgentPr;
  beforeAll(async () => {
    d1 = await createAs(reqC, await draftBody({ title: "facet-alpha Gasket" }));
    d2 = await createAs(reqC, await draftBody({ title: "facet-beta", pr_type: "service" }));
    inRev = await createAs(reqC, await draftBody({ title: "facet-gamma", urgency: "urgent" }));
    urgentPr = inRev;
    await setStatus(inRev.id, "in_review", ", submitted_at = NOW()");
  });

  it("facets: counts sum to total and are invariant to the facet filters", async () => {
    const base = await list(reqC, "tab=mine&q=facet-");
    const f = base.body.data.facets;
    expect(base.body.data.total).toBe(3);
    expect(f.status).toEqual({ draft: 2, in_review: 1 });
    expect(Object.values(f.status).reduce((a, b) => a + b, 0)).toBe(base.body.data.total);
    expect(f.pr_type).toEqual({ goods: 2, service: 1 });
    expect(f.urgency).toEqual({ normal: 2, urgent: 1 });
    expect(f.hotel).toEqual({ [A1]: 3 });
    expect(f.department).toEqual({ [ENG]: 3 });

    const filtered = await list(reqC, "tab=mine&q=facet-&status=draft");
    expect(filtered.body.data.total).toBe(2);
    expect(idsOf(filtered).sort()).toEqual([d1.id, d2.id].sort());
    expect(filtered.body.data.facets).toEqual(f);

    const t = await list(reqC, "tab=mine&q=facet-&pr_type=service&urgency=normal&hotel_id=" + A1 + "&department_id=" + ENG);
    expect(idsOf(t)).toEqual([d2.id]);
    expect(t.body.data.facets).toEqual(f);
  });

  it("search: q matches pr_number, title and line item names, case-insensitively", async () => {
    expect(idsOf(await list(reqC, "tab=mine&q=FACET-ALPHA"))).toEqual([d1.id]);
    expect(idsOf(await list(reqC, `tab=mine&q=${d2.pr_number.toLowerCase()}`))).toEqual([d2.id]);
    // A free-text line name unique to one PR.
    const p = await createAs(reqC, await draftBody({
      title: "search-by-line",
      lines: [{ free_text_name: "Zorblax Coupling", category_id: (await firstUsableVariant()).category_id,
        quantity: "1", uom: "nos", estimated_unit_price: "10.00" }],
    }));
    expect(idsOf(await list(reqC, "tab=mine&q=zORBlax"))).toEqual([p.id]);
    // Catalog line: the variant name.
    const v = await db.one(`SELECT name FROM tbl_product_variant WHERE id = $1`, [(await firstUsableVariant()).variant_id]);
    const byVariant = await list(reqC, `tab=mine&q=${encodeURIComponent(v.name.toUpperCase())}`);
    expect(idsOf(byVariant)).toContain(d1.id);
    // LIKE wildcards in q are literals.
    expect(idsOf(await list(reqC, "tab=mine&q=%25"))).toEqual([]);
  });

  it("pagination: page 2 of size 1 is the second row; total is stable; newest first", async () => {
    const p1 = await list(reqC, "tab=mine&q=facet-&page=1&page_size=1");
    const p2 = await list(reqC, "tab=mine&q=facet-&page=2&page_size=1");
    const p3 = await list(reqC, "tab=mine&q=facet-&page=3&page_size=1");
    const p4 = await list(reqC, "tab=mine&q=facet-&page=4&page_size=1");
    expect(p1.body.data.total).toBe(3);
    expect(p2.body.data.total).toBe(3);
    expect(p4.body.data.total).toBe(3);
    expect(p4.body.data.rows).toEqual([]);
    expect([p1, p2, p3].map((r) => r.body.data.rows[0].id)).toEqual([inRev.id, d2.id, d1.id]);
  });
});

describe("PR list — header_progress", () => {
  it("derives in_queue / partly_in_sourcing / partly_ordered / completed from line progress", async () => {
    const cat = (await firstUsableVariant()).category_id;
    const ft = (n) => ({ free_text_name: n, category_id: cat, quantity: "2", uom: "nos", estimated_unit_price: "10.00" });
    const pr = await createAs(reqC, await draftBody({ title: "progress-matrix", lines: [ft("hp-a"), ft("hp-b"), ft("hp-c")] }));
    const lines = await db.map(`SELECT id FROM tbl_purchase_requisition_line WHERE pr_id = $1 ORDER BY line_no`,
      [pr.id], (r) => r.id);
    const hp = async () => (await list(reqC, "tab=mine&q=progress-matrix")).body.data.rows[0].header_progress;

    expect(await hp()).toBeNull();                       // draft: every line pending
    await setStatus(pr.id, "approved", ", approved_at = NOW(), submitted_at = NOW()");
    expect(await hp()).toBe("in_queue");                 // needs_mapping lines

    const rfq = await makeRFQ(db, { createdBy: REQ, status: 1, is_published: 1, hospitality: A, hotel: A1 });
    rfqIds.push(rfq.rfq_id);
    const rp = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
       VALUES ($1, '', '0', '', '', (SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1), 1) RETURNING id`, [rfq.rfq_id]);
    await db.none(
      `INSERT INTO tbl_pr_line_rfq (pr_line_id, rfq_id, rfq_product_id, quantity, converted_by) VALUES ($1,$2,$3,2,$4)`,
      [lines[0], rfq.rfq_id, rp.id, REQ]);
    expect(await hp()).toBe("partly_in_sourcing");       // one sourcing, two in queue

    await db.none(`UPDATE tbl_purchase_requisition_line SET status = 'closed', close_reason = 'x' WHERE id = ANY($1)`,
      [[lines[1], lines[2]]]);
    expect(await hp()).toBe("in_sourcing");              // the only non-terminal line is sourcing

    await db.none(`UPDATE tbl_purchase_requisition_line SET status = 'active', close_reason = NULL WHERE id = $1`, [lines[1]]);
    const po = await makePO(db, {
      rfq_id: rfq.rfq_id, rfq_product_id: rp.id, status: "approved",
      company_id: A, vendor_user_id: VENDOR, initiated_by: REQ,
    });
    poIds.push(po.po_id);
    expect(await hp()).toBe("partly_ordered");           // line 0 ordered, line 1 still in queue

    await db.none(`UPDATE tbl_purchase_requisition_line SET status = 'closed', close_reason = 'x' WHERE id = $1`, [lines[1]]);
    expect(await hp()).toBe("completed");                // ordered + closed, nothing open

    expect(idsOf(await list(reqC, "tab=mine&progress=completed&q=progress-matrix"))).toEqual([pr.id]);
    expect(idsOf(await list(reqC, "tab=mine&progress=in_queue&q=progress-matrix"))).toEqual([]);
  });
});

describe("PR list — now_with", () => {
  it("labels who holds the PR in every state", async () => {
    const pr = await createAs(reqC, await draftBody({ title: "nowwith" }));
    const nw = async () => (await list(reqC, "tab=mine&q=nowwith")).body.data.rows[0].now_with;
    expect(await nw()).toBe("You");

    // in_review with no reviewer anywhere for eng.
    await db.none(`UPDATE tbl_purchase_requisition SET status = 'in_review', revision = 1 WHERE id = $1`, [pr.id]);
    await db.none(`INSERT INTO tbl_pr_review (pr_id, revision, department_id) VALUES ($1, 1, $2)`, [pr.id, PROC]);
    expect(await nw()).toBe("No eligible reviewer — contact your admin (Procurement)".replace("Procurement", await deptTitle(PROC)));
    await grantPr(NOBODY, "PR Technical Reviewer", { departmentId: PROC });
    expect(await nw()).toBe(`Technical review: ${await deptTitle(PROC)}`);
    await revokeAllPr([NOBODY]);

    // pending_approval: approvers on the current step.
    await setStatus(pr.id, "pending_approval");
    const inst = await db.one(
      `INSERT INTO tbl_approval_instances (entity_type, entity_id, approval_policy_id, status, current_step,
         hospitality_company_id, hotel_id, department_id, initiated_by)
       VALUES ('PR', $1, (SELECT id FROM tbl_approval_policies LIMIT 1), 'PENDING', 2, $2, $3, $4, $5) RETURNING id`,
      [pr.id, A, A1, ENG, REQ]);
    await db.none(`UPDATE tbl_purchase_requisition SET approval_instance_id = $2 WHERE id = $1`, [pr.id, inst.id]);
    const s1 = await db.one(`INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, status)
                              VALUES ($1, 1, 'APPROVED') RETURNING id`, [inst.id]);
    const s2 = await db.one(`INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, status)
                              VALUES ($1, 2, 'PENDING') RETURNING id`, [inst.id]);
    await db.none(`INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
                    VALUES ($1, $2, 'PENDING')`, [s1.id, NOBODY]);
    expect(await nw()).toBe("No eligible approver — contact your admin");
    await db.none(`INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
                    VALUES ($1, $2, 'PENDING')`, [s2.id, OTHER]);
    const otherName = (await db.one(`SELECT name FROM tbl_users WHERE id = $1`, [OTHER])).name;
    expect(await nw()).toBe(`Approval step 2: ${otherName}`);
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = $1`, [inst.id]);
    await db.none(`UPDATE tbl_purchase_requisition SET approval_instance_id = NULL WHERE id = $1`, [pr.id]);

    await setStatus(pr.id, "approved", ", approved_at = NOW()");
    expect(await nw()).toBe("Purchase team");
    await db.none(`UPDATE tbl_purchase_requisition SET assigned_buyer_id = $2 WHERE id = $1`, [pr.id, OTHER]);
    expect(await nw()).toBe(otherName);
    await setStatus(pr.id, "returned");
    expect(await nw()).toBe("You");
  });
});

const deptTitle = async (id) => (await db.one(`SELECT title FROM tbl_department WHERE id = $1`, [id])).title;

describe("PR KPIs", () => {
  it("awaiting_me: a pending review counts for the eligible reviewer only; returned PRs count for the requester", async () => {
    const before = (c) => c.get("/api/v1/pr/kpis").then((r) => r.body.data);
    const reqBefore = await before(reqC);
    const req2Before = await before(req2C);
    expect(reqBefore).toEqual(expect.objectContaining({
      open: expect.any(Number), awaiting_me: expect.any(Number), in_purchase_queue: expect.any(Number),
    }));
    expect("avg_days_to_approval" in reqBefore).toBe(true);

    await grantPr(REQ2, "PR Technical Reviewer", { departmentId: ENG });
    const pr = await createAs(reqC, await draftBody({ title: "kpi-review" }));
    await db.none(`UPDATE tbl_purchase_requisition SET status = 'in_review', revision = 1, submitted_at = NOW() WHERE id = $1`, [pr.id]);
    await db.none(`INSERT INTO tbl_pr_review (pr_id, revision, department_id) VALUES ($1, 1, $2)`, [pr.id, ENG]);
    expect((await before(req2C)).awaiting_me).toBe(req2Before.awaiting_me + 1);
    expect((await before(reqC)).awaiting_me).toBe(reqBefore.awaiting_me);
    expect((await before(reqC)).open).toBe(reqBefore.open + 1);

    await db.none(`UPDATE tbl_purchase_requisition SET status = 'returned' WHERE id = $1`, [pr.id]);
    expect((await before(reqC)).awaiting_me).toBe(reqBefore.awaiting_me + 1);
    expect((await before(req2C)).awaiting_me).toBe(req2Before.awaiting_me);
  });

  it("awaiting_me: pending approver rows on the current step of the PR's own instance", async () => {
    const pr = await createAs(reqC, await draftBody({ title: "kpi-approval" }));
    const base = (await otherC.get("/api/v1/pr/kpis")).body.data.awaiting_me;
    await setStatus(pr.id, "pending_approval");
    const inst = await db.one(
      `INSERT INTO tbl_approval_instances (entity_type, entity_id, approval_policy_id, status, current_step,
         hospitality_company_id, hotel_id, department_id, initiated_by)
       VALUES ('PR', $1, (SELECT id FROM tbl_approval_policies LIMIT 1), 'PENDING', 1, $2, $3, $4, $5) RETURNING id`,
      [pr.id, A, A1, ENG, REQ]);
    await db.none(`UPDATE tbl_purchase_requisition SET approval_instance_id = $2 WHERE id = $1`, [pr.id, inst.id]);
    const s = await db.one(`INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, status)
                             VALUES ($1, 1, 'PENDING') RETURNING id`, [inst.id]);
    await db.none(`INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
                    VALUES ($1, $2, 'PENDING')`, [s.id, OTHER]);
    expect((await otherC.get("/api/v1/pr/kpis")).body.data.awaiting_me).toBe(base + 1);
    await db.none(`UPDATE tbl_approval_step_approvers SET status = 'APPROVED' WHERE approval_instance_step_id = $1`, [s.id]);
    expect((await otherC.get("/api/v1/pr/kpis")).body.data.awaiting_me).toBe(base);
  });

  it("avg_days_to_approval: mean over PRs approved in the last 90 days, 1 decimal; older ones excluded", async () => {
    const mk = async (title, days, ageDays) => {
      const pr = await createAs(xcoC, await draftBody({ title, hotel_id: B1 }));
      await db.none(
        `UPDATE tbl_purchase_requisition SET status = 'approved',
                submitted_at = NOW() - make_interval(days => $2 + $3),
                approved_at = NOW() - make_interval(days => $3) WHERE id = $1`, [pr.id, days, ageDays]);
      return pr;
    };
    // Company B is otherwise empty, so the set is exactly these.
    expect((await xcoC.get("/api/v1/pr/kpis")).body.data.avg_days_to_approval).toBeNull();
    await mk("avg-1", 2, 5);
    await mk("avg-2", 3, 10);
    await mk("avg-old", 40, 120);
    const k = (await xcoC.get("/api/v1/pr/kpis")).body.data;
    expect(k.avg_days_to_approval).toBe(2.5);
    expect(k.in_purchase_queue).toBe(3);
  });
});

describe("PR duplicates", () => {
  let v, p1, p2, own;
  beforeAll(async () => {
    v = await otherVariant();
    const line = { product_variant_id: v.variant_id, quantity: "1", uom: "nos", estimated_unit_price: "10.00" };
    p1 = await createAs(req2C, await draftBody({ title: "dup-a1", lines: [line] }));
    p2 = await createAs(req2C, await draftBody({ title: "dup-a2", hotel_id: A2, lines: [line] }));
    // Drafts are private; only submitted PRs are hinted.
    await setStatus(p1.id, "in_review");
    await setStatus(p2.id, "in_review");
  });
  const dups = (c, variantId = v.variant_id, hotelId = A1) =>
    c.get(`/api/v1/pr/duplicates?hotel_id=${hotelId}&variant_id=${variantId}`);

  it("counts same-company open PRs in the last 30 days; unreadable ones come back readable:false without a title", async () => {
    const res = await dups(reqC);
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
    const byId = Object.fromEntries(res.body.data.items.map((i) => [i.id, i]));
    expect(byId[p1.id]).toMatchObject({ kind: "pr", number: p1.pr_number, readable: true, title: "dup-a1" });
    expect(byId[p2.id]).toMatchObject({ kind: "pr", number: p2.pr_number, readable: false });
    expect(byId[p2.id].title).toBeUndefined();
    expect(byId[p2.id].hotel_name).toEqual(expect.any(String));
    expect(byId[p1.id].created_at).toBeTruthy();
  });

  it("excludes PRs older than 30 days, terminal PRs and cancelled lines", async () => {
    await db.none(`UPDATE tbl_purchase_requisition SET created_at = NOW() - INTERVAL '31 days' WHERE id = $1`, [p2.id]);
    expect((await dups(reqC)).body.data.items.map((i) => i.id)).toEqual([p1.id]);
    await db.none(`UPDATE tbl_purchase_requisition SET created_at = NOW() WHERE id = $1`, [p2.id]);
    await setStatus(p2.id, "cancelled");
    expect((await dups(reqC)).body.data.count).toBe(1);
    await setStatus(p2.id, "in_review");
    await db.none(`UPDATE tbl_purchase_requisition_line SET status = 'cancelled' WHERE pr_id = $1`, [p2.id]);
    expect((await dups(reqC)).body.data.count).toBe(1);
    await db.none(`UPDATE tbl_purchase_requisition_line SET status = 'active' WHERE pr_id = $1`, [p2.id]);
    expect((await dups(reqC)).body.data.count).toBe(2);
  });

  it("never discloses drafts (R11)", async () => {
    const draft = await createAs(req2C, await draftBody({
      title: "dup-draft", lines: [{ product_variant_id: v.variant_id, quantity: "1", uom: "nos", estimated_unit_price: "10.00" }] }));
    for (const c of [reqC, req2C]) {
      expect((await dups(c)).body.data.items.map((i) => i.id)).not.toContain(draft.id);
    }
    await setStatus(draft.id, "pending_approval");
    expect((await dups(reqC)).body.data.items.map((i) => i.id)).toContain(draft.id);
    await setStatus(draft.id, "draft");
  });

  it("RFQ window: 30 days on the naive-UTC timestamp, reported as last_activity_at", async () => {
    const mk = async (interval) => {
      const r = await makeRFQ(db, { createdBy: REQ, status: 1, is_published: 1, hospitality: A, hotel: A1 });
      rfqIds.push(r.rfq_id);
      await db.none(`INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
                     VALUES ($1, '', '0', '', '', $2, 1)`, [r.rfq_id, v.variant_id]);
      await db.none(`UPDATE tbl_rfq SET "timestamp" = (NOW() AT TIME ZONE 'UTC') - $2::interval WHERE id = $1`, [r.rfq_id, interval]);
      return r.rfq_id;
    };
    const inside = await mk("29 days 23 hours");
    const outside = await mk("30 days 1 hour");
    const items = (await dups(reqC)).body.data.items.filter((i) => i.kind === "rfq");
    expect(items.map((i) => i.id)).toContain(inside);
    expect(items.map((i) => i.id)).not.toContain(outside);
    const it1 = items.find((i) => i.id === inside);
    expect(it1.created_at).toBeNull();
    const ageH = (Date.now() - new Date(it1.last_activity_at).getTime()) / 3600000;
    expect(ageH).toBeGreaterThan(29.9 * 24 - 1);
    expect(ageH).toBeLessThan(30 * 24);
  });

  it("includes live RFQs with the variant (only closed ones drop out — a withdrawn publish request is live, R24), readable per rfq.read or authorship", async () => {
    const open = await makeRFQ(db, { createdBy: REQ, status: 1, is_published: 1, hospitality: A, hotel: A1 });
    const closed = await makeRFQ(db, { createdBy: REQ, status: 2, is_published: 1, hospitality: A, hotel: A1 });
    const withdrawn = await makeRFQ(db, { createdBy: REQ, status: 5, is_published: 0, hospitality: A, hotel: A1 });
    const theirs = await makeRFQ(db, { createdBy: REQ2, status: 1, is_published: 1, hospitality: A, hotel: A2 });
    for (const r of [open, closed, withdrawn, theirs]) {
      rfqIds.push(r.rfq_id);
      await db.none(
        `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
         VALUES ($1, '', '0', '', '', $2, 1)`, [r.rfq_id, v.variant_id]);
    }
    const res = await dups(reqC);
    const rfqs = res.body.data.items.filter((i) => i.kind === "rfq");
    const got = rfqs.map((i) => i.id);
    expect(got).toEqual(expect.arrayContaining([open.rfq_id, withdrawn.rfq_id, theirs.rfq_id]));
    expect(got).not.toContain(closed.rfq_id);
    const byId = Object.fromEntries(rfqs.map((i) => [i.id, i]));
    expect(byId[open.rfq_id].readable).toBe(true);
    expect(byId[theirs.rfq_id].readable).toBe(false);
    expect(byId[theirs.rfq_id].title).toBeUndefined();
    expect(res.body.data.count).toBe(res.body.data.items.length);
  });

  it("refuses a caller with no PR access on the hotel; bad params are 422", async () => {
    expect((await dups(nobodyC)).status).toBe(403);
    expect((await reqC.get("/api/v1/pr/duplicates?hotel_id=x&variant_id=1")).status).toBe(422);
  });
});
