// Purchase Requisitions — category-driven technical review (Task 7, spec §6).
//
// Product-level: real HTTP through the full middleware chain against real
// Postgres; assertions read the response and the committed rows. Pattern B
// (commit + cleanup by tracked ids).
//
// Personas
//   REQ      a1_eng_buyer      PR Requester at (A, A1, eng)
//   AP1      a1_proc_commApp   PR Approver at (A, A1, eng) — the policy's USER step
//   RV_ENG   a1_proc_techEval  PR Technical Reviewer at (A, A1, eng)
//   RV_PROC  a1_proc_techApp   PR Technical Reviewer at (A, A1, proc)
//   OUT      a1_proc_poApp     no PR role at all (cannot read anything here)
//
// Routing: the catalog variant's category CE → Engineering; a second category
// CK (used by the free-text line) → Procurement. So every PR raised by
// createPr() gets two reviews: eng (line 1) and proc (line 2).
// Approval policy (re-made before every test): USER AP1.

import { httpClient } from "../helpers/http.js";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import {
  grantPr, revokeAllPr, firstUsableVariant, cleanupPrs, makePrPolicy, dropPrPolicies,
  mapCategory, unmapAll, istDate, prRoleId,
} from "../helpers/prFixtures.js";
import { buyerPrDetail } from "../../app/services/notificationLinks.js";
import { MAX_LEN } from "../../app/services/pr/prConstants.js";
import { isOwnUploadUrl } from "../../app/services/pr/prCatalog.js";

const A = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const ENG = IDS.departments.eng;
const PROC = IDS.departments.proc;
const REQ = IDS.users.a1_eng_buyer;
const AP1 = IDS.users.a1_proc_commApp;
const RV_ENG = IDS.users.a1_proc_techEval;
const RV_PROC = IDS.users.a1_proc_techApp;
const OUT = IDS.users.a1_proc_poApp;
const PERSONAS = [REQ, AP1, RV_ENG, RV_PROC, OUT];

const ACTION = "/api/v1/general/hospitality/approval/action";
const QUEUE = "/api/v1/pr/review-queue";

const prIds = [];
let originalUserTypes = [];
let reqC, ap1C, engC, procC, outC;
let variant;
let CE;
let CK;
let names = new Map();
const grants = {};

/** A URL exactly as our upload endpoint (multer-s3 location) returns it. */
const ownUrl = (key) =>
  `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

// ---------------------------------------------------------------------------
// Helpers (setup + reads only)
// ---------------------------------------------------------------------------
async function createPr() {
  const body = {
    hotel_id: A1,
    department_id: ENG,
    title: "Kitchen combi oven",
    pr_type: "goods",
    urgency: "normal",
    required_by_date: await istDate(14),
    justification: "Banquet kitchen expansion",
    lines: [
      { product_variant_id: variant.variant_id, quantity: "1", uom: "nos", estimated_unit_price: "2500.00", specification: "OEM" },
      { free_text_name: "Stainless prep table", category_id: CK, quantity: "2", uom: "nos", estimated_unit_price: "1000.00",
        specification: "SS304" },
    ],
  };
  const res = await reqC.post("/api/v1/pr").send(body);
  expect(res.status).toBe(200);
  prIds.push(res.body.data.id);
  const lines = await db.any(
    `SELECT id, line_no, specification FROM tbl_purchase_requisition_line WHERE pr_id = $1 ORDER BY line_no`,
    [res.body.data.id]);
  return { id: res.body.data.id, pr_number: res.body.data.pr_number, l1: lines[0].id, l2: lines[1].id };
}

const submit = (id, client = reqC) => client.post(`/api/v1/pr/${id}/submit`).send({});
const withdraw = (id, client = reqC) => client.post(`/api/v1/pr/${id}/withdraw`).send({});
const detail = (id, client = reqC) => client.get(`/api/v1/pr/${id}`);
const editSpec = (client, id, lineId, body) => client.put(`/api/v1/pr/${id}/lines/${lineId}/specification`).send(body);
const addClause = (client, id, lineId, body) => client.post(`/api/v1/pr/${id}/lines/${lineId}/clauses`).send(body);
const removeClause = (client, id, lineId, clauseId) => client.delete(`/api/v1/pr/${id}/lines/${lineId}/clauses/${clauseId}`);
const addAttachment = (client, id, body) => client.post(`/api/v1/pr/${id}/attachments`).send(body);
const removeAttachment = (client, id, attId) => client.delete(`/api/v1/pr/${id}/attachments/${attId}`);
const complete = (client, id, reviewId, body = {}) => client.post(`/api/v1/pr/${id}/reviews/${reviewId}/complete`).send(body);
const reviewSendBack = (client, id, reviewId, body) => client.post(`/api/v1/pr/${id}/reviews/${reviewId}/send-back`).send(body);
const queueOf = async (client) => {
  const res = await client.get(QUEUE);
  expect(res.status).toBe(200);
  return res.body.data.items;
};

const prRow = (id) => db.one(
  `SELECT id, status, revision, approval_instance_id, returned_note FROM tbl_purchase_requisition WHERE id = $1`, [id]);
const lineRow = (id) => db.one(
  `SELECT id, specification, quantity::text AS quantity, uom, estimated_unit_price::text AS estimated_unit_price,
          category_id, product_variant_id
     FROM tbl_purchase_requisition_line WHERE id = $1`, [id]);
const eventsOf = (id) => db.any(
  `SELECT event_type, actor_id, revision, pr_line_id, payload FROM tbl_pr_event WHERE pr_id = $1 ORDER BY id`, [id]);
const eventTypes = async (id) => (await eventsOf(id)).map((e) => e.event_type);
const instancesOf = (id) => db.any(
  `SELECT id, status FROM tbl_approval_instances WHERE entity_type = 'PR' AND entity_id = $1 ORDER BY id`, [id]);
const reviewsOf = (prId) => db.any(
  `SELECT rv.id, rv.revision, rv.department_id, rv.status, rv.acted_by, rv.acted_at, rv.note, rv.self_reviewed,
          COALESCE((SELECT array_agg(rl.pr_line_id ORDER BY rl.pr_line_id) FROM tbl_pr_review_line rl
                     WHERE rl.review_id = rv.id), '{}') AS line_ids
     FROM tbl_pr_review rv WHERE rv.pr_id = $1 ORDER BY rv.revision, rv.department_id`, [prId]);
const prNotifications = (prId) => db.any(
  `SELECT recipient_user_id, type, title, message, action_url FROM tbl_notifications
    WHERE category = 'pr' AND additional_data->>'pr_id' = $1::text ORDER BY id`, [prId]);
const approverIdsOf = (instanceId) => db.map(
  `SELECT DISTINCT asa.approver_user_id AS id
     FROM tbl_approval_step_approvers asa
     JOIN tbl_approval_instance_steps st ON st.id = asa.approval_instance_step_id
    WHERE st.approval_instance_id = $1 AND asa.removed_at IS NULL
    ORDER BY 1`, [instanceId], (r) => Number(r.id));

/** Wait until `n` backends of this database are waiting on a lock (5 s max). */
async function waitForLockWaiters(n) {
  for (let i = 0; i < 100; i++) {
    const { waiting } = await db.one(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (waiting >= n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`expected ${n} lock waiters`);
}

/** A PR submitted into review: { id, pr_number, l1, l2, eng, proc } (review ids of revision 1). */
async function inReview() {
  const pr = await createPr();
  const res = await submit(pr.id);
  expect(res.status).toBe(200);
  expect(res.body.data.pr.status).toBe("in_review");
  const reviews = await reviewsOf(pr.id);
  return {
    ...pr,
    eng: reviews.find((r) => r.department_id === ENG).id,
    proc: reviews.find((r) => r.department_id === PROC).id,
  };
}

const policy = () => makePrPolicy({ steps: [{ source: "USER", id: AP1 }] });

beforeAll(async () => {
  originalUserTypes = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS]);
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [PERSONAS]);
  await revokeAllPr(PERSONAS);
  await unmapAll(A);
  await dropPrPolicies();
  await grantPr(REQ, "PR Requester", { departmentId: ENG });
  await grantPr(AP1, "PR Approver", { departmentId: ENG });
  grants.rvEng = await grantPr(RV_ENG, "PR Technical Reviewer", { departmentId: ENG });
  grants.rvProc = await grantPr(RV_PROC, "PR Technical Reviewer", { departmentId: PROC });

  variant = await firstUsableVariant();
  CE = variant.category_id;
  CK = Number((await db.one(
    `SELECT id FROM tbl_category WHERE status = 1 AND is_deleted = 0 AND id <> $1 ORDER BY id LIMIT 1`, [CE])).id);
  await mapCategory(A, CE, ENG);
  await mapCategory(A, CK, PROC);

  names = new Map((await db.any(`SELECT id, name FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS]))
    .map((r) => [Number(r.id), r.name]));
  reqC = await httpClient(REQ);
  ap1C = await httpClient(AP1);
  engC = await httpClient(RV_ENG);
  procC = await httpClient(RV_PROC);
  outC = await httpClient(OUT);
});

beforeEach(async () => {
  await policy();
});

afterEach(async () => {
  await dropPrPolicies();
});

afterAll(async () => {
  if (prIds.length) {
    await db.none(
      `DELETE FROM tbl_notifications
        WHERE (category = 'pr' AND additional_data->>'pr_id' = ANY($1::text[]))
           OR action_url = ANY($2::text[])`,
      [prIds.map(String), prIds.map((id) => buyerPrDetail(id))]);
  }
  await cleanupPrs(prIds);
  await dropPrPolicies();
  await unmapAll(A);
  await revokeAllPr(PERSONAS);
  for (const u of originalUserTypes) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
  }
  // Release this file's test-side pool: an idle client left open is killed by
  // globalTeardown's DROP DATABASE … WITH (FORCE) and logs 57P01 after Jest ends.
  await closeDb();
});

// ---------------------------------------------------------------------------
// Review start (end to end) + the queue
// ---------------------------------------------------------------------------
describe("PR technical review: start and queue", () => {
  it("submit.creates-parallel-reviews: CE → eng (line 1), CK → proc (line 2); both reviewers notified; each queue lists only its own review", async () => {
    const pr = await createPr();
    const res = await submit(pr.id);
    expect(res.status).toBe(200);
    expect(res.body.data.pr.status).toBe("in_review");

    const reviews = await reviewsOf(pr.id);
    // reviewsOf orders by department id: Procurement (10201) before Engineering (10202).
    expect(reviews).toEqual([
      expect.objectContaining({ revision: 1, department_id: PROC, status: "pending", line_ids: [pr.l2], acted_by: null }),
      expect.objectContaining({ revision: 1, department_id: ENG, status: "pending", line_ids: [pr.l1], acted_by: null }),
    ]);
    const eng = reviews.find((r) => r.department_id === ENG);
    const proc = reviews.find((r) => r.department_id === PROC);
    expect(await instancesOf(pr.id)).toEqual([]);

    // Each reviewer is told about their own department's task.
    const tasks = (await prNotifications(pr.id)).filter((n) => n.type === "pr_review_task");
    expect(tasks.map((n) => n.recipient_user_id).sort()).toEqual([RV_ENG, RV_PROC].sort());
    expect(tasks.find((n) => n.recipient_user_id === RV_ENG).message).toContain("Engineering");
    expect(tasks.find((n) => n.recipient_user_id === RV_PROC).message).toContain("Procurement");

    // The queue: each reviewer sees their review of this PR, and only it.
    const engQueue = (await queueOf(engC)).filter((i) => i.pr_id === pr.id);
    expect(engQueue).toEqual([{
      review_id: eng.id, pr_id: pr.id, pr_number: pr.pr_number, title: "Kitchen combi oven",
      hotel_name: expect.any(String), department_title: "Engineering", requester_name: names.get(REQ),
      line_count: 1, submitted_at: expect.any(String), age_days: 0,
    }]);
    const procQueue = (await queueOf(procC)).filter((i) => i.pr_id === pr.id);
    expect(procQueue).toEqual([expect.objectContaining({ review_id: proc.id, department_title: "Procurement", line_count: 1 })]);
    for (const client of [reqC, ap1C, outC]) {
      expect((await queueOf(client)).filter((i) => i.pr_id === pr.id)).toEqual([]);
    }

    // Detail: each reviewer's capabilities name their review and lines; the chain names eligible reviewers.
    expect((await detail(pr.id, engC)).body.data.capabilities.review).toEqual({ review_id: eng.id, can_edit_lines: [pr.l1] });
    expect((await detail(pr.id, procC)).body.data.capabilities.review).toEqual({ review_id: proc.id, can_edit_lines: [pr.l2] });
    const asReq = (await detail(pr.id)).body.data;
    expect(asReq.capabilities.review).toBeNull();
    const dEng = asReq.reviews.find((r) => r.id === eng.id);
    expect(dEng).toMatchObject({
      department_title: "Engineering", status: "pending", acted_by_name: null, note: null, self_reviewed: false,
      eligible_reviewers: [names.get(RV_ENG)], no_eligible_reviewer: false,
    });
    expect(asReq.reviews.find((r) => r.id === proc.id)).toMatchObject({
      department_title: "Procurement", eligible_reviewers: [names.get(RV_PROC)], no_eligible_reviewer: false,
    });
    expect(asReq.pr.now_with).toBe("Technical review: Engineering, Procurement");
  });

  it("review-queue: a review leaves the queue once completed, and a draft's history never shows", async () => {
    const pr = await inReview();
    expect((await queueOf(engC)).map((i) => i.review_id)).toContain(pr.eng);
    expect((await complete(engC, pr.id, pr.eng)).status).toBe(200);
    expect((await queueOf(engC)).map((i) => i.review_id)).not.toContain(pr.eng);
    expect((await queueOf(procC)).map((i) => i.review_id)).toContain(pr.proc);
    expect((await withdraw(pr.id)).status).toBe(200);
    expect((await queueOf(procC)).filter((i) => i.pr_id === pr.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reviewer edits
// ---------------------------------------------------------------------------
describe("PR technical review: reviewer edits", () => {
  it("reviewer.edit-own-lines: spec edit on an own line → 200 + spec_edited {before, after}; a foreign line → 403; quantity → 422", async () => {
    const pr = await inReview();
    const res = await editSpec(engC, pr.id, pr.l1, { specification: "  IP54, 3-phase 415V  " });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ line_id: pr.l1, specification: "IP54, 3-phase 415V" });
    expect((await lineRow(pr.l1)).specification).toBe("IP54, 3-phase 415V");
    const ev = (await eventsOf(pr.id)).pop();
    expect(ev).toMatchObject({
      event_type: "spec_edited", actor_id: RV_ENG, revision: 1, pr_line_id: pr.l1,
      payload: { before: "OEM", after: "IP54, 3-phase 415V" },
    });

    // Line 2 belongs to the Procurement review.
    const foreign = await editSpec(engC, pr.id, pr.l2, { specification: "hijack" });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("PR_FORBIDDEN");
    expect((await lineRow(pr.l2)).specification).toBe("SS304");

    // Only the specification is editable here.
    const before = await lineRow(pr.l1);
    for (const body of [
      { specification: "x", quantity: "9" },
      { quantity: "9" },
      { specification: "x", estimated_unit_price: "1.00", uom: "kg", product_variant_id: 1, category_id: CK },
    ]) {
      const bad = await editSpec(engC, pr.id, pr.l1, body);
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe("PR_VALIDATION");
    }
    const bad = await editSpec(engC, pr.id, pr.l1, { specification: "x", quantity: "9" });
    expect(bad.body.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: "quantity" })]));
    // R23: 1000 characters at most — what an RFQ item's specification holds.
    const tooLong = await editSpec(engC, pr.id, pr.l1, { specification: "x".repeat(1001) });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body).toMatchObject({ code: "PR_VALIDATION", details: [expect.objectContaining({ field: "specification" })] });
    expect(await lineRow(pr.l1)).toEqual(before);
    expect((await eventTypes(pr.id)).filter((t) => t === "spec_edited")).toHaveLength(1);

    // Not a reviewer: the requester (403), a stranger (404), a line of another PR (404).
    expect((await editSpec(reqC, pr.id, pr.l1, { specification: "mine" })).status).toBe(403);
    expect((await editSpec(outC, pr.id, pr.l1, { specification: "x" })).status).toBe(404);
    const other = await createPr();
    expect((await editSpec(engC, pr.id, other.l1, { specification: "x" })).status).toBe(404);
    expect((await lineRow(pr.l1)).specification).toBe("IP54, 3-phase 415V");
  });

  it("reviewer.clauses+attachments: 2 clauses + 1 datasheet on line 1, one clause removed → detail shows 1 + 1; events; foreign URL → 422", async () => {
    const pr = await inReview();
    const c1 = await addClause(engC, pr.id, pr.l1, { clause_text: "IP54 rated enclosure", clause_type: "clause", weightage: 40 });
    expect(c1.status).toBe(200);
    expect(c1.body.data.clause).toMatchObject({
      id: expect.any(Number), pr_line_id: pr.l1, clause_text: "IP54 rated enclosure", clause_type: "clause", weightage: "40.00", added_by: RV_ENG,
    });
    const c2 = await addClause(engC, pr.id, pr.l1, { clause_text: "One sample unit before the order", clause_type: "sampling", weightage: null });
    expect(c2.status).toBe(200);
    // clause_type defaults to the RFQ default when omitted.
    const c3 = await addClause(engC, pr.id, pr.l1, { clause_text: "Two-year warranty" });
    expect(c3.status).toBe(200);
    expect(c3.body.data.clause).toMatchObject({ clause_type: "clause", weightage: null });

    // The RFQ add-clause types only; weightage a whole number 0..100; text required, ≤ 2000.
    for (const body of [
      { clause_text: "x", clause_type: "mandatory" },
      { clause_text: "x", clause_type: "desirable" },
      { clause_text: "x", weightage: 101 },
      { clause_text: "x", weightage: -1 },
      { clause_text: "x", weightage: 12.5 },
      { clause_text: "x", weightage: "abc" },
      { clause_text: "   " },
      { clause_text: "x".repeat(2001) },
    ]) {
      const bad = await addClause(engC, pr.id, pr.l1, body);
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe("PR_VALIDATION");
    }
    expect((await addClause(engC, pr.id, pr.l2, { clause_text: "not mine" })).status).toBe(403);
    expect((await addClause(reqC, pr.id, pr.l1, { clause_text: "requester" })).status).toBe(403);

    const att = await addAttachment(engC, pr.id, {
      pr_line_id: pr.l1, kind: "datasheet", file_url: ownUrl("1700000000-oven-ds.pdf"), file_name: "oven-datasheet.pdf",
    });
    expect(att.status).toBe(200);
    expect(att.body.data.attachment).toMatchObject({
      id: expect.any(Number), pr_line_id: pr.l1, kind: "datasheet", file_name: "oven-datasheet.pdf", uploaded_by: RV_ENG,
    });
    const evil = await addAttachment(engC, pr.id, {
      pr_line_id: pr.l1, kind: "datasheet", file_url: "https://evil.example.com/x.pdf", file_name: "x.pdf",
    });
    expect(evil.status).toBe(422);
    expect(evil.body.code).toBe("PR_VALIDATION");
    expect(evil.body.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: "file_url" })]));
    // A reviewer attaches to their lines only — never to the header, never to another group's line.
    const header = await addAttachment(engC, pr.id, { pr_line_id: null, kind: "spec", file_url: ownUrl("h.pdf"), file_name: "h.pdf" });
    expect(header.status).toBe(403);
    const foreign = await addAttachment(engC, pr.id, { pr_line_id: pr.l2, kind: "spec", file_url: ownUrl("f.pdf"), file_name: "f.pdf" });
    expect(foreign.status).toBe(403);

    const del = await removeClause(engC, pr.id, pr.l1, c1.body.data.clause.id);
    expect(del.status).toBe(200);
    expect((await removeClause(engC, pr.id, pr.l1, c1.body.data.clause.id)).status).toBe(404);
    // A clause is addressed through its own line: under another line it does not exist.
    expect((await removeClause(engC, pr.id, pr.l2, c2.body.data.clause.id)).status).toBe(404);
    expect((await removeClause(procC, pr.id, pr.l1, c2.body.data.clause.id)).status).toBe(403);
    expect((await removeClause(engC, pr.id, pr.l1, c3.body.data.clause.id)).status).toBe(200);

    const d = (await detail(pr.id, engC)).body.data;
    const line1 = d.lines.find((l) => l.id === pr.l1);
    expect(line1.clauses).toEqual([expect.objectContaining({
      id: c2.body.data.clause.id, clause_text: "One sample unit before the order", clause_type: "sampling", weightage: null,
      added_by: RV_ENG, added_by_name: names.get(RV_ENG),
    })]);
    expect(line1.attachments).toEqual([expect.objectContaining({
      id: att.body.data.attachment.id, kind: "datasheet", file_url: ownUrl("1700000000-oven-ds.pdf"), uploaded_by: RV_ENG,
    })]);
    expect(d.attachments).toEqual([]);
    expect(d.lines.find((l) => l.id === pr.l2)).toMatchObject({ clauses: [], attachments: [] });

    const events = (await eventsOf(pr.id)).filter((e) => e.pr_line_id === pr.l1);
    expect(events.map((e) => e.event_type)).toEqual([
      "clause_added", "clause_added", "clause_added", "attachment_added", "clause_removed", "clause_removed",
    ]);
    expect(events[0]).toMatchObject({
      actor_id: RV_ENG, revision: 1,
      payload: { clause_id: c1.body.data.clause.id, clause_text: "IP54 rated enclosure", clause_type: "clause", weightage: "40.00" },
    });
    expect(events[3].payload).toMatchObject({
      attachment_id: att.body.data.attachment.id, kind: "datasheet", file_name: "oven-datasheet.pdf",
    });
    expect(events[4].payload).toMatchObject({ clause_id: c1.body.data.clause.id, clause_text: "IP54 rated enclosure" });

    // The reviewer removes their own upload.
    expect((await removeAttachment(engC, pr.id, att.body.data.attachment.id)).status).toBe(200);
    expect((await eventsOf(pr.id)).pop()).toMatchObject({
      event_type: "attachment_removed", actor_id: RV_ENG, pr_line_id: pr.l1,
      payload: { attachment_id: att.body.data.attachment.id, uploaded_by: RV_ENG },
    });
  });

  it("reviewer edits end with the review: after completing, the reviewer's lines are locked (403); after send back the PR is returned (409)", async () => {
    const pr = await inReview();
    expect((await complete(engC, pr.id, pr.eng)).status).toBe(200);
    expect((await editSpec(engC, pr.id, pr.l1, { specification: "late" })).status).toBe(403);
    expect((await addClause(engC, pr.id, pr.l1, { clause_text: "late" })).status).toBe(403);
    expect((await detail(pr.id, engC)).body.data.capabilities.review).toBeNull();

    expect((await reviewSendBack(procC, pr.id, pr.proc, { note: "Need the table dimensions" })).status).toBe(200);
    const late = await editSpec(procC, pr.id, pr.l2, { specification: "late" });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("PR_STATE_CONFLICT");
    expect((await addClause(procC, pr.id, pr.l2, { clause_text: "late" })).status).toBe(409);
    expect((await lineRow(pr.l2)).specification).toBe("SS304");
  });
});

// ---------------------------------------------------------------------------
// Complete / send back
// ---------------------------------------------------------------------------
describe("PR technical review: complete and send back", () => {
  it("complete.partial: RV_ENG completes → still in_review, no instance; a second complete → 409; the proc review is not theirs → 403", async () => {
    const pr = await inReview();
    const res = await complete(engC, pr.id, pr.eng, { note: "  Spec is fine  " });
    expect(res.status).toBe(200);
    expect(res.body.data.pr.status).toBe("in_review");
    expect(await prRow(pr.id)).toMatchObject({ status: "in_review", approval_instance_id: null });
    expect(await instancesOf(pr.id)).toEqual([]);
    const eng = (await reviewsOf(pr.id)).find((r) => r.id === pr.eng);
    expect(eng).toMatchObject({ status: "completed", acted_by: RV_ENG, note: "Spec is fine", self_reviewed: false });
    expect(eng.acted_at).not.toBeNull();
    expect((await eventsOf(pr.id)).pop()).toMatchObject({
      event_type: "review_completed", actor_id: RV_ENG, revision: 1,
      payload: { review_id: pr.eng, department_id: ENG, department_title: "Engineering", note: "Spec is fine" },
    });

    const again = await complete(engC, pr.id, pr.eng);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("PR_STATE_CONFLICT");
    const notMine = await complete(engC, pr.id, pr.proc);
    expect(notMine.status).toBe(403);
    expect(notMine.body.code).toBe("PR_FORBIDDEN");
    expect((await complete(engC, pr.id, 999999999)).status).toBe(404);
    expect((await complete(outC, pr.id, pr.proc)).status).toBe(404);
    const longNote = await complete(procC, pr.id, pr.proc, { note: "x".repeat(MAX_LEN.note + 1) });
    expect(longNote.status).toBe(422);
    expect((await reviewsOf(pr.id)).find((r) => r.id === pr.proc).status).toBe("pending");
  });

  it("complete.last-starts-approval: the last completion opens the approval chain in the same request; AP1 approves → approved", async () => {
    const pr = await inReview();
    expect((await complete(engC, pr.id, pr.eng)).status).toBe(200);
    const res = await complete(procC, pr.id, pr.proc);
    expect(res.status).toBe(200);
    expect(res.body.data.pr.status).toBe("pending_approval");

    const [inst] = await instancesOf(pr.id);
    expect(inst).toMatchObject({ status: "PENDING" });
    expect(await prRow(pr.id)).toMatchObject({ status: "pending_approval", approval_instance_id: inst.id });
    expect(await approverIdsOf(inst.id)).toEqual([AP1]);
    expect((await eventTypes(pr.id)).slice(-3)).toEqual(["review_completed", "review_completed", "approval_started"]);
    expect((await eventsOf(pr.id)).pop()).toMatchObject({ actor_id: RV_PROC, revision: 1, payload: { instance_id: inst.id } });

    const asAp1 = (await detail(pr.id, ap1C)).body.data;
    expect(asAp1.capabilities.approval).toMatchObject({ instance_id: inst.id, can_approve: true, can_reject: true, can_send_back: true });
    const approve = await ap1C.post(ACTION).send({ approval_instance_id: inst.id, action: "APPROVE", comment: "ok" });
    expect(approve.status).toBe(200);
    expect((await prRow(pr.id)).status).toBe("approved");
  });

  it("complete.concurrent: both reviewers complete at once → both 200, exactly one approval instance", async () => {
    const pr = await inReview();
    // Hold both review rows from another connection until BOTH completions are
    // blocked inside Postgres, so they really are in flight together (without
    // the PR row lock each would count the other's review as still pending and
    // the PR would never reach approval).
    const gate = await db.connect();
    let results;
    try {
      await gate.none("BEGIN");
      await gate.any(`SELECT id FROM tbl_pr_review WHERE id = ANY($1::int[]) FOR UPDATE`, [[pr.eng, pr.proc]]);
      const inflight = Promise.all([complete(engC, pr.id, pr.eng), complete(procC, pr.id, pr.proc)]);
      await waitForLockWaiters(2);
      await gate.none("COMMIT");
      results = await inflight;
    } finally {
      // If anything above threw, the gate still holds its transaction and the
      // row locks: end it before the client goes back to the pool. (After the
      // COMMIT this is a no-op ROLLBACK — a warning, never an error.)
      try {
        await gate.none("ROLLBACK");
      } finally {
        gate.done();
      }
    }
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await instancesOf(pr.id)).toHaveLength(1);
    expect((await prRow(pr.id)).status).toBe("pending_approval");
    expect((await eventTypes(pr.id)).filter((t) => t === "approval_started")).toHaveLength(1);
  });

  it("complete.double: the same review completed twice at once → one 200, one 409", async () => {
    const pr = await inReview();
    const results = await Promise.all([complete(engC, pr.id, pr.eng), complete(engC, pr.id, pr.eng)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await eventTypes(pr.id)).filter((t) => t === "review_completed")).toHaveLength(1);
  });

  it("send-back.supersedes: RV_ENG sends back → returned; the proc review is superseded and can no longer be completed; resubmit opens revision 2", async () => {
    const pr = await inReview();
    for (const note of [undefined, "", "   ", "x".repeat(MAX_LEN.note + 1)]) {
      const bad = await reviewSendBack(engC, pr.id, pr.eng, { note });
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe("PR_VALIDATION");
    }
    expect((await reviewSendBack(procC, pr.id, pr.eng, { note: "not mine" })).status).toBe(403);
    expect((await reviewSendBack(reqC, pr.id, pr.eng, { note: "requester" })).status).toBe(403);

    const res = await reviewSendBack(engC, pr.id, pr.eng, { note: "  Need the IP rating and the power supply  " });
    expect(res.status).toBe(200);
    expect(res.body.data.pr.status).toBe("returned");
    expect(await prRow(pr.id)).toMatchObject({ status: "returned", returned_note: "Need the IP rating and the power supply" });
    const rev1 = await reviewsOf(pr.id);
    expect(rev1.find((r) => r.id === pr.eng)).toMatchObject({
      status: "sent_back", acted_by: RV_ENG, note: "Need the IP rating and the power supply",
    });
    expect(rev1.find((r) => r.id === pr.proc)).toMatchObject({ status: "superseded", acted_by: null });
    expect((await eventsOf(pr.id)).pop()).toMatchObject({
      event_type: "review_sent_back", actor_id: RV_ENG, revision: 1,
      payload: { review_id: pr.eng, department_id: ENG, note: "Need the IP rating and the power supply", superseded_review_ids: [pr.proc] },
    });
    const returned = (await prNotifications(pr.id)).filter((n) => n.type === "pr_returned");
    expect(returned.map((n) => n.recipient_user_id)).toEqual([REQ]);
    expect(returned[0].message).toContain("technical reviewer");

    const late = await complete(procC, pr.id, pr.proc);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("PR_STATE_CONFLICT");
    expect((await reviewSendBack(engC, pr.id, pr.eng, { note: "again" })).status).toBe(409);

    // Resubmit: revision 2 with fresh pending reviews; revision 1 stays as history.
    expect((await submit(pr.id)).status).toBe(200);
    expect(await prRow(pr.id)).toMatchObject({ status: "in_review", revision: 2, returned_note: null });
    const all = await reviewsOf(pr.id);
    expect(all.filter((r) => r.revision === 1)).toEqual(rev1);
    expect(all.filter((r) => r.revision === 2).map((r) => [r.department_id, r.status, r.line_ids]))
      .toEqual([[PROC, "pending", [pr.l2]], [ENG, "pending", [pr.l1]]]);
    const rev2Proc = all.find((r) => r.revision === 2 && r.department_id === PROC);
    const procQueue = (await queueOf(procC)).filter((i) => i.pr_id === pr.id);
    expect(procQueue.map((i) => i.review_id)).toEqual([rev2Proc.id]);
    // The superseded revision-1 review stays closed.
    expect((await complete(procC, pr.id, pr.proc)).status).toBe(409);
    expect((await complete(procC, pr.id, rev2Proc.id)).status).toBe(200);
  });

  it("self-review: the requester who is also an eligible reviewer completes their own review → self_reviewed; the approval still excludes them", async () => {
    // The approval step is the PR Approver ROLE, which REQ ALSO holds here — so
    // only separation of duties can keep REQ off the chain (a USER step naming
    // AP1 would exclude REQ trivially).
    await dropPrPolicies();
    await makePrPolicy({ steps: [{ source: "ROLE", id: await prRoleId("PR Approver") }] });
    const own = await grantPr(REQ, "PR Technical Reviewer", { departmentId: ENG });
    const ownApprover = await grantPr(REQ, "PR Approver", { departmentId: ENG });
    try {
      const pr = await inReview();
      expect((await detail(pr.id)).body.data.capabilities.review).toEqual({ review_id: pr.eng, can_edit_lines: [pr.l1] });
      const res = await complete(reqC, pr.id, pr.eng, { note: "Checked by the chief engineer" });
      expect(res.status).toBe(200);
      expect((await reviewsOf(pr.id)).find((r) => r.id === pr.eng)).toMatchObject({
        status: "completed", acted_by: REQ, self_reviewed: true,
      });
      expect((await eventsOf(pr.id)).pop()).toMatchObject({ event_type: "self_reviewed", actor_id: REQ, payload: { review_id: pr.eng } });
      const d = (await detail(pr.id)).body.data;
      expect(d.reviews.find((r) => r.id === pr.eng)).toMatchObject({ self_reviewed: true, acted_by_name: names.get(REQ) });

      expect((await complete(procC, pr.id, pr.proc)).status).toBe(200);
      const [inst] = await instancesOf(pr.id);
      expect((await prRow(pr.id)).status).toBe("pending_approval");
      // The role resolves to its holders minus the requester: AP1 only.
      expect(await approverIdsOf(inst.id)).toEqual([AP1]);
      expect((await detail(pr.id)).body.data.capabilities.approval).toMatchObject({ can_approve: false, can_reject: false });
      expect((await detail(pr.id, ap1C)).body.data.capabilities.approval).toMatchObject({ can_approve: true });
      const selfApprove = await reqC.post(ACTION).send({ approval_instance_id: inst.id, action: "APPROVE", comment: "mine" });
      expect(selfApprove.status).toBe(400);
      expect((await prRow(pr.id)).status).toBe("pending_approval");
    } finally {
      await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = ANY($1::int[])`, [[own, ownApprover]]);
    }
  });

  it("no-reviewer: Procurement loses its only reviewer → submit 422 PR_NO_REVIEWER naming Procurement; still a draft", async () => {
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [grants.rvProc]);
    try {
      const pr = await createPr();
      const res = await submit(pr.id);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("PR_NO_REVIEWER");
      expect(res.body.details).toMatchObject({ department_id: PROC, department_title: "Procurement" });
      expect(res.body.message).toContain("Procurement");
      expect(await prRow(pr.id)).toMatchObject({ status: "draft", revision: 0 });
      expect(await reviewsOf(pr.id)).toEqual([]);
    } finally {
      grants.rvProc = await grantPr(RV_PROC, "PR Technical Reviewer", { departmentId: PROC });
    }
  });

  it("review.no-eligible-reviewer-mid-flight: the eng reviewer is revoked after submit → detail says so; re-granted → they complete", async () => {
    const pr = await inReview();
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [grants.rvEng]);
    try {
      const d = (await detail(pr.id)).body.data;
      expect(d.pr.status).toBe("in_review");
      expect(d.reviews.find((r) => r.id === pr.eng)).toMatchObject({ eligible_reviewers: [], no_eligible_reviewer: true });
      expect(d.reviews.find((r) => r.id === pr.proc)).toMatchObject({
        eligible_reviewers: [names.get(RV_PROC)], no_eligible_reviewer: false,
      });
      expect(d.pr.now_with).toContain("No eligible reviewer");
      expect(d.pr.now_with).toBe("No eligible reviewer — contact your admin (Engineering)");
      // Eligibility is decided when acting: without the role RV_ENG can neither read nor complete.
      expect((await complete(engC, pr.id, pr.eng)).status).toBe(404);
      expect((await reviewsOf(pr.id)).find((r) => r.id === pr.eng).status).toBe("pending");
    } finally {
      grants.rvEng = await grantPr(RV_ENG, "PR Technical Reviewer", { departmentId: ENG });
    }
    const after = (await detail(pr.id)).body.data;
    expect(after.reviews.find((r) => r.id === pr.eng)).toMatchObject({ no_eligible_reviewer: false });
    expect((await complete(engC, pr.id, pr.eng)).status).toBe(200);
  });

  it("review eligibility follows the company mapping at action time: an unmapped reviewer gets 403 and the detail says no eligible reviewer", async () => {
    const pr = await inReview();
    const saved = await db.any(
      `SELECT * FROM tbl_hospitality_user_mappings WHERE user_id = $1 AND hospitality_company_id = $2`, [RV_ENG, A]);
    expect(saved.length).toBeGreaterThan(0);
    await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = $1 AND hospitality_company_id = $2`, [RV_ENG, A]);
    try {
      // Still a reader (pr.evaluate on a routed department), but no longer an eligible reviewer.
      const asEng = (await detail(pr.id, engC)).body.data;
      expect(asEng.capabilities.review).toBeNull();
      expect(asEng.reviews.find((r) => r.id === pr.eng)).toMatchObject({ no_eligible_reviewer: true });
      expect((await complete(engC, pr.id, pr.eng)).status).toBe(403);
      expect((await editSpec(engC, pr.id, pr.l1, { specification: "x" })).status).toBe(403);
      expect((await queueOf(engC)).filter((i) => i.pr_id === pr.id)).toEqual([]);
    } finally {
      for (const row of saved) {
        await db.none("INSERT INTO tbl_hospitality_user_mappings(${this:name}) VALUES(${this:csv})", row);
      }
    }
    expect((await complete(engC, pr.id, pr.eng)).status).toBe(200);
  });

  it("approval-broken-at-last-review: no policy at the last completion → 422 PR_NO_POLICY, the review stays pending; restored → pending_approval", async () => {
    const pr = await inReview();
    expect((await complete(engC, pr.id, pr.eng)).status).toBe(200);
    await dropPrPolicies();
    const res = await complete(procC, pr.id, pr.proc, { note: "fine" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("PR_NO_POLICY");
    expect((await reviewsOf(pr.id)).find((r) => r.id === pr.proc)).toMatchObject({ status: "pending", acted_by: null, note: null });
    expect(await prRow(pr.id)).toMatchObject({ status: "in_review", approval_instance_id: null });
    expect(await instancesOf(pr.id)).toEqual([]);
    expect((await eventTypes(pr.id)).filter((t) => t === "review_completed")).toHaveLength(1);

    await policy();
    const ok = await complete(procC, pr.id, pr.proc, { note: "fine" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.pr.status).toBe("pending_approval");
    expect(await instancesOf(pr.id)).toHaveLength(1);
  });

  it("withdraw during review: → draft; the pending review is superseded, the completed one kept", async () => {
    const pr = await inReview();
    expect((await complete(engC, pr.id, pr.eng)).status).toBe(200);
    expect((await withdraw(pr.id)).status).toBe(200);
    expect((await prRow(pr.id)).status).toBe("draft");
    const reviews = await reviewsOf(pr.id);
    expect(reviews.find((r) => r.id === pr.eng).status).toBe("completed");
    expect(reviews.find((r) => r.id === pr.proc).status).toBe("superseded");
    expect((await eventsOf(pr.id)).pop()).toMatchObject({
      event_type: "withdrawn", payload: { from_status: "in_review", superseded_review_ids: [pr.proc] },
    });
    expect((await complete(procC, pr.id, pr.proc)).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Requester attachments
// ---------------------------------------------------------------------------
describe("PR attachments (requester)", () => {
  it("requester-attachments: added and removed in draft; header and line; validated; in_review → 409", async () => {
    const pr = await createPr();
    const header = await addAttachment(reqC, pr.id, {
      pr_line_id: null, kind: "spec", file_url: ownUrl("1700000001-brief.pdf"), file_name: "brief.pdf",
    });
    expect(header.status).toBe(200);
    expect(header.body.data.attachment).toMatchObject({ pr_line_id: null, kind: "spec", uploaded_by: REQ });
    const line = await addAttachment(reqC, pr.id, {
      pr_line_id: pr.l1, kind: "qap", file_url: ownUrl("1700000002-qap.pdf"), file_name: "qap.pdf",
    });
    expect(line.status).toBe(200);

    const other = await createPr();
    for (const body of [
      { pr_line_id: null, kind: "spec", file_url: "https://evil.example.com/x.pdf", file_name: "x.pdf" },
      { pr_line_id: null, kind: "spec", file_url: ownUrl("x.pdf").replace("https:", "http:"), file_name: "x.pdf" },
      { pr_line_id: null, kind: "spec", file_url: "1700000001-brief.pdf", file_name: "x.pdf" },
      { pr_line_id: null, kind: "invoice", file_url: ownUrl("x.pdf"), file_name: "x.pdf" },
      { pr_line_id: null, kind: "spec", file_url: ownUrl("x.pdf"), file_name: "" },
      { pr_line_id: null, kind: "spec", file_url: ownUrl("x.pdf"), file_name: "x".repeat(301) },
      { pr_line_id: other.l1, kind: "spec", file_url: ownUrl("x.pdf"), file_name: "x.pdf" },
      { pr_line_id: "abc", kind: "spec", file_url: ownUrl("x.pdf"), file_name: "x.pdf" },
    ]) {
      const bad = await addAttachment(reqC, pr.id, body);
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe("PR_VALIDATION");
    }
    // Only the requester attaches to a draft; a stranger cannot even see it.
    expect((await addAttachment(outC, pr.id, { pr_line_id: null, kind: "spec", file_url: ownUrl("x.pdf"), file_name: "x.pdf" })).status).toBe(404);

    const d = (await detail(pr.id)).body.data;
    expect(d.attachments).toEqual([expect.objectContaining({ id: header.body.data.attachment.id, file_name: "brief.pdf", uploaded_by_name: names.get(REQ) })]);
    expect(d.lines.find((l) => l.id === pr.l1).attachments).toEqual([expect.objectContaining({ id: line.body.data.attachment.id, kind: "qap" })]);

    expect((await removeAttachment(reqC, pr.id, header.body.data.attachment.id)).status).toBe(200);
    expect((await removeAttachment(reqC, pr.id, header.body.data.attachment.id)).status).toBe(404);
    expect((await removeAttachment(reqC, other.id, line.body.data.attachment.id)).status).toBe(404);
    const trail = (await eventsOf(pr.id)).filter((e) => e.event_type.startsWith("attachment_"));
    expect(trail.map((e) => [e.event_type, e.pr_line_id, e.actor_id])).toEqual([
      ["attachment_added", null, REQ], ["attachment_added", pr.l1, REQ], ["attachment_removed", null, REQ],
    ]);

    // In review the requester's files are frozen; the reviewer may not remove someone else's upload.
    expect((await submit(pr.id)).status).toBe(200);
    const frozen = await addAttachment(reqC, pr.id, { pr_line_id: pr.l1, kind: "other", file_url: ownUrl("y.pdf"), file_name: "y.pdf" });
    expect(frozen.status).toBe(409);
    expect(frozen.body.code).toBe("PR_STATE_CONFLICT");
    expect((await addAttachment(reqC, pr.id, { pr_line_id: null, kind: "other", file_url: ownUrl("y.pdf"), file_name: "y.pdf" })).status).toBe(409);
    expect((await removeAttachment(reqC, pr.id, line.body.data.attachment.id)).status).toBe(409);
    expect((await removeAttachment(engC, pr.id, line.body.data.attachment.id)).status).toBe(403);
    expect(await db.one(`SELECT count(*)::int AS n FROM tbl_pr_attachment WHERE pr_id = $1`, [pr.id])).toEqual({ n: 1 });

    // Returned → the requester may change files again (including a reviewer's upload).
    const rvAtt = await addAttachment(engC, pr.id, { pr_line_id: pr.l1, kind: "datasheet", file_url: ownUrl("z.pdf"), file_name: "z.pdf" });
    expect(rvAtt.status).toBe(200);
    expect((await reviewSendBack(engC, pr.id, (await reviewsOf(pr.id)).find((r) => r.department_id === ENG).id, { note: "Add the drawing" })).status).toBe(200);
    expect((await removeAttachment(engC, pr.id, rvAtt.body.data.attachment.id)).status).toBe(403);
    expect((await removeAttachment(reqC, pr.id, rvAtt.body.data.attachment.id)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// isOwnUploadUrl — the upload endpoint's URLs only (unit)
// ---------------------------------------------------------------------------
describe("isOwnUploadUrl", () => {
  const cfg = { bucket: "acme-files", region: "ap-south-1" };
  const ok = (u) => expect(isOwnUploadUrl(u, cfg)).toBe(true);
  const no = (u) => expect(isOwnUploadUrl(u, cfg)).toBe(false);

  it("accepts the bucket's virtual-hosted (regional and global) and path-style object URLs over https", () => {
    ok("https://acme-files.s3.ap-south-1.amazonaws.com/1700000000-6f1c.pdf");
    ok("https://acme-files.s3.amazonaws.com/1700000000-6f1c.pdf");
    ok("https://s3.ap-south-1.amazonaws.com/acme-files/1700000000-6f1c.pdf");
    ok("https://s3.amazonaws.com/acme-files/purchase-order/po.pdf");
    ok("https://ACME-FILES.S3.AP-SOUTH-1.AMAZONAWS.COM/x.pdf");
    // Path traversal is irrelevant inside our own bucket's host: it is still our bucket.
    ok("https://acme-files.s3.ap-south-1.amazonaws.com/a/../b.pdf");
  });

  it("the platform's own uploads pass with the configured bucket", () => {
    expect(isOwnUploadUrl(ownUrl("1700000000-abc.pdf"))).toBe(true);
  });

  it("refuses http, other buckets, other regions, lookalike hosts, credentials, ports, queries and non-URLs", () => {
    no("http://acme-files.s3.ap-south-1.amazonaws.com/x.pdf");
    no("https://other-bucket.s3.ap-south-1.amazonaws.com/x.pdf");
    no("https://acme-files.s3.us-east-1.amazonaws.com/x.pdf");
    no("https://acme-files.s3.amazonaws.com.evil.com/x.pdf");
    no("https://acme-files.s3.ap-south-1.amazonaws.com.evil.com/x.pdf");
    no("https://evil.com/acme-files.s3.ap-south-1.amazonaws.com/x.pdf");
    no("https://evil.com/?u=https://acme-files.s3.ap-south-1.amazonaws.com/x.pdf");
    no("https://xacme-files.s3.ap-south-1.amazonaws.com/x.pdf");
    no("https://s3.ap-south-1.amazonaws.com/other-bucket/x.pdf");
    no("https://s3.ap-south-1.amazonaws.com/acme-files-evil/x.pdf");
    no("https://s3.ap-south-1.amazonaws.com/acme-files/../other-bucket/x.pdf");
    no("https://s3.ap-south-1.amazonaws.com/acme-files/");
    no("https://acme-files.s3.ap-south-1.amazonaws.com/");
    no("https://user:pw@acme-files.s3.ap-south-1.amazonaws.com/x.pdf");
    no("https://acme-files.s3.ap-south-1.amazonaws.com:8443/x.pdf");
    no("https://acme-files.s3.ap-south-1.amazonaws.com/x.pdf?X-Amz-Signature=abc");
    no("https://acme-files.s3.ap-south-1.amazonaws.com/x.pdf#frag");
    no("javascript:alert(1)");
    no("1700000000-6f1c.pdf");
    no("");
    no(null);
    no(42);
    no(`https://acme-files.s3.ap-south-1.amazonaws.com/${"a".repeat(2000)}.pdf`);
  });

  it("refuses everything when no bucket is configured", () => {
    expect(isOwnUploadUrl("https://acme-files.s3.ap-south-1.amazonaws.com/x.pdf", { bucket: "", region: "ap-south-1" })).toBe(false);
    expect(isOwnUploadUrl("https://.s3.ap-south-1.amazonaws.com/x.pdf", { bucket: undefined, region: "ap-south-1" })).toBe(false);
  });
});
