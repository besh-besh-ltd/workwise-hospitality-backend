// ARC Negotiation — Commercial Evaluators approve their colleagues' rounds.
//
// ARC mirrors RFQ: 'ARC Commercial Evaluator' holds arc-comm.read/evaluate/approve
// (migration 20261019100200), the round creator's own approver slot is
// auto-approved, and the OTHER evaluators must approve (policy rule ALL).
//
// Product-level: real HTTP + Postgres, the real SYSTEM role (no fixture role),
// the real ARC_NEGOTIATION policy engine.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const PROC     = IDS.processes.A_P1;
const EVAL_1   = IDS.users.a1_proc_buyer;    // creates the round
const EVAL_2   = IDS.users.a1_proc_commEval;
const EVAL_3   = IDS.users.a1_proc_commApp;
const VENDOR_A = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT  = 1;

const POLICY_ALL    = 64970; // hotel A1, [ROLE ARC Commercial Evaluator, ALL]
const SCOPE_BASE    = 64980;
const E = "/api/v1/arc-v2/evaluation";
const D = (days) => new Date(Date.now() + days * 86400_000).toISOString();

describe("ARC negotiation — Commercial Evaluators approve peers' rounds", () => {
  let roleId;
  const arcIds = [];

  async function seedArc(num, hotel) {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by, eligibility_type)
       VALUES ($1, 'Peer approval', $2, $3, $4, $5, $6, 'comm_eval_in_progress',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days', $7, 'open')
       RETURNING id`,
      [num, CATEGORY, HC, hotel, DEPT, PROC, EVAL_1]
    );
    arcIds.push(arc.id);
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 1000, 'litre', 120) RETURNING id`,
      [arc.id, VARIANT]
    );
    await db.none(
      `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status) VALUES ($1, $2, 'invited')
       ON CONFLICT DO NOTHING`, [arc.id, VENDOR_A]
    );
    const q = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at) VALUES ($1, $2, NOW()) RETURNING id`,
      [arc.id, VENDOR_A]
    );
    await db.none(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct) VALUES ($1, $2, 90, 18)`,
      [q.id, item.id]
    );
    return { arcId: arc.id, itemId: item.id };
  }

  async function launchRound(client, { arcId, itemId }) {
    const res = await client.post(`${E}/${arcId}/comm-eval/negotiation/rounds`).send({
      end_date: D(1),
      products: [{ arc_item_id: itemId, vendor_targets: [{ vendor_id: VENDOR_A, target_rate: 80 }] }],
    });
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    return Number(res.body.data.id);
  }

  const roundStatus = async (id) =>
    (await db.one(`SELECT status FROM tbl_negotiation_rounds WHERE id=$1`, [id])).status;

  const approverRows = (roundId) =>
    db.any(
      `SELECT asa.approver_user_id AS user_id, asa.status
         FROM tbl_approval_instances i
         JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
         JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = s.id
        WHERE i.entity_type='ARC_NEGOTIATION' AND i.entity_id=$1
        ORDER BY asa.approver_user_id`,
      [roundId]
    );

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`,
      [[EVAL_1, EVAL_2, EVAL_3]]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR_A]);
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CATEGORY, DEPT]
    );

    // The REAL system role, found by title (ids differ per environment).
    roleId = (await db.one(
      `SELECT id FROM tbl_roles WHERE created_by IS NULL AND title='ARC Commercial Evaluator'`
    )).id;

    // Three evaluators at hotel A1.
    const scopes = [[EVAL_1, HOTEL], [EVAL_2, HOTEL], [EVAL_3, HOTEL]];
    for (let i = 0; i < scopes.length; i++) {
      await db.none(
        `INSERT INTO tbl_user_role_scopes (id, user_id, role_id, company_id, hotel_id, department_id)
         VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (id) DO NOTHING`,
        [SCOPE_BASE + i, scopes[i][0], roleId, HC, scopes[i][1]]
      );
    }

    for (const [pid, hotel] of [[POLICY_ALL, HOTEL]]) {
      await db.none(
        `INSERT INTO tbl_approval_policies
           (id, entity_type, hospitality_company_id, hotel_id, department_id, is_active,
            created_by, process_id, is_master, is_department_scoped, version)
         VALUES ($1, 'ARC_NEGOTIATION', $2, $3, NULL, true, $4, NULL, false, false, 1)
         ON CONFLICT (id) DO UPDATE SET is_active = true`,
        [pid, HC, hotel, EVAL_1]
      );
      await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=$1`, [pid]);
      await db.none(
        `INSERT INTO tbl_approval_policy_steps
           (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
         VALUES ($1, 1, 'ALL', 'ROLE', $2)`,
        [pid, roleId]
      );
    }
  });

  afterAll(async () => {
    for (const aid of arcIds) {
      const rounds = await db.any(
        `SELECT id FROM tbl_negotiation_rounds WHERE source_type='ARC' AND source_id=$1`, [aid]);
      const rids = rounds.map((r) => r.id);
      if (rids.length) {
        const iids = (await db.any(
          `SELECT id FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=ANY($1::int[])`,
          [rids])).map((i) => i.id);
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
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [aid]);
      await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [aid]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=ANY($1::int[])`, [[POLICY_ALL]]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id=ANY($1::int[])`, [[POLICY_ALL]]);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id >= $1 AND id < $2`, [SCOPE_BASE, SCOPE_BASE + 3]);
  });

  test("creator's slot is auto-approved; the two peers must approve (rule ALL)", async () => {
    const arc = await seedArc("ARC-PEER-1", HOTEL);
    const c1 = await httpClient(EVAL_1), c2 = await httpClient(EVAL_2), c3 = await httpClient(EVAL_3);
    const roundId = await launchRound(c1, arc);

    expect(await roundStatus(roundId)).toBe("PENDING_APPROVAL");
    const rows = await approverRows(roundId);
    expect(rows.map((r) => [Number(r.user_id), r.status])).toEqual(
      [[EVAL_1, "APPROVED"], [EVAL_2, "PENDING"], [EVAL_3, "PENDING"]].sort((a, b) => a[0] - b[0])
    );

    const a2 = await c2.post(`${E}/${arc.arcId}/comm-eval/negotiation/rounds/${roundId}/approve`).send({});
    expect(a2.status).toBe(200);
    expect(a2.body.data.allApproved).toBe(false);
    expect(await roundStatus(roundId)).toBe("PENDING_APPROVAL");

    const a3 = await c3.post(`${E}/${arc.arcId}/comm-eval/negotiation/rounds/${roundId}/approve`).send({});
    expect(a3.status).toBe(200);
    expect(a3.body.data.allApproved).toBe(true);
    expect(await roundStatus(roundId)).toBe("ACTIVE");
  });

  test("a peer rejecting cancels the round", async () => {
    const arc = await seedArc("ARC-PEER-2", HOTEL);
    const c1 = await httpClient(EVAL_1), c2 = await httpClient(EVAL_2);
    const roundId = await launchRound(c1, arc);
    expect(await roundStatus(roundId)).toBe("PENDING_APPROVAL");

    const rej = await c2.post(`${E}/${arc.arcId}/comm-eval/negotiation/rounds/${roundId}/reject`)
      .send({ comment: "Targets too aggressive" });
    expect(rej.status).toBe(200);
    expect(await roundStatus(roundId)).toBe("CANCELLED");
  });

  test("the only evaluator at the hotel: instance completes as INITIATOR_ONLY", async () => {
    // Take the two peers off the hotel for this case, then put them back.
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = ANY($1::int[])`, [[SCOPE_BASE + 1, SCOPE_BASE + 2]]);
    try {
      const arc = await seedArc("ARC-PEER-3", HOTEL);
      const c1 = await httpClient(EVAL_1);
      const roundId = await launchRound(c1, arc);

      expect(await roundStatus(roundId)).toBe("ACTIVE");
      const inst = await db.one(
        `SELECT status, metadata FROM tbl_approval_instances
          WHERE entity_type='ARC_NEGOTIATION' AND entity_id=$1`, [roundId]);
      expect(inst.status).toBe("APPROVED");
      expect(inst.metadata.auto_approval.case).toBe("INITIATOR_ONLY");
    } finally {
      for (const [i, uid] of [[1, EVAL_2], [2, EVAL_3]]) {
        await db.none(
          `INSERT INTO tbl_user_role_scopes (id, user_id, role_id, company_id, hotel_id, department_id)
           VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (id) DO NOTHING`,
          [SCOPE_BASE + i, uid, roleId, HC, HOTEL]
        );
      }
    }
  });
});
