// ARC v2 — Commercial-eval split-award reconciliation invariant.
//
// Proves the controller enforces SUM(allocated_qty) = tbl_arc_item.indicative_qty
// per item on every save (plan §4.4 reconciliation workflow). Also proves
// the allocation history is written.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";

describe("ARC v2 — commercial eval split-award reconciliation", () => {
  const BUYER  = IDS.users.a1_proc_buyer;
  const VENDOR_A = IDS.users.vendor_alpha;
  const VENDOR_B = IDS.users.vendor_beta;
  const HOTEL  = IDS.hotels.A1;
  const DEPT   = IDS.departments.proc;
  const HC     = IDS.hospitality.A;
  const PROC   = IDS.processes.A_P1;
  const CATEGORY = TEST_CATEGORIES.beverages;
  const VARIANT_ID = 1;
  const POLICY_ID = 64903; // ARC_COMMITTEE — finalize now spawns the instance
  let client;
  let arcId, itemId, quoteLineA, quoteLineB;

  beforeAll(async () => {
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CATEGORY, DEPT]
    );
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    client = await httpClient(BUYER);
    // Evaluation endpoints are gated by requireArcPermission (arc-comm.*).
    await seedArcEvalPerms(db, [BUYER]);

    // finalizeCommEval creates the ARC_COMMITTEE approval instance, so the
    // scope needs a policy (one step, finance approver).
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_COMMITTEE', $2, $3, NULL, true, $4, $5, false, false, 1)
       ON CONFLICT (id) DO NOTHING`,
      [POLICY_ID, HC, HOTEL, BUYER, PROC]
    );
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`,
      [POLICY_ID, IDS.users.a1_proc_finance]
    );

    // Seed an ARC + item + two submitted vendor quotes so we can run comm-eval.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by)
       VALUES ('ARC-TEST-RECON-1', 'Reconciliation Test',
               $1, $2, $3, $4, $5, 'comm_eval_in_progress',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               $6)
       RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    const item = await db.one(
      `INSERT INTO tbl_arc_item
         (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 1000, 'litre', 100)
       RETURNING *`,
      [arcId, VARIANT_ID]
    );
    itemId = item.id;

    // Two submitted vendor quotes for this item — A is L1 (90), B is L2 (95).
    const qA = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at)
       VALUES ($1, $2, NOW()) RETURNING *`,
      [arcId, VENDOR_A]
    );
    quoteLineA = (await db.one(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate)
       VALUES ($1, $2, 90) RETURNING *`,
      [qA.id, itemId]
    )).id;
    const qB = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at)
       VALUES ($1, $2, NOW()) RETURNING *`,
      [arcId, VENDOR_B]
    );
    quoteLineB = (await db.one(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate)
       VALUES ($1, $2, 95) RETURNING *`,
      [qB.id, itemId]
    )).id;
  });

  afterAll(async () => {
    const instanceIds = (await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type = 'ARC_COMMITTEE' AND entity_id = $1`,
      [arcId]
    )).map((r) => r.id);
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
    await db.none(
      `DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    await db.none(
      `DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`,
      [CATEGORY, DEPT]
    );
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  test("rejects allocation that doesn't sum to indicative_qty", async () => {
    const res = await client.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/allocation`).send({
      item_id: itemId,
      allocations: [
        { awarded_vendor_id: VENDOR_A, awarded_quote_line_id: quoteLineA, allocated_qty: 600, l_rank: 'L1', is_l1_default: false, awarded_quote_snapshot: { rate: 90 } },
        { awarded_vendor_id: VENDOR_B, awarded_quote_line_id: quoteLineB, allocated_qty: 300, l_rank: 'L2', is_l1_default: false, awarded_quote_snapshot: { rate: 95 } },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Allocations sum/);
  });

  test("accepts a valid split allocation (60/40) summing to indicative_qty", async () => {
    const res = await client.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/allocation`).send({
      item_id: itemId,
      allocations: [
        { awarded_vendor_id: VENDOR_A, awarded_quote_line_id: quoteLineA, allocated_qty: 600, l_rank: 'L1', is_l1_default: false, awarded_quote_snapshot: { rate: 90 } },
        { awarded_vendor_id: VENDOR_B, awarded_quote_line_id: quoteLineB, allocated_qty: 400, l_rank: 'L2', is_l1_default: false, awarded_quote_snapshot: { rate: 95 } },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.awards.length).toBe(2);
    const allocs = res.body.data.awards.map(a => Number(a.allocated_qty)).sort((x, y) => y - x);
    expect(allocs).toEqual([600, 400]);
  });

  // Amount/qty-mode (client feedback #2): the FE now lets buyers type quantities
  // directly (e.g. 700 + 300 of 1000) with allocated_share_pct as a derived
  // display companion. This proves that payload shape is accepted/rejected
  // IDENTICALLY to percentage-mode — qty is the sole server invariant, the pct
  // companion is stored but never sum-validated.
  test("accepts an amount-derived split (qty typed directly) with a derived allocated_share_pct", async () => {
    const res = await client.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/allocation`).send({
      item_id: itemId,
      allocations: [
        { awarded_vendor_id: VENDOR_A, awarded_quote_line_id: quoteLineA, allocated_qty: 700, allocated_share_pct: 70, l_rank: 'L1', is_l1_default: false, awarded_quote_snapshot: { rate: 90 } },
        { awarded_vendor_id: VENDOR_B, awarded_quote_line_id: quoteLineB, allocated_qty: 300, allocated_share_pct: 30, l_rank: 'L2', is_l1_default: false, awarded_quote_snapshot: { rate: 95 } },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.awards.length).toBe(2);
    const byVendor = Object.fromEntries(res.body.data.awards.map(a => [Number(a.awarded_vendor_id), a]));
    expect(Number(byVendor[VENDOR_A].allocated_qty)).toBe(700);
    expect(Number(byVendor[VENDOR_B].allocated_qty)).toBe(300);
    // qty must still reconcile exactly to indicative_qty (1000)
    const total = res.body.data.awards.reduce((s, a) => s + Number(a.allocated_qty), 0);
    expect(total).toBe(1000);
    // the derived pct companion is persisted (nullable display, not sum-validated)
    expect(Number(byVendor[VENDOR_A].allocated_share_pct)).toBe(70);
    expect(Number(byVendor[VENDOR_B].allocated_share_pct)).toBe(30);
  });

  test("rejects an amount-derived split whose quantities don't sum to indicative_qty", async () => {
    const res = await client.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/allocation`).send({
      item_id: itemId,
      allocations: [
        // 700 + 299 = 999 ≠ 1000 — pct companion is well-formed (70/30) but qty is short.
        { awarded_vendor_id: VENDOR_A, awarded_quote_line_id: quoteLineA, allocated_qty: 700, allocated_share_pct: 70, l_rank: 'L1', is_l1_default: false, awarded_quote_snapshot: { rate: 90 } },
        { awarded_vendor_id: VENDOR_B, awarded_quote_line_id: quoteLineB, allocated_qty: 299, allocated_share_pct: 30, l_rank: 'L2', is_l1_default: false, awarded_quote_snapshot: { rate: 95 } },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/must equal indicative_qty/);
  });

  test("rejects finalize when allocations are missing for any item", async () => {
    // Add a second item (different variant) with no allocations — finalize should reject.
    const SECOND_VARIANT_ID = 3; // 'PEPSI 600 ML' — also seeded.
    const item2 = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 500, 'litre') RETURNING *`,
      [arcId, SECOND_VARIANT_ID]
    );
    const res = await client.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/finalize`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Allocation incomplete/);
    // Cleanup item2 for the next test.
    await db.none(`DELETE FROM tbl_arc_item WHERE id = $1`, [item2.id]);
  });

  test("getCommEval returns the ARC context (regression: 'Rate contract not found')", async () => {
    const res = await client.get(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval`);
    expect(res.status).toBe(200);
    expect(Number(res.body.data.arc?.id)).toBe(Number(arcId));
    expect(res.body.data.arc.category_title).toBeTruthy();
    expect(res.body.data.arc.hotel_name).toBeTruthy();
  });

  test("finalize flips ARC to committee_review and spawns the committee instance", async () => {
    const res = await client.post(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/finalize`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.approval_instance_id).toBeTruthy();
    const arc = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arc.status).toBe("committee_review");
    const comm = await db.one(`SELECT status, approval_instance_id FROM tbl_arc_comm_evaluation WHERE arc_id = $1`, [arcId]);
    expect(comm.status).toBe("finalized");
    expect(Number(comm.approval_instance_id)).toBe(Number(res.body.data.approval_instance_id));
    const instance = await db.one(
      `SELECT status FROM tbl_approval_instances WHERE entity_type = 'ARC_COMMITTEE' AND entity_id = $1`,
      [arcId]
    );
    expect(instance.status).toBe("PENDING");
  });

  test("history records every allocation save and finalize", async () => {
    const rows = await db.any(
      `SELECT action FROM tbl_arc_comm_evaluation_history
         WHERE arc_comm_evaluation_id = (SELECT id FROM tbl_arc_comm_evaluation WHERE arc_id = $1)
         ORDER BY changed_at`,
      [arcId]
    );
    const actions = rows.map(r => r.action);
    expect(actions).toContain("allocation_saved");
    expect(actions).toContain("finalized");
  });
});
