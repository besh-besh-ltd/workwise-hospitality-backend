/**
 * buildPOTemplateData — equivalence + query budget.
 *
 * POST /po/approve/:id renders the PO document inside the approval
 * transaction (deliberate: PO-document atomicity), and the template data
 * builder ran two per-row loops there — one approvers read per approved
 * TECHNICAL instance, and a product read + an approvers read per approved
 * NEGOTIATION / NEGOTIATION_QUOTE instance. On a transaction every one of
 * those is a serial round trip held under the approval's locks.
 *
 * Pinned on the rich RFQ plus three APPROVED commercial instances (two
 * NEGOTIATION_QUOTE on different products, one NEGOTIATION without a product)
 * and a second APPROVED TECHNICAL instance: the built data is snapshotted
 * against the pre-change code, and the statement count must not grow with the
 * number of instances.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { countQueries } from "../helpers/queryCounter.js";
import { seedRichRfq, cleanupRichRfq, normalizeForSnapshot } from "../helpers/perfRichRfq.js";
import { buildPOTemplateData } from "../../app/helper/poTemplateDataBuilder.js";
import appDb from "../../app/config/dbConn.js";

const BUYER = IDS.users.a1_proc_buyer;
const U = IDS.users;

// buildPOTemplateData(poId) on the plain pool.
//   before: 19 statements in 18 serial waves (2 TECHNICAL + 3 commercial instances)
//   after : 14 statements in 3 waves; the approval history is 2 statements for
//           ANY number of instances (it was 1 + 2 per instance).
const BUDGET = { statements: 14, waves: 4 };

describe("buildPOTemplateData — batched approval history", () => {
  let made;
  const extraInstanceIds = [];

  const approvedInstance = async (t, { type, entityId, policy, metadata, approvers, at }) => {
    const inst = await t.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, current_step, hospitality_company_id, hotel_id,
          department_id, initiated_by, metadata, created_at, completed_at, process_id)
       VALUES ($1,$2,$3,'APPROVED',$4,$5,$6,$7,$8,$9,$10,$10,$11) RETURNING id`,
      [type, entityId, policy, approvers.length, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc,
       BUYER, JSON.stringify(metadata), at, IDS.processes.A_P1]);
    extraInstanceIds.push(inst.id);
    let order = 1;
    for (const user of approvers) {
      const st = await t.one(
        `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status, created_at, completed_at)
         VALUES ($1,$2,'ANY','APPROVED',$3,$3) RETURNING id`, [inst.id, order, at]);
      await t.none(
        `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status, acted_at, created_at)
         VALUES ($1,$2,'APPROVED',$3,$3)`, [st.id, user, at]);
      await t.none(
        `INSERT INTO tbl_approval_actions (approval_instance_id, approval_instance_step_id, approver_user_id, action, created_at)
         VALUES ($1,$2,$3,'APPROVE',$4)`, [inst.id, st.id, user, at]);
      order += 1;
    }
  };

  beforeAll(async () => {
    made = await seedRichRfq({ buyer: BUYER });
    const [p1, p2] = made.productIds;
    await db.tx(async (t) => {
      await approvedInstance(t, {
        type: "TECHNICAL", entityId: made.techEvalId, policy: IDS.policies.A1_P1_TECHNICAL,
        metadata: { rfq_id: made.rfqId, product_name: "Second evaluated product" },
        approvers: [U.a1_proc_finance], at: "2026-09-08 11:00:00",
      });
      await approvedInstance(t, {
        type: "NEGOTIATION_QUOTE", entityId: p1, policy: IDS.policies.A1_P1_NEGOTIATION_QUOTE,
        metadata: { rfq_id: made.rfqId, rfq_product_id: p1 },
        approvers: [U.a1_proc_commApp, U.a1_proc_finance], at: "2026-09-14 11:00:00",
      });
      await approvedInstance(t, {
        type: "NEGOTIATION_QUOTE", entityId: p2, policy: IDS.policies.A1_P1_NEGOTIATION_QUOTE,
        metadata: { rfq_id: made.rfqId, rfq_product_id: p2 },
        approvers: [U.a1_proc_techApp], at: "2026-09-14 12:00:00",
      });
      await approvedInstance(t, {
        type: "NEGOTIATION", entityId: made.rfqId, policy: IDS.policies.A1_P1_NEGOTIATION,
        metadata: { rfq_id: made.rfqId },
        approvers: [U.a1_proc_poApp], at: "2026-09-14 13:00:00",
      });
    });
    made.instanceIds.push(...extraInstanceIds);
  });

  afterAll(async () => {
    await cleanupRichRfq(made);
  });

  it("builds the same template data as before", async () => {
    const data = await buildPOTemplateData(made.poIds[0]);
    expect(data.commercialEvaluations.approvers.length).toBeGreaterThan(0);
    expect(normalizeForSnapshot(data)).toMatchSnapshot();
  });

  it("does not issue a statement per approval instance", async () => {
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await countQueries(() => buildPOTemplateData(made.poIds[0])));
    const count = Math.max(...runs.map((r) => r.count));
    const waves = Math.min(...runs.map((r) => r.waves));
    if (process.env.PERF_DUMP) {
      console.log(`[po-template] ${count} statements, waves ${waves}\n${runs[0].statements.map((s) => s.slice(0, 120)).join("\n")}`);
    }
    expect(count).toBeLessThanOrEqual(BUDGET.statements);
    expect(waves).toBeLessThanOrEqual(BUDGET.waves);
  });

  it("inside a transaction (the approve path) builds the same data, same statements + BEGIN/COMMIT", async () => {
    const plain = await buildPOTemplateData(made.poIds[0]);
    const { result, count } = await countQueries(() =>
      appDb.tx((t) => buildPOTemplateData(made.poIds[0], t))
    );
    expect(result).toEqual(plain);
    expect(count).toBeLessThanOrEqual(BUDGET.statements + 2);
  });
});
