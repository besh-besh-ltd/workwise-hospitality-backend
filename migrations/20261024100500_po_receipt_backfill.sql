-- Inventory module: flag POs that predate line-level receiving. Spec §13
-- (docs/superpowers/specs/2026-10-23-inventory-management-design.md).
--
--   * status GRN / invoice_raised / completed -> receipt_status 'received',
--     receipt_legacy true. NO plan rows are created; screens label these
--     "Received (before line-level receiving)" and recomputePoReceipt leaves a
--     legacy received PO without plan rows untouched. No stock is backfilled.
--   * status approved / dispatched / sent -> receipt_legacy true, staying
--     'not_received'. Their default plan is created lazily by ensureDefaultPlan
--     when someone opens Receive or the Deliveries tab. They are excluded from
--     overdue, reorder on_order and vendor OTIF, and listed under "Older POs".
--
-- Re-run safety: a PO that already has a delivery plan or a GRN went through
-- the new flow and is never relabelled. Re-run the backfill block once right
-- after the new backend is healthy: it then also flags POs the old code moved
-- to GRN between this migration and the deploy (else they would be received
-- a second time). Do not re-run it later: by then a post-R1 PO with no plan
-- (submitted under old code, or whose plan creation failed) would be wrongly
-- flagged legacy. updated_at is deliberately left alone: this is a
-- classification, not an edit anybody made. One audit row per PO
-- (tbl_rfq_purchase_order's trigger): apply at a quiet hour.
--
-- tests/services/inventory.schema.test.js executes the statements between the
-- `-- backfill` and `-- end backfill` marker lines below. Keep the markers.

-- A lock wait longer than 5s aborts the file (rolling back whole) instead of
-- queueing every PO page behind it; every statement is idempotent: re-run it.
BEGIN;

SET LOCAL lock_timeout = '5s';

-- backfill
UPDATE public.tbl_rfq_purchase_order po
   SET receipt_status = 'received',
       receipt_legacy = true
 WHERE po.status IN ('GRN', 'invoice_raised', 'completed')
   AND po.receipt_legacy = false
   AND po.receipt_status = 'not_received'
   AND NOT EXISTS (SELECT 1 FROM public.tbl_po_delivery d WHERE d.po_id = po.id)
   AND NOT EXISTS (SELECT 1 FROM public.tbl_grn g WHERE g.po_id = po.id);

UPDATE public.tbl_rfq_purchase_order po
   SET receipt_legacy = true
 WHERE po.status IN ('approved', 'dispatched', 'sent')
   AND po.receipt_legacy = false
   AND po.receipt_status = 'not_received'
   AND NOT EXISTS (SELECT 1 FROM public.tbl_po_delivery d WHERE d.po_id = po.id)
   AND NOT EXISTS (SELECT 1 FROM public.tbl_grn g WHERE g.po_id = po.id);
-- end backfill

COMMIT;
