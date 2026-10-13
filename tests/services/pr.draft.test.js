// Purchase Requisitions — drafts, access rules, catalog guards, pickers (Task 3).
//
// Product-level: real HTTP through the full middleware chain against real
// Postgres; assertions read the response and the committed rows. Pattern B
// (commit + cleanup by tracked ids).
//
// Personas
//   REQ   a1_eng_buyer      PR Requester at (A, A1, eng)
//   REQ2  a1_proc_techEval  PR Requester at (A, A1, eng) — a second requester on the same cell
//   OTHER a1_proc_buyer     no PR role (granted narrowly inside single tests)
//   XCO   companyB_admin    another company
//   SUPER superAdmin        user_type 8 (only inside the access test)

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import {
  grantPr, revokeAllPr, draftBody, firstUsableVariant, cleanupPrs, makePrPolicy, dropPrPolicies, istDate,
} from "../helpers/prFixtures.js";
import { forbiddenMessage } from "../../app/services/pr/prAccess.js";

const A = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const B1 = IDS.hotels.B1;
const ENG = IDS.departments.eng;
const PROC = IDS.departments.proc;
const REQ = IDS.users.a1_eng_buyer;
const REQ2 = IDS.users.a1_proc_techEval;
const OTHER = IDS.users.a1_proc_buyer;
const XCO = IDS.users.companyB_admin;
const SUPER = IDS.users.superAdmin;
const PERSONAS = [REQ, REQ2, OTHER, XCO, SUPER];

const prIds = [];
let originalUserTypes = [];
let reqC, req2C, otherC, xcoC;

async function createAs(client, body) {
  const res = await client.post("/api/v1/pr").send(body);
  if (res.body?.data?.id) prIds.push(res.body.data.id);
  return res;
}
const createPr = async (body) => createAs(reqC, body ?? (await draftBody()));

const fieldsOf = (res) => (res.body.details || []).map((d) => d.field);
const linesOf = (prId) => db.any(
  `SELECT id, line_no, line_kind, product_variant_id, free_text_name, category_id, quantity::text AS quantity,
          uom, estimated_unit_price::text AS estimated_unit_price, specification, status, mapped_variant_id
     FROM tbl_purchase_requisition_line WHERE pr_id = $1 ORDER BY line_no`, [prId]);
const eventsOf = (prId) => db.any(
  `SELECT event_type, actor_id, payload, revision FROM tbl_pr_event WHERE pr_id = $1 ORDER BY id`, [prId]);
const prRow = (prId) => db.one(
  `SELECT *, required_by_date::text AS required_by_date FROM tbl_purchase_requisition WHERE id = $1`, [prId]);

beforeAll(async () => {
  originalUserTypes = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS]);
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [[REQ, REQ2, OTHER, XCO]]);
  await revokeAllPr(PERSONAS);
  await grantPr(REQ, "PR Requester", { departmentId: ENG });
  await grantPr(REQ2, "PR Requester", { departmentId: ENG });
  reqC = await httpClient(REQ);
  req2C = await httpClient(REQ2);
  otherC = await httpClient(OTHER);
  xcoC = await httpClient(XCO);
});

afterAll(async () => {
  await cleanupPrs(prIds);
  await dropPrPolicies();
  await revokeAllPr(PERSONAS);
  for (const u of originalUserTypes) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
  }
});

describe("PR drafts — create", () => {
  it("create.ok: stores a draft at revision 0, derives the catalog category, ignores client tenancy/totals", async () => {
    const v = await firstUsableVariant();
    const body = await draftBody({ hospitality_company_id: IDS.hospitality.B, estimated_total: "1.00", status: "approved" });
    expect(body.lines[0].category_id).not.toBe(v.category_id);

    const res = await createPr(body);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.id).toEqual(expect.any(Number));
    expect(res.body.data.pr_number).toMatch(/^PR-\d{4}-[0-9A-Z]+$/);

    const pr = await prRow(res.body.data.id);
    expect(pr).toMatchObject({
      status: "draft", revision: 0, estimated_total: null, raised_by: REQ,
      hospitality_company_id: A, hotel_id: A1, department_id: ENG, process_id: null,
      title: "Chiller spares", pr_type: "goods", urgency: "normal",
      required_by_date: body.required_by_date, pr_number: res.body.data.pr_number,
    });

    const lines = await linesOf(res.body.data.id);
    expect(lines.map((l) => l.line_no)).toEqual([1, 2]);
    expect(lines[0]).toMatchObject({
      line_kind: "catalog", product_variant_id: v.variant_id, free_text_name: null,
      category_id: v.category_id, quantity: "2.000", estimated_unit_price: "1500.00", uom: "nos",
    });
    expect(lines[1]).toMatchObject({
      line_kind: "free_text", product_variant_id: null, free_text_name: "Compressor relay 24V",
      category_id: body.lines[1].category_id, quantity: "4.000", estimated_unit_price: "250.50",
    });

    const events = await eventsOf(res.body.data.id);
    expect(events).toEqual([expect.objectContaining({ event_type: "created", actor_id: REQ, revision: 0 })]);
  });

  it("create.forbidden-cell: no pr.create on the cell → 403 PR_FORBIDDEN, nothing written", async () => {
    const title = `forbidden-${Date.now()}`;
    const asOther = await createAs(otherC, await draftBody({ title }));
    expect(asOther.status).toBe(403);
    expect(asOther.body).toMatchObject({ status: 0, code: "PR_FORBIDDEN" });
    expect(asOther.body.message).toMatch(/raise purchase requisitions/);
    // The refusal names what was refused, per permission.
    expect(forbiddenMessage("pr.convert")).toMatch(/purchase queue/);
    expect(forbiddenMessage("pr.evaluate")).toMatch(/technical reviewer/);

    const wrongDept = await createPr(await draftBody({ title, department_id: PROC }));
    expect(wrongDept.status).toBe(403);
    expect(wrongDept.body.code).toBe("PR_FORBIDDEN");

    const n = await db.one(`SELECT COUNT(*)::int AS c FROM tbl_purchase_requisition WHERE title = $1`, [title]);
    expect(n.c).toBe(0);
  });

  it("create.cross-tenant-ids: foreign hotel → 403; unknown variant / category → 422 PR_VALIDATION", async () => {
    const foreign = await createPr(await draftBody({ hotel_id: B1 }));
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("PR_FORBIDDEN");

    const noHotel = await createPr(await draftBody({ hotel_id: 999999999 }));
    expect(noHotel.status).toBe(403);

    const base = await draftBody();
    const badVariant = await createPr({ ...base, lines: [{ ...base.lines[0], product_variant_id: 999999999 }, base.lines[1]] });
    expect(badVariant.status).toBe(422);
    expect(badVariant.body.code).toBe("PR_VALIDATION");
    expect(badVariant.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "product_variant_id", line_no: 1 })]));

    const badCategory = await createPr({ ...base, lines: [base.lines[0], { ...base.lines[1], category_id: 999999999 }] });
    expect(badCategory.status).toBe(422);
    expect(badCategory.body.code).toBe("PR_VALIDATION");
    expect(badCategory.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "category_id", line_no: 2 })]));
  });

  it("create.validation: each bad field → 422 PR_VALIDATION naming the field; all errors at once", async () => {
    const base = await draftBody();
    const cat = base.lines[0];
    const free = base.lines[1];
    const yesterday = await istDate(-1);
    const withLine = (patch) => ({ ...base, lines: [{ ...cat, ...patch }] });
    const cases = [
      ["title", { ...base, title: "" }],
      ["title", { ...base, title: "   " }],
      ["justification", { ...base, justification: "" }],
      ["required_by_date", { ...base, required_by_date: yesterday }],
      ["required_by_date", { ...base, required_by_date: "2026-02-30" }],
      ["lines", { ...base, lines: [] }],
      ["lines", { ...base, lines: Array.from({ length: 201 }, () => ({ ...cat })) }],
      ["quantity", withLine({ quantity: 0 })],
      ["quantity", withLine({ quantity: "0" })],
      ["quantity", withLine({ quantity: "-1" })],
      ["quantity", withLine({ quantity: "abc" })],
      ["quantity", withLine({ quantity: "1.2345" })],
      ["estimated_unit_price", withLine({ estimated_unit_price: "10.123" })],
      ["estimated_unit_price", withLine({ estimated_unit_price: "100000000000000.00" })],
      ["estimated_unit_price", withLine({ estimated_unit_price: "0.00" })],
      ["uom", withLine({ uom: "" })],
      ["line_kind", withLine({ free_text_name: "Also free text" })],
      ["line_kind", { ...base, lines: [{ quantity: "1", uom: "nos", estimated_unit_price: "1" }] }],
      ["category_id", { ...base, lines: [{ ...free, category_id: null }] }],
      ["pr_type", { ...base, pr_type: "food" }],
      ["urgency", { ...base, urgency: "asap" }],
    ];
    for (const [field, body] of cases) {
      const res = await createPr(body);
      expect({ field, status: res.status, code: res.body.code }).toEqual({ field, status: 422, code: "PR_VALIDATION" });
      expect({ field, named: fieldsOf(res).includes(field) }).toEqual({ field, named: true });
    }

    const many = await createPr({ ...base, title: "", lines: [{ ...cat, uom: "" }] });
    expect(many.status).toBe(422);
    expect(fieldsOf(many)).toEqual(expect.arrayContaining(["title", "uom"]));
    expect(many.body.details.find((d) => d.field === "uom").line_no).toBe(1);

    // The Σ of line values must fit estimated_total NUMERIC(18,2) (9,999,999,999,999,999.99).
    const overflow = await createPr({ ...base, lines: [{ ...cat, quantity: "100.001", estimated_unit_price: "99999999999999.99" }] });
    expect(overflow.status).toBe(422);
    expect(overflow.body.details).toEqual([expect.objectContaining({ field: "lines" })]);
    const twoLines = await createPr({ ...base, lines: [
      { ...cat, quantity: "60", estimated_unit_price: "99999999999999.99" },
      { ...cat, quantity: "40.001", estimated_unit_price: "99999999999999.99" }] });
    expect(twoLines.status).toBe(422);
    expect(fieldsOf(twoLines)).toEqual(["lines"]);
    const atMax = await createPr({ ...base, lines: [{ ...cat, quantity: "100", estimated_unit_price: "99999999999999.99" }] });
    expect(atMax.status).toBe(200); // 9,999,999,999,999,999.00 fits

    // Boundaries that must pass: today's IST date; the largest price.
    const ok = await createPr({ ...base, required_by_date: await istDate(0), lines: [{ ...cat, estimated_unit_price: "99999999999999.99" }] });
    expect(ok.status).toBe(200);
  });

  it("create.fractional: 0.5 × 1250000.75 is stored and returned exactly", async () => {
    const base = await draftBody();
    const res = await createPr({ ...base, lines: [{ ...base.lines[0], quantity: "0.5", estimated_unit_price: "1250000.75" }] });
    expect(res.status).toBe(200);
    const [line] = await linesOf(res.body.data.id);
    expect(line.quantity).toBe("0.500");
    expect(line.estimated_unit_price).toBe("1250000.75");

    const detail = await reqC.get(`/api/v1/pr/${res.body.data.id}`);
    expect(detail.body.data.lines[0]).toMatchObject({
      quantity: "0.500", estimated_unit_price: "1250000.75", line_value: "625000.38",
    });
    expect(detail.body.data.pr.estimated_total).toBe("625000.38");
  });

  it("create.unusable-variant: a variant failing the RFQ usable predicate → 422 PR_VARIANT_NOT_USABLE", async () => {
    const v = await firstUsableVariant();
    const body = await draftBody();
    await db.none(`UPDATE tbl_product_variant SET is_approve = 0 WHERE id = $1`, [v.variant_id]);
    try {
      const res = await createPr(body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("PR_VARIANT_NOT_USABLE");
      expect(res.body.details).toEqual([expect.objectContaining({ line_no: 1, product_variant_id: v.variant_id })]);
    } finally {
      await db.none(`UPDATE tbl_product_variant SET is_approve = 1 WHERE id = $1`, [v.variant_id]);
    }
  });
});

describe("PR drafts — read access", () => {
  let prId;
  beforeAll(async () => {
    const res = await createPr();
    prId = res.body.data.id;
  });

  it("get.detail: the requester sees lines with progress, events and capabilities", async () => {
    const res = await reqC.get(`/api/v1/pr/${prId}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.pr).toMatchObject({
      id: prId, status: "draft", hotel_id: A1, department_id: ENG, raised_by: REQ,
      hotel_name: expect.any(String), department_name: "Engineering", raised_by_name: expect.any(String),
    });
    expect(d.pr.required_by_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.lines).toHaveLength(2);
    for (const l of d.lines) {
      expect(l.progress).toBe("pending");
      expect(l.clauses).toEqual([]);
      expect(l.attachments).toEqual([]);
      expect(l.links).toEqual([]);
    }
    expect(d.lines[0]).toMatchObject({ line_kind: "catalog", variant_name: expect.any(String), category_title: expect.any(String) });
    expect(d.lines[1]).toMatchObject({ line_kind: "free_text", free_text_name: "Compressor relay 24V" });
    expect(d.events.map((e) => e.event_type)).toEqual(["created"]);
    expect(d.reviews).toEqual([]);
    expect(d.comments).toEqual([]);
    expect(d.capabilities).toEqual({
      can_edit: true, can_submit: true, can_withdraw: false, can_cancel: true, can_copy: true,
    });
  });

  it("get.detail: a caller who cannot read the PR gets 404 PR_NOT_FOUND (no existence leak)", async () => {
    for (const client of [otherC, xcoC]) {
      const res = await client.get(`/api/v1/pr/${prId}`);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ status: 0, code: "PR_NOT_FOUND" });
    }
    const missing = await reqC.get(`/api/v1/pr/999999999`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("PR_NOT_FOUND");
    // A non-numeric id matches no PR route; the PR fallback answers in the PR contract.
    for (const res of [await reqC.get(`/api/v1/pr/abc`), await reqC.put(`/api/v1/pr/abc`).send({}),
                       await reqC.post(`/api/v1/pr/abc/cancel`).send({ reason: "x" })]) {
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ status: 0, code: "PR_NOT_FOUND" });
    }
  });

  it("get.access: pr.read is cell-scoped; pr.convert covers the hotel; reviewer/approver/super admin read", async () => {
    const asOther = () => otherC.get(`/api/v1/pr/${prId}`);

    // pr.read on the PR's own cell (a second requester): reads, but has no requester capabilities.
    const peer = await req2C.get(`/api/v1/pr/${prId}`);
    expect(peer.status).toBe(200);
    expect(peer.body.data.capabilities).toEqual({
      can_edit: false, can_submit: false, can_withdraw: false, can_cancel: false, can_copy: false,
    });

    // pr.read on another department of the same hotel → still 404.
    const approverProc = await grantPr(OTHER, "PR Approver", { departmentId: PROC });
    expect((await asOther()).status).toBe(404);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [approverProc]);

    // pr.convert on the hotel (any department) → reads.
    const buyer = await grantPr(OTHER, "PR Buyer", { departmentId: PROC });
    expect((await asOther()).status).toBe(200);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [buyer]);
    expect((await asOther()).status).toBe(404);

    // pr.convert at another hotel → 404.
    const buyerA2 = await grantPr(OTHER, "PR Buyer", { hotelId: IDS.hotels.A2 });
    expect((await asOther()).status).toBe(404);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [buyerA2]);

    // pr.evaluate on a department the PR is routed to for review (any revision) → reads.
    const reviewer = await grantPr(OTHER, "PR Technical Reviewer", { departmentId: PROC });
    expect((await asOther()).status).toBe(404);
    const review = await db.one(
      `INSERT INTO tbl_pr_review (pr_id, revision, department_id, status) VALUES ($1, 0, $2, 'superseded') RETURNING id`,
      [prId, PROC]);
    expect((await asOther()).status).toBe(200);
    await db.none(`DELETE FROM tbl_pr_review WHERE id = $1`, [review.id]);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [reviewer]);
    expect((await asOther()).status).toBe(404);

    // Approver read: a non-removed approver row on the PR's CURRENT approval instance (approval_instance_id).
    const policyId = await makePrPolicy({ hotelId: A1, steps: [{ source: "USER", id: OTHER }] });
    const instIds = [];
    const addInstance = async (approverId) => {
      const inst = await db.one(
        `INSERT INTO tbl_approval_instances (entity_type, entity_id, approval_policy_id, status, current_step,
                                             hospitality_company_id, hotel_id, department_id, initiated_by)
         VALUES ('PR', $1, $2, 'PENDING', 1, $3, $4, $5, $6) RETURNING id`, [prId, policyId, A, A1, ENG, REQ]);
      instIds.push(inst.id);
      const step = await db.one(
        `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order) VALUES ($1, 1) RETURNING id`, [inst.id]);
      const row = await db.one(
        `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id) VALUES ($1, $2) RETURNING id`,
        [step.id, approverId]);
      return { instId: inst.id, approverRowId: row.id };
    };
    const setCurrent = (instId) =>
      db.none(`UPDATE tbl_purchase_requisition SET approval_instance_id = $2 WHERE id = $1`, [prId, instId]);
    try {
      const first = await addInstance(OTHER);
      expect((await asOther()).status).toBe(404); // an instance of this PR, but not its current one
      await setCurrent(first.instId);
      expect((await asOther()).status).toBe(200);
      await db.none(`UPDATE tbl_approval_step_approvers SET removed_at = NOW(), status = 'REMOVED' WHERE id = $1`, [first.approverRowId]);
      expect((await asOther()).status).toBe(404);
      await db.none(`UPDATE tbl_approval_step_approvers SET removed_at = NULL, status = 'PENDING' WHERE id = $1`, [first.approverRowId]);
      expect((await asOther()).status).toBe(200);

      // Withdraw + resubmit: the first instance is cancelled and a new one becomes current.
      // The previous instance's approver loses read.
      await db.none(`UPDATE tbl_approval_instances SET status = 'CANCELLED' WHERE id = $1`, [first.instId]);
      const second = await addInstance(REQ2);
      await setCurrent(second.instId);
      expect((await asOther()).status).toBe(404);
    } finally {
      await setCurrent(null);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instIds]);
    }

    // A PR Buyer of ANOTHER company never reads it.
    const xcoBuyer = await grantPr(XCO, "PR Buyer", { companyId: IDS.hospitality.B, hotelId: null });
    expect((await xcoC.get(`/api/v1/pr/${prId}`)).status).toBe(404);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [xcoBuyer]);

    // Super admin (user_type 8) reads everything.
    const superType = (await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [SUPER])).user_type;
    await db.none(`UPDATE tbl_users SET user_type = 8 WHERE id = $1`, [SUPER]);
    try {
      const superC = await httpClient(SUPER);
      const res = await superC.get(`/api/v1/pr/${prId}`);
      expect(res.status).toBe(200);
      expect(res.body.data.capabilities.can_edit).toBe(false);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [SUPER, superType]);
    }
  });
});

describe("PR drafts — update, cancel, copy", () => {
  it("update.replace: lines sent without ids replace the old ones (line_no restarts at 1); header diff recorded", async () => {
    const created = await createPr();
    const id = created.body.data.id;
    const before = await linesOf(id);
    const body = await draftBody({
      title: "Chiller spares (revised)",
      lines: [{ free_text_name: "Relay socket", category_id: before[1].category_id, quantity: "3", uom: "pcs", estimated_unit_price: "99.99" }],
    });
    const res = await reqC.put(`/api/v1/pr/${id}`).send(body);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id });

    const after = await linesOf(id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ line_no: 1, line_kind: "free_text", free_text_name: "Relay socket", quantity: "3.000", uom: "pcs" });
    expect(before.map((l) => l.id)).not.toContain(after[0].id); // no id sent → a new line
    expect((await prRow(id)).title).toBe("Chiller spares (revised)");

    const events = await eventsOf(id);
    expect(events.map((e) => e.event_type)).toEqual(["created", "updated"]);
    const updated = events[1];
    expect(updated.actor_id).toBe(REQ);
    expect(updated.payload.changed).toEqual({ title: { from: "Chiller spares", to: "Chiller spares (revised)" } });
    expect(updated.payload.lines).toEqual({ before: 2, after: 1, kept: 0, added: 1, removed: 2 });
  });

  // Seed reviewer-style work on a line: one clause + one line attachment.
  const addClauseAndAttachment = async (prId, lineId) => {
    await db.none(`INSERT INTO tbl_pr_line_clause (pr_line_id, clause_text, added_by) VALUES ($1, 'IP54 rated', $2)`, [lineId, REQ]);
    await db.none(
      `INSERT INTO tbl_pr_attachment (pr_id, pr_line_id, kind, file_url, file_name, uploaded_by)
       VALUES ($1, $2, 'datasheet', 'https://example.test/ds.pdf', 'ds.pdf', $3)`, [prId, lineId, REQ]);
  };
  const workOn = async (lineId) => ({
    clauses: (await db.one(`SELECT COUNT(*)::int AS c FROM tbl_pr_line_clause WHERE pr_line_id = $1`, [lineId])).c,
    attachments: (await db.one(`SELECT COUNT(*)::int AS c FROM tbl_pr_attachment WHERE pr_line_id = $1`, [lineId])).c,
  });
  // The PUT body that re-sends the saved lines with their ids (as the FE edit form does).
  const resend = (base, saved, patches = {}) => base.lines.map((l, i) => ({ ...l, id: saved[i].id, ...(patches[i] || {}) }));

  it("update keeps line identity: a line sent with its id keeps its clauses and attachments; reorder renumbers", async () => {
    const base = await draftBody();
    const id = (await createPr(base)).body.data.id;
    const saved = await linesOf(id);
    await addClauseAndAttachment(id, saved[0].id);

    // Edit the catalog line's quantity and swap the two lines' order.
    const lines = resend(base, saved, { 0: { quantity: "7.5" } });
    const res = await reqC.put(`/api/v1/pr/${id}`).send({ ...base, lines: [lines[1], lines[0]] });
    expect(res.status).toBe(200);

    const after = await linesOf(id);
    expect(after.map((l) => [l.id, l.line_no])).toEqual([[saved[1].id, 1], [saved[0].id, 2]]);
    expect(after[1]).toMatchObject({ id: saved[0].id, quantity: "7.500", category_id: saved[0].category_id });
    expect(await workOn(saved[0].id)).toEqual({ clauses: 1, attachments: 1 });
    const updated = (await eventsOf(id)).pop();
    expect(updated.payload.lines).toEqual({ before: 2, after: 2, kept: 2, added: 0, removed: 0 });
  });

  it("update of a returned PR works and keeps the reviewer's clause", async () => {
    const base = await draftBody();
    const id = (await createPr(base)).body.data.id;
    const saved = await linesOf(id);
    await addClauseAndAttachment(id, saved[1].id);
    await db.none(
      `UPDATE tbl_purchase_requisition SET status = 'returned', revision = 1, returned_note = 'Fix qty' WHERE id = $1`, [id]);

    const res = await reqC.put(`/api/v1/pr/${id}`).send({ ...base, lines: resend(base, saved, { 1: { quantity: "6" } }) });
    expect(res.status).toBe(200);
    const after = await linesOf(id);
    expect(after.map((l) => l.id)).toEqual(saved.map((l) => l.id));
    expect(after[1].quantity).toBe("6.000");
    expect(await workOn(saved[1].id)).toEqual({ clauses: 1, attachments: 1 });
    expect(await prRow(id)).toMatchObject({ status: "returned", revision: 1 });
    expect((await eventsOf(id)).pop()).toMatchObject({ event_type: "updated", revision: 1 });
  });

  it("update refuses a line id that is not one of this PR's lines → 422 PR_VALIDATION, nothing changes", async () => {
    const base = await draftBody();
    const id = (await createPr(base)).body.data.id;
    const otherPrId = (await createPr(base)).body.data.id;
    const foreignLine = (await linesOf(otherPrId))[0];
    const saved = await linesOf(id);

    const res = await reqC.put(`/api/v1/pr/${id}`).send({
      ...base, title: "should not save", lines: [{ ...base.lines[0], id: foreignLine.id }, { ...base.lines[1], id: saved[1].id }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("PR_VALIDATION");
    expect(res.body.details).toEqual([expect.objectContaining({ field: "id", line_no: 1 })]);
    expect(await linesOf(id)).toEqual(saved);
    expect(await linesOf(otherPrId)).toHaveLength(2);
    expect((await prRow(id)).title).toBe("Chiller spares");

    // The same line twice, and an id on create, are refused too.
    const dup = await reqC.put(`/api/v1/pr/${id}`).send({ ...base, lines: [{ ...base.lines[0], id: saved[0].id }, { ...base.lines[0], id: saved[0].id }] });
    expect(dup.status).toBe(422);
    expect(dup.body.details).toEqual([expect.objectContaining({ field: "id", line_no: 2 })]);
    const onCreate = await createPr({ ...base, lines: [{ ...base.lines[0], id: saved[0].id }] });
    expect(onCreate.status).toBe(422);
    expect(fieldsOf(onCreate)).toEqual(["id"]);
  });

  it("update deletes a line left out of the body (with its clauses) and renumbers the rest", async () => {
    const base = await draftBody();
    const id = (await createPr(base)).body.data.id;
    const saved = await linesOf(id);
    await addClauseAndAttachment(id, saved[0].id);

    const res = await reqC.put(`/api/v1/pr/${id}`).send({ ...base, lines: [{ ...base.lines[1], id: saved[1].id }] });
    expect(res.status).toBe(200);
    const after = await linesOf(id);
    expect(after.map((l) => [l.id, l.line_no])).toEqual([[saved[1].id, 1]]);
    expect(await workOn(saved[0].id)).toEqual({ clauses: 0, attachments: 0 });
    expect((await eventsOf(id)).pop().payload.lines).toEqual({ before: 2, after: 1, kept: 1, added: 0, removed: 1 });
  });

  it("update re-derives the category when a kept catalog line changes variant, keeping its clauses", async () => {
    const v = await firstUsableVariant();
    const other = await db.one(
      `SELECT pv.id AS variant_id, cat.category_id
         FROM tbl_product_variant pv JOIN tbl_product p ON p.id = pv.product_id
         CROSS JOIN LATERAL (SELECT pc.category_id FROM tbl_product_categories pc JOIN tbl_category c ON c.id = pc.category_id
                              WHERE pc.product_id = p.id ORDER BY pc.category_id LIMIT 1) cat
        WHERE p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve = 1 AND pv.is_approve = 1
          AND cat.category_id <> $1
        ORDER BY pv.id LIMIT 1`, [v.category_id]);
    const base = await draftBody();
    const id = (await createPr(base)).body.data.id;
    const saved = await linesOf(id);
    await addClauseAndAttachment(id, saved[0].id);

    const res = await reqC.put(`/api/v1/pr/${id}`).send({
      ...base, lines: resend(base, saved, { 0: { product_variant_id: other.variant_id, category_id: v.category_id } }),
    });
    expect(res.status).toBe(200);
    const [line] = await linesOf(id);
    expect(line).toMatchObject({ id: saved[0].id, product_variant_id: other.variant_id, category_id: Number(other.category_id) });
    expect(await workOn(saved[0].id)).toEqual({ clauses: 1, attachments: 1 });
  });

  it("update.after-submit: a draft submitted from another tab → 409 PR_STATE_CONFLICT, nothing changes", async () => {
    const created = await createPr();
    const id = created.body.data.id;
    await db.none(`UPDATE tbl_purchase_requisition SET status = 'in_review' WHERE id = $1`, [id]);
    const before = await linesOf(id);
    const res = await reqC.put(`/api/v1/pr/${id}`).send(await draftBody({ title: "edited in tab 1", lines: [] }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: 0, code: "PR_STATE_CONFLICT" });
    expect(await linesOf(id)).toEqual(before);
    expect((await prRow(id)).title).toBe("Chiller spares");
    expect((await eventsOf(id)).map((e) => e.event_type)).toEqual(["created"]);
  });

  it("update.not-owner: another requester on the same cell cannot edit, cancel or copy → 404", async () => {
    const created = await createPr();
    const id = created.body.data.id;
    const put = await req2C.put(`/api/v1/pr/${id}`).send(await draftBody({ title: "hijack" }));
    expect(put.status).toBe(404);
    expect(put.body.code).toBe("PR_NOT_FOUND");
    expect((await req2C.post(`/api/v1/pr/${id}/cancel`).send({ reason: "x" })).status).toBe(404);
    expect((await req2C.post(`/api/v1/pr/${id}/copy`).send({})).status).toBe(404);
    expect((await prRow(id))).toMatchObject({ title: "Chiller spares", status: "draft" });
  });

  it("update re-validates the catalog: an unusable variant on save → 422, lines unchanged", async () => {
    const created = await createPr();
    const id = created.body.data.id;
    const before = await linesOf(id);
    const v = await firstUsableVariant();
    const body = await draftBody({ title: "should not save" });
    await db.none(`UPDATE tbl_product_variant SET is_approve = 0 WHERE id = $1`, [v.variant_id]);
    try {
      const res = await reqC.put(`/api/v1/pr/${id}`).send(body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("PR_VARIANT_NOT_USABLE");
    } finally {
      await db.none(`UPDATE tbl_product_variant SET is_approve = 1 WHERE id = $1`, [v.variant_id]);
    }
    expect(await linesOf(id)).toEqual(before);
    expect((await prRow(id)).title).toBe("Chiller spares");
  });

  it("update cannot move the draft to a cell the requester may not create in → 403", async () => {
    const created = await createPr();
    const id = created.body.data.id;
    const res = await reqC.put(`/api/v1/pr/${id}`).send(await draftBody({ department_id: PROC }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PR_FORBIDDEN");
    expect((await prRow(id)).department_id).toBe(ENG);
  });

  it("cancel: draft → cancelled with a reason; cancelling (or editing) again → 409", async () => {
    const created = await createPr();
    const id = created.body.data.id;
    const noReason = await reqC.post(`/api/v1/pr/${id}/cancel`).send({ reason: "  " });
    expect(noReason.status).toBe(422);
    expect(fieldsOf(noReason)).toContain("reason");

    const res = await reqC.post(`/api/v1/pr/${id}/cancel`).send({ reason: "Bought from petty cash" });
    expect(res.status).toBe(200);
    expect(await prRow(id)).toMatchObject({ status: "cancelled", cancelled_reason: "Bought from petty cash" });
    const events = await eventsOf(id);
    expect(events[events.length - 1]).toMatchObject({
      event_type: "cancelled", actor_id: REQ, payload: { reason: "Bought from petty cash", from_status: "draft" },
    });

    const again = await reqC.post(`/api/v1/pr/${id}/cancel`).send({ reason: "again" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("PR_STATE_CONFLICT");
    const edit = await reqC.put(`/api/v1/pr/${id}`).send(await draftBody());
    expect(edit.status).toBe(409);

    const detail = await reqC.get(`/api/v1/pr/${id}`);
    expect(detail.body.data.capabilities).toEqual({
      can_edit: false, can_submit: false, can_withdraw: false, can_cancel: false, can_copy: true,
    });
  });

  it("copy: a new draft with the same header and lines; date reset if past; no clauses/attachments/mapping", async () => {
    const created = await createPr();
    const srcId = created.body.data.id;
    const src = await prRow(srcId);
    const srcLines = await linesOf(srcId);
    const v = await firstUsableVariant();
    // Make the source look like a finished, rejected PR with reviewer work on it.
    await db.none(
      `UPDATE tbl_purchase_requisition SET status = 'rejected', revision = 2, estimated_total = 3002.00,
              required_by_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date - 5 WHERE id = $1`, [srcId]);
    await db.none(
      `UPDATE tbl_purchase_requisition_line SET status = 'closed', close_reason = 'n/a', mapped_variant_id = $2
        WHERE id = $1`, [srcLines[1].id, v.variant_id]);
    await db.none(`INSERT INTO tbl_pr_line_clause (pr_line_id, clause_text, added_by) VALUES ($1, 'IP54 rated', $2)`,
      [srcLines[0].id, REQ]);
    await db.none(
      `INSERT INTO tbl_pr_attachment (pr_id, pr_line_id, kind, file_url, file_name, uploaded_by)
       VALUES ($1, $2, 'spec', 'https://example.test/spec.pdf', 'spec.pdf', $3)`, [srcId, srcLines[0].id, REQ]);

    const res = await reqC.post(`/api/v1/pr/${srcId}/copy`).send({});
    expect(res.status).toBe(200);
    const newId = res.body.data.id;
    prIds.push(newId);
    expect(newId).not.toBe(srcId);
    expect(res.body.data.pr_number).not.toBe(src.pr_number);

    const copy = await prRow(newId);
    expect(copy).toMatchObject({
      status: "draft", revision: 0, estimated_total: null, raised_by: REQ,
      title: src.title, justification: src.justification, pr_type: src.pr_type, urgency: src.urgency,
      delivery_location: src.delivery_location, hospitality_company_id: A, hotel_id: A1, department_id: ENG,
      cancelled_reason: null, approval_instance_id: null, submitted_at: null,
    });
    expect(copy.required_by_date).toBe(await istDate(0));

    const lines = await linesOf(newId);
    expect(lines.map((l) => [l.line_no, l.line_kind, l.product_variant_id, l.free_text_name, l.category_id, l.quantity, l.uom, l.estimated_unit_price, l.specification]))
      .toEqual(srcLines.map((l) => [l.line_no, l.line_kind, l.product_variant_id, l.free_text_name, l.category_id, l.quantity, l.uom, l.estimated_unit_price, l.specification]));
    expect(lines.map((l) => [l.status, l.mapped_variant_id])).toEqual([["active", null], ["active", null]]);
    const lineIds = lines.map((l) => l.id);
    expect((await db.one(`SELECT COUNT(*)::int AS c FROM tbl_pr_line_clause WHERE pr_line_id = ANY($1::int[])`, [lineIds])).c).toBe(0);
    expect((await db.one(`SELECT COUNT(*)::int AS c FROM tbl_pr_attachment WHERE pr_id = $1`, [newId])).c).toBe(0);

    const events = await eventsOf(newId);
    expect(events).toEqual([expect.objectContaining({
      event_type: "copied_from", actor_id: REQ,
      payload: { source_pr_id: srcId, source_pr_number: src.pr_number },
    })]);

    // A non-terminal source with a future date keeps its date.
    const live = await createPr();
    const copy2 = await reqC.post(`/api/v1/pr/${live.body.data.id}/copy`).send({});
    expect(copy2.status).toBe(200);
    prIds.push(copy2.body.data.id);
    expect((await prRow(copy2.body.data.id)).required_by_date).toBe((await prRow(live.body.data.id)).required_by_date);
  });
});

describe("PR form pickers", () => {
  it("form pickers: hotels/departments the caller holds pr.create for; a foreign hotel → 403", async () => {
    const hotels = await reqC.get(`/api/v1/pr/form/hotels`);
    expect(hotels.status).toBe(200);
    expect(hotels.body.data.hotels.map((h) => h.id)).toEqual([A1]);

    const depts = await reqC.get(`/api/v1/pr/form/departments?hotel_id=${A1}`);
    expect(depts.status).toBe(200);
    expect(depts.body.data.departments).toEqual([{ id: ENG, title: "Engineering" }]);

    const foreign = await reqC.get(`/api/v1/pr/form/departments?hotel_id=${B1}`);
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("PR_FORBIDDEN");

    const none = await otherC.get(`/api/v1/pr/form/hotels`);
    expect(none.status).toBe(200);
    expect(none.body.data.hotels).toEqual([]);
  });

  it("form pickers: a grant with department NULL lists every department at the hotel", async () => {
    const g = await grantPr(OTHER, "PR Requester", { departmentId: null });
    try {
      const hotels = await otherC.get(`/api/v1/pr/form/hotels`);
      expect(hotels.body.data.hotels.map((h) => h.id)).toEqual([A1]);
      const depts = await otherC.get(`/api/v1/pr/form/departments?hotel_id=${A1}`);
      expect(depts.status).toBe(200);
      const all = await db.map(`SELECT id, title FROM tbl_department ORDER BY title, id`, [], (r) => ({ id: r.id, title: r.title }));
      expect(depts.body.data.departments).toEqual(all);
      expect((await otherC.get(`/api/v1/pr/form/departments?hotel_id=${IDS.hotels.A2}`)).status).toBe(403);
    } finally {
      await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [g]);
    }
  });

  it("categories: active, non-deleted categories {id, title, parent_id}, at most 50", async () => {
    const all = await xcoC.get(`/api/v1/pr/categories?q=`);
    expect(all.status).toBe(200);
    const rows = all.body.data.categories;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(50);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["id", "parent_id", "title"]);
    const active = new Set(await db.map(
      `SELECT id FROM tbl_category WHERE status = 1 AND is_deleted = 0`, [], (r) => Number(r.id)));
    expect(rows.every((r) => active.has(r.id))).toBe(true);

    const target = await db.one(`SELECT id, title FROM tbl_category WHERE status = 1 AND is_deleted = 0 ORDER BY id LIMIT 1`);
    const q = encodeURIComponent(target.title); // the full title, so the row cannot fall outside the 50-row limit
    const hit = await reqC.get(`/api/v1/pr/categories?q=${q}`);
    expect(hit.body.data.categories.map((c) => c.id)).toContain(target.id);

    await db.none(`UPDATE tbl_category SET is_deleted = 1 WHERE id = $1`, [target.id]);
    try {
      const gone = await reqC.get(`/api/v1/pr/categories?q=${q}`);
      expect(gone.body.data.categories.map((c) => c.id)).not.toContain(target.id);
    } finally {
      await db.none(`UPDATE tbl_category SET is_deleted = 0 WHERE id = $1`, [target.id]);
    }
  });
});

describe("PR catalog guards — contracts and item search", () => {
  let v;
  const search = (q) => reqC.get(`/api/v1/pr/search-items?hotel_id=${A1}&department_id=${ENG}&q=${encodeURIComponent(q)}`);

  beforeAll(async () => {
    v = await firstUsableVariant();
  });

  it("search-items: usable variants with their category, not on contract; cell-gated", async () => {
    const res = await search(v.variant_name); // the full name, so the row cannot fall outside the LIMIT
    expect(res.status).toBe(200);
    const hit = res.body.data.items.find((i) => i.variant_id === v.variant_id);
    expect(hit).toMatchObject({
      variant_id: v.variant_id, variant_name: v.variant_name, product_name: expect.any(String),
      category_id: v.category_id, on_contract: false, arc_number: null,
    });

    const forbidden = await reqC.get(`/api/v1/pr/search-items?hotel_id=${A1}&department_id=${PROC}&q=ab`);
    expect(forbidden.status).toBe(403);
    expect((await otherC.get(`/api/v1/pr/search-items?hotel_id=${A1}&department_id=${ENG}&q=ab`)).status).toBe(403);
  });

  describe("with an active rate contract for the variant at (A1, eng)", () => {
    let arcId, contractId, itemId;
    beforeAll(async () => {
      const arc = await db.one(
        `INSERT INTO tbl_arc
           (arc_number, title, category_id, hospitality_company_id, hotel_id,
            department_id, process_id, status,
            submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
         VALUES ('ARC-TEST-PR-1', 'PR guided-buying ARC', $1, $2, $3, $4, $5, 'contract_active',
                 NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days',
                 NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $6) RETURNING id`,
        [v.category_id, A, A1, ENG, IDS.processes.A_P1, REQ]);
      arcId = Number(arc.id);
      const item = await db.one(
        `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
         VALUES ($1, $2, 1000, 'nos') RETURNING id`, [arcId, v.variant_id]);
      itemId = Number(item.id);
      const contract = await db.one(
        `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`,
        [arcId, IDS.users.vendor_alpha]);
      contractId = Number(contract.id);
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

    it("create.on-contract-blocked: → 422 PR_LINE_ON_CONTRACT naming the line and the ARC", async () => {
      const res = await createPr();
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("PR_LINE_ON_CONTRACT");
      expect(res.body.details[0]).toMatchObject({
        line_no: 1, product_variant_id: v.variant_id, arc_number: "ARC-TEST-PR-1", arc_contract_id: contractId,
      });
    });

    it("the same variant in another department of the hotel is not on contract", async () => {
      const g = await grantPr(REQ, "PR Requester", { departmentId: PROC });
      try {
        const res = await createPr(await draftBody({ department_id: PROC }));
        expect(res.status).toBe(200);
      } finally {
        await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [g]);
      }
    });

    it("search-items flags the contracted variant with its ARC number", async () => {
      const res = await search(v.variant_name);
      expect(res.status).toBe(200);
      const hit = res.body.data.items.find((i) => i.variant_id === v.variant_id);
      expect(hit).toMatchObject({ on_contract: true, arc_number: "ARC-TEST-PR-1", arc_contract_id: contractId });
    });

    it("a fully consumed contract line no longer blocks", async () => {
      await db.none(`UPDATE tbl_arc_contract_line SET consumed_qty = committed_qty WHERE arc_contract_id = $1`, [contractId]);
      try {
        const res = await createPr();
        expect(res.status).toBe(200);
      } finally {
        await db.none(`UPDATE tbl_arc_contract_line SET consumed_qty = 0 WHERE arc_contract_id = $1`, [contractId]);
      }
    });
  });
});
