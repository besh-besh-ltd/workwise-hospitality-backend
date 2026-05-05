// Tests for the will-be-final-approver predictor.
//
// This is the gate that decides whether the QC merge-PO modal opens at
// finalize time. The gate has to be correct or auto-approving sole
// approvers silently bypass the merge prompt (the bug we just fixed).
//
// Two surfaces are exercised:
//   1. The model-level helper `checkIfUserIsFinalApprover` — pure logic.
//   2. The HTTP controller method `willBeFinalApprover` (called directly
//      with a mock req/res) — including the rfq_id-derived scope path
//      which is what the FE actually uses.
//
// Fixture references (see tests/fixtures/policies.js + ids.js):
//   A1_P1_NEGOTIATION_QUOTE: 1-step ANY, USER a1_proc_commApp (80015)
//   A1_P2_NEGOTIATION_QUOTE: 1-step ANY, USER a1_proc_commEval (80014)
//   A1_P1_PO:                3-step ALL chain — used to test multi-step ALL semantics

import { describe, it, expect, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { checkIfUserIsFinalApprover } from "../../app/models/generalModel.js";
import { hospitalityApprovalController as ctrl } from "../../app/controllers/general/generalController.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

afterAll(async () => {
  await closeDb();
});

// Helper: invoke the controller's HTTP handler with a synthetic req/res and
// capture the JSON status + payload it would have returned. Mirrors
// CONVENTIONS.md §3 controller-direct pattern.
function invokeController(handler, { user, query = {} }) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const req = { user, query };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ status: statusCode, body: payload });
        return this;
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

// ──────────────────────────────────────────────────────────────────────
// Model-level: checkIfUserIsFinalApprover
// ──────────────────────────────────────────────────────────────────────

describe("checkIfUserIsFinalApprover — NEGOTIATION_QUOTE", () => {
  it("returns true when user is the sole approver in a 1-step ANY policy", async () => {
    // A1_P1_NEGOTIATION_QUOTE: 1 step, ANY rule, USER source = a1_proc_commApp.
    // commApp is the only resolved approver → final approver by definition.
    const result = await checkIfUserIsFinalApprover(
      IDS.users.a1_proc_commApp,
      "NEGOTIATION_QUOTE",
      IDS.hospitality.A,
      IDS.hotels.A1,
      IDS.departments.proc,
      null,
      IDS.processes.A_P1
    );
    expect(result).toBe(true);
  });

  it("returns false when user is NOT in the approver chain", async () => {
    // a1_proc_buyer is the RFQ creator, not an approver on the
    // NEGOTIATION_QUOTE policy.
    const result = await checkIfUserIsFinalApprover(
      IDS.users.a1_proc_buyer,
      "NEGOTIATION_QUOTE",
      IDS.hospitality.A,
      IDS.hotels.A1,
      IDS.departments.proc,
      null,
      IDS.processes.A_P1
    );
    expect(result).toBe(false);
  });

  it("respects process scope: P1 commApp is NOT final approver of P2 policy", async () => {
    // A1_P2_NEGOTIATION_QUOTE has commEval (80014), not commApp (80015).
    // Routing the same user through a different process must not match.
    const result = await checkIfUserIsFinalApprover(
      IDS.users.a1_proc_commApp,
      "NEGOTIATION_QUOTE",
      IDS.hospitality.A,
      IDS.hotels.A1,
      IDS.departments.proc,
      null,
      IDS.processes.A_P2
    );
    expect(result).toBe(false);
  });

  it("returns true for P2 commEval under process A_P2", async () => {
    const result = await checkIfUserIsFinalApprover(
      IDS.users.a1_proc_commEval,
      "NEGOTIATION_QUOTE",
      IDS.hospitality.A,
      IDS.hotels.A1,
      IDS.departments.proc,
      null,
      IDS.processes.A_P2
    );
    expect(result).toBe(true);
  });

  it("returns false when no policy matches (process_id not known)", async () => {
    // process_id=null on a process-scoped policy returns no match — exactly
    // the regression that broke finalize-time prediction.
    const result = await checkIfUserIsFinalApprover(
      IDS.users.a1_proc_commApp,
      "NEGOTIATION_QUOTE",
      IDS.hospitality.A,
      IDS.hotels.A1,
      IDS.departments.proc,
      null,
      null
    );
    expect(result).toBe(false);
  });

  it("returns false for cross-company lookup", async () => {
    const result = await checkIfUserIsFinalApprover(
      IDS.users.companyB_admin,
      "NEGOTIATION_QUOTE",
      IDS.hospitality.A, // wrong company for this user
      IDS.hotels.A1,
      IDS.departments.proc,
      null,
      IDS.processes.A_P1
    );
    expect(result).toBe(false);
  });
});

describe("checkIfUserIsFinalApprover — multi-step ALL semantics (PO chain)", () => {
  it("returns false when user is in a non-final step", async () => {
    // A1_P1_PO step 1 = poApp, step 2 = COMM_APPROVER role, step 3 = finance.
    // poApp is NOT the final approver — finance is.
    const result = await checkIfUserIsFinalApprover(
      IDS.users.a1_proc_poApp,
      "PO",
      IDS.hospitality.A,
      IDS.hotels.A1,
      IDS.departments.proc,
      null,
      IDS.processes.A_P1
    );
    expect(result).toBe(false);
  });

  it("returns true when user is the sole approver in the FINAL step (ALL rule)", async () => {
    // Step 3 is ALL with USER source = finance. Sole resolved approver.
    const result = await checkIfUserIsFinalApprover(
      IDS.users.a1_proc_finance,
      "PO",
      IDS.hospitality.A,
      IDS.hotels.A1,
      IDS.departments.proc,
      null,
      IDS.processes.A_P1
    );
    expect(result).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// HTTP controller: willBeFinalApprover
// ──────────────────────────────────────────────────────────────────────

describe("willBeFinalApprover controller — query-param scope path", () => {
  it("returns 400 when entity_type is missing", async () => {
    const r = await invokeController(ctrl.willBeFinalApprover, {
      user: { id: IDS.users.a1_proc_commApp },
      query: { hospitality_company_id: IDS.hospitality.A },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/entity_type/i);
  });

  it("returns 401 when user is missing", async () => {
    const r = await invokeController(ctrl.willBeFinalApprover, {
      user: null,
      query: {
        entity_type: "NEGOTIATION_QUOTE",
        hospitality_company_id: IDS.hospitality.A,
      },
    });
    expect(r.status).toBe(401);
  });

  it("returns 400 when neither rfq_id nor hospitality_company_id is provided", async () => {
    const r = await invokeController(ctrl.willBeFinalApprover, {
      user: { id: IDS.users.a1_proc_commApp },
      query: { entity_type: "NEGOTIATION_QUOTE" },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/hospitality_company_id|rfq_id/i);
  });

  it("returns willBeFinal=true with explicit query-param scope (sole P1 commApp)", async () => {
    const r = await invokeController(ctrl.willBeFinalApprover, {
      user: { id: IDS.users.a1_proc_commApp },
      query: {
        entity_type: "NEGOTIATION_QUOTE",
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.proc,
        process_id: IDS.processes.A_P1,
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.willBeFinal).toBe(true);
    expect(r.body.data.resolved_scope).toEqual({
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
      department_id: IDS.departments.proc,
      process_id: IDS.processes.A_P1,
    });
  });

  it("returns willBeFinal=false when process_id is omitted on a process-scoped policy", async () => {
    // This is the bug shape — the original endpoint version received no
    // process_id from the FE and returned false even for the actual final
    // approver. Locking it in as a regression guard.
    const r = await invokeController(ctrl.willBeFinalApprover, {
      user: { id: IDS.users.a1_proc_commApp },
      query: {
        entity_type: "NEGOTIATION_QUOTE",
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.proc,
        // NO process_id → no policy match
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.willBeFinal).toBe(false);
  });
});

describe("willBeFinalApprover controller — rfq_id derives scope (the FE happy path)", () => {
  // Tests in this block need committed RFQ rows because the controller's
  // db.oneOrNone runs against the production db handle, not a tx context.
  // We track the inserted RFQ IDs and clean them up in afterEach.
  const created = { rfqIds: [] };

  afterEach(async () => {
    if (created.rfqIds.length > 0) {
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [created.rfqIds]);
      created.rfqIds = [];
    }
  });

  async function makeCommittedRFQ(opts) {
    const { rfq_id } = await makeRFQ(db, opts);
    created.rfqIds.push(rfq_id);
    return rfq_id;
  }

  it("derives full scope (process_id included) from the RFQ — sole approver returns true", async () => {
    const rfq_id = await makeCommittedRFQ({
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      department: IDS.departments.proc,
      process: IDS.processes.A_P1,
    });

    const r = await invokeController(ctrl.willBeFinalApprover, {
      user: { id: IDS.users.a1_proc_commApp },
      query: { entity_type: "NEGOTIATION_QUOTE", rfq_id },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.willBeFinal).toBe(true);
    expect(r.body.data.resolved_scope.process_id).toBe(IDS.processes.A_P1);
    expect(r.body.data.resolved_scope.hotel_id).toBe(IDS.hotels.A1);
  });

  it("rfq_id resolution flips correctly across processes (P1 vs P2)", async () => {
    // Same user, two RFQs — one in P1 where they ARE the approver, one in P2
    // where they aren't. The endpoint should return different answers.
    const rfqP1 = await makeCommittedRFQ({
      createdBy: IDS.users.a1_proc_buyer,
      process: IDS.processes.A_P1,
    });
    const rfqP2 = await makeCommittedRFQ({
      createdBy: IDS.users.a1_proc_buyer,
      process: IDS.processes.A_P2,
    });

    const rP1 = await invokeController(ctrl.willBeFinalApprover, {
      user: { id: IDS.users.a1_proc_commApp },
      query: { entity_type: "NEGOTIATION_QUOTE", rfq_id: rfqP1 },
    });
    const rP2 = await invokeController(ctrl.willBeFinalApprover, {
      user: { id: IDS.users.a1_proc_commApp },
      query: { entity_type: "NEGOTIATION_QUOTE", rfq_id: rfqP2 },
    });
    expect(rP1.body.data.willBeFinal).toBe(true);
    expect(rP2.body.data.willBeFinal).toBe(false);
  });

  it("returns willBeFinal=true for the P2 commEval when the rfq is in P2", async () => {
    const rfq_id = await makeCommittedRFQ({
      createdBy: IDS.users.a1_proc_buyer,
      process: IDS.processes.A_P2,
    });
    const r = await invokeController(ctrl.willBeFinalApprover, {
      user: { id: IDS.users.a1_proc_commEval },
      query: { entity_type: "NEGOTIATION_QUOTE", rfq_id },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.willBeFinal).toBe(true);
    expect(r.body.data.resolved_scope.process_id).toBe(IDS.processes.A_P2);
  });

  it("returns 404 when rfq_id does not exist", async () => {
    const r = await invokeController(ctrl.willBeFinalApprover, {
      user: { id: IDS.users.a1_proc_commApp },
      query: { entity_type: "NEGOTIATION_QUOTE", rfq_id: 999_999_999 },
    });
    expect(r.status).toBe(404);
  });

  it("PO entity through rfq_id: poApp (step 1 of 3) is NOT final, finance IS", async () => {
    const rfq_id = await makeCommittedRFQ({
      createdBy: IDS.users.a1_proc_buyer,
      process: IDS.processes.A_P1,
    });

    const rPoApp = await invokeController(ctrl.willBeFinalApprover, {
      user: { id: IDS.users.a1_proc_poApp },
      query: { entity_type: "PO", rfq_id },
    });
    const rFinance = await invokeController(ctrl.willBeFinalApprover, {
      user: { id: IDS.users.a1_proc_finance },
      query: { entity_type: "PO", rfq_id },
    });
    expect(rPoApp.body.data.willBeFinal).toBe(false);
    expect(rFinance.body.data.willBeFinal).toBe(true);
  });
});
