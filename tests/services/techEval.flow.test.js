// Wave-1 step-3.7 (continued) tests: technical-evaluation flow.
//
// Three controller surfaces:
//   - rfqController.addClause            — buyer adds a clause
//   - rfqController.addVendorResponse    — vendor responds to clauses
//   - rfqController.submitTechEvalForApproval — buyer submits eval; creates
//     a TECHNICAL approval instance via the same engine we already exercise
//     in approvalPolicyResolution.test.js.
//
// Per CONVENTIONS.md: every test calls the production controller; setup data
// uses raw SQL committed to the test DB and tracked for afterEach cleanup.

import {
  describe, it, expect, afterAll, beforeEach, afterEach, jest,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import rfqController from "../../app/controllers/rfq/rfqController.js";
import { makeRFQ } from "../factories/rfq.js";
import { setupScoredVendor } from "../factories/techEval.js";

afterAll(async () => {
  await closeDb();
});

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return {
    req: {
      user: opts.user,
      params: opts.params || {},
      body: opts.body || {},
      query: opts.query || {},
    },
    res,
    next: jest.fn(),
    calls,
  };
}

const inserted = { rfqIds: [] };

beforeEach(() => { inserted.rfqIds = []; });

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  // Cascade: clarifications → approval instances tied to tech_eval rows
  // (entity_type='TECHNICAL', entity_id=rfq_product_id) → tech eval children
  // → tech eval rows → rfq_products → rfq.
  // We drop instances tied to tech_eval rfq_product_ids by joining through
  // tbl_rfq_product_tech_evaluation.
  const techEvalIds = await db.any(
    `SELECT te.id, te.tbl_rfq_product_id
     FROM tbl_rfq_product_tech_evaluation te WHERE te.rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  const teIds = techEvalIds.map((r) => r.id);
  const teRfqProductIds = techEvalIds.map((r) => r.tbl_rfq_product_id);

  if (teRfqProductIds.length) {
    // Drop TECHNICAL approval instances and their children.
    await db.none(
      `DELETE FROM tbl_approval_actions
       WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances
         WHERE entity_type='TECHNICAL' AND entity_id = ANY($1::int[])
       )`,
      [teRfqProductIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_step_approvers
       WHERE approval_instance_step_id IN (
         SELECT s.id FROM tbl_approval_instance_steps s
         JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
         WHERE i.entity_type='TECHNICAL' AND i.entity_id = ANY($1::int[])
       )`,
      [teRfqProductIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instance_steps
       WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances
         WHERE entity_type='TECHNICAL' AND entity_id = ANY($1::int[])
       )`,
      [teRfqProductIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instances
       WHERE entity_type='TECHNICAL' AND entity_id = ANY($1::int[])`,
      [teRfqProductIds]
    );
    await db.none(
      `DELETE FROM tbl_tech_evaluation_rounds
       WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`,
      [teIds]
    );
  }
  if (teIds.length) {
    // Vendor responses FK clauses → delete responses BEFORE clauses.
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_vendors_response
       WHERE tbl_rfq_product_tech_evaluation_clauses_id IN (
         SELECT id FROM tbl_rfq_product_tech_evaluation_clauses
         WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])
       )`,
      [teIds]
    );
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_cleared_vendors
       WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`,
      [teIds]
    );
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_clauses
       WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`,
      [teIds]
    );
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation
       WHERE id = ANY($1::int[])`,
      [teIds]
    );
  }
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[]) AND entity_type='TECHNICAL'`, [teRfqProductIds]);
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
});

// ---- Setup helpers ---------------------------------------------------------

/** Open RFQ + 1 product, returns { rfq_id, rfq_product_id }. */
async function makeRfqWithProduct(overrides = {}) {
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19);
  const fiveDaysHence = new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    tender_publish_date: oneDayAgo,
    vendor_clarification_date: oneHourAgo,
    bid_end_date: fiveDaysHence,
    ...overrides,
  });
  inserted.rfqIds.push(rfq_id);
  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0)
     RETURNING id`,
    [rfq_id]
  );
  return { rfq_id, rfq_product_id: product.id };
}

// ===========================================================================
//  addClause
// ===========================================================================

describe("addClause — input validation + happy path", () => {
  it("rejects when rfq_id is missing", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_product_id: 1, clause_text: "Spec X" },
    });
    await rfqController.addClause(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Invalid input/i);
  });

  it("rejects when rfq_product_id is missing", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id: 1, clause_text: "Spec X" },
    });
    await rfqController.addClause(m.req, m.res);
    expect(m.calls.status).toBe(400);
  });

  it("rejects when clause_text is missing", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id: 1, rfq_product_id: 1 },
    });
    await rfqController.addClause(m.req, m.res);
    expect(m.calls.status).toBe(400);
  });

  it("F-CLAUSE-NOTFOUND-001 — RFQ not found returns HTTP 404 (not 200/status=0)", async () => {
    // POST-FIX: HTTP semantics align — when the requested RFQ doesn't exist,
    // the controller returns 404. Today the model resolves with
    // `{status: 0, message}` and the controller forwards 200 with that body,
    // which masks the not-found state from any HTTP-level client.
    // Fix: standardize the controller-trusts-model pattern — model throws or
    // returns null; controller maps to 404.
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id: 999999999, rfq_product_id: 1, clause_text: "x" },
    });
    await rfqController.addClause(m.req, m.res);
    expect(m.calls.status).toBe(404);
    expect(m.calls.body.message).toMatch(/(not found|does not exist)/i);
  });

  it("happy path: persists tbl_rfq_product_tech_evaluation + tbl_rfq_product_tech_evaluation_clauses", async () => {
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct();
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, rfq_product_id, clause_text: "Stainless steel finish required",
      },
    });
    await rfqController.addClause(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const evalRow = await db.one(
      `SELECT id FROM tbl_rfq_product_tech_evaluation
       WHERE rfq_id=$1 AND tbl_rfq_product_id=$2`,
      [rfq_id, rfq_product_id]
    );
    const clauseRow = await db.one(
      `SELECT clause_text, clause_type FROM tbl_rfq_product_tech_evaluation_clauses
       WHERE tbl_rfq_product_tech_evaluation_id=$1`,
      [evalRow.id]
    );
    expect(clauseRow.clause_text).toBe("Stainless steel finish required");
    expect(clauseRow.clause_type).toBe("clause"); // default
  });

  it("happy path: subsequent addClause for the same product reuses the existing tech-eval row (does not duplicate)", async () => {
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct();
    for (const text of ["First", "Second", "Third"]) {
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: { rfq_id, rfq_product_id, clause_text: text },
      });
      await rfqController.addClause(m.req, m.res);
      expect(m.calls.status).toBe(200);
    }
    const evals = await db.any(
      `SELECT id FROM tbl_rfq_product_tech_evaluation
       WHERE rfq_id=$1 AND tbl_rfq_product_id=$2`,
      [rfq_id, rfq_product_id]
    );
    expect(evals.length).toBe(1);
    const clauses = await db.any(
      `SELECT clause_text FROM tbl_rfq_product_tech_evaluation_clauses
       WHERE tbl_rfq_product_tech_evaluation_id=$1
       ORDER BY id`,
      [evals[0].id]
    );
    expect(clauses.map((c) => c.clause_text)).toEqual(["First", "Second", "Third"]);
  });
});

// ===========================================================================
//  addVendorResponse
// ===========================================================================

describe("addVendorResponse — input validation + deadline lock", () => {
  it("rejects empty array body", async () => {
    const m = mockExpress({
      user: { id: IDS.users.vendor_alpha, user_type: 3 },
      body: [],
    });
    await rfqController.addVendorResponse(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Invalid input/i);
  });

  it("rejects non-array body", async () => {
    const m = mockExpress({
      user: { id: IDS.users.vendor_alpha, user_type: 3 },
      body: { not: "an array" },
    });
    await rfqController.addVendorResponse(m.req, m.res);
    expect(m.calls.status).toBe(400);
  });

  it("LOCKS responses when bid_end_date end-of-day has passed (tech-eval is locked)", async () => {
    // Create an RFQ whose bid_end_date was yesterday end-of-day in the past.
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct({
      bid_end_date: twoDaysAgo,
    });
    // Create a clause via the controller (so the deadline lookup query joins
    // correctly through tech_eval → rfq_product → rfq).
    await rfqController.addClause(
      mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: { rfq_id, rfq_product_id, clause_text: "Locked clause" },
      }).req,
      mockExpress({}).res
    );
    const clause = await db.one(
      `SELECT c.id FROM tbl_rfq_product_tech_evaluation_clauses c
       JOIN tbl_rfq_product_tech_evaluation t ON t.id = c.tbl_rfq_product_tech_evaluation_id
       WHERE t.rfq_id=$1`,
      [rfq_id]
    );

    const m = mockExpress({
      user: { id: IDS.users.vendor_alpha, user_type: 3 },
      body: [{
        clause_id: clause.id,
        vendor_id: IDS.users.vendor_alpha,
        response: "Yes, complies",
      }],
    });
    await rfqController.addVendorResponse(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/locked.*deadline.*passed/i);
  });
});

// ===========================================================================
//  submitTechEvalForApproval
// ===========================================================================

describe("submitTechEvalForApproval — gates", () => {
  it("rejects when rfq_product_id / rfq_id do not exist (no approval instance created)", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id: 999999999, rfq_product_id: 999999999 },
    });
    await rfqController.submitTechEvalForApproval(m.req, m.res);
    // Non-hospitality RFQ resolves to 'success: false' → status 400 here.
    // Hospitality RFQ that doesn't exist surfaces "RFQ product not found" →
    // status 400. Either way no instance row should exist.
    expect([400, 500]).toContain(m.calls.status);
    const insts = await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type='TECHNICAL' AND entity_id=$1`,
      [999999999]
    );
    expect(insts.length).toBe(0);
  });

  it("rejects with 'Technical evaluation not found' when no clauses have been added yet", async () => {
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct({
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      process: IDS.processes.A_P1,
    });
    // No addClause call — tbl_rfq_product_tech_evaluation row does not exist.

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, rfq_product_id },
    });
    await rfqController.submitTechEvalForApproval(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Technical evaluation not found/i);
  });

  it("rejects with 'No vendors have been evaluated' when clauses exist but no vendor scores recorded", async () => {
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct({
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      process: IDS.processes.A_P1,
    });
    // Add a clause via the production controller — creates the tech-eval row.
    await rfqController.addClause(
      mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: { rfq_id, rfq_product_id, clause_text: "X" },
      }).req,
      mockExpress({}).res
    );
    // No vendor scores → submit should reject before creating an approval row.

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, rfq_product_id },
    });
    await rfqController.submitTechEvalForApproval(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/No vendors have been evaluated/i);

    const insts = await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type='TECHNICAL'`
    );
    // Make sure no stray TECHNICAL instance was created.
    const newInsts = insts.filter((i) => i.id > 1000); // exclude any seeded
    expect(newInsts.length).toBe(0);
  });

});

// ===========================================================================
//  Full happy path with scored vendor (Tasks 26 + 27 — uses tests/factories/techEval.js)
// ===========================================================================

describe("submitTechEvalForApproval — happy path with a fully-scored vendor", () => {
  it("creates a TECHNICAL approval instance against the A1/P1 TECHNICAL policy (NOT cross-process)", async () => {
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct({
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      process: IDS.processes.A_P1,
    });
    // Seed scored vendor: 2 clauses (weights 50, 50), vendor scored 30/50 each.
    // Total = 60 / 100 = 60% → passes the default 50% threshold.
    await setupScoredVendor({
      rfq_id, rfq_product_id, product_variant_id: 1, variant: 0,
      vendor_id: IDS.users.vendor_alpha, buyer_id: IDS.users.a1_proc_buyer,
      weightages: [50, 50], marksPerClause: 30, minimum_passing_score: 50,
    });

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, rfq_product_id },
    });
    await rfqController.submitTechEvalForApproval(m.req, m.res);

    expect(m.calls.status).toBe(200);
    expect(m.calls.body.status).toBe(1);
    expect(m.calls.body.data.approval_instance_id).toBeTruthy();

    // Instance: entity_type=TECHNICAL, policy is the A1/P1 TECHNICAL policy.
    const inst = await db.one(
      `SELECT entity_type, approval_policy_id, status
       FROM tbl_approval_instances WHERE id=$1`,
      [m.calls.body.data.approval_instance_id]
    );
    expect(inst.entity_type).toBe("TECHNICAL");
    expect(inst.approval_policy_id).toBe(IDS.policies.A1_P1_TECHNICAL);
    // Most likely PENDING (creator a1_proc_buyer isn't TECH_APPROVER).
    expect(["PENDING", "APPROVED"]).toContain(inst.status);
  });

  it("on a P2 RFQ resolves the A1/P2 TECHNICAL policy (no cross-process fall-through)", async () => {
    const { rfq_id, rfq_product_id } = await makeRfqWithProduct({
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      process: IDS.processes.A_P2, // P2!
    });
    await setupScoredVendor({
      rfq_id, rfq_product_id, product_variant_id: 1, variant: 0,
      vendor_id: IDS.users.vendor_alpha, buyer_id: IDS.users.a1_proc_buyer,
      weightages: [100], marksPerClause: 90, minimum_passing_score: 50,
    });

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, rfq_product_id },
    });
    await rfqController.submitTechEvalForApproval(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const inst = await db.one(
      `SELECT approval_policy_id FROM tbl_approval_instances
       WHERE id=$1`,
      [m.calls.body.data.approval_instance_id]
    );
    expect(inst.approval_policy_id).toBe(IDS.policies.A1_P2_TECHNICAL);
    expect(inst.approval_policy_id).not.toBe(IDS.policies.A1_P1_TECHNICAL);
  });

  it("rejects when the RFQ's process has NO TECHNICAL policy (no fall-through to a process-agnostic policy)", async () => {
    // Spin up an extra process with no policies, attach an RFQ to it, score
    // a vendor — the engine must surface "No approval policy found for
    // TECHNICAL" rather than silently use A1/P1's policy.
    const newProc = await db.one(
      `INSERT INTO tbl_approval_processes
         (company_id, name, description, is_active, created_by, process_type)
       VALUES ($1, 'TechEval-No-Policy', '', true, $2, 'RFQ')
       RETURNING id`,
      [IDS.companies.A, IDS.users.companyA_admin]
    );

    try {
      const { rfq_id, rfq_product_id } = await makeRfqWithProduct({
        hospitality: IDS.hospitality.A,
        hotel: IDS.hotels.A1,
        process: newProc.id,
      });
      await setupScoredVendor({
        rfq_id, rfq_product_id, product_variant_id: 1, variant: 0,
        vendor_id: IDS.users.vendor_alpha, buyer_id: IDS.users.a1_proc_buyer,
        weightages: [100], marksPerClause: 90, minimum_passing_score: 50,
      });

      const m = mockExpress({
        user: { id: IDS.users.a1_proc_buyer },
        body: { rfq_id, rfq_product_id },
      });
      await rfqController.submitTechEvalForApproval(m.req, m.res);
      expect([400, 500]).toContain(m.calls.status);

      // Critically: NO TECHNICAL approval instance must have been created.
      const insts = await db.any(
        `SELECT i.id FROM tbl_approval_instances i
         JOIN tbl_tech_evaluation_rounds r ON r.id = i.entity_id
         WHERE i.entity_type='TECHNICAL'
           AND r.tbl_rfq_product_tech_evaluation_id IN (
             SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id=$1
           )`,
        [rfq_id]
      );
      expect(insts.length).toBe(0);
    } finally {
      // The under-test RFQ has FK to this process; afterEach deletes the RFQ
      // first (in the inserted.rfqIds cleanup). After that we can drop the
      // process. Move it to extraProcessIds so the broader cleanup catches it.
      await db.none(`UPDATE tbl_rfq SET process_id=NULL WHERE process_id=$1`, [newProc.id]);
      await db.none(`DELETE FROM tbl_approval_processes WHERE id=$1`, [newProc.id]);
    }
  });
});
