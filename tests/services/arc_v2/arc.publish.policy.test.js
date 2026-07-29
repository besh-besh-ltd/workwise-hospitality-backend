// ARC v2 — TRACK D: process-NULL publish-policy resolution (the create unblock).
//
// Product-level: real Express app + local Postgres. Asserts OBSERVABLE
// end-to-end behaviour over HTTP + DB rows; never internal call counts.
//
// ── Why this suite exists ────────────────────────────────────────────────────
// The ARC create wizard publishes an ARC whose process_id is NULL by design
// (audit H5). findBestMatchingPolicyTx (generalModel.js) reduces its predicate to
// `process_id IS NULL` when the ARC's process is NULL, so it can ONLY match
// process-NULL ARC policies. If every ARC policy in scope carries a non-NULL
// process_id, the matcher finds nothing → POST /:id/publish hard-400s and the ARC
// stays draft — the exact "contract won't create" bug. Track D's fix is the seed
// script `scripts/seed_arc_publish_policy.js`, which inserts the ONE missing
// process-NULL ARC policy for the ARC's scope, pointed at a REAL (non-creator)
// approver so publish parks PENDING (a genuine gate, not an auto-float).
//
// Cases (mapped to the Track-D requirement list):
//   D1  publish with a process-NULL ARC policy + NON-CREATOR approver
//         → 200, ARC parks pending_publish_approval, a PENDING ARC_PUBLISH
//         instance whose current-step approver is that user (NOT the creator,
//         NOT auto-floated). This is the "real gate" the human chose.
//   D2  CONTROL (reproduces the bug): only a process-SCOPED ARC policy in scope
//         (process_id set ≠ the ARC's NULL) → publish 400s "approval policy",
//         ARC stays draft, no instance.
//   D3  CONTROL: NO ARC policy at all → publish 400s, ARC stays draft.
//   D4  Seed idempotency: the script's find-or-skip guard + INSERT, run twice
//         against the test DB, yields exactly ONE process-NULL ARC policy for
//         the scope (the second attempt is skipped).
//
// NOTE on D4: scripts/seed_arc_publish_policy.js imports the APP db config
// (../app/config/dbConn.js), targets PRODUCTION ids (company 13 / hotel 30 /
// approver 412) that do not exist in the test DB, and calls process.exit(). It
// cannot be invoked against the isolated test DB. Per the tester brief we
// REPLICATE the script's exact idempotency guard + INSERT SQL inline here,
// against test-fixture scope, and assert the NOT-EXISTS guard the script relies
// on. (Confirmed inline SQL is byte-identical in shape to the script's lines
// 80-105: same WHERE on entity_type/company/hotel/dept-NULL/process-NULL/active,
// same INSERT column list.)

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const HC        = IDS.hospitality.A;          // 10001
const HOTEL     = IDS.hotels.A1;              // 10101
const DEPT      = IDS.departments.proc;       // 10201
const PROC      = IDS.processes.A_P1;         // 70001 — a real process_id, ≠ the ARC's NULL
const BUYER     = IDS.users.a1_proc_buyer;    // 80011 — the creator/publisher
const APPROVER  = IDS.users.a1_proc_techApp;  // 80013 — a REAL, non-creator approver
                                              //         with a role scope covering (10001,10101,proc)
const VENDOR    = IDS.users.vendor_alpha;     // 80101 — keeps the open-ARC panel non-empty (audit M2)
const CATEGORY  = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;                         // '7 UP PEPSI 1.5 LTR' — seed_reference.sql

// 5-digit test-block policy ids (mirrors the existing arc_v2 suites' 649xx block).
const POLICY_NULL_PROC = 64930; // the FIX: process-NULL ARC policy → matches the wizard's NULL-process ARC
const POLICY_PROC      = 64931; // the BUG: process-SCOPED ARC policy → cannot match a NULL-process ARC

const BASE = "/api/v1/arc-v2";
const D = (days) => new Date(Date.now() + days * 86400_000).toISOString();

// Create a complete, publishable OPEN draft through the REAL create endpoint so
// it carries process_id = NULL exactly as the wizard does. Returns the arc id.
async function createPublishableDraft(client, title) {
  const res = await client.post(BASE).send({
    title,
    category_id: CATEGORY,
    hotel_id: HOTEL,
    department_id: DEPT,
    eligibility_type: "open",
    submission_start_at: D(1),
    submission_end_at:   D(7),
    contract_start_at:   D(14),
    contract_end_at:     D(200),
    items: [{ product_variant_id: VARIANT_ID, indicative_qty: 500, uom: "litre" }],
  });
  expect(res.status).toBe(200);
  // The wizard never sends process_id → it must persist NULL (the bug's premise).
  expect(res.body.data.arc.process_id == null).toBe(true);
  return Number(res.body.data.arc.id);
}

// Seed a single-step ARC policy. processId = null reproduces the FIX shape;
// a real processId reproduces the BUG shape. Step → USER approver (ANY).
async function seedArcPolicy({ policyId, processId, approver }) {
  await db.none(
    `INSERT INTO tbl_approval_policies
       (id, entity_type, hospitality_company_id, hotel_id, department_id,
        is_active, created_by, process_id, is_master, is_department_scoped, version)
     VALUES ($1, 'ARC', $2, $3, NULL, true, $4, $5, false, false, 1)
     ON CONFLICT (id) DO UPDATE SET is_active = true, process_id = EXCLUDED.process_id`,
    [policyId, HC, HOTEL, BUYER, processId]
  );
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [policyId]);
  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, approval_type, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'STANDARD', 'ANY', 'USER', $2)`,
    [policyId, approver]
  );
}

async function deactivatePolicy(policyId) {
  await db.none(`UPDATE tbl_approval_policies SET is_active = false WHERE id = $1`, [policyId]);
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

describe("ARC v2 — Track D: process-NULL publish policy resolution", () => {
  let buyerClient;
  const createdArcs = [];
  const ALL_POLICY_IDS = [POLICY_NULL_PROC, POLICY_PROC];

  beforeAll(async () => {
    // acl([2,8]) gates on user_type; vendor must be an active vendor user so the
    // open ARC resolves ≥1 eligible vendor (so we hit policy resolution, not M2).
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id IN ($1,$2)`, [BUYER, APPROVER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
    // The category→department mapping the create endpoint's dept resolution needs.
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CATEGORY, DEPT]
    );
    buyerClient = await httpClient(BUYER);
  });

  afterAll(async () => {
    for (const arcId of createdArcs) await cleanupArc(arcId);
    for (const pid of ALL_POLICY_IDS) {
      await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [pid]);
      await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [pid]);
    }
    await db.none(
      `DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`,
      [CATEGORY, DEPT]
    );
  });

  // ── D1: the fix — process-NULL policy + non-creator approver → real gate ────
  test("D1. publish with a process-NULL ARC policy + non-creator approver → 200, parks PENDING on that approver (not auto-floated)", async () => {
    // Ensure ONLY the process-NULL policy is in scope (the process-scoped one off).
    await deactivatePolicy(POLICY_PROC);
    await seedArcPolicy({ policyId: POLICY_NULL_PROC, processId: null, approver: APPROVER });

    const arcId = await createPublishableDraft(buyerClient, "Track D — process-NULL policy float");
    createdArcs.push(arcId);

    const pub = await buyerClient.post(`${BASE}/${arcId}/publish`).send({});
    expect(pub.status).toBe(200);
    // Real gate: parks for the approver, does NOT auto-float in the same request.
    expect(pub.body.data.floated).toBe(false);
    expect(pub.body.data.arc.status).toBe("pending_publish_approval");

    const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(row.status).toBe("pending_publish_approval");
    expect(row.status).not.toBe("floated");

    // A PENDING ARC_PUBLISH instance was created against the process-NULL policy.
    const inst = await db.one(
      `SELECT id, status, approval_policy_id FROM tbl_approval_instances
        WHERE entity_type = 'ARC_PUBLISH' AND entity_id = $1`, [arcId]);
    expect(inst.status).toBe("PENDING");
    expect(Number(inst.approval_policy_id)).toBe(POLICY_NULL_PROC);

    // The current pending step's approver is the NON-CREATOR (80013), not the
    // creator (80011) → genuine one-up gate, no self-approval.
    const approvers = (await db.any(
      `SELECT sa.approver_user_id, sa.status
         FROM tbl_approval_step_approvers sa
         JOIN tbl_approval_instance_steps st ON st.id = sa.approval_instance_step_id
        WHERE st.approval_instance_id = $1`, [inst.id]));
    const pendingApproverIds = approvers
      .filter((a) => a.status === "PENDING")
      .map((a) => Number(a.approver_user_id));
    expect(pendingApproverIds).toContain(APPROVER);
    expect(pendingApproverIds).not.toContain(BUYER);
  });

  // ── D2: the bug — only a process-SCOPED policy in scope → 400 (control) ──────
  test("D2. publish with only a process-SCOPED ARC policy (process_id set) → 400, ARC stays draft (reproduces the bug)", async () => {
    // Turn the fix off; seed only a process-scoped policy. The wizard's NULL-
    // process ARC cannot match it → the no-policy 400 the user reported.
    await deactivatePolicy(POLICY_NULL_PROC);
    await seedArcPolicy({ policyId: POLICY_PROC, processId: PROC, approver: APPROVER });

    const arcId = await createPublishableDraft(buyerClient, "Track D — process-scoped only (bug repro)");
    createdArcs.push(arcId);

    const pub = await buyerClient.post(`${BASE}/${arcId}/publish`).send({});
    expect(pub.status).toBe(400);
    expect(pub.body.message).toMatch(/approval policy/i);

    const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(row.status).toBe("draft");

    const inst = await db.oneOrNone(
      `SELECT id FROM tbl_approval_instances WHERE entity_type = 'ARC_PUBLISH' AND entity_id = $1`, [arcId]);
    expect(inst).toBeNull();

    await deactivatePolicy(POLICY_PROC);
  });

  // ── D3: no policy at all → 400 (pure control) ───────────────────────────────
  test("D3. publish with NO ARC policy in scope → 400, ARC stays draft", async () => {
    await deactivatePolicy(POLICY_NULL_PROC);
    await deactivatePolicy(POLICY_PROC);

    const arcId = await createPublishableDraft(buyerClient, "Track D — no policy at all");
    createdArcs.push(arcId);

    const pub = await buyerClient.post(`${BASE}/${arcId}/publish`).send({});
    expect(pub.status).toBe(400);
    expect(pub.body.message).toMatch(/approval policy/i);

    const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(row.status).toBe("draft");
  });

  // ── D4: seed idempotency (the script's NOT-EXISTS guard) ────────────────────
  // Replicates scripts/seed_arc_publish_policy.js's find-or-skip guard + INSERT
  // SQL inline (see file header) against test-fixture scope, run TWICE, and
  // asserts exactly one process-NULL ARC policy (+ one step) results.
  test("D4. seed find-or-skip guard run twice → exactly ONE process-NULL ARC policy for the scope", async () => {
    const SCOPE = { hc: HC, hotel: HOTEL, createdBy: BUYER, approver: APPROVER };

    // The script's exact idempotency guard (lines 80-90): a process-NULL, dept-
    // NULL, active ARC policy for this (company, hotel). Returns null when absent.
    async function findExisting() {
      return db.oneOrNone(
        `SELECT id FROM tbl_approval_policies
          WHERE entity_type = 'ARC'
            AND hospitality_company_id = $1
            AND hotel_id = $2
            AND department_id IS NULL
            AND process_id IS NULL
            AND is_active = true
          LIMIT 1`,
        [SCOPE.hc, SCOPE.hotel]
      );
    }

    // The script's INSERT pair (policy + step), find-or-skip guarded (lines 80-117).
    async function seedOnce() {
      const existing = await findExisting();
      if (existing) return { inserted: false, policyId: existing.id };
      const policy = await db.one(
        `INSERT INTO tbl_approval_policies
           (entity_type, hospitality_company_id, hotel_id, department_id,
            is_active, created_by, process_id, is_master, is_department_scoped, version)
         VALUES ('ARC', $1, $2, NULL, true, $3, NULL, false, false, 1)
         RETURNING id`,
        [SCOPE.hc, SCOPE.hotel, SCOPE.createdBy]
      );
      await db.none(
        `INSERT INTO tbl_approval_policy_steps
           (approval_policy_id, step_order, approval_type, decision_rule, approver_source_type, approver_source_id)
         VALUES ($1, 1, 'STANDARD', 'ANY', 'USER', $2)`,
        [policy.id, SCOPE.approver]
      );
      return { inserted: true, policyId: policy.id };
    }

    // Guard the assertion's premise: no such policy exists before we start (the
    // process-scoped/NULL fixtures above are either deactivated or carry a
    // distinct process_id, so they don't satisfy the process-NULL guard).
    const before = await findExisting();
    expect(before).toBeNull();

    let createdPolicyId;
    try {
      const first  = await seedOnce();
      const second = await seedOnce();

      expect(first.inserted).toBe(true);   // first run creates it
      expect(second.inserted).toBe(false); // second run is a no-op (guard skips)
      expect(Number(second.policyId)).toBe(Number(first.policyId));
      createdPolicyId = first.policyId;

      // Exactly one process-NULL ARC policy row for this scope.
      const policies = await db.any(
        `SELECT id FROM tbl_approval_policies
          WHERE entity_type = 'ARC' AND hospitality_company_id = $1 AND hotel_id = $2
            AND department_id IS NULL AND process_id IS NULL AND is_active = true`,
        [SCOPE.hc, SCOPE.hotel]
      );
      expect(policies.length).toBe(1);

      // And exactly one step (the second run never re-wrote steps).
      const steps = await db.any(
        `SELECT id FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`,
        [createdPolicyId]
      );
      expect(steps.length).toBe(1);
    } finally {
      if (createdPolicyId) {
        await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [createdPolicyId]);
        await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [createdPolicyId]);
      }
    }
  });
});
