// ARC negotiation — I2: vendor sees field targets + revised quote auto-applies.
//
// End-to-end for the unified negotiation: buyer creates a round with field-keyed
// targets (base price + a named charge + a tax demand); the vendor's round view
// surfaces those targets (not just a scalar rate); the vendor submits a revised
// rate + GST + charges, which auto-applies onto the quote line (rate_source
// NEGOTIATED, negotiated_round_id set) and archives the previous values.

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
const BUYER    = IDS.users.a1_proc_buyer;   // creator + sole approver → auto-approve
const VENDOR_A = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const POLICY_ID = 64931;
const BASE = "/api/v1/arc-v2";
const E = `${BASE}/evaluation`;
const D = (days) => new Date(Date.now() + days * 86400_000).toISOString();

describe("ARC negotiation — vendor sees field targets + revised quote applies", () => {
  let buyerClient, vendorClient;
  let arcId, itemId, roundId;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type=2, status=1 WHERE id=$1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type=3, status=1 WHERE id=$1`, [VENDOR_A]);
    await db.none(`INSERT INTO tbl_category_department (category_id, department_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [CATEGORY, DEPT]);
    await seedArcEvalPerms(db, [BUYER]);

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
    // BUYER is the sole USER-source approver on this ARC_NEGOTIATION step —
    // grant read+approve on 'arc-comm' at the ARC's own hotel+department.
    await ensureApprovable(db, BUYER, "arc-comm", HC, HOTEL, DEPT);

    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number,title,category_id,hospitality_company_id,hotel_id,department_id,process_id,status,
          submission_start_at,submission_end_at,contract_start_at,contract_end_at,created_by,eligibility_type)
       VALUES ('ARC-NEG-APPLY-1','Vendor apply test',$1,$2,$3,$4,$5,'comm_eval_in_progress',
               NOW()-INTERVAL '10 days',NOW()-INTERVAL '1 day',NOW()+INTERVAL '7 days',NOW()+INTERVAL '180 days',$6,'open')
       RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    itemId = (await db.one(`INSERT INTO tbl_arc_item (arc_id,product_variant_id,indicative_qty,uom,target_price) VALUES ($1,1,1000,'litre',120) RETURNING *`, [arcId])).id;
    await db.none(`INSERT INTO tbl_arc_invitation (arc_id,vendor_id,status) VALUES ($1,$2,'invited') ON CONFLICT DO NOTHING`, [arcId, VENDOR_A]);
    const q = await db.one(`INSERT INTO tbl_arc_quote (arc_id,vendor_id,submitted_at) VALUES ($1,$2,NOW()) RETURNING *`, [arcId, VENDOR_A]);
    await db.none(`INSERT INTO tbl_arc_quote_line (arc_quote_id,arc_item_id,rate,gst_pct,charges) VALUES ($1,$2,90,18,'[]'::jsonb)`, [q.id, itemId]);

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
      await db.none(`DELETE FROM tbl_arc_quote_line_history WHERE arc_quote_line_id IN (SELECT ql.id FROM tbl_arc_quote_line ql JOIN tbl_arc_quote q ON q.id=ql.arc_quote_id WHERE q.arc_id=$1)`, [arcId]);
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

  test("1. buyer creates a round with field-keyed targets (auto-approved ACTIVE)", async () => {
    const res = await buyerClient.post(`${E}/${arcId}/comm-eval/negotiation/rounds`).send({
      end_date: D(2),
      products: [{
        arc_item_id: itemId,
        vendor_targets: [{
          vendor_id: VENDOR_A,
          fields: [
            { name: "base_price", target: 85, tax_demand: "Bring GST to 12%" },
            { name: "freight", target: 5, mode: "percentage" },
          ],
        }],
      }],
    });
    expect(res.status).toBe(200);
    roundId = Number(res.body.data.id);
    const row = await db.one(`SELECT status FROM tbl_negotiation_rounds WHERE id=$1`, [roundId]);
    expect(row.status).toBe("ACTIVE"); // creator is the sole approver → auto-approved
  });

  test("2. vendor's round view surfaces the field targets (not just a scalar rate)", async () => {
    const res = await vendorClient.get(`${BASE}/vendor/requests/${arcId}/negotiation`);
    expect(res.status).toBe(200);
    const round = (res.body.data || []).find((r) => Number(r.round_id) === roundId);
    expect(round).toBeTruthy();
    const item = (round.items || []).find((it) => Number(it.arc_item_id) === Number(itemId));
    expect(item).toBeTruthy();
    // target_rate derived from the base_price field (back-compat), plus the full
    // field targets exposed for a rich vendor UI.
    expect(Number(item.target_rate)).toBe(85);
    const byName = Object.fromEntries((item.target_fields || []).map(f => [f.name, f]));
    expect(byName.base_price).toMatchObject({ target: 85, tax_demand: "Bring GST to 12%" });
    expect(byName.freight).toMatchObject({ target: 5, mode: "percentage" });
  });

  test("3. vendor's revised rate + GST + charges auto-applies (NEGOTIATED) and archives the old values", async () => {
    const res = await vendorClient.post(`${BASE}/vendor/negotiation/rounds/${roundId}/quote`).send({
      arc_item_id: itemId,
      rate: 84,
      gst_pct: 12,
      charges: [{ name: "freight", amount: 4, amount_mode: "percentage" }],
    });
    expect(res.status).toBe(200);

    const line = await db.one(
      `SELECT ql.rate, ql.gst_pct, ql.charges, ql.rate_source, ql.negotiated_round_id
         FROM tbl_arc_quote_line ql JOIN tbl_arc_quote q ON q.id=ql.arc_quote_id
        WHERE q.arc_id=$1 AND q.vendor_id=$2 AND ql.arc_item_id=$3`,
      [arcId, VENDOR_A, itemId]
    );
    expect(Number(line.rate)).toBe(84);
    expect(Number(line.gst_pct)).toBe(12);
    expect(line.rate_source).toBe("NEGOTIATED");
    expect(Number(line.negotiated_round_id)).toBe(roundId);
    expect(Array.isArray(line.charges)).toBe(true);
    expect(line.charges[0]).toMatchObject({ name: "freight" });

    // Previous values archived (rate 90, gst 18).
    const hist = await db.one(
      `SELECT rate, gst_pct FROM tbl_arc_quote_line_history
        WHERE arc_quote_line_id = (SELECT ql.id FROM tbl_arc_quote_line ql JOIN tbl_arc_quote q ON q.id=ql.arc_quote_id WHERE q.arc_id=$1 AND q.vendor_id=$2 AND ql.arc_item_id=$3)
        ORDER BY changed_at DESC LIMIT 1`,
      [arcId, VENDOR_A, itemId]
    );
    expect(Number(hist.rate)).toBe(90);
    expect(Number(hist.gst_pct)).toBe(18);
  });

  test("4. a second submit for the same item in the round is rejected (409 duplicate)", async () => {
    const res = await vendorClient.post(`${BASE}/vendor/negotiation/rounds/${roundId}/quote`).send({
      arc_item_id: itemId, rate: 83,
    });
    expect(res.status).toBe(409);
  });
});
