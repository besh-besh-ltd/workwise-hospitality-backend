// ARC v2 listing — "Waiting on" (REQ-2026-0094).
//
// The rate contract list card never said who a contract was waiting on: a
// floated ARC whose window had closed with every quote in still read
// "Floated · 2 of 2 responses", and "Awaiting Vendor" covered contract copies
// the buyer had not sent yet. POST /arc-v2/list-view now stamps every row on
// the page with `waiting_on` (who acts next) and `submission_window_closed`.
//
// Part 1 pins the pure rule (deriveWaitingOn) status by status.
// Part 2 drives the real endpoint over HTTP against seeded ARCs, so the
// batched SQL (approval engine, invitations, contracts, clarifications,
// evaluator roles) is exercised end to end.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";
import { deriveWaitingOn, submissionWindowClosed } from "../../../app/services/arcWaitingOnService.js";

// ── Part 1: the rule ────────────────────────────────────────────────────────
describe("ARC waiting_on — rule by status", () => {
  const people = (...names) => names.map((name) => ({ name }));
  const row = (status, extra = {}) => ({ id: 1, status, created_by_name: "Creator One", submitted_count: 2, ...extra });

  test("draft and publish_rejected wait on the creator", () => {
    expect(deriveWaitingOn(row("draft"), {})).toMatchObject({ kind: "creator", people: people("Creator One") });
    expect(deriveWaitingOn(row("draft", { is_manual: true }), {}).action).toMatch(/manual entry/i);
    expect(deriveWaitingOn(row("publish_rejected"), {})).toMatchObject({ kind: "creator", action: expect.stringMatching(/rejected/) });
  });

  test("pending_publish_approval names the current level's approvers", () => {
    const w = deriveWaitingOn(row("pending_publish_approval"), {
      approvals: { ARC_PUBLISH: { step_order: 2, total_steps: 3, decision_rule: "ALL", people: people("Asha"), unreachable: 0 } },
    });
    expect(w).toMatchObject({ kind: "approval", role: "Publish approval", step: { level: 2, of: 3, rule: "ALL" }, people: people("Asha") });
    // No pending instance → still an approval, with nobody to name.
    expect(deriveWaitingOn(row("pending_publish_approval"), {})).toMatchObject({ kind: "approval", people: [], step: null });
  });

  test("floated, window open: the vendors yet to respond, or the window when all are in", () => {
    const vendors = [{ name: "Vendor B", company: "B Co" }];
    expect(deriveWaitingOn(row("floated"), { windowClosed: false, vendorsToRespond: vendors }))
      .toMatchObject({ kind: "vendors", role: "Vendors yet to respond", people: vendors });
    expect(deriveWaitingOn(row("floated"), { windowClosed: false, vendorsToRespond: [] }))
      .toMatchObject({ kind: "window", people: [] });
  });

  test("window closed: technical evaluators, commercial without clauses, creator with no quotes", () => {
    const f = { windowClosed: true, techEvaluators: people("Tech T"), commEvaluators: people("Comm C") };
    expect(deriveWaitingOn(row("floated"), { ...f, hasTechClauses: true }))
      .toMatchObject({ kind: "evaluators", role: "Technical evaluators", people: people("Tech T") });
    expect(deriveWaitingOn(row("submission_closed"), { ...f, hasTechClauses: false }))
      .toMatchObject({ kind: "evaluators", role: "Commercial evaluators", people: people("Comm C") });
    expect(deriveWaitingOn(row("submission_closed", { submitted_count: 0 }), { ...f, hasTechClauses: true }))
      .toMatchObject({ kind: "creator", action: expect.stringMatching(/No quote/) });
  });

  test("technical stage: the approval when pending, otherwise the evaluators", () => {
    const tech = { step_order: 1, total_steps: 1, decision_rule: "ANY", people: people("Approver A"), unreachable: 0 };
    expect(deriveWaitingOn(row("tech_eval_in_progress"), { approvals: { ARC_TECH: tech } }))
      .toMatchObject({ kind: "approval", role: "Technical approval" });
    expect(deriveWaitingOn(row("tech_eval_in_progress"), { techEvaluators: people("Tech T") }))
      .toMatchObject({ kind: "evaluators", role: "Technical evaluators" });
    expect(deriveWaitingOn(row("tech_eval_rejected"), { techEvaluators: people("Tech T") }))
      .toMatchObject({ kind: "evaluators", role: "Technical evaluators", action: expect.stringMatching(/rejected/) });
  });

  test("commercial stage: a pending negotiation round's approvers, otherwise the evaluators", () => {
    const round = { step_order: 1, total_steps: 1, decision_rule: "ANY", people: people("Round R"), unreachable: 0 };
    expect(deriveWaitingOn(row("comm_eval_in_progress"), { approvals: { ARC_NEGOTIATION: round } }))
      .toMatchObject({ kind: "approval", role: "Negotiation round approval", people: people("Round R") });
    expect(deriveWaitingOn(row("tech_eval_approved"), { commEvaluators: people("Comm C") }))
      .toMatchObject({ kind: "evaluators", role: "Commercial evaluators" });
  });

  test("committee and contract stages", () => {
    const committee = { step_order: 1, total_steps: 2, decision_rule: "ANY", people: people("Member M"), unreachable: 1 };
    expect(deriveWaitingOn(row("committee_review"), { approvals: { ARC_COMMITTEE: committee } }))
      .toMatchObject({ kind: "approval", role: "Committee approval", unreachable: 1 });
    expect(deriveWaitingOn(row("committee_review"), { commEvaluators: people("Comm C") }).kind).toBe("evaluators");
    expect(deriveWaitingOn(row("committee_sent_back"), { commEvaluators: people("Comm C") }).action).toMatch(/sent back/);
    expect(deriveWaitingOn(row("contract_generated"), { commEvaluators: people("Comm C") }))
      .toMatchObject({ kind: "evaluators", action: expect.stringMatching(/send them to the vendors/) });
    expect(deriveWaitingOn(row("committee_approved"), { commEvaluators: people("Comm C") }).kind).toBe("evaluators");
  });

  test("awaiting vendor acceptance: vendors yet to sign, or the evaluators on a clarification", () => {
    const vendors = [{ name: "Vendor A", company: "A Co" }];
    expect(deriveWaitingOn(row("awaiting_vendor_acceptance"), { vendorsToSign: vendors }))
      .toMatchObject({ kind: "vendors", role: "Vendors yet to sign", people: vendors });
    expect(deriveWaitingOn(row("awaiting_vendor_acceptance"), { vendorsToSign: vendors, clarificationsOpen: 1, commEvaluators: people("Comm C") }))
      .toMatchObject({ kind: "evaluators", action: expect.stringMatching(/clarification/) });
    expect(deriveWaitingOn(row("awaiting_vendor_acceptance"), { vendorsToSign: [] })).toBeNull();
  });

  test("live and ended contracts wait on nobody", () => {
    for (const s of ["contract_active", "expiring_soon", "expired", "terminated", "closed_no_award", "committee_rejected"]) {
      expect(deriveWaitingOn(row(s), {})).toBeNull();
    }
  });

  test("submissionWindowClosed reads the status, then the IST clock", () => {
    expect(submissionWindowClosed({ status: "submission_closed" })).toBe(true);
    expect(submissionWindowClosed({ status: "floated", submission_end_at: "2000-01-01 00:00:00" })).toBe(true);
    expect(submissionWindowClosed({ status: "floated", submission_end_at: "2999-01-01 00:00:00" })).toBe(false);
    expect(submissionWindowClosed({ status: "committee_review", submission_end_at: "2000-01-01 00:00:00" })).toBe(false);
  });
});

// ── Part 2: the endpoint ────────────────────────────────────────────────────
const API = "/api/v1/arc-v2";
const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const PROC = IDS.processes.A_P1;
const CATEGORY = TEST_CATEGORIES.beverages;
const BUYER = IDS.users.a1_proc_buyer;        // creator + tech/comm evaluator (fixture role)
const APPROVER = IDS.users.a1_proc_commApp;   // live approver
const GHOST = IDS.users.a1_proc_techApp;      // REMOVED from the level — never named
const INACTIVE = IDS.users.inactive;          // status 0 — counted, not named
const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;

const POLICY = { ARC_PUBLISH: 64970, ARC_COMMITTEE: 64971, ARC_NEGOTIATION: 64972 };

describe("ARC waiting_on — POST /arc-v2/list-view", () => {
  let buyer;
  const arcIds = [];
  const instanceIds = [];
  const roundIds = [];
  const ids = {};
  let names = {};
  let rowsById = new Map();

  async function arc(key, status, { endOffsetDays = -1, title } = {}) {
    const r = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               NOW() - INTERVAL '10 days', NOW() + ($9 || ' days')::interval,
               NOW() + INTERVAL '20 days', NOW() + INTERVAL '200 days', $10)
       RETURNING id`,
      [`ARC-TEST-WAIT-${key}`, title || `Waiting on — ${key}`, CATEGORY, HC, HOTEL, DEPT, PROC, status,
        String(endOffsetDays), BUYER]
    );
    arcIds.push(Number(r.id));
    ids[key] = Number(r.id);
    return Number(r.id);
  }

  const invite = (arcId, vendor, status) => db.none(
    `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status) VALUES ($1, $2, $3)`, [arcId, vendor, status]);

  async function item(arcId) {
    return Number((await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, 1, 100, 'litre', 50) RETURNING id`, [arcId])).id);
  }

  async function techClause(arcId) {
    const itemId = await item(arcId);
    const te = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score) VALUES ($1, 60) RETURNING id`, [itemId]);
    await db.none(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses (arc_item_tech_evaluation_id, clause_text, weightage, clause_type)
       VALUES ($1, 'FSSAI licence on file', 10, 'compliance')`, [te.id]);
  }

  // A PENDING instance whose current level holds the given approvers.
  async function pendingInstance(entityType, entityId, { currentStep = 1, totalSteps = 1, rule = "ANY", approvers }) {
    const inst = await db.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, hospitality_company_id, hotel_id, initiated_by, status, current_step)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7) RETURNING id`,
      [entityType, entityId, POLICY[entityType], HC, HOTEL, BUYER, currentStep]);
    instanceIds.push(Number(inst.id));
    for (let step = 1; step <= totalSteps; step++) {
      const s = await db.one(
        `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [inst.id, step, rule, step < currentStep ? "APPROVED" : "PENDING"]);
      if (step !== currentStep) continue;
      for (const [userId, status] of approvers) {
        await db.none(
          `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
           VALUES ($1, $2, $3)`, [s.id, userId, status]);
      }
    }
    return Number(inst.id);
  }

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [[BUYER, APPROVER, GHOST]]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`, [[VENDOR_A, VENDOR_B]]);
    await seedArcEvalPerms(db, [BUYER], { hospitality: HC, hotel: HOTEL });
    for (const [type, id] of Object.entries(POLICY)) {
      await db.none(
        `INSERT INTO tbl_approval_policies
           (id, entity_type, hospitality_company_id, hotel_id, department_id,
            is_active, created_by, process_id, is_master, is_department_scoped, version)
         VALUES ($1, $2, $3, $4, NULL, true, $5, $6, false, false, 1)
         ON CONFLICT (id) DO NOTHING`, [id, type, HC, HOTEL, BUYER, PROC]);
    }
    const rows = await db.any(`SELECT id, name FROM tbl_users WHERE id = ANY($1::int[])`,
      [[BUYER, APPROVER, GHOST, INACTIVE, VENDOR_A, VENDOR_B]]);
    names = Object.fromEntries(rows.map((r) => [Number(r.id), r.name]));

    // 1. floated, window open, one vendor still to respond
    const open = await arc("OPEN", "floated", { endOffsetDays: 3 });
    await invite(open, VENDOR_A, "submitted");
    await invite(open, VENDOR_B, "invited");
    // 2. floated, window open, everyone in
    const allIn = await arc("ALLIN", "floated", { endOffsetDays: 3 });
    await invite(allIn, VENDOR_A, "submitted");
    // 3. floated but past its window (status not flipped yet), technical clauses
    const pastTech = await arc("PASTTECH", "floated", { endOffsetDays: -1 });
    await invite(pastTech, VENDOR_A, "submitted");
    await invite(pastTech, VENDOR_B, "submitted");
    await techClause(pastTech);
    // 4. submission_closed, no clauses → commercial
    const closedComm = await arc("CLOSEDCOMM", "submission_closed");
    await invite(closedComm, VENDOR_A, "submitted");
    await item(closedComm);
    // 5. submission_closed with no quote → creator
    const noQuote = await arc("NOQUOTE", "submission_closed");
    await invite(noQuote, VENDOR_A, "invited");
    // 6. committee review: live approver, a REMOVED one and an inactive one
    const committee = await arc("COMMITTEE", "committee_review");
    await pendingInstance("ARC_COMMITTEE", committee, {
      currentStep: 1, totalSteps: 2, rule: "ALL",
      approvers: [[APPROVER, "PENDING"], [GHOST, "REMOVED"], [INACTIVE, "PENDING"]],
    });
    // 7. publish approval on level 2 of 2
    const publish = await arc("PUBLISH", "pending_publish_approval", { endOffsetDays: 5 });
    await pendingInstance("ARC_PUBLISH", publish, { currentStep: 2, totalSteps: 2, approvers: [[APPROVER, "PENDING"]] });
    // 8. commercial with a negotiation round awaiting approval
    const negotiating = await arc("NEGOTIATING", "comm_eval_in_progress");
    const round = await db.one(
      `INSERT INTO tbl_negotiation_rounds (source_type, source_id, round_number, status, end_date, created_by, products)
       VALUES ('ARC', $1, 1, 'PENDING_APPROVAL', NOW() + INTERVAL '1 day', $2, '[]'::jsonb) RETURNING id`,
      [negotiating, BUYER]);
    roundIds.push(Number(round.id));
    await pendingInstance("ARC_NEGOTIATION", Number(round.id), { approvers: [[APPROVER, "PENDING"]] });
    // 9. contract copies held for the buyer
    await arc("REVIEW", "contract_generated");
    // 10. awaiting signatures: A still to sign, B signed
    const signing = await arc("SIGNING", "awaiting_vendor_acceptance");
    await db.none(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'awaiting_acceptance'), ($1, $3, 'active')`,
      [signing, VENDOR_A, VENDOR_B]);
    // 11. awaiting signatures with an open clarification → back with the buyer
    const clarifying = await arc("CLARIFY", "awaiting_vendor_acceptance");
    const clarItem = await item(clarifying);
    const clarContract = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'clarification') RETURNING id`,
      [clarifying, VENDOR_A]);
    await db.none(
      `INSERT INTO tbl_arc_contract_clarification
         (arc_id, arc_contract_id, arc_item_id, vendor_id, field, round, vendor_comment, status, raised_by)
       VALUES ($1, $2, $3, $4, 'base_price', 1, 'rate differs', 'open', $4)`,
      [clarifying, clarContract.id, clarItem, VENDOR_A]);
    // 12. technical stage with no pending approval (send-back) → evaluators
    await arc("TECHBACK", "tech_eval_in_progress");
    // 13. live contract, 14. draft
    await arc("LIVE", "contract_active");
    await arc("DRAFT", "draft", { endOffsetDays: 5 });

    buyer = await httpClient(BUYER);
    const res = await buyer.post(`${API}/list-view`).send({ tab: "all", page: 1, limit: 100, search: "waiting on" });
    expect(res.status).toBe(200);
    rowsById = new Map(res.body.data.rows.map((r) => [Number(r.id), r]));
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
                     (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [roundIds]);
    await db.none(`DELETE FROM tbl_arc_contract_clarification WHERE arc_id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_clauses WHERE arc_item_tech_evaluation_id IN
                     (SELECT te.id FROM tbl_arc_item_tech_evaluation te JOIN tbl_arc_item i ON i.id = te.arc_item_id
                       WHERE i.arc_id = ANY($1::int[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_item_tech_evaluation WHERE arc_item_id IN
                     (SELECT id FROM tbl_arc_item WHERE arc_id = ANY($1::int[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [Object.values(POLICY)]);
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  const w = (key) => rowsById.get(ids[key])?.waiting_on;
  const peopleNames = (key) => (w(key)?.people || []).map((p) => p.name);

  test("every seeded ARC is on the page and carries both new fields", () => {
    for (const key of Object.keys(ids)) {
      const r = rowsById.get(ids[key]);
      expect(r).toBeDefined();
      expect(r).toHaveProperty("waiting_on");
      expect(typeof r.submission_window_closed).toBe("boolean");
    }
  });

  test("floated with the window open waits on the vendors who have not responded", () => {
    expect(w("OPEN")).toMatchObject({ kind: "vendors", role: "Vendors yet to respond" });
    expect(peopleNames("OPEN")).toEqual([names[VENDOR_B]]);
    expect(rowsById.get(ids.OPEN).submission_window_closed).toBe(false);
    expect(w("ALLIN")).toMatchObject({ kind: "window", people: [] });
  });

  test("the client's case: floated past its window with all quotes in waits on the technical evaluators", () => {
    const r = rowsById.get(ids.PASTTECH);
    expect(r.status).toBe("floated"); // the listing never flips status
    expect(r.submission_window_closed).toBe(true);
    expect(r.waiting_on).toMatchObject({ kind: "evaluators", role: "Technical evaluators" });
    expect(peopleNames("PASTTECH")).toContain(names[BUYER]);
  });

  test("closed with no technical clauses waits on the commercial evaluators; no quote waits on the creator", () => {
    expect(w("CLOSEDCOMM")).toMatchObject({ kind: "evaluators", role: "Commercial evaluators" });
    expect(peopleNames("CLOSEDCOMM")).toContain(names[BUYER]);
    expect(w("NOQUOTE")).toMatchObject({ kind: "creator" });
    expect(peopleNames("NOQUOTE")).toEqual([names[BUYER]]);
  });

  test("committee review names the live approver only: REMOVED never, inactive counted", () => {
    expect(w("COMMITTEE")).toMatchObject({
      kind: "approval", role: "Committee approval", step: { level: 1, of: 2, rule: "ALL" }, unreachable: 1,
    });
    expect(peopleNames("COMMITTEE")).toEqual([names[APPROVER]]);
  });

  test("publish approval reports the level it is on", () => {
    expect(w("PUBLISH")).toMatchObject({ kind: "approval", role: "Publish approval", step: { level: 2, of: 2 } });
    expect(peopleNames("PUBLISH")).toEqual([names[APPROVER]]);
  });

  test("a negotiation round awaiting approval is reached through the round", () => {
    expect(w("NEGOTIATING")).toMatchObject({ kind: "approval", role: "Negotiation round approval" });
    expect(peopleNames("NEGOTIATING")).toEqual([names[APPROVER]]);
  });

  test("contract copies held for review wait on the commercial evaluators, not the vendor", () => {
    expect(w("REVIEW")).toMatchObject({ kind: "evaluators", role: "Commercial evaluators" });
    expect(w("REVIEW").action).toMatch(/send them to the vendors/);
  });

  test("awaiting signatures names only the vendors still to sign; a clarification hands it back", () => {
    expect(w("SIGNING")).toMatchObject({ kind: "vendors", role: "Vendors yet to sign" });
    expect(peopleNames("SIGNING")).toEqual([names[VENDOR_A]]);
    expect(w("CLARIFY")).toMatchObject({ kind: "evaluators", action: expect.stringMatching(/clarification/) });
  });

  test("technical stage with no pending approval falls back to the evaluators", () => {
    expect(w("TECHBACK")).toMatchObject({ kind: "evaluators", role: "Technical evaluators" });
  });

  test("a live contract waits on nobody; a draft waits on its creator", () => {
    expect(w("LIVE")).toBeNull();
    expect(w("DRAFT")).toMatchObject({ kind: "creator" });
  });

  test("only names leave the server: no ids, emails or phone numbers", () => {
    for (const key of Object.keys(ids)) {
      for (const p of w(key)?.people || []) {
        expect(Object.keys(p).sort()).toEqual(expect.arrayContaining(["name"]));
        for (const k of Object.keys(p)) expect(["name", "company"]).toContain(k);
      }
    }
  });

  test("tab counts and the existing row fields are unchanged by the stamp", async () => {
    const res = await buyer.post(`${API}/list-view`).send({ tab: "all", page: 1, limit: 100, search: "waiting on" });
    const r = res.body.data.rows.find((x) => Number(x.id) === ids.OPEN);
    expect(r).toMatchObject({ invited_count: 2, submitted_count: 1, status: "floated" });
    expect(res.body.data.total).toBe(Object.keys(ids).length);
  });
});
