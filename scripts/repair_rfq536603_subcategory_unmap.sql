-- ============================================================================
-- Repair: RFQ 536603 vendors short on products after a sub-category removal
--
-- Cause (RCA 2026-09-17): removing a FREE sub-category from a vendor's
-- subscription runs _unmapProductsForCategories (hospitalityController.js:112)
-- which HARD DELETES every product-variant mapping under that sub-category,
-- even though the vendor still holds the PAID parent category. The parent
-- covers those products everywhere else in the system (registration mapping,
-- new-product mapping, and the RFQ eligibility gate, which only reads
-- item_type='category'), so the deletion is the only place a sub-category
-- filters anything -- and only for products that existed at removal time.
--
-- This script repairs RFQ 536603 ONLY. The platform-wide backfill
-- (~22.3k mappings across 58 vendors) ships with the code fix.
--
-- Restores, for the 11 products on RFQ 536603:
--   1. tbl_product_variant_vendor_mapping rows for vendors who still hold an
--      ACTIVE parent category subscription and a hotel-6 subscription, whose
--      mapping is missing only because they removed the sub-category.
--   2. tbl_rfq_product_vendors rows, mirroring hospitalityModel.addVendorToRfq
--      (same NOT EXISTS + approved-PO guards).
--
-- Expected: 18 mapping rows + 18 RFQ-vendor rows across 6 vendors
--           (521, 572, 579, 634, 721, 908). Vendor 572 is not on the RFQ at
--           all today and gains 1 product (MEMORY CARD).
--
-- Idempotent: re-running inserts nothing. No DELETEs, no UPDATEs.
-- No emails are sent. Vendors see the products on their next page load.
--
-- Dry run:  psql ... -f this_file.sql -v commit=0   (default -- rolls back)
-- Execute:  psql ... -f this_file.sql -v commit=1
-- ============================================================================

\set ON_ERROR_STOP on
\if :{?commit} \else \set commit 0 \endif

BEGIN;

-- Eligible (vendor, variant) pairs. Recomputed from the RFQ number so the
-- script carries no hard-coded vendor or variant ids.
CREATE TEMP TABLE repair_pairs ON COMMIT DROP AS
WITH rfq AS (
  SELECT id FROM tbl_rfq WHERE rfq_no = 536603
),
rfq_products AS (
  SELECT rp.product_variant_id AS vid,
         (SELECT array_agg(pc.category_id)
            FROM tbl_product_categories pc
           WHERE pc.product_id = pv.product_id) AS cats
    FROM rfq
    JOIN tbl_rfq_products rp ON rp.rfq_id = rfq.id
    JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
),
-- Passes the live eligibility gate on everything except the mapping:
-- active parent-category subscription + a subscription to the RFQ's hotel.
gated AS (
  SELECT DISTINCT s.vendor_id, p.vid, p.cats
    FROM rfq_products p
    JOIN tbl_vendor_hotel_category_subscription s
      ON s.item_type = 'category'
     AND s.item_id = ANY(p.cats)
     AND s.status = 'active'
    JOIN tbl_users u
      ON u.id = s.vendor_id AND u.status = 1 AND u.user_type = 3
   WHERE EXISTS (
     SELECT 1
       FROM rfq
       JOIN tbl_rfq_hotel_mappings hm ON hm.rfq_id = rfq.id
       JOIN tbl_vendor_hotel_category_subscription h
         ON h.vendor_id = s.vendor_id
        AND h.item_type = 'hotel'
        AND h.item_id = hm.hotel_id
        AND h.status IN ('active', 'expired')
   )
)
SELECT g.vendor_id, g.vid AS product_variant_id
  FROM gated g
 WHERE NOT EXISTS (                      -- mapping is gone
   SELECT 1 FROM tbl_product_variant_vendor_mapping m
    WHERE m.vendor_id = g.vendor_id
      AND m.product_variant_id = g.vid
      AND m.status = true AND m.is_approved = true
 )
   AND EXISTS (                          -- ...and a removed sub-category is why
   SELECT 1 FROM tbl_vendor_hotel_category_subscription x
    WHERE x.vendor_id = g.vendor_id
      AND x.item_type = 'subcategory'
      AND x.item_id = ANY(g.cats)
      AND x.cancelled_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM tbl_vendor_hotel_category_subscription y
         WHERE y.vendor_id = x.vendor_id
           AND y.item_type = 'subcategory'
           AND y.item_id = x.item_id
           AND y.status = 'active'
      )
 );

\echo '--- pairs to repair (expected 18 across 6 vendors) ---'
SELECT vendor_id, count(*) AS products FROM repair_pairs GROUP BY 1 ORDER BY 1;

-- 1. Restore the product mappings. Column set and values mirror
--    productModel.bulkInsertVariantVendorMappings + autoApproveVariantMappings,
--    which is what the vendor's own "re-add the sub-category" click would run.
WITH ins AS (
  INSERT INTO tbl_product_variant_vendor_mapping
    (product_variant_id, vendor_id, created_at, updated_at,
     status, is_approved, created_by, updated_by)
  SELECT rp.product_variant_id, rp.vendor_id, NOW(), NOW(),
         true, true, rp.vendor_id, rp.vendor_id
    FROM repair_pairs rp
   WHERE NOT EXISTS (
     SELECT 1 FROM tbl_product_variant_vendor_mapping m
      WHERE m.vendor_id = rp.vendor_id
        AND m.product_variant_id = rp.product_variant_id
   )
  RETURNING 1
)
SELECT count(*) AS mappings_inserted FROM ins;

-- Any mapping row that exists but is switched off gets re-enabled (belt and
-- braces: the unmap path deletes, but an older admin flow could have disabled).
WITH upd AS (
  UPDATE tbl_product_variant_vendor_mapping m
     SET status = true, is_approved = true, updated_at = NOW(), updated_by = m.vendor_id
    FROM repair_pairs rp
   WHERE m.vendor_id = rp.vendor_id
     AND m.product_variant_id = rp.product_variant_id
     AND (m.status IS DISTINCT FROM true OR m.is_approved IS DISTINCT FROM true)
  RETURNING 1
)
SELECT count(*) AS mappings_reenabled FROM upd;

-- 2. Add the vendors to the RFQ's products. Mirrors
--    hospitalityModel.addVendorToRfq, including the approved-PO skip.
WITH rfq AS (
  SELECT id FROM tbl_rfq WHERE rfq_no = 536603
), ins AS (
  INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
  SELECT rp.rfq_id, rp.product_variant_id, v.vendor_id, rp.variant
    FROM rfq
    JOIN tbl_rfq_products rp ON rp.rfq_id = rfq.id
    JOIN repair_pairs v ON v.product_variant_id = rp.product_variant_id
   WHERE EXISTS (
     SELECT 1 FROM tbl_product_variant_vendor_mapping m
      WHERE m.product_variant_id = rp.product_variant_id
        AND m.vendor_id = v.vendor_id
        AND m.status = true AND m.is_approved = true
   )
     AND NOT EXISTS (
     SELECT 1 FROM tbl_rfq_product_vendors rpv
      WHERE rpv.rfq_id = rp.rfq_id
        AND rpv.product_variant_id = rp.product_variant_id
        AND rpv.variant = rp.variant
        AND rpv.user_id = v.vendor_id
   )
     AND NOT EXISTS (
     SELECT 1 FROM tbl_purchase_order_product pop
       JOIN tbl_rfq_purchase_order po ON po.id = pop.purchase_order_id
      WHERE pop.rfq_product_id = rp.id
        AND po.status IN ('approved', 'sent', 'GRN', 'completed')
   )
  RETURNING 1
)
SELECT count(*) AS rfq_vendor_rows_inserted FROM ins;

-- 3. Verify: products visible per affected vendor (11 is the full RFQ;
--    908 should reach 10 -- MEMORY CARD is IT, which they never subscribed to).
\echo '--- products visible per affected vendor after repair ---'
SELECT v.user_id AS vendor_id, u.name, count(DISTINCT v.product_variant_id) AS products_visible
  FROM tbl_rfq_product_vendors v
  JOIN tbl_users u ON u.id = v.user_id
 WHERE v.rfq_id = (SELECT id FROM tbl_rfq WHERE rfq_no = 536603)
   AND v.user_id IN (SELECT DISTINCT vendor_id FROM repair_pairs)
 GROUP BY 1, 2 ORDER BY 1;

\echo '--- remaining gaps on this RFQ from this cause (expect 0) ---'
SELECT count(*) AS remaining FROM repair_pairs rp
 WHERE NOT EXISTS (
   SELECT 1 FROM tbl_rfq_product_vendors v
    WHERE v.rfq_id = (SELECT id FROM tbl_rfq WHERE rfq_no = 536603)
      AND v.user_id = rp.vendor_id
      AND v.product_variant_id = rp.product_variant_id
 );

\if :commit
  COMMIT;
  \echo '*** COMMITTED ***'
\else
  ROLLBACK;
  \echo '*** DRY RUN -- rolled back. Re-run with -v commit=1 to apply. ***'
\endif
