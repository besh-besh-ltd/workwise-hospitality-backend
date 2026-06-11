// ARC amendment — end-to-end HTTP flow over the real middleware stack.
//
// Proves the full request → review → terminal-state journey:
//   1. Request validation: type whitelist, mandatory effective window,
//      type-specific payload fields, reason.
//   2. ACL split: only vendors request (acl [3]); only buyers review
//      (acl [2,8]); a buyer who is NOT the current step's engine approver
//      is rejected by the engine even though the route lets them through.
//   3. Overlapping-window guard per contract line (409), and that a
//      different line is NOT blocked.
//   4. Two-step approval chain through the central engine: step-1
//      edit-then-approve (counter-offer) writes tbl_arc_amendment_edit_history
//      and merges the payload; step-2 approval lands the terminal state.
//   5. Reject path: comment mandatory; rejection is terminal.
//   6. Anonymisation: every vendor-facing payload (request response, contract
//      detail, My Amendments list) reduces the chain to numbered levels —
//      no approver names or user ids may leak.
//   7. Term extension: approval durably moves tbl_arc.contract_end_at and
//      the amendment goes live immediately.
//   8. An amendment whose window is already open goes live the moment the
//      final approver clears it (no cron needed).

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const PROC     = IDS.processes.A_P1;
const BUYER    = IDS.users.a1_proc_buyer;     // buyer, NOT on the amendment policy
const APPROVER1 = IDS.users.a1_proc_techApp;  // step 1
const APPROVER2 = IDS.users.a1_proc_finance;  // step 2
const VENDOR   = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;
const POLICY_ID  = 64901; // outside the fixtures' 60001..60099 range

const dIso = (offsetDays) => {
  // Local-calendar day (pg DATE comparisons are local; toISOString would
  // shift the day for TZs east of UTC when run near midnight).
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

describe("ARC amendment flow — request → review → terminal state", () => {
  let vendorClient, approver1Client, approver2Client, buyerClient;
  let arcId, contractId, line1Id, line2Id;
  let amdPriceId, amdQtyId;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [VENDOR]);
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id IN ($1, $2, $3)`,
      [BUYER, APPROVER1, APPROVER2]);

    vendorClient    = await httpClient(VENDOR);
    approver1Client = await httpClient(APPROVER1);
    approver2Client = await httpClient(APPROVER2);
    buyerClient     = await httpClient(BUYER);

    // Active ARC + contract + two lines.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by)
       VALUES ('ARC-TEST-AMD-1', 'Amendment flow ARC', $1, $2, $3, $4, $5,
               'contract_active',
               NOW() - INTERVAL '40 days', NOW() - INTERVAL '30 days',
               NOW() - INTERVAL '20 days', (NOW() + INTERVAL '180 days')::date,
               $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    // tbl_arc_item is unique on (arc_id, product_variant_id) — distinct
    // variants per item (1 and 2 are seeded beverages).
    const item1 = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 500, 'litre') RETURNING *`, [arcId, VARIANT_ID]);
    const item2 = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 200, 'kg') RETURNING *`, [arcId, VARIANT_ID + 1]);
    const contract = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status)
       VALUES ($1, $2, 'active') RETURNING *`, [arcId, VENDOR]);
    contractId = contract.id;
    line1Id = (await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1, $2, 100, 5, 500) RETURNING id`, [contractId, item1.id])).id;
    line2Id = (await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1, $2, 50, 5, 200) RETURNING id`, [contractId, item2.id])).id;

    // Two-step ARC_AMENDMENT policy: APPROVER1 then APPROVER2.
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_AMENDMENT', $2, $3, NULL, true, $4, $5, false, false, 1)
       ON CONFLICT (id) DO NOTHING`,
      [POLICY_ID, HC, HOTEL, BUYER, PROC]
    );
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2), ($1, 2, 'ALL', 'USER', $3)`,
      [POLICY_ID, APPROVER1, APPROVER2]
    );
  });

  afterAll(async () => {
    const instanceIds = (await db.any(
      `SELECT approval_instance_id AS id FROM tbl_arc_amendment
        WHERE arc_contract_id = $1 AND approval_instance_id IS NOT NULL`,
      [contractId]
    )).map((r) => r.id);

    await db.none(`DELETE FROM tbl_arc_amendment_edit_history
                    WHERE arc_amendment_id IN (SELECT id FROM tbl_arc_amendment WHERE arc_contract_id = $1)`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_amendment WHERE arc_contract_id = $1`, [contractId]);
    if (instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_step_approvers
                      WHERE approval_instance_step_id IN
                        (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
  });

  // ── 1. request validation ──────────────────────────────────────────────
  test("rejects an unknown amendment_type", async () => {
    const res = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "discount",
      amendment_from: dIso(1), amendment_to: dIso(30), reason: "x",
      payload: { arc_contract_line_id: line1Id, new_rate: 1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/amendment_type/);
  });

  test("price revision demands a bounded effective window and a positive new_rate", async () => {
    const noTo = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "price",
      amendment_from: dIso(1), reason: "cost rise",
      payload: { arc_contract_line_id: line1Id, new_rate: 120 },
    });
    expect(noTo.status).toBe(400);
    expect(noTo.body.message).toMatch(/amendment_to/);

    const noRate = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "price",
      amendment_from: dIso(1), amendment_to: dIso(30), reason: "cost rise",
      payload: { arc_contract_line_id: line1Id },
    });
    expect(noRate.status).toBe(400);
    expect(noRate.body.message).toMatch(/new_rate/);

    const noReason = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "price",
      amendment_from: dIso(1), amendment_to: dIso(30), reason: "",
      payload: { arc_contract_line_id: line1Id, new_rate: 120 },
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.message).toMatch(/reason/);
  });

  test("buyers cannot create amendment requests (vendor-only route)", async () => {
    const res = await buyerClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "price",
      amendment_from: dIso(1), amendment_to: dIso(30), reason: "nope",
      payload: { arc_contract_line_id: line1Id, new_rate: 120 },
    });
    expect(res.status).toBe(403);
  });

  // ── 2. happy-path request + anonymisation ──────────────────────────────
  test("vendor requests a price revision; response carries an anonymised 2-step chain", async () => {
    const res = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "price",
      amendment_from: dIso(1), amendment_to: dIso(90),
      reason: "Resin pass-through cost increase per Q3 circular",
      payload: { arc_contract_line_id: line1Id, new_rate: 120 },
    });
    expect(res.status).toBe(200);
    const am = res.body.data.amendment;
    amdPriceId = am.id;
    expect(am.status).toBe("requested");
    expect(am.total_steps).toBe(2);
    expect(Array.isArray(am.chain)).toBe(true);
    expect(am.chain.length).toBe(2);
    for (const step of am.chain) {
      expect(step.approver_names).toBeUndefined();
      expect(step.approver_user_ids).toBeUndefined();
      expect(step.level).toBeGreaterThan(0);
    }
    expect(am.approval_chain).toBeUndefined();

    const row = await db.one(`SELECT * FROM tbl_arc_amendment WHERE id = $1`, [amdPriceId]);
    expect(row.approval_instance_id).toBeTruthy();
    expect(row.status).toBe("requested");
    // The engine snapshot in the DB DOES carry approver ids — the redaction
    // is a projection, not data loss.
    expect(JSON.stringify(row.approval_chain)).toMatch(/approver_user_ids/);
  });

  test("a second amendment on the same line is blocked while one is in flight (409)", async () => {
    // Overlapping window — blocked.
    const overlapping = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "price",
      amendment_from: dIso(10), amendment_to: dIso(20), reason: "double dip",
      payload: { arc_contract_line_id: line1Id, new_rate: 140 },
    });
    expect(overlapping.status).toBe(409);
    expect(overlapping.body.message).toMatch(/in flight/);

    // NON-overlapping window on the same line — still blocked. The rule is
    // one in-flight amendment per item, not merely no window overlap.
    const disjoint = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "qty",
      amendment_from: dIso(120), amendment_to: dIso(150), reason: "later window",
      payload: { arc_contract_line_id: line1Id, new_qty: 600 },
    });
    expect(disjoint.status).toBe(409);
    expect(disjoint.body.message).toMatch(/in flight/);
  });

  test("a different contract line is not blocked by the overlap guard", async () => {
    const res = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "qty",
      amendment_from: dIso(1), amendment_to: dIso(30),
      reason: "Need a higher cap for the season",
      payload: { arc_contract_line_id: line2Id, new_qty: 300 },
    });
    expect(res.status).toBe(200);
    amdQtyId = res.body.data.amendment.id;
  });

  // ── 3. review gates ─────────────────────────────────────────────────────
  test("vendors cannot review (buyer-only route); non-approver buyers are stopped by the engine", async () => {
    const vendorTry = await vendorClient
      .post(`/api/v1/arc-v2/amendments/${amdPriceId}/review`)
      .send({ decision: "approve" });
    expect(vendorTry.status).toBe(403);

    const outsiderTry = await buyerClient
      .post(`/api/v1/arc-v2/amendments/${amdPriceId}/review`)
      .send({ decision: "approve" });
    expect(outsiderTry.status).toBeGreaterThanOrEqual(400);

    const still = await db.one(`SELECT status, current_step FROM tbl_arc_amendment WHERE id = $1`, [amdPriceId]);
    expect(still.status).toBe("requested");
    expect(still.current_step).toBe(1);
  });

  // ── 4. edit-then-approve + chain walk ───────────────────────────────────
  test("step-1 approver counter-offers (edit-then-approve): edit history + merged payload", async () => {
    const res = await approver1Client
      .post(`/api/v1/arc-v2/amendments/${amdPriceId}/review`)
      .send({ decision: "approve", comment: "OK at a smaller uplift", edit: { new_rate: 115 } });
    expect(res.status).toBe(200);
    const am = res.body.data.amendment;
    expect(am.status).toBe("requested");   // step 2 still pending
    expect(am.current_step).toBe(2);
    expect(Number(am.payload.new_rate)).toBe(115);

    const edits = await db.any(
      `SELECT * FROM tbl_arc_amendment_edit_history WHERE arc_amendment_id = $1`, [amdPriceId]);
    expect(edits.length).toBe(1);
    expect(edits[0].field_changed).toBe("new_rate");
    expect(Number(JSON.parse(JSON.stringify(edits[0].before_value)))).toBe(120);
    expect(Number(JSON.parse(JSON.stringify(edits[0].after_value)))).toBe(115);
    expect(edits[0].changed_by).toBe(APPROVER1);

    // The engine comment folds the diff so downstream approvers see it.
    const action = await db.oneOrNone(
      `SELECT comment FROM tbl_approval_actions
        WHERE approval_instance_id = (SELECT approval_instance_id FROM tbl_arc_amendment WHERE id = $1)
        ORDER BY id DESC LIMIT 1`, [amdPriceId]);
    expect(action.comment).toMatch(/Edited before approval/);
    expect(action.comment).toMatch(/new_rate/);
  });

  test("step-2 approval lands the engine-terminal state; future window stays 'approved'", async () => {
    const res = await approver2Client
      .post(`/api/v1/arc-v2/amendments/${amdPriceId}/review`)
      .send({ decision: "approve", comment: "Cleared" });
    expect(res.status).toBe(200);
    // Window opens tomorrow — approved, not yet live.
    expect(res.body.data.amendment.status).toBe("approved");
  });

  test("re-reviewing a decided amendment is rejected", async () => {
    const res = await approver1Client
      .post(`/api/v1/arc-v2/amendments/${amdPriceId}/review`)
      .send({ decision: "approve" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/approved/);
  });

  // ── 5. reject path ──────────────────────────────────────────────────────
  test("rejection demands a comment, then is terminal", async () => {
    const noComment = await approver1Client
      .post(`/api/v1/arc-v2/amendments/${amdQtyId}/review`)
      .send({ decision: "reject" });
    expect(noComment.status).toBe(400);
    expect(noComment.body.message).toMatch(/comment|reason/i);

    const rejected = await approver1Client
      .post(`/api/v1/arc-v2/amendments/${amdQtyId}/review`)
      .send({ decision: "reject", comment: "Cap stays as contracted this quarter" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.amendment.status).toBe("rejected");

    const again = await approver2Client
      .post(`/api/v1/arc-v2/amendments/${amdQtyId}/review`)
      .send({ decision: "approve" });
    expect(again.status).toBe(400);
  });

  // ── 6. vendor-facing anonymisation across every read surface ───────────
  test("vendor contract detail + My Amendments list expose levels, never identities", async () => {
    const detail = await vendorClient.get(`/api/v1/arc-v2/vendor/contracts/${contractId}`);
    expect(detail.status).toBe(200);
    const fromDetail = detail.body.data.amendments.find((a) => a.id === amdPriceId);
    expect(fromDetail).toBeTruthy();
    expect(fromDetail.total_steps).toBe(2);
    for (const step of fromDetail.chain) {
      expect(step.approver_names).toBeUndefined();
      expect(step.approver_user_ids).toBeUndefined();
    }
    // Edit history is level-attributed, not name-attributed.
    expect(fromDetail.edit_history.length).toBe(1);
    expect(fromDetail.edit_history[0].level).toBe(1);
    expect(fromDetail.edit_history[0].changed_by).toBeUndefined();
    // Whole-payload sweep: no approver identity may appear anywhere.
    const raw = JSON.stringify(detail.body.data.amendments);
    expect(raw).not.toMatch(/approver_names/);
    expect(raw).not.toMatch(/approver_user_ids/);
    expect(raw).not.toMatch(/changed_by/);

    const list = await vendorClient.get(`/api/v1/arc-v2/vendor/amendments`);
    expect(list.status).toBe(200);
    const fromList = list.body.data.amendments.find((a) => a.id === amdPriceId);
    expect(fromList).toBeTruthy();
    expect(fromList.arc_number).toBe("ARC-TEST-AMD-1");
    expect(fromList.total_steps).toBe(2);
    expect(JSON.stringify(list.body.data.amendments)).not.toMatch(/approver_user_ids|approver_names/);

    const rejectedRow = list.body.data.amendments.find((a) => a.id === amdQtyId);
    expect(rejectedRow.status).toBe("rejected");
    // The rejection reason still reaches the vendor through the step comment.
    expect(JSON.stringify(rejectedRow.chain)).toMatch(/Cap stays as contracted/);
  });

  test("another vendor cannot read this contract's amendments", async () => {
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [IDS.users.vendor_beta]);
    const otherVendor = await httpClient(IDS.users.vendor_beta);
    const res = await otherVendor.get(`/api/v1/arc-v2/vendor/contracts/${contractId}`);
    expect(res.status).toBe(403);

    const list = await otherVendor.get(`/api/v1/arc-v2/vendor/amendments`);
    expect(list.status).toBe(200);
    expect(list.body.data.amendments.find((a) => a.id === amdPriceId)).toBeUndefined();
  });

  // ── 7. term extension — durable application ─────────────────────────────
  test("approved term extension moves tbl_arc.contract_end_at and goes live immediately", async () => {
    const newEnd = dIso(240);
    const req = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "term",
      amendment_from: newEnd, // proposed new end date
      reason: "Align contract close-out with FY end",
    });
    expect(req.status).toBe(200);
    const termId = req.body.data.amendment.id;

    const s1 = await approver1Client
      .post(`/api/v1/arc-v2/amendments/${termId}/review`)
      .send({ decision: "approve" });
    expect(s1.status).toBe(200);
    const s2 = await approver2Client
      .post(`/api/v1/arc-v2/amendments/${termId}/review`)
      .send({ decision: "approve" });
    expect(s2.status).toBe(200);
    expect(s2.body.data.amendment.status).toBe("live");

    const arcRow = await db.one(`SELECT contract_end_at::date::text AS d FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arcRow.d).toBe(newEnd);

    const ev = await db.oneOrNone(
      `SELECT * FROM tbl_arc_event_log
        WHERE arc_id = $1 AND event_type = 'amendment_live'
          AND (payload->>'amendment_id')::bigint = $2`, [arcId, termId]);
    expect(ev).toBeTruthy();
    expect(ev.payload.new_end_date).toBe(newEnd);
  });

  test("only one term extension may be in flight per contract", async () => {
    // The previous test left a LIVE term extension on this contract.
    const res = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "term",
      amendment_from: dIso(300),
      reason: "Extend again",
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/term extension/);
  });

  // ── 8. already-open window goes live on final approval, no cron needed ──
  test("amendment whose window already opened flips straight to live on approval", async () => {
    const req = await vendorClient.post("/api/v1/arc-v2/amendments/request").send({
      arc_contract_id: contractId, amendment_type: "qty",
      amendment_from: dIso(0), amendment_to: dIso(30),
      reason: "Immediate seasonal uplift",
      payload: { arc_contract_line_id: line2Id, new_qty: 350 },
    });
    expect(req.status).toBe(200);
    const id = req.body.data.amendment.id;

    await approver1Client.post(`/api/v1/arc-v2/amendments/${id}/review`).send({ decision: "approve" });
    const fin = await approver2Client.post(`/api/v1/arc-v2/amendments/${id}/review`).send({ decision: "approve" });
    expect(fin.status).toBe(200);
    expect(fin.body.data.amendment.status).toBe("live");

    const ev = await db.oneOrNone(
      `SELECT * FROM tbl_arc_event_log
        WHERE arc_id = $1 AND event_type = 'amendment_live'
          AND (payload->>'amendment_id')::bigint = $2`, [arcId, id]);
    expect(ev).toBeTruthy();
  });
});
