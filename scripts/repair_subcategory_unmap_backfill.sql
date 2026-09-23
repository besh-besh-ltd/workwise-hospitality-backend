-- ============================================================================
-- Platform-wide repair: product mappings deleted by a sub-category removal
--
-- Companion to the code fix in hospitalityController.js
-- (`_unmapProductsForCategories` now keeps variants a surviving category still
-- covers). This restores the damage already done, and re-adds the affected
-- vendors to RFQs that are still open for bids.
--
-- Cause (RCA 2026-09-17, RFQ 536603): removing a FREE sub-category hard
-- DELETED every product mapping under it, even though the vendor still held
-- the PAID parent category. Sub-category selection narrows nothing anywhere
-- else in the system, so those vendors silently stopped receiving products
-- that existed at the moment of removal — while NEW products in the same
-- sub-category kept flowing to them.
--
-- Repairs a (vendor, variant) pair only when ALL of:
--   * the vendor removed a sub-category the product belongs to, and has no
--     active replacement row for it;
--   * the product ALSO belongs to a category/sub-category the vendor holds
--     ACTIVE today — i.e. they are still subscribed to this product;
--   * no mapping row exists at all.
-- A vendor who dropped the parent category too is therefore left alone.
--
-- Step 2 adds those vendors to still-open RFQs, mirroring
-- hospitalityModel.getMatchingOpenRfqsForVendor + addVendorToRfq (hotel and
-- category gates, IST deadline, approved-PO skip). It sends no email; the
-- vendor's own "join open RFQs" click would have sent one.
--
-- Idempotent: re-running inserts nothing. No DELETEs, no UPDATEs.
--
-- Dry run:  psql ... -f this_file.sql -v commit=0   (default -- rolls back)
-- Execute:  psql ... -f this_file.sql -v commit=1
-- ============================================================================

\set ON_ERROR_STOP on
\if :{?commit} \else \set commit 0 \endif

BEGIN;

-- Sub-categories each vendor removed and has not re-added.
CREATE TEMP TABLE removed_subcats ON COMMIT DROP AS
SELECT DISTINCT s.vendor_id, s.item_id AS category_id
  FROM tbl_vendor_hotel_category_subscription s
 WHERE s.item_type = 'subcategory'
   AND s.cancelled_at IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM tbl_vendor_hotel_category_subscription a
      WHERE a.vendor_id = s.vendor_id
        AND a.item_type = 'subcategory'
        AND a.item_id = s.item_id
        AND a.status = 'active'
   );

-- (vendor, variant) pairs to restore.
CREATE TEMP TABLE repair_pairs ON COMMIT DROP AS
SELECT DISTINCT rs.vendor_id, pv.id AS product_variant_id
  FROM removed_subcats rs
  JOIN tbl_product_categories removed ON removed.category_id = rs.category_id
  JOIN tbl_product p  ON p.id = removed.product_id
  JOIN tbl_product_variant pv ON pv.product_id = p.id
  JOIN tbl_users u ON u.id = rs.vendor_id AND u.status = 1 AND u.user_type = 3
 WHERE p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0
   AND pv.status = 1 AND pv.is_deleted = 0 AND pv.is_approve = 1
   -- still subscribed to this product through a category they kept
   AND EXISTS (
     SELECT 1
       FROM tbl_product_categories kept
       JOIN tbl_vendor_hotel_category_subscription k
         ON k.vendor_id = rs.vendor_id
        AND k.item_type IN ('category', 'subcategory')
        AND k.item_id = kept.category_id
        AND k.status = 'active'
      WHERE kept.product_id = p.id
        AND kept.category_id <> rs.category_id
   )
   -- mapping is gone entirely
   AND NOT EXISTS (
     SELECT 1 FROM tbl_product_variant_vendor_mapping m
      WHERE m.vendor_id = rs.vendor_id
        AND m.product_variant_id = pv.id
   );

\echo '--- vendors and mappings to restore ---'
SELECT count(DISTINCT vendor_id) AS vendors, count(*) AS mappings FROM repair_pairs;

-- 1. Restore the mappings. Values mirror
--    productModel.bulkInsertVariantVendorMappings + autoApproveVariantMappings.
WITH ins AS (
  INSERT INTO tbl_product_variant_vendor_mapping
    (product_variant_id, vendor_id, created_at, updated_at,
     status, is_approved, created_by, updated_by)
  SELECT rp.product_variant_id, rp.vendor_id, NOW(), NOW(),
         true, true, rp.vendor_id, rp.vendor_id
    FROM repair_pairs rp
  RETURNING 1
)
SELECT count(*) AS mappings_inserted FROM ins;

-- 2. Add the vendors to RFQs still open for bids. Gates mirror
--    hospitalityModel.getMatchingOpenRfqsForVendor and addVendorToRfq.
WITH candidates AS (
  SELECT DISTINCT r.id AS rfq_id, rp.id AS rfq_product_id,
         rp.product_variant_id, rp.variant, v.vendor_id
    FROM repair_pairs v
    JOIN tbl_rfq_products rp ON rp.product_variant_id = v.product_variant_id
    JOIN tbl_rfq r ON r.id = rp.rfq_id
    JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
    JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
   WHERE r.status = 1 AND r.is_published = 1
     AND NULLIF(r.bid_end_date, '')::timestamp > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')
     -- vendor holds the RFQ's hotel
     AND EXISTS (
       SELECT 1 FROM tbl_rfq_hotel_mappings hm
         JOIN tbl_vendor_hotel_category_subscription h
           ON h.vendor_id = v.vendor_id
          AND h.item_type = 'hotel'
          AND h.item_id = hm.hotel_id
          AND h.status IN ('active', 'expired')
        WHERE hm.rfq_id = r.id
     )
     -- vendor holds the product's category (the RFQ gate reads 'category' only)
     AND EXISTS (
       SELECT 1 FROM tbl_vendor_hotel_category_subscription c
        WHERE c.vendor_id = v.vendor_id
          AND c.item_type = 'category'
          AND c.item_id = pc.category_id
          AND c.status IN ('active', 'expired')
     )
     AND NOT EXISTS (
       SELECT 1 FROM tbl_rfq_product_vendors rpv
        WHERE rpv.rfq_id = r.id
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
), ins AS (
  INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
  SELECT rfq_id, product_variant_id, vendor_id, variant FROM candidates
  RETURNING rfq_id, user_id
)
SELECT count(*) AS rfq_vendor_rows_inserted,
       count(DISTINCT rfq_id) AS rfqs_touched,
       count(DISTINCT user_id) AS vendors_added
  FROM ins;

\echo '--- remaining gaps (expect 0) ---'
SELECT count(*) AS remaining
  FROM repair_pairs rp
 WHERE NOT EXISTS (
   SELECT 1 FROM tbl_product_variant_vendor_mapping m
    WHERE m.vendor_id = rp.vendor_id
      AND m.product_variant_id = rp.product_variant_id
      AND m.status = true AND m.is_approved = true
 );

\if :commit
  COMMIT;
  \echo '*** COMMITTED ***'
\else
  ROLLBACK;
  \echo '*** DRY RUN -- rolled back. Re-run with -v commit=1 to apply. ***'
\endif
