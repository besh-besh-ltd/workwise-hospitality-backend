-- Script to undo finalization for RFQ #535734
-- Run this inside a transaction so it can be rolled back if needed

BEGIN;

-- 1. Find the RFQ
SELECT id, rfq_no, status, is_published FROM tbl_rfq WHERE rfq_no = 535734;

-- 2. Move finalization records to history
INSERT INTO tbl_quote_finalization_history
  (rfq_id, rfq_no, quote_id, product_variant_id, vendor_id, created_by, timestamp, variant, changed_by, changed_at)
SELECT
  qf.rfq_id, qf.rfq_no, qf.quote_id, qf.product_variant_id, qf.vendor_id, qf.created_by, qf.timestamp, qf.variant,
  qf.created_by, -- changed_by = original creator
  NOW()
FROM tbl_quote_finalization qf
JOIN tbl_rfq r ON r.id = qf.rfq_id
WHERE r.rfq_no = 535734;

-- 3. Delete finalization records
DELETE FROM tbl_quote_finalization
WHERE rfq_id = (SELECT id FROM tbl_rfq WHERE rfq_no = 535734);

-- 4. Cancel NEGOTIATION_QUOTE approval instances for this RFQ's products
UPDATE tbl_approval_instances
SET status = 'CANCELLED', completed_at = NOW()
WHERE entity_type = 'NEGOTIATION_QUOTE'
  AND entity_id IN (
    SELECT rp.id FROM tbl_rfq_products rp
    JOIN tbl_rfq r ON r.id = rp.rfq_id
    WHERE r.rfq_no = 535734
  )
  AND status IN ('PENDING', 'APPROVED');

-- 5. Cancel any DRAFT POs created for this RFQ
UPDATE tbl_rfq_purchase_order
SET status = 'cancelled', updated_at = NOW()
WHERE rfq_id = (SELECT id FROM tbl_rfq WHERE rfq_no = 535734)
  AND status = 'draft';

-- 6. Verify the cleanup
SELECT 'Remaining finalizations:' AS check_label,
  COUNT(*) AS cnt
FROM tbl_quote_finalization
WHERE rfq_id = (SELECT id FROM tbl_rfq WHERE rfq_no = 535734);

SELECT 'Active approval instances:' AS check_label,
  COUNT(*) AS cnt
FROM tbl_approval_instances
WHERE entity_type = 'NEGOTIATION_QUOTE'
  AND entity_id IN (
    SELECT rp.id FROM tbl_rfq_products rp
    JOIN tbl_rfq r ON r.id = rp.rfq_id
    WHERE r.rfq_no = 535734
  )
  AND status IN ('PENDING', 'APPROVED');

-- If everything looks good, run COMMIT. Otherwise ROLLBACK.
-- COMMIT;
