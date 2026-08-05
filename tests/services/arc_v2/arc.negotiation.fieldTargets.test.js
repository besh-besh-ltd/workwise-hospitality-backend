// ARC negotiation — I1: field-keyed vendor targets persist on create.
//
// Unifying RFQ + ARC negotiation: the RFQ module negotiates many fields per
// vendor (base price, named charges, payment terms, tax demands) via
//   vendor_targets: [{ vendor_id, fields: [{ name, target, mode?, tax_demand? }] }]
// The ARC create endpoint previously persisted per-vendor targets only in the
// `products` JSONB for MULTI/arc-level rounds — the single-item path stored
// products=null and DROPPED the targets. This suite proves createRound now
// persists field-keyed targets for EVERY round (single-item included), keeps the
// legacy { target_rate } shape working, validates the fields[] shape, and stays
// acl-gated.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const PROC     = IDS.processes.A_P1;
const BUYER    = IDS.users.a1_proc_buyer;   // creator AND sole approver → auto-approve
const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;
const CATEGORY = TEST_CATEGORIES.beverages;
const POLICY_ID = 64930;
const E = "/api/v1/arc-v2/evaluation";
const D = (days) => new Date(Date.now() + days * 86400_000).toISOString();

describe("ARC negotiation — field-keyed vendor targets persist on create", () => {
  let buyerClient, vendorClient;
  let arcId, itemAId, itemBId;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type=2, status=1 WHERE id=$1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type=3, status=1 WHERE id = ANY($1::int[])`, [[VENDOR_A, VENDOR_B]]);
    await db.none(`INSERT INTO tbl_category_department (category_id, department_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [CATEGORY, DEPT]);
    await seedArcEvalPerms(db, [BUYER]);

    // Auto-approve ARC_NEGOTIATION policy (approver = creator BUYER) → rounds go
    // ACTIVE on create, no separate approval step needed for this suite.
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1,'ARC_NEGOTIATION',$2,$3,NULL,true,$4,$5,false,false,1)
       ON CONFLICT (id) DO UPDATE SET is_active=true, process_id=$5`,
      [POLICY_ID, HC, HOTEL, BUYER, PROC]
    );
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=$1`, [POLICY_ID]);
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`,
      [POLICY_ID, BUYER]
    );

    // ARC at commercial (comm_eval_in_progress). No tech clauses → technical
    // skipped → commercial writable (assertStageWritable passes).
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number,title,category_id,hospitality_company_id,hotel_id,department_id,process_id,status,
          submission_start_at,submission_end_at,contract_start_at,contract_end_at,created_by,eligibility_type)
       VALUES ('ARC-NEG-FT-1','Field targets test',$1,$2,$3,$4,$5,'comm_eval_in_progress',
               NOW()-INTERVAL '10 days',NOW()-INTERVAL '1 day',NOW()+INTERVAL '7 days',NOW()+INTERVAL '180 days',$6,'open')
       RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    itemAId = (await db.one(`INSERT INTO tbl_arc_item (arc_id,product_variant_id,indicative_qty,uom,target_price) VALUES ($1,1,1000,'litre',120) RETURNING *`, [arcId])).id;
    itemBId = (await db.one(`INSERT INTO tbl_arc_item (arc_id,product_variant_id,indicative_qty,uom,target_price) VALUES ($1,2,500,'litre',120) RETURNING *`, [arcId])).id;
    await db.none(`INSERT INTO tbl_arc_invitation (arc_id,vendor_id,status) VALUES ($1,$2,'invited'),($1,$3,'invited') ON CONFLICT DO NOTHING`, [arcId, VENDOR_A, VENDOR_B]);
    // Both vendors: submitted quote with a line for BOTH items.
    for (const v of [VENDOR_A, VENDOR_B]) {
      const q = await db.one(`INSERT INTO tbl_arc_quote (arc_id,vendor_id,submitted_at) VALUES ($1,$2,NOW()) RETURNING *`, [arcId, v]);
      await db.none(`INSERT INTO tbl_arc_quote_line (arc_quote_id,arc_item_id,rate,gst_pct) VALUES ($1,$2,90,18),($1,$3,95,18)`, [q.id, itemAId, itemBId]);
    }

    buyerClient  = await httpClient(BUYER);
    vendorClient = await httpClient(VENDOR_A);
  });

  afterAll(async () => {
    if (arcId) {
      const rids = (await db.any(`SELECT id FROM tbl_negotiation_rounds WHERE source_type='ARC' AND source_id=$1`, [arcId])).map(r => r.id);
      if (rids.length) {
        const insts = (await db.any(`SELECT id FROM tbl_approval_instances WHERE entity_type='ARC_NEGOTIATION' AND entity_id=ANY($1::int[])`, [rids])).map(r => r.id);
        if (insts.length) {
          await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id=ANY($1::int[])`, [insts]);
          await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[]))`, [insts]);
          await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id=ANY($1::int[])`, [insts]);
          await db.none(`DELETE FROM tbl_approval_instances WHERE id=ANY($1::int[])`, [insts]);
        }
        await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id=ANY($1::int[])`, [rids]);
        await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id=ANY($1::int[])`, [rids]);
      }
      await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id=$1)`, [arcId]);
      await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id=$1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id=$1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id=$1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=$1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id=$1`, [POLICY_ID]);
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  test("1. single-item round persists field-keyed vendor_targets (base_price + charge + payment_terms + tax_demand)", async () => {
    const res = await buyerClient.post(`${E}/${arcId}/comm-eval/negotiation/rounds`).send({
      end_date: D(2),
      products: [{
        arc_item_id: itemAId,
        vendor_targets: [{
          vendor_id: VENDOR_A,
          fields: [
            { name: "base_price", target: 85, tax_demand: "Bring GST to 12%" },
            { name: "freight", target: 5, mode: "percentage" },
            { name: "payment_terms", target: "Net 45" },
          ],
        }],
      }],
    });
    expect(res.status).toBe(200);
    const roundId = Number(res.body.data.id);

    // The round is single-item (arc_item_id column set for display) …
    const row = await db.one(`SELECT arc_item_id, products FROM tbl_negotiation_rounds WHERE id=$1`, [roundId]);
    expect(Number(row.arc_item_id)).toBe(Number(itemAId));
    // … AND the field-keyed targets survived in products JSONB (the fix).
    expect(Array.isArray(row.products)).toBe(true);
    const vt = row.products[0].vendor_targets[0];
    expect(Number(vt.vendor_id)).toBe(VENDOR_A);
    const byName = Object.fromEntries((vt.fields || []).map(f => [f.name, f]));
    expect(byName.base_price).toMatchObject({ target: 85, tax_demand: "Bring GST to 12%" });
    expect(byName.freight).toMatchObject({ target: 5, mode: "percentage" });
    expect(byName.payment_terms).toMatchObject({ target: "Net 45" });
  });

  test("2. legacy { vendor_id, target_rate } shape still persists", async () => {
    const res = await buyerClient.post(`${E}/${arcId}/comm-eval/negotiation/rounds`).send({
      end_date: D(2),
      products: [{ arc_item_id: itemBId, vendor_targets: [{ vendor_id: VENDOR_B, target_rate: 80 }] }],
    });
    expect(res.status).toBe(200);
    const roundId = Number(res.body.data.id);
    const row = await db.one(`SELECT products FROM tbl_negotiation_rounds WHERE id=$1`, [roundId]);
    expect(Number(row.products[0].vendor_targets[0].target_rate)).toBe(80);
  });

  test("3. malformed fields[] is rejected (must be an array)", async () => {
    const res = await buyerClient.post(`${E}/${arcId}/comm-eval/negotiation/rounds`).send({
      end_date: D(2),
      products: [{ arc_item_id: itemAId, vendor_targets: [{ vendor_id: VENDOR_A, fields: "nope" }] }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/fields must be an array/i);
  });

  test("4. a target field without a name is rejected", async () => {
    const res = await buyerClient.post(`${E}/${arcId}/comm-eval/negotiation/rounds`).send({
      end_date: D(2),
      products: [{ arc_item_id: itemAId, vendor_targets: [{ vendor_id: VENDOR_A, fields: [{ target: 5 }] }] }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/must have a name/i);
  });

  test("5. a vendor (user_type 3) cannot create a round (acl)", async () => {
    const res = await vendorClient.post(`${E}/${arcId}/comm-eval/negotiation/rounds`).send({
      end_date: D(2),
      products: [{ arc_item_id: itemAId, vendor_targets: [{ vendor_id: VENDOR_A, fields: [{ name: "base_price", target: 85 }] }] }],
    });
    expect([401, 403]).toContain(res.status);
  });
});
