// negotiation.approvalActivation.test.js — the negotiation-round approval
// activation path (live data-integrity trap).
//
// THE BUGS THIS SUITE PINS DOWN
//
// 1. (P0) Approving a NEGOTIATION approval instance through the GENERIC engine
//    endpoint — POST /general/hospitality/approval/action, which is what the
//    entity-agnostic RfqApprovalDecisionCard on the RFQ workspace and the
//    in-app pending-approvals queue both call — never activated the round.
//    approvalActionService dispatched `handleNegotiationPostApproval`, which
//    wrote finalizations and flipped vendor statuses but never set
//    status='ACTIVE' / approved_at / published_at and never sent the vendor
//    invitation. The approver saw "approved", and the round silently rotted to
//    EXPIRED with zero vendor quotes.
//
// 2. (P0) The dedicated endpoint POST /negotiation/rounds/:id/approve flipped
//    EVERY vendor_approvals[].status to APPROVED unconditionally — outside the
//    "instance is fully approved" branch. On a multi-step ALL policy the first
//    approver's click made the round look vendor-approved while it was still
//    PENDING_APPROVAL.
//
// 3. (P0) Six mutating round endpoints (approve, reject, approve-vendor,
//    reject-vendor, resubmit-vendor, close) resolved the round by id with NO
//    tenant check, so any acl([2,8]) user could mutate another hotel's round.
//
// 4. (P1) The approve-vendor activation path sent only the internal
//    "round approved" mail — never the vendor invitation — so the round went
//    live and the vendors were never told.
//
// 5. Double-click safety: approveRound read round.status without a lock and
//    ignored the engine's `already_completed` flag, so a retry could re-send
//    the approved mail and every vendor invite a second time.
//
// Assertions are OBSERVABLE OUTCOMES only — round row state, vendor_approvals
// JSONB, HTTP status, and which notification payloads were produced. Never
// which function called which.

import {
  describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest,
} from "@jest/globals";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

// ── Email capture ───────────────────────────────────────────────────────────
// The activation notifications are fire-and-forget; we capture the payloads
// rather than the transport so we can assert WHO would have been told.
const emailCalls = { vendor: [], approved: [], created: [] };

jest.unstable_mockModule(
  "../../app/helper/sendEmailFunctions/negotiationEmails.js",
  () => ({
    sendNegotiationExpiredNotification: async () => {},
    sendNegotiationRoundEndedNotification: async () => {},
    sendNegotiationRoundCreatedNotification: async (args) => { emailCalls.created.push(args); },
    sendNegotiationRoundVendorNotification: async (args) => { emailCalls.vendor.push(args); },
    sendNegotiationRoundApprovedNotification: async (args) => { emailCalls.approved.push(args); },
  })
);

const { httpClient } = await import("../helpers/http.js");
const negotiationController = (
  await import("../../app/controllers/negotiation/negotiationController.js")
).default;

// ── Actors ──────────────────────────────────────────────────────────────────
const BUYER = IDS.users.a1_proc_buyer;      // round creator (no negotiation.read)
const APPROVER = IDS.users.a1_proc_commApp;  // COMM_APPROVER — sole A1/P1 NEGOTIATION approver
// Step 2 on the multi-step policy. Must be a role that carries negotiation.read,
// because the tenant guard on the dedicated endpoints is the negotiation read
// matrix — an approver without that permission can only act through the generic
// approval endpoint. COMM_NEGO_N1 (role 8) carries it; TENDER_APPROVER does not.
const SECOND_APPROVER = IDS.users.a1_proc_commEval;
const OUTSIDER = IDS.users.companyB_admin;   // Hospitality B — must never touch an A1 round
const VENDOR = IDS.users.vendor_alpha;
const VARIANT_ID = 1;

const created = {
  rfqIds: [],
  roundIds: [],
  processIds: [],
  policyIds: [],
};

let approverClient, secondApproverClient, outsiderClient;

// ── Small utilities ─────────────────────────────────────────────────────────
const futureIso = (offsetMs = 7 * 86400_000) => new Date(Date.now() + offsetMs).toISOString();
const pastSqlTs = (offsetMs = 86400_000) =>
  new Date(Date.now() - offsetMs).toISOString().replace("T", " ").slice(0, 19);

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return {
    req: { user: opts.user, params: opts.params || {}, body: opts.body || {}, query: opts.query || {} },
    res,
    calls,
  };
}

/** Poll until `predicate()` is truthy or the budget runs out. */
async function waitFor(predicate, { timeoutMs = 8000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const roundRow = (roundId) =>
  db.one(`SELECT * FROM tbl_negotiation_rounds WHERE id = $1`, [roundId]);

const vendorStatuses = async (roundId) => {
  const row = await roundRow(roundId);
  return (row.vendor_approvals || []).map((v) => v.status);
};

/**
 * Seed the exact live state the traps need: a bid-ended RFQ with one product,
 * one eligible vendor, and a negotiation round sitting in PENDING_APPROVAL
 * behind a real NEGOTIATION approval instance. The round is created through
 * the production controller, not hand-rolled SQL.
 */
async function seedRoundPendingApproval({ process = IDS.processes.A_P1, label = "neg-activation" } = {}) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: BUYER,
    status: 1,
    is_published: 1,
    tender_publish_date: pastSqlTs(3 * 86400_000),
    vendor_clarification_date: pastSqlTs(2 * 86400_000),
    bid_end_date: pastSqlTs(), // bid window CLOSED → negotiation allowed
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process,
    title: label,
  });
  created.rfqIds.push(Number(rfq_id));

  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
    [rfq_id, VARIANT_ID]
  );
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, VARIANT_ID, VENDOR]
  );

  const m = mockExpress({
    user: { id: BUYER },
    body: {
      rfq_id,
      rfq_product_id: product.id,
      end_date: futureIso(),
      vendor_targets: [{ vendor_id: VENDOR, fields: [{ name: "base_price", target: "90" }] }],
    },
  });
  await negotiationController.createRound(m.req, m.res);
  expect(m.calls.status).toBe(200);

  const round = await db.one(
    `SELECT * FROM tbl_negotiation_rounds WHERE rfq_id = $1 ORDER BY id DESC LIMIT 1`,
    [rfq_id]
  );
  created.roundIds.push(Number(round.id));
  // The buyer initiated and the approver is somebody else — nothing auto-approves.
  expect(round.status).toBe("PENDING_APPROVAL");

  const instance = await db.one(
    `SELECT * FROM tbl_approval_instances
      WHERE entity_type = 'NEGOTIATION' AND entity_id = $1 AND status = 'PENDING'`,
    [round.id]
  );

  return {
    rfqId: Number(rfq_id),
    rfqProductId: Number(product.id),
    roundId: Number(round.id),
    instanceId: Number(instance.id),
  };
}

/** A NEGOTIATION policy with two ALL steps, so step 1 leaves the instance PENDING. */
async function seedMultiStepNegotiationPolicy() {
  const proc = await db.one(
    `INSERT INTO tbl_approval_processes
       (company_id, name, description, is_active, created_by, process_type)
     VALUES ($1, 'Neg-Activation Two-Step', '', true, $2, 'RFQ') RETURNING id`,
    [IDS.companies.A, IDS.users.companyA_admin]
  );
  created.processIds.push(Number(proc.id));

  const policy = await db.one(
    `INSERT INTO tbl_approval_policies
       (entity_type, hospitality_company_id, hotel_id, department_id,
        is_active, created_by, process_id, is_master, is_department_scoped, version)
     VALUES ('NEGOTIATION', $1, $2, NULL, true, $3, $4, false, false, 1) RETURNING id`,
    [IDS.hospitality.A, IDS.hotels.A1, IDS.users.companyA_admin, proc.id]
  );
  created.policyIds.push(Number(policy.id));

  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'ALL', 'USER', $2), ($1, 2, 'ALL', 'USER', $3)`,
    [policy.id, APPROVER, SECOND_APPROVER]
  );

  return Number(proc.id);
}

describe("Negotiation round approval — activation, idempotency, vendor invite, tenant guard", () => {
  beforeAll(async () => {
    // The negotiation routes are gated by acl([2, 8]); fixture users carry a
    // NULL user_type by design. Restored in afterAll.
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [
      [APPROVER, SECOND_APPROVER, OUTSIDER],
    ]);
    approverClient = await httpClient(APPROVER);
    secondApproverClient = await httpClient(SECOND_APPROVER);
    outsiderClient = await httpClient(OUTSIDER);
  });

  afterAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = ANY($1::int[])`, [
      [APPROVER, SECOND_APPROVER, OUTSIDER],
    ]);
  });

  beforeEach(() => {
    emailCalls.vendor.length = 0;
    emailCalls.approved.length = 0;
    emailCalls.created.length = 0;
  });

  afterEach(async () => {
    if (created.roundIds.length) {
      await db.none(
        `DELETE FROM tbl_approval_actions WHERE approval_instance_id IN (
           SELECT id FROM tbl_approval_instances
            WHERE entity_type = 'NEGOTIATION' AND entity_id = ANY($1::int[]))`,
        [created.roundIds]
      );
      await db.none(
        `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
           SELECT s.id FROM tbl_approval_instance_steps s
             JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
            WHERE i.entity_type = 'NEGOTIATION' AND i.entity_id = ANY($1::int[]))`,
        [created.roundIds]
      );
      await db.none(
        `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id IN (
           SELECT id FROM tbl_approval_instances
            WHERE entity_type = 'NEGOTIATION' AND entity_id = ANY($1::int[]))`,
        [created.roundIds]
      );
      await db.none(
        `DELETE FROM tbl_approval_instances
          WHERE entity_type = 'NEGOTIATION' AND entity_id = ANY($1::int[])`,
        [created.roundIds]
      );
      await db.none(
        `DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`,
        [created.roundIds]
      );
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [created.roundIds]);
      created.roundIds = [];
    }
    if (created.rfqIds.length) {
      await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [created.rfqIds]);
      created.rfqIds = [];
    }
    if (created.policyIds.length) {
      await db.none(
        `DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`,
        [created.policyIds]
      );
      await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [created.policyIds]);
      created.policyIds = [];
    }
    if (created.processIds.length) {
      await db.none(`DELETE FROM tbl_approval_processes WHERE id = ANY($1::int[])`, [created.processIds]);
      created.processIds = [];
    }
  });

  // ══ FIX 1 — the generic engine must produce the dedicated endpoint's outcome ══
  test("POST /general/hospitality/approval/action APPROVE activates the round and invites the vendors", async () => {
    const seed = await seedRoundPendingApproval({ label: "generic-endpoint activation" });

    const res = await approverClient
      .post("/api/v1/general/hospitality/approval/action")
      .send({ approval_instance_id: seed.instanceId, action: "APPROVE", comment: "go live" });

    expect(res.status).toBe(200);
    expect(res.body.data.instance_status).toBe("APPROVED");

    // The round must actually go live — not merely be "approved" on paper.
    const round = await waitFor(async () => {
      const r = await roundRow(seed.roundId);
      return r.status === "ACTIVE" ? r : null;
    });
    expect(round?.status).toBe("ACTIVE");
    expect(round.published_at).not.toBeNull();
    expect(round.approved_at).not.toBeNull();

    // …and the vendors must be told, or nobody can quote into it.
    await waitFor(() => emailCalls.vendor.length > 0);
    expect(emailCalls.vendor).toHaveLength(1);
    expect(emailCalls.vendor[0].vendors.map((v) => Number(v.id))).toContain(VENDOR);

    // Vendor-level statuses follow the round.
    expect(await vendorStatuses(seed.roundId)).toEqual(["APPROVED"]);
  });

  // ══ Idempotency — a double-click must activate once and notify once ══
  test("approving the same instance twice activates once and sends the vendor invitation once", async () => {
    const seed = await seedRoundPendingApproval({ label: "double-click idempotency" });

    const first = await approverClient
      .post("/api/v1/general/hospitality/approval/action")
      .send({ approval_instance_id: seed.instanceId, action: "APPROVE", comment: "go live" });
    expect(first.status).toBe(200);

    const activated = await waitFor(async () => {
      const r = await roundRow(seed.roundId);
      return r.status === "ACTIVE" ? r : null;
    });
    expect(activated?.status).toBe("ACTIVE");
    await waitFor(() => emailCalls.vendor.length > 0);

    // The retry: same approver, same instance, already terminal.
    const second = await approverClient
      .post("/api/v1/general/hospitality/approval/action")
      .send({ approval_instance_id: seed.instanceId, action: "APPROVE", comment: "go live" });
    expect(second.status).toBe(200);

    // Give any second-round fire-and-forget notification a chance to land.
    await new Promise((r) => setTimeout(r, 700));

    const after = await roundRow(seed.roundId);
    expect(after.status).toBe("ACTIVE");
    // published_at must not be rewritten by the retry.
    expect(new Date(after.published_at).getTime()).toBe(new Date(activated.published_at).getTime());

    expect(emailCalls.vendor).toHaveLength(1);
    expect(emailCalls.approved).toHaveLength(1);
  });

  // ══ FIX 2 — a partial approval must not flip vendor statuses ══
  test("multi-step ALL policy: the first approver does not flip vendor statuses to APPROVED", async () => {
    const processId = await seedMultiStepNegotiationPolicy();
    const seed = await seedRoundPendingApproval({ process: processId, label: "two-step ALL" });

    const res = await approverClient
      .post(`/api/v1/negotiation/rounds/${seed.roundId}/approve`)
      .send({ remarks: "step 1 ok" });
    expect(res.status).toBe(200);
    expect(res.body.data.allApproved).toBe(false);

    const round = await roundRow(seed.roundId);
    expect(round.status).toBe("PENDING_APPROVAL");
    expect(round.published_at).toBeNull();
    // THE TRAP: the round is still awaiting step 2, so no vendor may be shown
    // as approved.
    expect(await vendorStatuses(seed.roundId)).toEqual(["PENDING"]);
    expect(emailCalls.vendor).toHaveLength(0);

    // Step 2 completes the instance → now it activates and the vendors are told.
    const final = await secondApproverClient
      .post(`/api/v1/negotiation/rounds/${seed.roundId}/approve`)
      .send({ remarks: "step 2 ok" });
    expect(final.status).toBe(200);
    expect(final.body.data.allApproved).toBe(true);

    const live = await waitFor(async () => {
      const r = await roundRow(seed.roundId);
      return r.status === "ACTIVE" ? r : null;
    });
    expect(live?.status).toBe("ACTIVE");
    expect(await vendorStatuses(seed.roundId)).toEqual(["APPROVED"]);
    await waitFor(() => emailCalls.vendor.length > 0);
    expect(emailCalls.vendor).toHaveLength(1);
  });

  // ══ FIX 4 — the approve-vendor activation path must invite the vendors ══
  test("approve-vendor completes the round and sends the vendor invitation", async () => {
    const seed = await seedRoundPendingApproval({ label: "approve-vendor invite" });

    const res = await approverClient
      .post(`/api/v1/negotiation/rounds/${seed.roundId}/approve-vendor`)
      .send({ vendor_id: VENDOR, remarks: "vendor ok" });

    expect(res.status).toBe(200);
    expect(res.body.data.round_active).toBe(true);

    const round = await waitFor(async () => {
      const r = await roundRow(seed.roundId);
      return r.status === "ACTIVE" ? r : null;
    });
    expect(round?.status).toBe("ACTIVE");
    expect(round.published_at).not.toBeNull();

    await waitFor(() => emailCalls.vendor.length > 0);
    expect(emailCalls.vendor).toHaveLength(1);
    expect(emailCalls.vendor[0].vendors.map((v) => Number(v.id))).toContain(VENDOR);
  });

  // ══ FIX 3 — six mutating endpoints must refuse a cross-tenant caller ══
  test("a cross-hotel caller is refused on every mutating round endpoint, and the round is untouched", async () => {
    const seed = await seedRoundPendingApproval({ label: "tenant guard" });
    const before = await roundRow(seed.roundId);

    const attempts = [
      ["approve", {}],
      ["reject", { remarks: "not mine" }],
      ["approve-vendor", { vendor_id: VENDOR }],
      ["reject-vendor", { vendor_id: VENDOR, remarks: "not mine" }],
      ["resubmit-vendor", { vendor_id: VENDOR }],
      ["close", { action: "ANOTHER_ROUND" }],
    ];

    for (const [segment, body] of attempts) {
      const res = await outsiderClient
        .post(`/api/v1/negotiation/rounds/${seed.roundId}/${segment}`)
        .send(body);
      expect({ segment, status: res.status }).toEqual({ segment, status: 403 });
    }

    const after = await roundRow(seed.roundId);
    expect(after.status).toBe(before.status);
    expect(after.published_at).toBeNull();
    expect(after.approved_at).toBeNull();
    expect(await vendorStatuses(seed.roundId)).toEqual(["PENDING"]);

    // The instance is untouched too — no action was recorded against it.
    const actions = await db.any(
      `SELECT id FROM tbl_approval_actions WHERE approval_instance_id = $1`,
      [seed.instanceId]
    );
    expect(actions).toHaveLength(0);
  });

  // ══ Control: the legitimate approver still gets through ══
  test("the in-scope approver still activates the round through the dedicated endpoint", async () => {
    const seed = await seedRoundPendingApproval({ label: "dedicated endpoint control" });

    const res = await approverClient
      .post(`/api/v1/negotiation/rounds/${seed.roundId}/approve`)
      .send({ remarks: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.data.published).toBe(true);

    const round = await waitFor(async () => {
      const r = await roundRow(seed.roundId);
      return r.status === "ACTIVE" ? r : null;
    });
    expect(round?.status).toBe("ACTIVE");
    expect(round.published_at).not.toBeNull();
    await waitFor(() => emailCalls.vendor.length > 0);
    expect(emailCalls.vendor).toHaveLength(1);
  });
});
