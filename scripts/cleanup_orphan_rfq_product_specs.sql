-- ===========================================================================
--  DATA CLEANUP — spec rows that belong to no product
-- ===========================================================================
--
--  ⚠️  DEPLOY THE CODE FIX FIRST. ⚠️
--
--  This script is a one-off mop-up. It is only permanent once the guard in
--    app/controllers/rfq/rfqController.js  (saveRfqDraft: refuses to write
--                                           specs for a product with no row)
--  is live. Without it the RFQ wizard keeps minting fresh orphans and you will
--  be running this again next week.
--
--  It is also only SAFE once the gate fix in
--    app/models/rfqModel.js  (checkRFQCompletion: per-product matching)
--  is live. The old gate compared counts, so deleting rows here shifts the
--  qualified count and would flip some RFQs from blocked to passing and others
--  the other way, unpredictably. The new gate matches each product to its own
--  specs and ignores orphans entirely, which is what makes this deletion a
--  no-op for validation and purely a tidy-up.
--
--  Order of operations:
--    1. Deploy backend (rfqController.js + rfqModel.js).
--    2. Smoke-test: open a draft, add a product, set qty/unit, submit.
--    3. Run section A (identify) and eyeball the output.
--    4. Run section B or C inside the transaction shown.
--
-- ---------------------------------------------------------------------------
--  WHAT AN ORPHAN IS AND WHY IT HURTS
--
--  tbl_rfq_products_specs is keyed by (rfq_id, product_variant_id, variant)
--  rather than by tbl_rfq_products.id, so a spec row does not need a product
--  behind it to exist. When the product is gone — or was never created — the
--  spec rows survive on their own.
--
--  Nothing renders them: every product list is built FROM tbl_rfq_products, so
--  an orphan group is invisible in the UI. The buyer cannot see it, edit it or
--  delete it. But the old completion gate counted spec groups, so one ghost
--  group made the counts disagree and the RFQ could never be submitted again.
--
--  Production example (hospitality_main, read-only, 2026-08-08):
--    RFQ 610 "The Orchid Hotel Pune — Lights for swimming pool area"
--    26 products, all with a valid quantity and unit, but 27 qualifying spec
--    groups. The 27th was "LED STRIP" variant 4 (Qty 40, Unit RMT), written
--    2026-08-07 04:21, with no product row. The draft was unsubmittable and
--    there was nothing the buyer could click to fix it.
--
--  Measured on hospitality_main 2026-08-08:
--    31 orphan spec rows across 6 RFQs  (section B)
--    28 spec rows whose RFQ no longer exists at all (section C)
--     0 orphan rows in tbl_rfq_product_vendors
--     0 orphan rows in tbl_rfq_product_files
--
--  Both sections are safe to re-run: they delete by a NOT EXISTS predicate, so
--  a second run finds nothing.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  SECTION A — identify. Read-only. Run this first and read the output.
-- ---------------------------------------------------------------------------

-- A1. Orphan groups on RFQs that still exist, with the values about to go.
SELECT s.rfq_id,
       r.rfq_no,
       s.product_variant_id,
       s.variant,
       COALESCE(pv.name, '(no catalogue row)') AS product_name,
       count(*)                                          AS spec_rows,
       string_agg(s.title || '=' || btrim(s.value), ', ' ORDER BY s.title) AS values_being_deleted,
       min(s.created_at)                                 AS first_written
  FROM tbl_rfq_products_specs s
  JOIN tbl_rfq r  ON r.id = s.rfq_id
  LEFT JOIN tbl_product_variant pv ON pv.id = s.product_variant_id
 WHERE NOT EXISTS (
         SELECT 1 FROM tbl_rfq_products p
          WHERE p.rfq_id             = s.rfq_id
            AND p.product_variant_id = s.product_variant_id
            AND p.variant IS NOT DISTINCT FROM s.variant)
 GROUP BY s.rfq_id, r.rfq_no, s.product_variant_id, s.variant, pv.name
 ORDER BY s.rfq_id, s.product_variant_id, s.variant;

-- A2. Spec rows whose RFQ is gone entirely.
SELECT s.rfq_id, count(*) AS spec_rows
  FROM tbl_rfq_products_specs s
 WHERE NOT EXISTS (SELECT 1 FROM tbl_rfq r WHERE r.id = s.rfq_id)
 GROUP BY s.rfq_id
 ORDER BY s.rfq_id;

-- A3. Safety net — no product may LOSE its specs to this script. Must be 0.
--     If this returns anything, stop: the NOT EXISTS predicate is matching
--     rows that a live product depends on and something is wrong.
SELECT count(*) AS must_be_zero
  FROM tbl_rfq_products_specs s
  JOIN tbl_rfq_products p
    ON p.rfq_id             = s.rfq_id
   AND p.product_variant_id = s.product_variant_id
   AND p.variant IS NOT DISTINCT FROM s.variant
 WHERE NOT EXISTS (
         SELECT 1 FROM tbl_rfq_products p2
          WHERE p2.rfq_id             = s.rfq_id
            AND p2.product_variant_id = s.product_variant_id
            AND p2.variant IS NOT DISTINCT FROM s.variant);


-- ---------------------------------------------------------------------------
--  SECTION B — delete orphan specs on RFQs that still exist.
--
--  Run inside the transaction. Check the reported counts against section A
--  before COMMIT; ROLLBACK if they disagree.
-- ---------------------------------------------------------------------------

BEGIN;

-- Keep a copy of exactly what we removed. Survives the transaction, so if a
-- deletion turns out to be wrong the rows can be re-inserted from here.
CREATE TABLE IF NOT EXISTS tbl_rfq_products_specs_orphan_backup (
  LIKE public.tbl_rfq_products_specs INCLUDING DEFAULTS
);
ALTER TABLE tbl_rfq_products_specs_orphan_backup
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT now();

INSERT INTO tbl_rfq_products_specs_orphan_backup
     (rfq_id, product_variant_id, title, value, id, variant, sheet_id, created_at, updated_at)
SELECT s.rfq_id, s.product_variant_id, s.title, s.value, s.id, s.variant, s.sheet_id,
       s.created_at, s.updated_at
  FROM tbl_rfq_products_specs s
  JOIN tbl_rfq r ON r.id = s.rfq_id
 WHERE NOT EXISTS (
         SELECT 1 FROM tbl_rfq_products p
          WHERE p.rfq_id             = s.rfq_id
            AND p.product_variant_id = s.product_variant_id
            AND p.variant IS NOT DISTINCT FROM s.variant);

DELETE FROM tbl_rfq_products_specs s
 USING tbl_rfq r
 WHERE r.id = s.rfq_id
   AND NOT EXISTS (
         SELECT 1 FROM tbl_rfq_products p
          WHERE p.rfq_id             = s.rfq_id
            AND p.product_variant_id = s.product_variant_id
            AND p.variant IS NOT DISTINCT FROM s.variant);

-- Expect 0 after the delete.
SELECT count(*) AS remaining_orphans_on_live_rfqs
  FROM tbl_rfq_products_specs s
  JOIN tbl_rfq r ON r.id = s.rfq_id
 WHERE NOT EXISTS (
         SELECT 1 FROM tbl_rfq_products p
          WHERE p.rfq_id             = s.rfq_id
            AND p.product_variant_id = s.product_variant_id
            AND p.variant IS NOT DISTINCT FROM s.variant);

-- Expect the same number of products as before — this must not touch them.
SELECT count(*) AS products_still_complete
  FROM tbl_rfq_products rp
 WHERE EXISTS (SELECT 1 FROM tbl_rfq_products_specs s
                WHERE s.rfq_id = rp.rfq_id
                  AND s.product_variant_id = rp.product_variant_id
                  AND s.variant IS NOT DISTINCT FROM rp.variant
                  AND lower(btrim(s.title)) = 'quantity')
   AND EXISTS (SELECT 1 FROM tbl_rfq_products_specs s
                WHERE s.rfq_id = rp.rfq_id
                  AND s.product_variant_id = rp.product_variant_id
                  AND s.variant IS NOT DISTINCT FROM rp.variant
                  AND lower(btrim(s.title)) = 'unit');

COMMIT;
-- ROLLBACK;   -- use this instead if the counts above do not match section A


-- ---------------------------------------------------------------------------
--  SECTION C — delete specs whose RFQ no longer exists.
--
--  Separate from section B on purpose: these belong to deleted RFQs and are
--  unrelated to the completion gate, so they can be left alone if you would
--  rather only fix the submit-blocking rows today.
-- ---------------------------------------------------------------------------

BEGIN;

INSERT INTO tbl_rfq_products_specs_orphan_backup
     (rfq_id, product_variant_id, title, value, id, variant, sheet_id, created_at, updated_at)
SELECT s.rfq_id, s.product_variant_id, s.title, s.value, s.id, s.variant, s.sheet_id,
       s.created_at, s.updated_at
  FROM tbl_rfq_products_specs s
 WHERE NOT EXISTS (SELECT 1 FROM tbl_rfq r WHERE r.id = s.rfq_id);

DELETE FROM tbl_rfq_products_specs s
 WHERE NOT EXISTS (SELECT 1 FROM tbl_rfq r WHERE r.id = s.rfq_id);

SELECT count(*) AS remaining_specs_for_missing_rfqs
  FROM tbl_rfq_products_specs s
 WHERE NOT EXISTS (SELECT 1 FROM tbl_rfq r WHERE r.id = s.rfq_id);

COMMIT;
-- ROLLBACK;


-- ---------------------------------------------------------------------------
--  SECTION D — verification sweep. Read-only. Run after B and C.
-- ---------------------------------------------------------------------------

-- D1. No orphans anywhere. Both must be 0.
SELECT 'orphans_on_live_rfqs' AS check, count(*) AS n
  FROM tbl_rfq_products_specs s JOIN tbl_rfq r ON r.id = s.rfq_id
 WHERE NOT EXISTS (SELECT 1 FROM tbl_rfq_products p
                    WHERE p.rfq_id = s.rfq_id
                      AND p.product_variant_id = s.product_variant_id
                      AND p.variant IS NOT DISTINCT FROM s.variant)
UNION ALL
SELECT 'specs_for_missing_rfqs', count(*)
  FROM tbl_rfq_products_specs s
 WHERE NOT EXISTS (SELECT 1 FROM tbl_rfq r WHERE r.id = s.rfq_id);

-- D2. Which open drafts would now pass the completion gate. Compare this to
--     the same query run BEFORE the cleanup: the numbers must be identical,
--     because the new gate never looked at orphans in the first place. If a
--     draft changes verdict here, the deletion removed something real.
SELECT count(*) FILTER (WHERE passes)     AS drafts_passing,
       count(*) FILTER (WHERE NOT passes) AS drafts_blocked
  FROM (
    SELECT rp.rfq_id,
           bool_and(
             EXISTS (SELECT 1 FROM tbl_rfq_products_specs s
                      WHERE s.rfq_id = rp.rfq_id
                        AND s.product_variant_id = rp.product_variant_id
                        AND s.variant IS NOT DISTINCT FROM rp.variant
                        AND lower(btrim(s.title)) = 'quantity'
                        AND CASE WHEN btrim(s.value) ~ '^\+?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
                                 THEN btrim(s.value)::float8 >= 0.1 ELSE FALSE END)
             AND
             EXISTS (SELECT 1 FROM tbl_rfq_products_specs s
                      WHERE s.rfq_id = rp.rfq_id
                        AND s.product_variant_id = rp.product_variant_id
                        AND s.variant IS NOT DISTINCT FROM rp.variant
                        AND lower(btrim(s.title)) = 'unit'
                        AND btrim(s.value) <> ''
                        AND upper(btrim(s.value)) NOT IN ('NA','N/A','NIL','NONE','NULL','-','--'))
           ) AS passes
      FROM tbl_rfq_products rp
      JOIN tbl_rfq r ON r.id = rp.rfq_id
     WHERE r.status = 1 AND r.is_published = 0
     GROUP BY rp.rfq_id) x;
