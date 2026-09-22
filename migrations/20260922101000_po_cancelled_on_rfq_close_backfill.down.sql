-- Put the backfilled POs back to 'pending_approval'.
--
-- Uses the same RFQ-closure evidence, so it also reverts any PO the fixed code
-- cancelled on RFQ close after the backfill ran — which is the correct partner
-- to rolling that code back. The exact rows the forward migration touched are
-- also in tbl_audit_row_changes if a narrower revert is ever wanted.

BEGIN;

UPDATE public.tbl_rfq_purchase_order po
   SET status = 'pending_approval', updated_at = NOW()
 WHERE po.status = 'cancelled'
   AND EXISTS (
     SELECT 1
       FROM public.tbl_approval_instances x
       JOIN public.tbl_approval_actions a ON a.approval_instance_id = x.id
      WHERE x.entity_type = 'PO' AND x.entity_id = po.id
        AND x.status = 'CANCELLED'
        AND a.comment LIKE '[CANCELLED] RFQ closed%'
   );

COMMIT;
