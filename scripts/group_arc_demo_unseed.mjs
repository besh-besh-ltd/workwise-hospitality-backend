// Removes exactly what scripts/group_arc_demo_seed.mjs created: the "ZZ DEMO"
// group rate contracts and everything hanging off them, in foreign-key order.
//
// It does NOT remove the ARC_GROUP approval workflow — that is configuration
// the company keeps using — unless you pass --drop-workflow.
//
//   node scripts/group_arc_demo_unseed.mjs --db=hospitality_stage --company=5 [--drop-workflow]

import pgPromise from 'pg-promise';
import dotenv from 'dotenv';

dotenv.config();

const MARKER = 'ZZ DEMO';
const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const DB = arg('db');
const COMPANY = Number(arg('company'));
const DROP_WORKFLOW = process.argv.includes('--drop-workflow');
if (!DB || !COMPANY) { console.error('usage: --db= --company= [--drop-workflow]'); process.exit(1); }

const db = pgPromise()({
  host: process.env.HOST,
  port: Number(process.env.DATABASE_PORT || 5432),
  user: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  database: DB,
  ssl: process.env.TEST_DB_NO_SSL === '1' ? false : { rejectUnauthorized: false },
});

const main = async () => {
  const arcs = await db.any(
    `SELECT id, arc_number, title FROM tbl_arc WHERE hospitality_company_id = $1 AND title LIKE $2`,
    [COMPANY, `${MARKER}%`]);
  if (arcs.length === 0) { console.log('nothing to remove'); return; }
  const ids = arcs.map((a) => Number(a.id));
  console.log('removing:', arcs.map((a) => `#${a.id} ${a.arc_number}`).join(', '));

  await db.tx(async (t) => {
    // Anything a tester may have raised against the demo contracts goes first.
    const poIds = (await t.any(
      `SELECT cp.po_id FROM tbl_arc_callof_po cp
        JOIN tbl_arc_contract c ON c.id = cp.arc_contract_id WHERE c.arc_id = ANY($1::bigint[])`, [ids]
    )).map((r) => r.po_id);
    const mrIds = (await t.any(
      `SELECT DISTINCT cp.mr_id FROM tbl_arc_callof_po cp
        JOIN tbl_arc_contract c ON c.id = cp.arc_contract_id
       WHERE c.arc_id = ANY($1::bigint[]) AND cp.mr_id IS NOT NULL`, [ids]
    )).map((r) => r.mr_id);
    await t.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[]))`, [ids]);
    if (poIds.length) {
      await t.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
      await t.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [poIds]);
    }
    if (mrIds.length) {
      await t.none(`DELETE FROM tbl_material_requisition_item WHERE mr_id = ANY($1::int[])`, [mrIds]);
      await t.none(`DELETE FROM tbl_material_requisition WHERE id = ANY($1::int[])`, [mrIds]);
    }
    await t.none(`DELETE FROM tbl_approval_instances WHERE entity_type LIKE 'ARC%' AND entity_id = ANY($1::bigint[])`, [ids]);
    await t.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = ANY($1::text[])`, [ids.map(String)]);
    await t.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [ids]);
    await t.none(`DELETE FROM tbl_arc_contract_clarification WHERE arc_id = ANY($1::bigint[])`, [ids]);
    await t.none(`DELETE FROM tbl_arc_contract_signature_otp WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[]))`, [ids]);
    await t.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[]))`, [ids]);
    await t.none(`DELETE FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[])`, [ids]);
    await t.none(`DELETE FROM tbl_arc_comm_evaluation WHERE arc_id = ANY($1::bigint[])`, [ids]);
    await t.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[]))`, [ids]);
    await t.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[])`, [ids]);
    await t.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [ids]);
    if (DROP_WORKFLOW) {
      const pol = await t.any(
        `SELECT id FROM tbl_approval_policies WHERE hospitality_company_id = $1 AND entity_type LIKE 'ARC_GROUP%'`, [COMPANY]);
      const pids = pol.map((p) => p.id);
      if (pids.length) {
        await t.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [pids]);
        await t.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [pids]);
        console.log('removed group workflow policies:', pids.join(', '));
      }
    }
  });
  console.log('done');
};

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
