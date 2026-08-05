-- ===========================================================================
--  REVERT for scripts/repair_po_total_value.sql
-- ===========================================================================
--
--  Restores tbl_rfq_purchase_order.total_value on all 30 repaired POs to the
--  EXACT values they held in hospitality_main on 2026-08-01, captured
--  read-only immediately before the repair was written.
--
--  ⚠️  READ THIS BEFORE RUNNING  ⚠️
--
--  These are the WRONG values. They are the understated totals the repair
--  existed to correct — ₹5,76,56,394.93 of real, committed spend missing from
--  the PO book. Running this script re-introduces that gap. Use it only if the
--  repair itself is judged to have been a mistake, not as routine cleanup.
--
--  It does NOT undo legitimate PO edits made after the repair. If any of these
--  POs has been edited since, its total_value is now a THIRD value and forcing
--  it back to the 2026-08-01 figure would be wrong. Section A below shows you
--  which rows have moved; check it before Section B.
--
--  Provenance: every value below was read from production on 2026-08-01 with
--  a read-only connection (default_transaction_read_only=on). The
--  `-- would become` comment on each line is what the repair sets it to, so
--  each row documents both directions.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- SECTION A — PRE-REVERT INSPECTION (read-only). Run this first.
-- Any row where `current_value` matches neither `repaired_to` nor
-- `original_value` has been edited since the repair — do NOT blanket-revert it.
-- ---------------------------------------------------------------------------
WITH snapshot(po_id, original_value, repaired_to) AS (VALUES
      (7,     311898.00::numeric,   343616.00::numeric),
      (60,     20672.00,           2588614.00),
      (61,      5009.00,           1934635.00),
      (66,     79800.00,           1799800.00),
      (71,     34710.00,           3587722.00),
      (72,     53330.00,           5177260.00),
      (76,     39172.00,           3804307.00),
      (77,     12727.00,           1151647.00),
      (91,    453120.00,            759920.00),
      (92,     17348.00,             79725.00),
      (93,     41536.00,            143134.00),
      (94,     60900.00,            171048.00),
      (95,    531000.00,           2923155.00),
      (98,   8494386.00,          24871086.00),
      (99,   5593065.00,          15371791.00),
      (100,    43660.00,           2052569.00),
      (101,    17348.00,             89946.00),
      (106,    85365.00,            673345.00),
      (110,    10540.00,             35312.00),
      (111,    27000.00,            199096.00),
      (113,    25000.00,            162000.00),
      (114,    48676.00,            247397.00),
      (117,    85260.00,            328859.00),
      (124,    13176.00,             39306.00),
      (130,    94400.00,           1095040.00),
      (174,   324500.00,           1343461.00),
      (175,  2007180.00,           4902900.00),
      (184,    20210.00,            330479.00),
      (186,      666.00,               665.50),
      (440,    18124.73,             18338.16)
)
SELECT s.po_id,
       po.po_number,
       po.status,
       po.total_value AS current_value,
       s.repaired_to,
       s.original_value,
       CASE
         WHEN po.total_value = s.repaired_to     THEN 'repaired — revertable'
         WHEN po.total_value = s.original_value  THEN 'already original — no-op'
         ELSE                                         'CHANGED SINCE REPAIR — DO NOT REVERT'
       END AS state,
       po.updated_at
  FROM snapshot s
  JOIN tbl_rfq_purchase_order po ON po.id = s.po_id
 ORDER BY s.po_id;
-- expect (immediately after the repair): 30 rows, all "repaired — revertable"


-- ---------------------------------------------------------------------------
-- SECTION B — REVERT. Self-verifying: aborts unless exactly 30 rows change.
--
--     BEGIN;
--     \i scripts/repair_po_total_value_revert.sql
--     -- read the NOTICE line; it must say 30
--     COMMIT;                                   -- or ROLLBACK;
--
-- The `AND po.total_value <> s.original_value` predicate makes this a no-op on
-- rows already holding their original value, so a partially-applied revert
-- cannot double-count — but it also means a second run updates 0 rows and
-- therefore RAISES, telling you the revert already happened.
-- ---------------------------------------------------------------------------

DO $revert$
DECLARE
    v_rows integer;
BEGIN
    WITH snapshot(po_id, original_value) AS (VALUES
          (7,     311898.00::numeric),
          (60,     20672.00),
          (61,      5009.00),
          (66,     79800.00),
          (71,     34710.00),
          (72,     53330.00),
          (76,     39172.00),
          (77,     12727.00),
          (91,    453120.00),
          (92,     17348.00),
          (93,     41536.00),
          (94,     60900.00),
          (95,    531000.00),
          (98,   8494386.00),
          (99,   5593065.00),
          (100,    43660.00),
          (101,    17348.00),
          (106,    85365.00),
          (110,    10540.00),
          (111,    27000.00),
          (113,    25000.00),
          (114,    48676.00),
          (117,    85260.00),
          (124,    13176.00),
          (130,    94400.00),
          (174,   324500.00),
          (175,  2007180.00),
          (184,    20210.00),
          (186,      666.00),
          (440,    18124.73)
    )
    UPDATE tbl_rfq_purchase_order po
       SET total_value = s.original_value,
           updated_at  = now()
      FROM snapshot s
     WHERE s.po_id = po.id
       AND po.total_value <> s.original_value;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RAISE NOTICE 'Reverted % PO headers to their 2026-08-01 values', v_rows;
    IF v_rows <> 30 THEN
        RAISE EXCEPTION
          'ABORT: revert updated % rows, expected exactly 30. Nothing has been committed. Run SECTION A and check for rows edited since the repair.',
          v_rows;
    END IF;
END
$revert$;


-- ---------------------------------------------------------------------------
-- SECTION C — POST-REVERT VERIFICATION (read-only).
-- ---------------------------------------------------------------------------
SELECT count(*) AS pos, sum(total_value) AS po_book FROM tbl_rfq_purchase_order;
-- expect: 385 | 150580920.31   (back to the pre-repair PO book)
