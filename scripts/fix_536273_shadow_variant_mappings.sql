-- ============================================================================
-- RFQ 536273 (id 731) — "shadow variant" mapping repair
-- Root cause: rfqModel.getProductsByCategories dedups variants by
-- (variant NAME, category) keeping the LOWEST id, with no is_approve/is_deleted
-- filter. When a product's variant is re-created (old one left unapproved),
-- the dead old variant "shadows" the live one, so every subscription-time
-- auto-map lands on the dead variant and the live variant never gains vendors.
--
-- Fix 1 clones vendor mappings from each shadow variant to the live variant
-- it starves (8 live variants affected as of 2026-07-28).
-- Fix 2 backfills the still-open RFQ 731 so already-invited vendors also get
-- PILLOW COVER 20 X 30 INCH (variant 13671), gated by the same eligibility
-- rules the app uses (mapping + category 273 sub + hotel 4 sub).
--
-- Both statements are idempotent (NOT EXISTS guards) — safe to re-run.
-- Run Fix 1 BEFORE Fix 2 (Fix 2 depends on the new mapping rows).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- FIX 1: clone mappings shadow-variant -> live-variant (all 8 affected pairs)
-- Expected: ~1,282 rows inserted
--   (GROHE 272 x 3, AMERICAN STANDARD 243, END PLUG 140,
--    PILLOW COVER 29, FNS SLIMLINE 27, ARIANE 27)
-- ---------------------------------------------------------------------------
BEGIN;

WITH ranked AS (
    SELECT pv.id  AS variant_id,
           pv.is_approve AS v_approved,
           pv.is_deleted AS v_deleted,
           ROW_NUMBER() OVER (PARTITION BY pv.name, pc.category_id ORDER BY pv.id) AS rn,
           MIN(pv.id)    OVER (PARTITION BY pv.name, pc.category_id)               AS shadow_variant_id
    FROM tbl_product_variant pv
    JOIN tbl_product p             ON p.id = pv.product_id
    JOIN tbl_product_categories pc ON p.id = pc.product_id
    WHERE p.status = 1 AND pv.status = 1
      AND p.is_deleted = 0 AND p.is_review = 0
),
pairs AS (
    SELECT DISTINCT variant_id AS live_variant_id, shadow_variant_id
    FROM ranked
    WHERE rn > 1 AND v_approved = 1 AND v_deleted = 0
)
INSERT INTO tbl_product_variant_vendor_mapping
    (product_variant_id, vendor_id, status, is_approved, approved_by,
     created_by, updated_by, created_at, updated_at, approved_at)
SELECT DISTINCT ON (pr.live_variant_id, ms.vendor_id)
    pr.live_variant_id, ms.vendor_id, ms.status, ms.is_approved, ms.approved_by,
    ms.created_by, ms.updated_by, now(), now(), ms.approved_at
FROM pairs pr
JOIN tbl_product_variant_vendor_mapping ms
  ON ms.product_variant_id = pr.shadow_variant_id
WHERE NOT EXISTS (
    SELECT 1 FROM tbl_product_variant_vendor_mapping ml
    WHERE ml.product_variant_id = pr.live_variant_id
      AND ml.vendor_id = ms.vendor_id
)
ORDER BY pr.live_variant_id, ms.vendor_id, ms.id;

COMMIT;

-- ---------------------------------------------------------------------------
-- FIX 2: backfill RFQ 731 (rfq_no 536273, bid open until 2026-07-29 17:31 IST)
-- Adds variant 13671 rows for vendors ALREADY on this RFQ who pass the
-- eligibility gate. Expected: ~14 rows (incl. vendors 675, 686, 739).
-- ---------------------------------------------------------------------------
BEGIN;

INSERT INTO tbl_rfq_product_vendors
    (rfq_id, product_variant_id, user_id, variant, sheet_id, is_rfq_viewed, created_at)
SELECT 731, 13671, v.user_id, 0, NULL, 0, now()
FROM (SELECT DISTINCT user_id FROM tbl_rfq_product_vendors WHERE rfq_id = 731) v
JOIN tbl_product_variant_vendor_mapping m
  ON m.product_variant_id = 13671
 AND m.vendor_id = v.user_id
 AND m.status = true AND m.is_approved = true
WHERE EXISTS (SELECT 1 FROM tbl_vendor_hotel_category_subscription s
              WHERE s.vendor_id = v.user_id AND s.item_type = 'category'
                AND s.item_id = 273 AND s.status IN ('active','expired'))
  AND EXISTS (SELECT 1 FROM tbl_vendor_hotel_category_subscription s
              WHERE s.vendor_id = v.user_id AND s.item_type = 'hotel'
                AND s.item_id = 4 AND s.status IN ('active','expired'))
  AND NOT EXISTS (SELECT 1 FROM tbl_rfq_product_vendors e
                  WHERE e.rfq_id = 731 AND e.product_variant_id = 13671
                    AND e.user_id = v.user_id);

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFY (read-only)
-- ---------------------------------------------------------------------------
-- 1) The 3 complaining vendors now cover all 4 products (expect 4 rows each):
SELECT user_id, count(DISTINCT product_variant_id) AS products_visible
FROM tbl_rfq_product_vendors
WHERE rfq_id = 731 AND user_id IN (675, 686, 739)
GROUP BY user_id;

-- 2) No live variant is starved anymore (expect missing_on_live = 0 everywhere):
WITH ranked AS (
    SELECT pv.id AS variant_id, pv.is_approve AS v_approved, pv.is_deleted AS v_deleted,
           ROW_NUMBER() OVER (PARTITION BY pv.name, pc.category_id ORDER BY pv.id) AS rn,
           MIN(pv.id)    OVER (PARTITION BY pv.name, pc.category_id) AS shadow_variant_id
    FROM tbl_product_variant pv
    JOIN tbl_product p ON p.id = pv.product_id
    JOIN tbl_product_categories pc ON p.id = pc.product_id
    WHERE p.status = 1 AND pv.status = 1 AND p.is_deleted = 0 AND p.is_review = 0
)
SELECT variant_id AS live_variant, shadow_variant_id,
       (SELECT count(*) FROM tbl_product_variant_vendor_mapping ms
         WHERE ms.product_variant_id = r.shadow_variant_id
           AND NOT EXISTS (SELECT 1 FROM tbl_product_variant_vendor_mapping ml
                           WHERE ml.product_variant_id = r.variant_id
                             AND ml.vendor_id = ms.vendor_id)) AS missing_on_live
FROM (SELECT DISTINCT variant_id, shadow_variant_id FROM ranked
      WHERE rn > 1 AND v_approved = 1 AND v_deleted = 0) r;
