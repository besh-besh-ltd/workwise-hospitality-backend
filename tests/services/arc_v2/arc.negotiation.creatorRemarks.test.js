// ARC negotiation rounds carry an internal "creator remarks" note for approvers.
// Over real HTTP: stored + put in the approval metadata, validated, visible to
// the approver's read, and NEVER present in any vendor payload.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";
import { ensureApprovable } from "../../helpers/arcApproverPerms.js";

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const PROC     = IDS.processes.A_P1;
const BUYER    = IDS.users.a1_proc_buyer;
const APPROVER = IDS.users.a1_proc_commApp;
const VENDOR_A = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID_A = 1;
const POLICY_ID = 64995;

const E = "/api/v1/arc-v2/evaluation";
const V = "/api/v1/arc-v2/vendor";
const D = (days) => new Date(Date.now() + days * 86400_000).toISOString();

const SECRET = "Internal: push the price down, vendor B is cheaper";

// Recursively collect every key name in a JSON payload.
const allKeys = (value, acc = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, acc));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) { acc.add(k); allKeys(v, acc); }
  }
  return acc;
};

describe("ARC negotiation — creator remarks", () => {
  let buyerClient, approverClient, vendorClient;
  let arcId, itemId, roundId;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`, [[BUYER, APPROVER]]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR_A]);
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`, [CATEGORY, DEPT]);
    await seedArcEvalPerms(db, [BUYER, APPROVER]);

    // APPROVER is the sole approver, so the buyer's round stays PENDING_APPROVAL.
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_NEGOTIATION', $2, $3, NULL, true, $4, NULL, false, false, 1)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [POLICY_ID, HC, HOTEL, BUYER]);
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`, [POLICY_ID, APPROVER]);
    await ensureApprovable(db, APPROVER, "arc-comm", HC, HOTEL, DEPT);

    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by, eligibility_type)
       VALUES ('ARC-NEG-REMARKS-1', 'Creator Remarks Test',
               $1, $2, $3, $4, $5, 'comm_eval_in_progress',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               $6, 'open')
       RETURNING id`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]);
    arcId = arc.id;
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 1000, 'litre', 120) RETURNING id`, [arcId, VARIANT_ID_A]);
    itemId = item.id;
    await db.none(
      `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
       VALUES ($1, $2, 'invited') ON CONFLICT DO NOTHING`, [arcId, VENDOR_A]);
    const q = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at)
       VALUES ($1, $2, NOW()) RETURNING id`, [arcId, VENDOR_A]);
    await db.none(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
       VALUES ($1, $2, 90, 18)`, [q.id, itemId]);

    buyerClient    = await httpClient(BUYER);
    approverClient = await httpClient(APPROVER);
    vendorClient   = await httpClient(VENDOR_A);
  });

  afterAll(async () => {
    const rounds = await db.any(
      `SELECT id FROM tbl_negotiation_rounds WHERE source_type='ARC' AND source_id=$1`, [arcId]);
    const rids = rounds.map((r) => r.id);
    if (rids.length) {
      const insts = await db.any(
        `SELECT id FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=ANY($1::int[])`, [rids]);
      const iids = insts.map((i) => i.id);
      if (iids.length) {
        await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id=ANY($1::int[])`, [iids]);
        await db.none(
          `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
            (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[]))`, [iids]);
        await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[])`, [iids]);
        await db.none(`DELETE FROM tbl_approval_instances WHERE id=ANY($1::int[])`, [iids]);
      }
      await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id=ANY($1::int[])`, [rids]);
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id=ANY($1::int[])`, [rids]);
    }
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=$1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id=$1`, [POLICY_ID]);
    await cleanupArcEvalPerms(db, [BUYER, APPROVER]);
  });

  const body = (extra = {}) => ({
    end_date: D(1),
    products: [{ arc_item_id: itemId, vendor_targets: [{ vendor_id: VENDOR_A, target_rate: 80 }] }],
    ...extra,
  });

  test("ARC create stores creator_remarks and puts it in ARC_NEGOTIATION metadata", async () => {
    const res = await buyerClient
      .post(`${E}/${arcId}/comm-eval/negotiation/rounds`)
      .send(body({ creator_remarks: `  ${SECRET}  `, remarks: "legacy field" }));
    expect(res.status).toBe(200);
    roundId = Number(res.body.data.id);

    const row = await db.one(
      `SELECT creator_remarks, remarks FROM tbl_negotiation_rounds WHERE id=$1`, [roundId]);
    expect(row.creator_remarks).toBe(SECRET);       // trimmed
    expect(row.remarks).toBe("legacy field");       // untouched meaning

    const inst = await db.one(
      `SELECT metadata FROM tbl_approval_instances
        WHERE entity_type='ARC_NEGOTIATION' AND entity_id=$1`, [roundId]);
    expect(inst.metadata.creator_remarks).toBe(SECRET);
  });

  test("ARC create rejects 1001-char remarks with 400", async () => {
    const before = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_negotiation_rounds WHERE source_type='ARC' AND source_id=$1`, [arcId]);
    const res = await buyerClient
      .post(`${E}/${arcId}/comm-eval/negotiation/rounds`)
      .send(body({ creator_remarks: "x".repeat(1001) }));
    expect(res.status).toBe(400);
    const after = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_negotiation_rounds WHERE source_type='ARC' AND source_id=$1`, [arcId]);
    expect(after.n).toBe(before.n);
  });

  test("ARC approver round payload includes creator_remarks", async () => {
    const res = await approverClient.get(`${E}/${arcId}/comm-eval/negotiation/rounds`);
    expect(res.status).toBe(200);
    const r = res.body.data.find((x) => Number(x.id) === roundId);
    expect(r).toBeTruthy();
    expect(r.can_user_approve).toBe(true);
    expect(r.creator_remarks).toBe(SECRET);
  });

  test("vendor ARC rounds never include creator_remarks", async () => {
    const res = await vendorClient.get(`${V}/requests/${arcId}/negotiation`);
    expect(res.status).toBe(200);
    // non-vacuous: the round really came back
    expect(res.body.data.map((r) => Number(r.round_id))).toContain(roundId);
    expect(allKeys(res.body).has("creator_remarks")).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
});
