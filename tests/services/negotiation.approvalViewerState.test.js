// negotiation.approvalViewerState.test.js — a round can await approval
// without awaiting YOURS.
//
// TICKET 2. Two facts about a negotiation round used to be conflated:
//
//   "this round is awaiting approval"   — a property of the ROUND
//   "this round is awaiting YOUR        — a property of the READER
//    approval"
//
// The possessive was baked into a state constant (negotiationModel.js:331,
// and its client mirror), computed with no viewer in scope. And the action
// gate was worse than cosmetic:
//
//   can_approve: !!p.approve && preApproval,      // negotiationRoundDetailController
//   can_reject:  !!p.approve && preApproval,
//
// Neither operand is viewer-relative to the approval INSTANCE. All five
// approvers on production round 914 hold negotiation.approve, and the round
// stays PENDING until the LAST of them acts — so everyone who had already
// approved kept seeing "Review and approve", and the API answered
//
//   "User has already acted on this step with status: APPROVED"
//                                              (generalModel.js:3299)
//
// …violating the invariant written at the top of the controller that renders
// those buttons: NEVER RENDER A BUTTON THE API WOULD REFUSE. Every assertion
// below is over real HTTP so that invariant is tested as one statement rather
// than two hopeful halves.
//
// MEASURED BLAST RADIUS (production, 2026-08-13):
//   NEGOTIATION approval steps by rule : ALL 882 (882 multi-approver) | ANY 35
//   Fully-approved multi-approver ALL steps : 821
//   Avg gap first -> last approval          : 8.4 hours   (max 4.8 days)
// User 745 approved round 914 at 2026-08-12 13:24; user 138 not until
// 2026-08-13 05:59. Sixteen and a half hours of being told the round awaited
// *his* approval.
//
// Fixture: ONE round, ONE `ALL` step, THREE approvers — the 96% shape, not an
// edge case. U_A approves; the payload is then read as U_A (acted), as U_B
// (still pending) and as U_NON (holds negotiation.approve, is not on the
// instance at all — the latent half of the bug).
//
// Pattern B (commit + cleanup). Run:
//   TEST_RUN_ID=<unique> npm test -- --testPathPatterns "negotiation\.approvalViewerState"

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

const HC_A = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const PROC = IDS.departments.proc;
const PROCESS = IDS.processes.A_P1;
const VENDOR = IDS.users.vendor_alpha;
const VARIANT_ID = 1;

// Role 8 = Commercial Negotiator — negotiation.{read,create,update,approve}.
// EVERY user below holds it, which is the whole point: the permission is not
// what distinguishes them. Their record on the approval instance is.
const ROLE_NEG_FULL = 8;

const U_A = 80961; // approver, and the round's creator — approves during setup
const U_B = 80962; // approver, never acts
const U_C = 80963; // approver, never acts
const U_NON = 80964; // holds negotiation.approve, is NOT an approver on this round

// Clear of 64960 / 64970 / 64980 (other suites) and 64961 (ARC expiry).
const POLICY_ID = 64990;

// The round must end in the FUTURE: approveRound refuses a round whose
// deadline has passed (negotiationController.js:1584), and that refusal would
// mask the one this suite is about.
const FUTURE_END = new Date(Date.now() + 5 * 86_400_000)
  .toISOString()
  .replace("T", " ")
  .slice(0, 19);
const PAST_BID_END = new Date(Date.now() - 30 * 86_400_000)
  .toISOString()
  .replace("T", " ")
  .slice(0, 19);

const created = { rfqIds: [], rfqProductIds: [], roundIds: [], instanceIds: [], stepIds: [] };

let clientA, clientB, clientNon;
let rfqId;
let rfqProductId;
let roundId;
let instanceId;

async function addUser(userId, name) {
  // THE FIXTURE TRAP: tbl_users.user_type is NULL on fixture rows and
  // acl([2, 8]) refuses before any handler runs — so "can_approve is false"
  // would pass against a 403 and prove nothing at all.
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, $2, $3, 1, 2, $4, now(), now())
     ON CONFLICT (id) DO UPDATE SET user_type = 2, status = 1`,
    [userId, name, `negviewer.${userId}@test.local`, IDS.companies.A]
  );
  await db.none(
    `INSERT INTO tbl_hospitality_user_mappings
       (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
    [userId, HC_A, A1, IDS.users.superAdmin]
  );
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
     VALUES ($1, $2, $3, $4, NULL)`,
    [userId, ROLE_NEG_FULL, HC_A, A1]
  );
}

/** The round-detail payload AS SEEN BY one caller. */
const detailAs = async (client) => {
  const res = await client.get(`/api/v1/negotiation/rounds/${roundId}/detail`);
  expect(res.status).toBe(200);
  return res.body.data;
};

describe("Negotiation approval — where the VIEWER stands", () => {
  beforeAll(async () => {
    await addUser(U_A, "Viewer State Approver A");
    await addUser(U_B, "Viewer State Approver B");
    await addUser(U_C, "Viewer State Approver C");
    await addUser(U_NON, "Viewer State Non-Approver");

    clientA = await httpClient(U_A);
    clientB = await httpClient(U_B);
    clientNon = await httpClient(U_NON);

    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'NEGOTIATION', $2, $3, NULL, true, $4, NULL, false, false, 1)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [POLICY_ID, HC_A, A1, U_A]
    );

    // bid window CLOSED, so the round-detail payload is not quote-visibility
    // redacted (a locked payload hides the very fields under test).
    const rfq = await makeRFQ(db, {
      createdBy: U_A,
      hospitality: HC_A,
      hotel: A1,
      department: PROC,
      process: PROCESS,
      bid_end_date: PAST_BID_END,
      title: "NEGVIEWER Approval Viewer State RFQ",
      status: 1,
      is_published: 1,
    });
    rfqId = Number(rfq.rfq_id);
    created.rfqIds.push(rfqId);

    const product = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, product_variant_id, variant, comment, spec_file, qap_file)
       VALUES ($1, $2, 0, 'NEGVIEWER line', '0', '0') RETURNING id`,
      [rfqId, VARIANT_ID]
    );
    rfqProductId = Number(product.id);
    created.rfqProductIds.push(rfqProductId);

    // created_by = U_A on purpose. can_withdraw is authorship-gated and must
    // NOT pick up the new is_pending_for_me condition — see the guard below.
    const round = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (rfq_id, source_type, source_id, rfq_product_id, round_number, status,
          end_date, vendor_ids, vendor_approvals, created_by, remarks, created_at)
       VALUES ($1, 'RFQ', $1, $2, 1, 'PENDING_APPROVAL',
               $3::timestamp, ARRAY[$4]::int[], $5::jsonb, $6, 'viewer state round', now())
       RETURNING id`,
      [
        rfqId,
        rfqProductId,
        FUTURE_END,
        VENDOR,
        JSON.stringify([
          { vendor_id: VENDOR, status: "PENDING", remarks: null, acted_by: null, acted_at: null,
            negotiation_fields: [{ name: "base_price", target: "90" }] },
        ]),
        U_A,
      ]
    );
    roundId = Number(round.id);
    created.roundIds.push(roundId);

    // ── ONE step, decision_rule ALL, THREE pending approvers ─────────────────
    // 96% of production negotiation rounds go through exactly this shape.
    const inst = await db.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, current_step,
          initiated_by, hospitality_company_id, hotel_id, department_id, metadata)
       VALUES ('NEGOTIATION', $1, $2, 'PENDING', 1, $3, $4, $5, $6, $7::jsonb)
       RETURNING id`,
      [
        roundId, POLICY_ID, U_A, HC_A, A1, PROC,
        JSON.stringify({ rfq_id: String(rfqId), rfq_product_id: rfqProductId, round_id: roundId }),
      ]
    );
    instanceId = Number(inst.id);
    created.instanceIds.push(instanceId);

    const step = await db.one(
      `INSERT INTO tbl_approval_instance_steps
         (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1, 1, 'ALL', 'PENDING') RETURNING id`,
      [instanceId]
    );
    created.stepIds.push(Number(step.id));

    await db.none(
      `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
       VALUES ($1, $2, 'PENDING'), ($1, $3, 'PENDING'), ($1, $4, 'PENDING')`,
      [Number(step.id), U_A, U_B, U_C]
    );

    // ── U_A APPROVES — through the real endpoint, not a hand-rolled UPDATE ───
    // Everything below is the state of the world after ONE of three approvers
    // has acted: the 8.4-hour window production spends here on average.
    const approve = await clientA
      .post(`/api/v1/negotiation/rounds/${roundId}/approve`)
      .send({ remarks: "A approves" });
    expect(approve.status).toBe(200);
    expect(approve.body.data.allApproved).toBe(false);

    // Sanity: the round is genuinely still awaiting the other two.
    const after = await db.one(`SELECT status FROM tbl_negotiation_rounds WHERE id = $1`, [roundId]);
    expect(after.status).toBe("PENDING_APPROVAL");
  });

  afterAll(async () => {
    if (created.instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [created.instanceIds]);
      await db.none(
        `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
           (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
        [created.instanceIds]
      );
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [created.instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [created.instanceIds]);
    }
    if (created.roundIds.length) {
      await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [created.roundIds]);
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [created.roundIds]);
    }
    if (created.rfqProductIds.length) {
      await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [created.rfqProductIds]);
    }
    if (created.rfqIds.length) {
      await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [created.rfqIds]);
    }
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[]) AND role_id = $2`, [
      [U_A, U_B, U_C, U_NON], ROLE_NEG_FULL,
    ]);
  });

  // ── the approver who has already acted ─────────────────────────────────────

  describe("the approver who already approved", () => {
    it("is told WHERE THEY STAND — my_status APPROVED, not waiting on them", async () => {
      const d = await detailAs(clientA);
      // `my_status` is new. Pre-fix the field did not exist, so the client had
      // nothing viewer-relative to render the header from and fell back to the
      // state's own baked-in possessive.
      expect(d.approval.my_status).toBe("APPROVED");
      expect(d.approval.is_pending_for_me).toBe(false);
    });

    it("is told HOW MANY are left — a count, never names", async () => {
      const d = await detailAs(clientA);
      // Two of three still to act. Names would tell the reader who is sitting
      // on it, which is not theirs to know from a status chip (decision 3).
      expect(d.approval.pending_count).toBe(2);
      expect(d.approval.pending_with).toHaveLength(2);
      expect(d.approval.pending_with.map((a) => Number(a.user_id)).sort()).toEqual([U_B, U_C]);
      // The viewer is NOT in pending_with — which is what makes pending_count
      // readable as "other approvers" on the client.
      expect(d.approval.pending_with.map((a) => Number(a.user_id))).not.toContain(U_A);
    });

    it("IS NOT SHOWN Approve or Reject — the invariant, tested as one statement", async () => {
      const d = await detailAs(clientA);
      expect(d.permissions.approve).toBe(true); // holds it, in scope…
      expect(d.actions.can_approve).toBe(false); // …and still must not see the button
      expect(d.actions.can_reject).toBe(false);
    });

    it("…because the API would refuse it — 400, 'already acted'", async () => {
      // The other half of the same statement. If this ever returns 200 the
      // gate above has become over-tight instead of correct; if the gate above
      // returns true this proves the button was a lie.
      const res = await clientA
        .post(`/api/v1/negotiation/rounds/${roundId}/approve`)
        .send({ remarks: "A approves again" });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(/already acted|already (approved|rejected)/i);
    });

    it("keeps the round's own label neutral — the state is not the reader", async () => {
      const d = await detailAs(clientA);
      expect(d.round.state).toBe("awaiting_approval");
      // 'Awaiting your approval' had "your" baked into a table keyed on ROUND
      // STATE, so every one of the five approvers on a round read the same
      // possessive. The server label is now viewer-independent and correct for
      // everyone; the client composes the possessive from my_status.
      expect(d.round.state_label).toBe("Awaiting approval");
      expect(d.round.state_label).not.toMatch(/your/i);
    });

    it("REGRESSION GUARD: can_withdraw stays authorship-gated, not approval-gated", async () => {
      // U_A created this round AND has approved it. Withdraw is the author's
      // escape hatch and must survive the new is_pending_for_me condition —
      // tightening it would strand exactly the buyer it exists for.
      const d = await detailAs(clientA);
      expect(Number(d.round.created_by.user_id)).toBe(U_A);
      expect(d.actions.can_withdraw).toBe(true);
    });

    it("REGRESSION GUARD: the vendor-level gates are deliberately NOT viewer-gated", async () => {
      // POST /rounds/:id/approve-vendor is acl([2,8]) + read scope + round
      // status — it never consults the approval instance. So these buttons are
      // ones the API HONOURS, and gating them would hide a working action.
      // Pinned so that "tighten them too, for consistency" is a decision
      // someone makes on purpose rather than a tidy-up.
      const d = await detailAs(clientA);
      expect(d.actions.can_approve_vendor).toBe(true);
      expect(d.actions.can_reject_vendor).toBe(true);
    });
  });

  // ── the approver who has not acted ────────────────────────────────────────

  describe("the approver who has NOT acted", () => {
    it("still gets the button, and the API still honours it", async () => {
      const d = await detailAs(clientB);
      expect(d.approval.my_status).toBe("PENDING");
      expect(d.approval.is_pending_for_me).toBe(true);
      expect(d.actions.can_approve).toBe(true);
      expect(d.actions.can_reject).toBe(true);
    });

    it("reads the same neutral round label as everybody else", async () => {
      const d = await detailAs(clientB);
      expect(d.round.state_label).toBe("Awaiting approval");
      // The possessive is the CLIENT's to compose from my_status: the same
      // round is 'Awaiting your approval' to U_B and 'You approved — awaiting
      // 2 other approvers' to U_A, off one payload field.
      expect(d.approval.my_status).toBe("PENDING");
    });

    it("cannot withdraw a round somebody else created", async () => {
      const d = await detailAs(clientB);
      expect(d.actions.can_withdraw).toBe(false);
    });
  });

  // ── the reader who is not an approver at all ──────────────────────────────

  describe("the reader who holds negotiation.approve but is NOT on this instance", () => {
    it("has no status on it — my_status is null, not 'PENDING'", async () => {
      const d = await detailAs(clientNon);
      expect(d.approval.my_status).toBeNull();
      expect(d.approval.is_pending_for_me).toBe(false);
    });

    it("IS NOT SHOWN Approve or Reject — this was the latent half of the bug", async () => {
      const d = await detailAs(clientNon);
      // The permission is held. Pre-fix that alone rendered the buttons, on a
      // round this user was never asked to decide.
      expect(d.permissions.approve).toBe(true);
      expect(d.actions.can_approve).toBe(false);
      expect(d.actions.can_reject).toBe(false);
    });

    it("…and the API would refuse it — 400, 'not an approver'", async () => {
      const res = await clientNon
        .post(`/api/v1/negotiation/rounds/${roundId}/approve`)
        .send({ remarks: "not my round" });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(/not an approver|not authorized|no pending/i);
    });

    it("still sees the round, and still sees who it is with", async () => {
      // Hiding the ACTION must not hide the INFORMATION — a colleague looking
      // at a round to find out who to chase is a legitimate reader.
      const d = await detailAs(clientNon);
      expect(d.approval.status).toBe("PENDING");
      expect(d.approval.pending_count).toBe(2);
      expect(d.round.state_label).toBe("Awaiting approval");
    });
  });
});
