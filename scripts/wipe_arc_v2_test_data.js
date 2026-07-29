/**
 * ARC v2 — Wipe seeded test data from hospitality_stage.
 *
 * The seed script writes ARCs whose arc_number is prefixed `ARC-STG-`.
 * Plain `DELETE FROM tbl_arc WHERE arc_number LIKE 'ARC-STG-%'` fails
 * because several child tables (tbl_arc_contract, tbl_rfq_purchase_order,
 * tbl_material_requisition, tbl_arc_callof_po) reference the ARC chain
 * with ON DELETE RESTRICT. This script walks the chain in reverse so the
 * delete order respects every constraint:
 *
 *   1. tbl_arc_callof_po                       (link table — leaf)
 *   2. tbl_rfq_purchase_order                  (is_call_off + source_mr_id chain)
 *   3. tbl_material_requisition_item           (CASCADE on MR, but we drop
 *                                               explicitly so the order is
 *                                               obvious)
 *   4. tbl_material_requisition                (parents now free)
 *   5. tbl_arc_contract_line                   (CASCADE on contract; drop
 *                                               explicitly for visibility)
 *   6. tbl_arc_contract                        (now unblocked)
 *   7. tbl_arc                                 (root — cascades through
 *                                               item / invitation / event_log /
 *                                               tech_eval / quote / comm_eval)
 *
 * Filters on `arc_number LIKE 'ARC-STG-%'` so nothing outside the seed's
 * scope is touched.
 *
 * Usage (from /backend):
 *     node scripts/wipe_arc_v2_test_data.js
 */

import dotenv from 'dotenv';
import pg from 'pg-promise';

dotenv.config();

const pgp = pg({});
const db = pgp({
  user:     process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  host:     process.env.HOST,
  port:     process.env.DATABASE_PORT,
  ssl:      process.env.TEST_DB_NO_SSL === '1' ? false : { rejectUnauthorized: false },
});
pgp.pg.types.setTypeParser(1114, (s) => s);

const head = (s) => console.log('\n━━━', s, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const ok   = (s) => console.log('  ✓', s);

(async () => {
  try {
    head('Finding seeded ARCs');
    const arcs = await db.any(
      `SELECT id, arc_number FROM public.tbl_arc
        WHERE arc_number LIKE 'ARC-STG-%'
        ORDER BY id`
    );
    if (arcs.length === 0) {
      console.log('  (none found — nothing to wipe.)');
      process.exit(0);
    }
    console.log(`  ${arcs.length} ARC(s) to wipe:`);
    arcs.forEach((a) => console.log(`    #${a.id} ${a.arc_number}`));

    const arcIds = arcs.map((a) => Number(a.id));

    head('Cascading delete');
    await db.tx(async (t) => {
      // Resolve dependent ids so the deletes work even if some children
      // were created outside this seed.
      const contractIds = (await t.any(
        `SELECT id FROM public.tbl_arc_contract WHERE arc_id = ANY($1::bigint[])`,
        [arcIds]
      )).map((r) => Number(r.id));

      const contractLineIds = contractIds.length ? (await t.any(
        `SELECT id FROM public.tbl_arc_contract_line
          WHERE arc_contract_id = ANY($1::bigint[])`,
        [contractIds]
      )).map((r) => Number(r.id)) : [];

      const mrIds = contractIds.length ? (await t.any(
        `SELECT DISTINCT mr_id FROM public.tbl_arc_callof_po
          WHERE arc_contract_id = ANY($1::bigint[])`,
        [contractIds]
      )).map((r) => Number(r.mr_id)) : [];

      const poIds = contractIds.length ? (await t.any(
        `SELECT DISTINCT po_id FROM public.tbl_arc_callof_po
          WHERE arc_contract_id = ANY($1::bigint[])`,
        [contractIds]
      )).map((r) => Number(r.po_id)) : [];

      // 1) Call-off link rows — RESTRICT-blocking everything downstream.
      let r;
      r = await t.result(
        `DELETE FROM public.tbl_arc_callof_po
          WHERE arc_contract_id = ANY($1::bigint[])`,
        [contractIds.length ? contractIds : [0]]
      );
      ok(`tbl_arc_callof_po          deleted ${r.rowCount}`);

      // 2) Purchase orders referencing those contracts / MRs.
      r = poIds.length ? await t.result(
        `DELETE FROM public.tbl_rfq_purchase_order WHERE id = ANY($1::int[])`,
        [poIds]
      ) : { rowCount: 0 };
      ok(`tbl_rfq_purchase_order     deleted ${r.rowCount}`);

      // 3) MR items (will cascade with MR delete, but drop explicitly so
      //    the FK to arc_contract_line on tbl_material_requisition_item
      //    clears before we delete contract_lines below).
      r = mrIds.length ? await t.result(
        `DELETE FROM public.tbl_material_requisition_item
          WHERE mr_id = ANY($1::bigint[])`,
        [mrIds]
      ) : { rowCount: 0 };
      ok(`tbl_material_requisition_item deleted ${r.rowCount}`);

      // 4) MR rows themselves.
      r = mrIds.length ? await t.result(
        `DELETE FROM public.tbl_material_requisition
          WHERE id = ANY($1::bigint[])`,
        [mrIds]
      ) : { rowCount: 0 };
      ok(`tbl_material_requisition   deleted ${r.rowCount}`);

      // 5) Contract lines — cascades from contract, but explicit for clarity.
      r = contractLineIds.length ? await t.result(
        `DELETE FROM public.tbl_arc_contract_line
          WHERE id = ANY($1::bigint[])`,
        [contractLineIds]
      ) : { rowCount: 0 };
      ok(`tbl_arc_contract_line      deleted ${r.rowCount}`);

      // 6) Contracts.
      r = contractIds.length ? await t.result(
        `DELETE FROM public.tbl_arc_contract WHERE id = ANY($1::bigint[])`,
        [contractIds]
      ) : { rowCount: 0 };
      ok(`tbl_arc_contract           deleted ${r.rowCount}`);

      // 7) Finally the ARC root — cascades through items, invitations,
      //    snapshots, tech eval, quotes, comm eval, event log.
      r = await t.result(
        `DELETE FROM public.tbl_arc WHERE id = ANY($1::bigint[])`,
        [arcIds]
      );
      ok(`tbl_arc                    deleted ${r.rowCount}`);
    });

    head('Done');
    console.log(`  Cleared ${arcs.length} ARC(s) and every dependent row.`);
    process.exit(0);
  } catch (err) {
    console.error('\nWipe failed:', err.message);
    if (err.detail) console.error('  detail:', err.detail);
    if (err.hint)   console.error('  hint:',   err.hint);
    process.exit(1);
  }
})();
