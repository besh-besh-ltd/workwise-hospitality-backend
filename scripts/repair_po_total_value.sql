-- ===========================================================================
--  P0 DATA REPAIR — tbl_rfq_purchase_order.total_value understated
-- ===========================================================================
--
--  ⚠️  DEPLOY THE CODE FIX FIRST — see "ORDER OF OPERATIONS" below. ⚠️
--
--  This script realigns the stored PO grand total with the arithmetic every
--  other surface already performs. It covers TWO distinct defect classes with
--  two different root causes, and it recomputes rather than compares, because
--  one class is invisible to a naive `line_sum > total_value` query.
--
-- ---------------------------------------------------------------------------
--  THE PAPERWORK IS ALREADY RIGHT — ONLY THE DATABASE IS WRONG
-- ---------------------------------------------------------------------------
--  The printed/emailed PO does NOT read tbl_rfq_purchase_order.total_value.
--  app/helper/poTemplateDataBuilder.js:190 calls buildPOTemplatePricing(),
--  and app/helper/poTemplatePricing.js:105 recomputes the whole document from
--  tbl_purchase_order_product lines plus the global-charge snapshot — including
--  each charge's additional_tax (poTemplatePricing.js:237).
--
--  So for every row below, the vendor's PDF, the buyer's PDF and the file copy
--  all already show the figure in the `correct_value` column. What is wrong is
--  the number the DATABASE reports to dashboards, the PO book, spend
--  analytics and every list view. This repair makes the database agree with
--  the paperwork — it does not change any commercial commitment.
--
--  VISIBLE EFFECT: the PO book moves from ≈ ₹15.06 cr to ≈ ₹20.82 cr.
--    SUM(total_value) before : ₹15,05,80,920.31   (385 POs)
--    Class 1 correction      : + ₹5,76,56,182.00
--    Class 2 correction      : +       ₹212.93
--    SUM(total_value) after  : ₹20,82,37,315.24
--  Nobody is being charged more. ~₹5.77 cr of already-committed spend was
--  simply missing from every internal report.
--
-- ---------------------------------------------------------------------------
--  CLASS 1 — header froze at the FIRST line (28 POs, ₹5,76,56,182 understated)
-- ---------------------------------------------------------------------------
--  Root cause: the pre-`eeb66119` multi-line merge path appended a product row
--  to an existing draft PO without re-aggregating the header, so total_value
--  kept the value computed for line #1 while lines #2..#n were added silently.
--  PO 98 (138371) has 13 lines and a header holding ₹84,94,386 against a real
--  ₹2,48,71,086 — a ₹1,63,76,700 gap.
--
--  NONE of these 28 carry global charges (all have global_charges = '[]'),
--  which makes the correct value unambiguous:
--        correct = SUM(tbl_purchase_order_product.total_price)
--  All 28 are status='approved'. Gaps range ₹24,772 … ₹1,63,76,700.
--  All 28 gaps are POSITIVE (asserted in Section B1).
--
-- ---------------------------------------------------------------------------
--  CLASS 2 — the header disagrees with the engine on a PO that HAS global
--            charges (2 POs, net +₹212.93)
-- ---------------------------------------------------------------------------
--  ⚠️  THESE DO NOT APPEAR IN A NAIVE `line_sum > total_value` QUERY.  ⚠️
--  Their stored value already contains the BASE global charge, so it is
--  HIGHER than the line sum. They can only be found by recomputing. That is
--  why every query below rebuilds the grand total from first principles
--  instead of comparing against SUM(total_price).
--
--  Of 45 POs carrying global charges, 43 are already exactly correct — which
--  is also this script's cross-validation: the SQL recompute below reproduces
--  the JS pricing engine's output to the paisa on 43 independent production
--  rows that the engine itself wrote. The 2 that disagree:
--
--    PO 440 / 138712  (2026-07-24, pending_approval)   delta +₹213.43
--      6 lines summing ₹16,939.00
--      global charge "Transportation" 7%     → ₹1,185.73  (applied)
--      its additional_tax 18% of ₹1,185.73   → ₹  213.43  (DROPPED)
--      stored ₹18,124.73   correct ₹18,338.16
--      Root cause: app/models/purchaseOrderModel.js handleUpdatePO hand-rolled
--      the global-charge loop and applied only `norm.amount`, never
--      `additional_tax`. The CREATE path (draftPurchaseOrder) and the MERGE
--      path (mergeDraftPOs) both delegate to pricingEngine.sumGlobalCharges,
--      which includes it. The PO was therefore correct when drafted and became
--      wrong the first time somebody edited it. Both Class-2 rows had been
--      through an edit; the 43 correct ones had not.
--
--    PO 186 / 138458  (2026-05-05, approved)           delta −₹0.50
--      ⚠️  THIS IS THE ONE ROW THAT MOVES DOWN. READ BEFORE RUNNING.  ⚠️
--      1 line of ₹605.00, global charge "TCS" 10% (legacy {tax,tax_mode}
--      shape, NO additional_tax at all — so this is NOT the handleUpdatePO
--      defect). 605 + 10% = ₹665.50. The header holds ₹666.00.
--      ₹665.50 is corroborated three independent ways: the source quote
--      (tbl_quotes 296 / tbl_quote_items 1759, total_price 605.00 + TCS 10%),
--      the frozen approval payload (tbl_approval_instances 1102 carries
--      total_value 605 pre-globals), and the rendered PDF. The stored 666.00
--      is a whole-rupee rounding artefact of an older write path
--      (Math.round(665.5) = 666 rather than Math.round(665.5*100)/100 =
--      665.50); the PO was edited on 2026-06-24, long after it was drafted.
--      50 paise. Repairing it aligns the DB with the paperwork like every
--      other row here. If your reviewer would rather not move an `approved`
--      PO downward at all, delete PO 186 from Section C2 and change the
--      expected row count in the guard from 2 to 1 — the script will then
--      abort if anything else has shifted, which is the point.
--
-- ---------------------------------------------------------------------------
--  ORDER OF OPERATIONS
-- ---------------------------------------------------------------------------
--   1. Deploy the backend fix in app/models/purchaseOrderModel.js
--      (handleUpdatePO now calls pricingEngine.sumGlobalCharges).
--      ⚠️  WITHOUT IT, THE CLASS-2 ROWS RE-BREAK ON THE NEXT PO EDIT.  ⚠️
--      Class 1's root cause was already fixed in eeb66119; only Class 2 is
--      gated on this deploy. Repairing Class 1 early is safe.
--   2. Smoke-test: edit any PO that carries a global charge with an
--      additional_tax and confirm total_value still includes the tax leg.
--      (tests/services/po.globalChargeRecompute.test.js pins this.)
--   3. Run SECTION A (read-only). Keep the output — it is the audit trail.
--   4. Run SECTION B (read-only). EVERY assertion must return 0 rows.
--      If any returns a row, STOP: an assumption in this script is wrong.
--   5. Capture before-state (SECTION A4) to a file, and confirm
--      scripts/repair_po_total_value_revert.sql matches it.
--   6. Run SECTION C inside the transaction shown. The DO block aborts the
--      whole thing unless EXACTLY the expected number of rows change.
--   7. Run SECTION D (read-only). All counts must be 0.
--
--  Verified read-only against hospitality_main on 2026-08-01.
--
--  Rounding note: the recompute uses round(x, 2), which is half-away-from-zero
--  in Postgres and matches JS `Math.round(x*100)/100` for the positive values
--  involved here.
--
--  Side effect: Section C also stamps `updated_at = now()` on the 30 rows, so
--  the change is attributable. Checked: no listing, dashboard or cron orders
--  or filters POs by tbl_rfq_purchase_order.updated_at, so this does not
--  reshuffle any user-facing view. If you would rather leave the column
--  untouched, drop `updated_at = now()` from both UPDATEs — the row-count
--  guards are unaffected. Note the revert script reads total_value, not
--  updated_at, to decide what is revertable.
--
--  Not covered here: this repair does not touch tbl_purchase_order_product.
--  Every line total is already correct — only the header aggregate was wrong,
--  which is why SUM(total_price) is a trustworthy source for Class 1.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- SECTION A — IDENTIFY (read-only). Run first; keep the output.
-- ---------------------------------------------------------------------------

-- The canonical recompute, expressed once here and repeated verbatim below.
-- It mirrors app/services/pricingEngine.js exactly:
--   normalizeGlobalCharge : amount      = charge.amount ?? charge.tax
--                           amount_mode = charge.amount_mode ?? charge.tax_mode
--                                                            ?? 'percentage'
--   applyChargeMode       : percentage → base * v / 100 ; anything else → v
--   sumGlobalCharges      : Σ ( amount + additional_tax-on-that-amount )
--   grand total           : round(line_subtotal + Σ, 2)

-- ---- A1. CLASS 1 — no global charges, header frozen at the first line ------
WITH lines AS (
    SELECT purchase_order_id AS po_id,
           COALESCE(SUM(total_price), 0)::numeric AS line_sum,
           COUNT(*)::int                          AS n_lines
      FROM tbl_purchase_order_product
     GROUP BY purchase_order_id
)
SELECT po.id                            AS po_id,
       po.po_number,
       po.status,
       l.n_lines,
       po.total_value                   AS stored_value,
       l.line_sum                       AS correct_value,
       l.line_sum - po.total_value      AS understated_by,
       po.created_at::date              AS created_on,
       po.updated_at::date              AS last_edited_on
  FROM tbl_rfq_purchase_order po
  JOIN lines l ON l.po_id = po.id
 WHERE jsonb_array_length(
         CASE WHEN jsonb_typeof(po.global_charges) = 'array'
              THEN po.global_charges ELSE '[]'::jsonb END) = 0
   AND round(l.line_sum, 2) <> po.total_value
 ORDER BY (l.line_sum - po.total_value) DESC;
-- expect: 28 rows, every `understated_by` positive,
--         SUM(understated_by) = 57656182.00


-- ---- A2. CLASS 2 — PO carries global charges; recompute disagrees ---------
WITH lines AS (
    SELECT purchase_order_id AS po_id,
           COALESCE(SUM(total_price), 0)::numeric AS line_sum,
           COUNT(*)::int                          AS n_lines
      FROM tbl_purchase_order_product
     GROUP BY purchase_order_id
), calc AS (
    SELECT po.id, po.po_number, po.status, po.total_value, po.global_charges,
           po.created_at, po.updated_at, l.line_sum, l.n_lines,
           COALESCE((
             SELECT SUM(
               -- charge amount, on the line subtotal
               (CASE WHEN COALESCE(e->>'amount_mode', e->>'tax_mode', 'percentage') = 'percentage'
                     THEN l.line_sum * COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) / 100
                     ELSE            COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0)
                END)
               -- + additional_tax, on that charge amount (the Class-2 defect)
             + (CASE WHEN COALESCE(e->>'additional_tax_mode', 'percentage') = 'percentage'
                     THEN (CASE WHEN COALESCE(e->>'amount_mode', e->>'tax_mode', 'percentage') = 'percentage'
                                THEN l.line_sum * COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) / 100
                                ELSE            COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0)
                           END)
                          * COALESCE(NULLIF(e->>'additional_tax', '')::numeric, 0) / 100
                     ELSE COALESCE(NULLIF(e->>'additional_tax', '')::numeric, 0)
                END))
               FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(po.global_charges) = 'array'
                           THEN po.global_charges ELSE '[]'::jsonb END) e
           ), 0) AS gc_total
      FROM tbl_rfq_purchase_order po
      JOIN lines l ON l.po_id = po.id
     WHERE jsonb_array_length(
             CASE WHEN jsonb_typeof(po.global_charges) = 'array'
                  THEN po.global_charges ELSE '[]'::jsonb END) > 0
)
SELECT id                                  AS po_id,
       po_number,
       status,
       n_lines,
       line_sum,
       round(gc_total, 2)                  AS global_charges_total,
       total_value                         AS stored_value,
       round(line_sum + gc_total, 2)       AS correct_value,
       round(line_sum + gc_total, 2) - total_value AS delta,
       created_at::date                    AS created_on,
       updated_at::date                    AS last_edited_on,
       global_charges
  FROM calc
 WHERE round(line_sum + gc_total, 2) <> total_value
 ORDER BY id;
-- expect: 2 rows
--   po 186 → stored 666.00     correct 665.50    delta  -0.50
--   po 440 → stored 18124.73   correct 18338.16  delta +213.43
--   net delta = +212.93


-- ---- A3. Headline impact --------------------------------------------------
WITH lines AS (
    SELECT purchase_order_id AS po_id, COALESCE(SUM(total_price), 0)::numeric AS line_sum
      FROM tbl_purchase_order_product GROUP BY purchase_order_id
), calc AS (
    SELECT po.id, po.total_value, l.line_sum,
           jsonb_array_length(CASE WHEN jsonb_typeof(po.global_charges) = 'array'
                                   THEN po.global_charges ELSE '[]'::jsonb END) > 0 AS has_gc,
           COALESCE((
             SELECT SUM(
               (CASE WHEN COALESCE(e->>'amount_mode', e->>'tax_mode', 'percentage') = 'percentage'
                     THEN l.line_sum * COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) / 100
                     ELSE            COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) END)
             + (CASE WHEN COALESCE(e->>'additional_tax_mode', 'percentage') = 'percentage'
                     THEN (CASE WHEN COALESCE(e->>'amount_mode', e->>'tax_mode', 'percentage') = 'percentage'
                                THEN l.line_sum * COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) / 100
                                ELSE            COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) END)
                          * COALESCE(NULLIF(e->>'additional_tax', '')::numeric, 0) / 100
                     ELSE COALESCE(NULLIF(e->>'additional_tax', '')::numeric, 0) END))
               FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(po.global_charges) = 'array'
                           THEN po.global_charges ELSE '[]'::jsonb END) e
           ), 0) AS gc_total
      FROM tbl_rfq_purchase_order po
      JOIN lines l ON l.po_id = po.id
)
SELECT count(*) FILTER (WHERE NOT has_gc AND round(line_sum + gc_total, 2) <> total_value) AS class1_pos,
       COALESCE(sum(round(line_sum + gc_total, 2) - total_value)
                FILTER (WHERE NOT has_gc AND round(line_sum + gc_total, 2) <> total_value), 0) AS class1_delta,
       count(*) FILTER (WHERE has_gc AND round(line_sum + gc_total, 2) <> total_value) AS class2_pos,
       COALESCE(sum(round(line_sum + gc_total, 2) - total_value)
                FILTER (WHERE has_gc AND round(line_sum + gc_total, 2) <> total_value), 0) AS class2_delta,
       sum(total_value)                                       AS po_book_before,
       sum(round(line_sum + gc_total, 2))                     AS po_book_after
  FROM calc;
-- expect: 28 | 57656182.00 | 2 | 212.93 | 150580920.31 | 208237315.24


-- ---- A4. BEFORE-STATE CAPTURE (run from psql, writes a local file) --------
-- Keeps an exact, machine-readable snapshot of every row this repair touches.
-- scripts/repair_po_total_value_revert.sql already holds the same values as
-- ready-to-run UPDATEs; this file is the belt to that braces.
--
--   \copy (SELECT po.id, po.po_number, po.status, po.total_value, now()
--            FROM tbl_rfq_purchase_order po
--           WHERE po.id IN (7,60,61,66,71,72,76,77,91,92,93,94,95,98,99,100,
--                           101,106,110,111,113,114,117,124,130,174,175,184,
--                           186,440)
--           ORDER BY po.id)
--     TO 'po_total_value_before.csv' WITH CSV HEADER
--
-- expect: 30 data rows.


-- ---------------------------------------------------------------------------
-- SECTION B — SAFETY ASSERTIONS (read-only). EVERY ONE MUST RETURN 0 ROWS.
-- If any returns a row, STOP and re-triage: an assumption here is wrong.
-- ---------------------------------------------------------------------------

-- ---- B1. No Class-1 PO may move DOWN. ------------------------------------
-- Class 1's premise is "the header froze before later lines were added", so
-- every correction must be an increase. A decrease would mean lines were
-- REMOVED without the header following, which is a different defect needing a
-- different fix — never a blind overwrite.
WITH lines AS (
    SELECT purchase_order_id AS po_id, COALESCE(SUM(total_price), 0)::numeric AS line_sum
      FROM tbl_purchase_order_product GROUP BY purchase_order_id
)
SELECT po.id AS po_id, po.po_number, po.total_value AS stored_value,
       l.line_sum AS would_become, l.line_sum - po.total_value AS delta
  FROM tbl_rfq_purchase_order po
  JOIN lines l ON l.po_id = po.id
 WHERE jsonb_array_length(
         CASE WHEN jsonb_typeof(po.global_charges) = 'array'
              THEN po.global_charges ELSE '[]'::jsonb END) = 0
   AND round(l.line_sum, 2) < po.total_value;
-- expect: 0 rows


-- ---- B2. No PO anywhere may move down by more than ₹1. -------------------
-- The single tolerated decrease is PO 186 at −₹0.50 (documented in the header:
-- a whole-rupee rounding artefact, corroborated by the quote, the frozen
-- approval payload and the PDF). Anything larger means the recompute
-- disagrees with reality, not that the stored value is stale.
WITH lines AS (
    SELECT purchase_order_id AS po_id, COALESCE(SUM(total_price), 0)::numeric AS line_sum
      FROM tbl_purchase_order_product GROUP BY purchase_order_id
), calc AS (
    SELECT po.id, po.po_number, po.total_value, l.line_sum,
           COALESCE((
             SELECT SUM(
               (CASE WHEN COALESCE(e->>'amount_mode', e->>'tax_mode', 'percentage') = 'percentage'
                     THEN l.line_sum * COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) / 100
                     ELSE            COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) END)
             + (CASE WHEN COALESCE(e->>'additional_tax_mode', 'percentage') = 'percentage'
                     THEN (CASE WHEN COALESCE(e->>'amount_mode', e->>'tax_mode', 'percentage') = 'percentage'
                                THEN l.line_sum * COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) / 100
                                ELSE            COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) END)
                          * COALESCE(NULLIF(e->>'additional_tax', '')::numeric, 0) / 100
                     ELSE COALESCE(NULLIF(e->>'additional_tax', '')::numeric, 0) END))
               FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(po.global_charges) = 'array'
                           THEN po.global_charges ELSE '[]'::jsonb END) e
           ), 0) AS gc_total
      FROM tbl_rfq_purchase_order po
      JOIN lines l ON l.po_id = po.id
)
SELECT id AS po_id, po_number, total_value AS stored_value,
       round(line_sum + gc_total, 2) AS would_become,
       round(line_sum + gc_total, 2) - total_value AS delta
  FROM calc
 WHERE total_value - round(line_sum + gc_total, 2) > 1;
-- expect: 0 rows


-- ---- B3. No PO in the repair set may be line-less. ------------------------
-- A header with zero product rows would be "repaired" to 0 and wipe a real
-- commitment. (Production currently has no line-less POs at all.)
SELECT po.id AS po_id, po.po_number, po.status, po.total_value
  FROM tbl_rfq_purchase_order po
 WHERE NOT EXISTS (SELECT 1 FROM tbl_purchase_order_product p
                    WHERE p.purchase_order_id = po.id);
-- expect: 0 rows


-- ---- B4. Every global-charge number must actually be a number. -----------
-- The recompute casts these to numeric. A junk value ('N/A', '12%') would
-- abort the repair mid-transaction; catch it here instead, read-only.
SELECT po.id AS po_id, po.po_number, e AS offending_charge
  FROM tbl_rfq_purchase_order po
  CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(po.global_charges) = 'array'
             THEN po.global_charges ELSE '[]'::jsonb END) e
 WHERE COALESCE(COALESCE(e->>'amount', e->>'tax'), '') !~ '^-?[0-9]*\.?[0-9]*$'
    OR COALESCE(e->>'additional_tax', '')            !~ '^-?[0-9]*\.?[0-9]*$';
-- expect: 0 rows


-- ---- B5. The repair set must be exactly the 30 POs enumerated in A4. -----
-- Guards against drift between triage and execution: if a PO was edited (and
-- thereby fixed, or newly broken) between the two, this lights up.
WITH lines AS (
    SELECT purchase_order_id AS po_id, COALESCE(SUM(total_price), 0)::numeric AS line_sum
      FROM tbl_purchase_order_product GROUP BY purchase_order_id
), calc AS (
    SELECT po.id, po.total_value, l.line_sum,
           COALESCE((
             SELECT SUM(
               (CASE WHEN COALESCE(e->>'amount_mode', e->>'tax_mode', 'percentage') = 'percentage'
                     THEN l.line_sum * COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) / 100
                     ELSE            COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) END)
             + (CASE WHEN COALESCE(e->>'additional_tax_mode', 'percentage') = 'percentage'
                     THEN (CASE WHEN COALESCE(e->>'amount_mode', e->>'tax_mode', 'percentage') = 'percentage'
                                THEN l.line_sum * COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) / 100
                                ELSE            COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) END)
                          * COALESCE(NULLIF(e->>'additional_tax', '')::numeric, 0) / 100
                     ELSE COALESCE(NULLIF(e->>'additional_tax', '')::numeric, 0) END))
               FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(po.global_charges) = 'array'
                           THEN po.global_charges ELSE '[]'::jsonb END) e
           ), 0) AS gc_total
      FROM tbl_rfq_purchase_order po
      JOIN lines l ON l.po_id = po.id
)
SELECT id AS unexpected_po_id, total_value, round(line_sum + gc_total, 2) AS would_become
  FROM calc
 WHERE round(line_sum + gc_total, 2) <> total_value
   AND id NOT IN (7,60,61,66,71,72,76,77,91,92,93,94,95,98,99,100,101,106,110,
                  111,113,114,117,124,130,174,175,184,186,440);
-- expect: 0 rows
-- (and the mirror check — a PO on the list that is no longer broken — is
--  caught by the exact row-count guards in Section C.)


-- ===========================================================================
-- SECTION C — REPAIR.  ⚠️  DO NOT RUN UNTIL SECTIONS A + B ARE CLEAN.  ⚠️
--
-- Self-verifying: the DO block below aborts the entire transaction unless
-- EXACTLY 28 Class-1 rows and EXACTLY 2 Class-2 rows change. A wrong count
-- means the world moved between triage and execution — the correct response
-- is to roll back and re-triage, never to commit "close enough".
--
-- Run it exactly like this:
--
--     BEGIN;
--     \i scripts/repair_po_total_value.sql   -- (or paste the DO block)
--     -- read the NOTICE lines; they must say 28 and 2
--     COMMIT;                                -- or ROLLBACK;
--
-- The DO block is idempotent in the safe direction: re-running it after a
-- successful commit updates 0 rows and therefore RAISES, rather than silently
-- doing nothing. That is deliberate — it tells you the repair already ran.
-- ===========================================================================

DO $repair$
DECLARE
    v_class1 integer;
    v_class2 integer;
BEGIN

    -- ---- C1. CLASS 1 — no global charges: header := SUM(line totals) -----
    WITH lines AS (
        SELECT purchase_order_id AS po_id,
               COALESCE(SUM(total_price), 0)::numeric AS line_sum
          FROM tbl_purchase_order_product
         GROUP BY purchase_order_id
    ), target AS (
        SELECT po.id AS po_id, round(l.line_sum, 2) AS correct_value
          FROM tbl_rfq_purchase_order po
          JOIN lines l ON l.po_id = po.id
         WHERE jsonb_array_length(
                 CASE WHEN jsonb_typeof(po.global_charges) = 'array'
                      THEN po.global_charges ELSE '[]'::jsonb END) = 0
           AND round(l.line_sum, 2) <> po.total_value
           -- Belt-and-braces: refuse to move a Class-1 header downward even
           -- if B1 was skipped.
           AND round(l.line_sum, 2) > po.total_value
    )
    UPDATE tbl_rfq_purchase_order po
       SET total_value = t.correct_value,
           updated_at  = now()
      FROM target t
     WHERE t.po_id = po.id;

    GET DIAGNOSTICS v_class1 = ROW_COUNT;
    RAISE NOTICE 'Class 1 (header frozen at first line): % rows updated', v_class1;
    IF v_class1 <> 28 THEN
        RAISE EXCEPTION
          'ABORT: Class 1 updated % rows, expected exactly 28. Nothing has been committed. Re-run Section A and re-triage.',
          v_class1;
    END IF;

    -- ---- C2. CLASS 2 — with global charges: header := engine recompute ---
    WITH lines AS (
        SELECT purchase_order_id AS po_id,
               COALESCE(SUM(total_price), 0)::numeric AS line_sum
          FROM tbl_purchase_order_product
         GROUP BY purchase_order_id
    ), calc AS (
        SELECT po.id AS po_id, po.total_value, l.line_sum,
               COALESCE((
                 SELECT SUM(
                   (CASE WHEN COALESCE(e->>'amount_mode', e->>'tax_mode', 'percentage') = 'percentage'
                         THEN l.line_sum * COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) / 100
                         ELSE            COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) END)
                 + (CASE WHEN COALESCE(e->>'additional_tax_mode', 'percentage') = 'percentage'
                         THEN (CASE WHEN COALESCE(e->>'amount_mode', e->>'tax_mode', 'percentage') = 'percentage'
                                    THEN l.line_sum * COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) / 100
                                    ELSE            COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) END)
                              * COALESCE(NULLIF(e->>'additional_tax', '')::numeric, 0) / 100
                         ELSE COALESCE(NULLIF(e->>'additional_tax', '')::numeric, 0) END))
                   FROM jsonb_array_elements(
                          CASE WHEN jsonb_typeof(po.global_charges) = 'array'
                               THEN po.global_charges ELSE '[]'::jsonb END) e
               ), 0) AS gc_total
          FROM tbl_rfq_purchase_order po
          JOIN lines l ON l.po_id = po.id
         WHERE jsonb_array_length(
                 CASE WHEN jsonb_typeof(po.global_charges) = 'array'
                      THEN po.global_charges ELSE '[]'::jsonb END) > 0
    ), target AS (
        SELECT po_id, round(line_sum + gc_total, 2) AS correct_value
          FROM calc
         WHERE round(line_sum + gc_total, 2) <> total_value
           -- Hard ceiling on downward movement, mirroring assertion B2.
           AND total_value - round(line_sum + gc_total, 2) <= 1
    )
    UPDATE tbl_rfq_purchase_order po
       SET total_value = t.correct_value,
           updated_at  = now()
      FROM target t
     WHERE t.po_id = po.id;

    GET DIAGNOSTICS v_class2 = ROW_COUNT;
    RAISE NOTICE 'Class 2 (global-charge recompute, incl. additional_tax): % rows updated', v_class2;
    IF v_class2 <> 2 THEN
        RAISE EXCEPTION
          'ABORT: Class 2 updated % rows, expected exactly 2 (po 186 and po 440). Nothing has been committed. Re-run Section A and re-triage.',
          v_class2;
    END IF;

    RAISE NOTICE 'OK: % + % = % PO headers realigned. Review SECTION D, then COMMIT.',
                 v_class1, v_class2, v_class1 + v_class2;
END
$repair$;


-- ---------------------------------------------------------------------------
-- SECTION D — POST-REPAIR VERIFICATION (read-only). All must return 0 / match.
-- ---------------------------------------------------------------------------

-- ---- D1. Nothing left where the recompute disagrees with the header. -----
WITH lines AS (
    SELECT purchase_order_id AS po_id, COALESCE(SUM(total_price), 0)::numeric AS line_sum
      FROM tbl_purchase_order_product GROUP BY purchase_order_id
), calc AS (
    SELECT po.id, po.total_value, l.line_sum,
           COALESCE((
             SELECT SUM(
               (CASE WHEN COALESCE(e->>'amount_mode', e->>'tax_mode', 'percentage') = 'percentage'
                     THEN l.line_sum * COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) / 100
                     ELSE            COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) END)
             + (CASE WHEN COALESCE(e->>'additional_tax_mode', 'percentage') = 'percentage'
                     THEN (CASE WHEN COALESCE(e->>'amount_mode', e->>'tax_mode', 'percentage') = 'percentage'
                                THEN l.line_sum * COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) / 100
                                ELSE            COALESCE(NULLIF(COALESCE(e->>'amount', e->>'tax'), '')::numeric, 0) END)
                          * COALESCE(NULLIF(e->>'additional_tax', '')::numeric, 0) / 100
                     ELSE COALESCE(NULLIF(e->>'additional_tax', '')::numeric, 0) END))
               FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(po.global_charges) = 'array'
                           THEN po.global_charges ELSE '[]'::jsonb END) e
           ), 0) AS gc_total
      FROM tbl_rfq_purchase_order po
      JOIN lines l ON l.po_id = po.id
)
SELECT count(*) AS pos_still_disagreeing_with_the_engine
  FROM calc
 WHERE round(line_sum + gc_total, 2) <> total_value;
-- expect: 0


-- ---- D2. The 30 repaired rows, with their new values. --------------------
SELECT id AS po_id, po_number, status, total_value, updated_at
  FROM tbl_rfq_purchase_order
 WHERE id IN (7,60,61,66,71,72,76,77,91,92,93,94,95,98,99,100,101,106,110,111,
              113,114,117,124,130,174,175,184,186,440)
 ORDER BY id;
-- expect: 30 rows; po 186 = 665.50, po 440 = 18338.16,
--         po 98 = 24871086.00, po 99 = 15371791.00


-- ---- D3. The PO book. ----------------------------------------------------
SELECT count(*) AS pos, sum(total_value) AS po_book FROM tbl_rfq_purchase_order;
-- expect: 385 | 208237315.24    (was 385 | 150580920.31)


-- ---- D4. No PO carries a total that is impossible for its lines. ---------
-- Sanity net: after the repair, a header must never be BELOW its own line sum
-- (global charges only ever add).
WITH lines AS (
    SELECT purchase_order_id AS po_id, COALESCE(SUM(total_price), 0)::numeric AS line_sum
      FROM tbl_purchase_order_product GROUP BY purchase_order_id
)
SELECT count(*) AS pos_below_their_own_line_sum
  FROM tbl_rfq_purchase_order po
  JOIN lines l ON l.po_id = po.id
 WHERE po.total_value < round(l.line_sum, 2) - 0.01;
-- expect: 0


-- ---------------------------------------------------------------------------
-- ROLLING BACK AFTER A COMMIT
-- ---------------------------------------------------------------------------
-- scripts/repair_po_total_value_revert.sql restores all 30 rows to the exact
-- values they held on 2026-08-01, one explicit UPDATE per PO id, wrapped in
-- its own transaction with the same 30-row guard. Use it only if the repair
-- itself is judged wrong — it does NOT undo any legitimate PO edit made after
-- the repair, so check tbl_rfq_purchase_order.updated_at before running it.
-- ---------------------------------------------------------------------------
