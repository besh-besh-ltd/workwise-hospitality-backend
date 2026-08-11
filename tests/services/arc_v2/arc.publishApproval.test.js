// ARC v2 — publish-approval gate (ARC_PUBLISH).
//
// Product-level: real Express app + local Postgres. Asserts OBSERVABLE
// end-to-end behaviour over HTTP + DB rows; never internal call counts.
//
// The gate inserts an approval step between an ARC being *published* and it
// going LIVE (floated, vendor-visible):
//   - publish resolves the ARC policy (matched as entity_type 'ARC'), creates
//     an ARC_PUBLISH instance, parks the ARC in pending_publish_approval (NOT
//     live). No policy → 400 (stays draft).
//   - APPROVE (POST /:id/publish-approval/decide) → auto-floats + vendors see it.
//     Auto-approve (creator is sole approver) → floats in the publish response.
//   - REJECT → publish_rejected (still invisible to vendors); creator edits +
//     re-publishes (fresh PENDING instance).
//   - withdraw a pending publish → draft (instance CANCELLED).
//   - legacy 'ARC' instances (entity_id = rfq_product_id) must NOT mis-fire the
//     publish hook (collision guard — 'ARC' is not in the dispatch registry).
//
// Cases (mapped to the required list):
//   1  publish creates the gate, NOT live
//   2  pending ARC invisible to vendors (list + detail + lifecycle)
//   3  approve → auto-floats + vendor-visible
//   4  reject → not live + revisable (edit + re-publish → fresh PENDING)
//   5  no-policy → 400 (ARC stays draft)
//   6  auto-approve floats immediately
//   7  legacy 'ARC' instance does NOT mis-fire the publish hook
//   8  withdraw a pending publish → draft (instance CANCELLED)
//   9  permissions: publish w/o hotel access → 403; decide by non-approver → 400
//  10  in-flight floated ARC unaffected → publish 409

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { ensureArcApprovable } from "../../helpers/arcApproverPerms.js";

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;
const HOTEL_B  = IDS.hotels.B1;       // a hotel the A-side buyer cannot access
const DEPT     = IDS.departments.proc;
const PROC     = IDS.processes.A_P1;
const BUYER    = IDS.users.a1_proc_buyer;     // creator
const APPROVER = IDS.users.a1_proc_techApp;   // a DIFFERENT user (policy approver)
const OUTSIDER = IDS.users.a1_eng_buyer;      // a buyer with no policy-chain role
const VENDOR   = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;

// A UNIQUE index uq_approval_policy_scope_process forbids two ACTIVE policies
// in the same (entity_type, company, hotel, dept, process) scope. So we keep ONE
// shared ARC policy at (ARC, HC, HOTEL, PROC) and re-point its single step's
// approver per scenario (suites run sequentially, maxWorkers:1). The no-policy
// scenario simply DEACTIVATES it (the index is partial WHERE is_active=true and
// findBestMatchingPolicyTx filters is_active=true) — no delete, so the FK from
// existing instances is never violated.
const POLICY_ID        = 64920;  // shared ARC policy (5-digit 649xx test block)
const POLICY_LEGACY_ID = 64929;  // throwaway 'ARC' policy for the legacy instance
                                 // (distinct hotel scope → no unique collision)

const ALL_POLICY_IDS = [POLICY_ID, POLICY_LEGACY_ID];

const BASE = "/api/v1/arc-v2";

// Seed a complete, publishable invitation-type draft ARC with one item and a
// pre-seeded invitation for vendor_alpha. Returns the arc id.
//
// submission_start_at is seeded already-open (NOW() - 1 hour), not in the
// future: this suite exercises the ARC_PUBLISH approval gate itself (pending →
// approved/rejected → floated), which is orthogonal to submission-window
// timing. Sr 27 (Option C) hides a floated ARC from vendors + defers its float
// notification while submission_start_at is still future — cases 3 and 6 below
// assert immediate vendor visibility right after floating, so the window must
// already be open for those assertions to hold. The hidden-until-open /
// deferred-notification behavior itself is covered by arc.submissionOpen.test.js.
async function seedDraftArc(arcNumber, { hotel = HOTEL, status = "draft" } = {}) {
  const arc = await db.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id,
        department_id, process_id, status, eligibility_type,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at,
        payment_terms_expected, created_by)
     VALUES ($1, 'Publish-approval fixture', $2, $3, $4, $5, $6, $7, 'invitation',
             NOW() - INTERVAL '1 hour', NOW() + INTERVAL '7 days',
             NOW() + INTERVAL '14 days', NOW() + INTERVAL '200 days',
             'Net 30', $8) RETURNING id`,
    [arcNumber, CATEGORY, HC, hotel, DEPT, PROC, status, BUYER]
  );
  const arcId = Number(arc.id);
  await db.none(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
     VALUES ($1, 1, 500, 'litre', 100)`, [arcId]);
  await db.none(
    `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status) VALUES ($1, $2, 'invited')`,
    [arcId, VENDOR]);
  return arcId;
}

// Ensure the shared ARC policy exists, is ACTIVE, and its single step points at
// `approverUserId`. Idempotent across scenarios — the step is rewritten each time.
async function pointPolicyAt(approverUserId) {
  await db.none(
    `INSERT INTO tbl_approval_policies
       (id, entity_type, hospitality_company_id, hotel_id, department_id,
        is_active, created_by, process_id, is_master, is_department_scoped, version)
     VALUES ($1, 'ARC', $2, $3, NULL, true, $4, $5, false, false, 1)
     ON CONFLICT (id) DO UPDATE SET is_active = true`,
    [POLICY_ID, HC, HOTEL, BUYER, PROC]);
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'ALL', 'USER', $2)`,
    [POLICY_ID, approverUserId]);
  // USER-source steps are permission-gated at instance creation: the named
  // approver must hold read+approve on 'arc' or the step (and thus the whole
  // policy, which has only this one step) gets dropped. Only the user actually
  // named here is granted — never the other suite actors.
  await ensureArcApprovable(db, approverUserId, HC);
}

// Toggle the shared policy active/inactive (no-policy scenario uses false). The
// partial unique index + findBestMatchingPolicyTx both gate on is_active=true.
async function setPolicyActive(active) {
  await db.none(`UPDATE tbl_approval_policies SET is_active = $2 WHERE id = $1`, [POLICY_ID, active]);
}

// A throwaway 'ARC' policy in a DIFFERENT scope (HOTEL_B) so it can't collide
// with the shared A-side policy on uq_approval_policy_scope_process.
async function seedLegacyPolicy() {
  await db.none(
    `INSERT INTO tbl_approval_policies
       (id, entity_type, hospitality_company_id, hotel_id, department_id,
        is_active, created_by, process_id, is_master, is_department_scoped, version)
     VALUES ($1, 'ARC', $2, $3, NULL, true, $4, $5, false, false, 1)
     ON CONFLICT (id) DO NOTHING`,
    [POLICY_LEGACY_ID, IDS.hospitality.B, HOTEL_B, BUYER, IDS.processes.B_P1]);
}

async function deletePublishInstances(arcId) {
  const ids = (await db.any(
    `SELECT id FROM tbl_approval_instances WHERE entity_type = 'ARC_PUBLISH' AND entity_id = $1`,
    [arcId])).map((r) => r.id);
  if (!ids.length) return;
  await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_approval_step_approvers
                  WHERE approval_instance_step_id IN
                    (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [ids]);
  await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [ids]);
}

async function cleanupArc(arcId) {
  await deletePublishInstances(arcId);
  await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = $1`, [String(arcId)]);
  await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
  await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = $1`, [arcId]);
  await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
  await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
}

describe("ARC v2 — publish-approval gate (ARC_PUBLISH)", () => {
  let buyerClient, approverClient, outsiderClient, vendorClient;
  const createdArcs = [];

  beforeAll(async () => {
    // Roles: buyers user_type=2 (acl[2,8]); vendor user_type=3 (acl[3]).
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id IN ($1,$2,$3)`,
      [BUYER, APPROVER, OUTSIDER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);

    buyerClient    = await httpClient(BUYER);
    approverClient = await httpClient(APPROVER);
    outsiderClient = await httpClient(OUTSIDER);
    vendorClient   = await httpClient(VENDOR);
  });

  afterAll(async () => {
    for (const arcId of createdArcs) await cleanupArc(arcId);
    for (const pid of ALL_POLICY_IDS) {
      await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [pid]);
      await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [pid]);
    }
  });

  // ---- Case 1: publish creates the gate, NOT live -------------------------
  test("1. publish creates an ARC_PUBLISH instance and parks pending_publish_approval (not floated)", async () => {
    await pointPolicyAt(APPROVER);
    const arcId = await seedDraftArc("ARC-PA-1");
    createdArcs.push(arcId);

    const pub = await buyerClient.post(`${BASE}/${arcId}/publish`).send({});
    expect(pub.status).toBe(200);
    expect(pub.body.data.floated).toBe(false);
    expect(pub.body.data.arc.status).toBe("pending_publish_approval");

    const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(row.status).toBe("pending_publish_approval");

    const inst = await db.one(
      `SELECT entity_type, entity_id, status FROM tbl_approval_instances
        WHERE entity_type = 'ARC_PUBLISH' AND entity_id = $1`, [arcId]);
    expect(inst.status).toBe("PENDING");
    expect(Number(inst.entity_id)).toBe(arcId);

    // Not floated yet → no invitation rows written by the float path. (We seeded
    // an 'invited' row at create; the float path REPLACES via setInvitations only
    // for 'open' ARCs. For invitation ARCs the seeded row stands, so instead we
    // assert the ARC never reached floated and stays invisible — covered in #2.)
    expect(row.status).not.toBe("floated");
  });

  // ---- Case 2: pending ARC invisible to vendors ---------------------------
  test("2. a pending ARC is invisible to vendors (list absent; detail + lifecycle 4xx)", async () => {
    // Reuse case-1's pending ARC.
    const arcId = createdArcs[0];

    const list = await vendorClient.get(`${BASE}/vendor/requests`);
    expect(list.status).toBe(200);
    const listedIds = list.body.data.requests.map((r) => Number(r.id));
    expect(listedIds).not.toContain(arcId);

    const detail = await vendorClient.get(`${BASE}/vendor/requests/${arcId}`);
    expect(detail.status).toBeGreaterThanOrEqual(400);
    expect(detail.status).not.toBe(200);

    const lifecycle = await vendorClient.get(`${BASE}/vendor/requests/${arcId}/lifecycle`);
    expect(lifecycle.status).toBeGreaterThanOrEqual(400);
    expect(lifecycle.status).not.toBe(200);
  });

  // ---- Case 3: approve → auto-floats + vendor-visible ---------------------
  test("3. approver decides approve → ARC floats and the vendor can now see it", async () => {
    const arcId = createdArcs[0]; // still pending from case 1

    const decide = await approverClient
      .post(`${BASE}/${arcId}/publish-approval/decide`)
      .send({ decision: "approve" });
    expect(decide.status).toBe(200);

    const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(row.status).toBe("floated");

    const inst = await db.one(
      `SELECT status FROM tbl_approval_instances
        WHERE entity_type = 'ARC_PUBLISH' AND entity_id = $1`, [arcId]);
    expect(inst.status).toBe("APPROVED");

    // The invited vendor now sees the floated ARC in their request list.
    const list = await vendorClient.get(`${BASE}/vendor/requests`);
    expect(list.status).toBe(200);
    const listedIds = list.body.data.requests.map((r) => Number(r.id));
    expect(listedIds).toContain(arcId);

    // And the detail read is now reachable.
    const detail = await vendorClient.get(`${BASE}/vendor/requests/${arcId}`);
    expect(detail.status).toBe(200);
  });

  // ---- Case 4: reject → not live + revisable ------------------------------
  test("4. reject parks publish_rejected (invisible), creator edits + re-publishes → fresh PENDING", async () => {
    await pointPolicyAt(APPROVER);
    const arcId = await seedDraftArc("ARC-PA-4");
    createdArcs.push(arcId);

    const pub = await buyerClient.post(`${BASE}/${arcId}/publish`).send({});
    expect(pub.status).toBe(200);
    expect(pub.body.data.arc.status).toBe("pending_publish_approval");

    const reject = await approverClient
      .post(`${BASE}/${arcId}/publish-approval/decide`)
      .send({ decision: "reject", comment: "fix scope" });
    expect(reject.status).toBe(200);

    const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(row.status).toBe("publish_rejected");

    // Still invisible to vendors.
    const list = await vendorClient.get(`${BASE}/vendor/requests`);
    const listedIds = list.body.data.requests.map((r) => Number(r.id));
    expect(listedIds).not.toContain(arcId);

    // Creator can edit a publish_rejected ARC.
    const patch = await buyerClient.patch(`${BASE}/${arcId}`).send({ title: "Revised after rejection" });
    expect(patch.status).toBe(200);

    // Re-publish → a fresh PENDING instance + back to pending_publish_approval.
    const rePub = await buyerClient.post(`${BASE}/${arcId}/publish`).send({});
    expect(rePub.status).toBe(200);
    expect(rePub.body.data.arc.status).toBe("pending_publish_approval");

    const instances = await db.any(
      `SELECT status FROM tbl_approval_instances
        WHERE entity_type = 'ARC_PUBLISH' AND entity_id = $1 ORDER BY created_at`, [arcId]);
    expect(instances.length).toBe(2);
    const pendingCount = instances.filter((i) => i.status === "PENDING").length;
    expect(pendingCount).toBe(1);
    expect(instances.some((i) => i.status === "REJECTED")).toBe(true);
  });

  // ---- Case 5: no-policy → 400 --------------------------------------------
  test("5. publishing with NO ARC policy in scope → 400 and the ARC stays draft", async () => {
    // Deactivate the shared policy so nothing matches this scope. We do NOT
    // delete it (existing instances FK-reference it via fk_instance_policy).
    await setPolicyActive(false);
    const arcId = await seedDraftArc("ARC-PA-5");
    createdArcs.push(arcId);

    try {
      const pub = await buyerClient.post(`${BASE}/${arcId}/publish`).send({});
      expect(pub.status).toBe(400);
      expect(pub.body.message).toMatch(/approval policy/i);

      const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
      expect(row.status).toBe("draft");

      const inst = await db.oneOrNone(
        `SELECT id FROM tbl_approval_instances WHERE entity_type = 'ARC_PUBLISH' AND entity_id = $1`, [arcId]);
      expect(inst).toBeNull();
    } finally {
      await setPolicyActive(true);
    }
  });

  // ---- Case 6: auto-approve floats immediately ----------------------------
  test("6. when the sole approver IS the creator, publish auto-approves and floats in the same request", async () => {
    await pointPolicyAt(BUYER);
    const arcId = await seedDraftArc("ARC-PA-6");
    createdArcs.push(arcId);

    const pub = await buyerClient.post(`${BASE}/${arcId}/publish`).send({});
    expect(pub.status).toBe(200);
    expect(pub.body.data.floated).toBe(true);
    expect(pub.body.data.arc.status).toBe("floated");

    const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(row.status).toBe("floated");

    const inst = await db.one(
      `SELECT status FROM tbl_approval_instances
        WHERE entity_type = 'ARC_PUBLISH' AND entity_id = $1`, [arcId]);
    expect(inst.status).toBe("APPROVED");

    // Vendor-visible in the same flow.
    const list = await vendorClient.get(`${BASE}/vendor/requests`);
    const listedIds = list.body.data.requests.map((r) => Number(r.id));
    expect(listedIds).toContain(arcId);
  });

  // ---- Case 7: legacy 'ARC' instance does NOT mis-fire the publish hook ----
  test("7. a legacy entity_type='ARC' instance does NOT mis-fire the publish hook (collision guard)", async () => {
    // Park a real draft ARC whose id we will reuse as the legacy instance's
    // entity_id. If the dispatch registry had an 'ARC' handler it would treat
    // this id as an arc and float it. The registry has only ARC_PUBLISH → no-op.
    const arcId = await seedDraftArc("ARC-PA-7");
    createdArcs.push(arcId);

    // Build a minimal legacy 'ARC' instance directly. We mark it APPROVED and
    // then invoke the dispatcher the same way executeApprovalAction would on a
    // terminal state. Because 'ARC' is unregistered, the dispatch is a no-op.
    // approval_policy_id is NOT NULL, so seed a throwaway 'ARC' policy first.
    await seedLegacyPolicy();
    const legacyInst = await db.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, hospitality_company_id, hotel_id, department_id,
          process_id, approval_policy_id, status, current_step, initiated_by)
       VALUES ('ARC', $1, $2, $3, $4, $5, $6, 'APPROVED', 0, $7)
       RETURNING id`,
      [arcId, HC, HOTEL, DEPT, PROC, POLICY_LEGACY_ID, BUYER]);

    const svc = await import("../../../app/services/approvalActionService.js");
    // dispatchPostApprovalAction looks up postActionRegistry[entity_type]; 'ARC'
    // is intentionally absent → returns/no-ops. Must not throw, must not float.
    await svc.dispatchPostApprovalAction(legacyInst.id, BUYER, {
      status: "APPROVED", comment: "legacy ARC terminal",
    });

    const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(row.status).toBe("draft"); // never floated

    // No ARC_PUBLISH instance was conjured for this ARC.
    const pubInst = await db.oneOrNone(
      `SELECT id FROM tbl_approval_instances WHERE entity_type = 'ARC_PUBLISH' AND entity_id = $1`, [arcId]);
    expect(pubInst).toBeNull();

    // Cleanup the legacy instance.
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = $1`, [legacyInst.id]);
  });

  // ---- Case 8: withdraw a pending publish → draft -------------------------
  test("8. withdrawing a pending publish returns the ARC to draft and CANCELS the instance", async () => {
    await pointPolicyAt(APPROVER); // diff approver so it stays PENDING
    const arcId = await seedDraftArc("ARC-PA-8");
    createdArcs.push(arcId);

    const pub = await buyerClient.post(`${BASE}/${arcId}/publish`).send({});
    expect(pub.status).toBe(200);
    expect(pub.body.data.arc.status).toBe("pending_publish_approval");

    const wd = await buyerClient.post(`${BASE}/${arcId}/withdraw`).send({});
    expect(wd.status).toBe(200);

    const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(row.status).toBe("draft");

    const inst = await db.one(
      `SELECT status FROM tbl_approval_instances
        WHERE entity_type = 'ARC_PUBLISH' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1`, [arcId]);
    expect(inst.status).not.toBe("PENDING");
    expect(inst.status).toBe("CANCELLED");
  });

  // ---- Case 9: permissions ------------------------------------------------
  test("9a. publish by a user with no access to the ARC's hotel → 403", async () => {
    // An ARC in hotel B (the A-side OUTSIDER has no B-hotel scope). The publish
    // auth check (userCanAccessHotel) runs BEFORE policy resolution, so this
    // 403s regardless of any policy.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status, eligibility_type,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-PA-9', 'Foreign hotel', $1, $2, $3, $4, $5, 'draft', 'invitation',
               NOW() + INTERVAL '1 day', NOW() + INTERVAL '7 days',
               NOW() + INTERVAL '14 days', NOW() + INTERVAL '200 days', $6) RETURNING id`,
      [CATEGORY, IDS.hospitality.B, HOTEL_B, DEPT, PROC, BUYER]);
    const arcId = Number(arc.id);
    createdArcs.push(arcId);
    await db.none(`INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
                   VALUES ($1, 1, 100, 'litre')`, [arcId]);

    const res = await outsiderClient.post(`${BASE}/${arcId}/publish`).send({});
    expect(res.status).toBe(403);
  });

  test("9b. decide by a non-approver (an unrelated buyer) → 4xx, ARC stays pending", async () => {
    // Seed a fresh pending ARC under a diff-approver policy.
    await pointPolicyAt(APPROVER);
    const arcId = await seedDraftArc("ARC-PA-9b");
    createdArcs.push(arcId);

    const pub = await buyerClient.post(`${BASE}/${arcId}/publish`).send({});
    expect(pub.status).toBe(200);
    expect(pub.body.data.arc.status).toBe("pending_publish_approval");

    // OUTSIDER passes acl([2,8]) but is not the policy approver → engine rejects.
    const decide = await outsiderClient
      .post(`${BASE}/${arcId}/publish-approval/decide`)
      .send({ decision: "approve" });
    expect(decide.status).toBeGreaterThanOrEqual(400);
    expect(decide.status).not.toBe(200);

    // The creator is also NOT an approver here → engine rejects too.
    const decideCreator = await buyerClient
      .post(`${BASE}/${arcId}/publish-approval/decide`)
      .send({ decision: "approve" });
    expect(decideCreator.status).toBeGreaterThanOrEqual(400);
    expect(decideCreator.status).not.toBe(200);

    const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(row.status).toBe("pending_publish_approval");
  });

  // ---- Case 10: in-flight floated ARC unaffected --------------------------
  test("10. publishing an already-floated ARC → 409 and it stays floated + visible", async () => {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status, eligibility_type,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-PA-10', 'Already floated', $1, $2, $3, $4, $5, 'floated', 'invitation',
               NOW() - INTERVAL '1 day', NOW() + INTERVAL '7 days',
               NOW() + INTERVAL '14 days', NOW() + INTERVAL '200 days', $6) RETURNING id`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]);
    const arcId = Number(arc.id);
    createdArcs.push(arcId);
    await db.none(`INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
                   VALUES ($1, 1, 100, 'litre')`, [arcId]);
    await db.none(`INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
                   VALUES ($1, $2, 'invited')`, [arcId, VENDOR]);

    const res = await buyerClient.post(`${BASE}/${arcId}/publish`).send({});
    expect(res.status).toBe(409);

    const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(row.status).toBe("floated");

    // Still vendor-visible.
    const list = await vendorClient.get(`${BASE}/vendor/requests`);
    const listedIds = list.body.data.requests.map((r) => Number(r.id));
    expect(listedIds).toContain(arcId);
  });
});
