-- Backfill: purchase orders orphaned at 'pending_approval' by an RFQ closure.
--
-- Closing an RFQ cancels the pending approval instances hanging off it,
-- including PO approvals — but until the fix that ships with this migration it
-- never touched the PO row itself. The PO stayed at 'pending_approval' with
-- nothing pending behind it: shown as awaiting approval on every PO screen,
-- actionable by nobody, forever. On prod on 22 Sep 2026 that was 22 of the 29
-- POs showing "pending approval".
--
-- The code now sets these to 'cancelled' at the moment the RFQ closes. This
-- moves the existing ones to the state the code would have left them in.
--
-- The predicate is the NARROW one, deliberately: pending_approval, nothing
-- pending, and a cancelled PO instance whose cancellation says the RFQ was
-- closed. On prod the broad form (any cancelled instance) matched the same 22,
-- but the narrow form cannot sweep up an orphan from some other cause without
-- someone looking at it first.
--
-- Traceable: tbl_rfq_purchase_order carries the row-audit trigger, so every row
-- this touches is recorded in tbl_audit_row_changes with its before and after.

BEGIN;

UPDATE public.tbl_rfq_purchase_order po
   SET status = 'cancelled', updated_at = NOW()
 WHERE po.status = 'pending_approval'
   AND NOT EXISTS (
     SELECT 1 FROM public.tbl_approval_instances x
      WHERE x.entity_type = 'PO' AND x.entity_id = po.id AND x.status = 'PENDING'
   )
   AND EXISTS (
     SELECT 1
       FROM public.tbl_approval_instances x
       JOIN public.tbl_approval_actions a ON a.approval_instance_id = x.id
      WHERE x.entity_type = 'PO' AND x.entity_id = po.id
        AND x.status = 'CANCELLED'
        AND a.comment LIKE '[CANCELLED] RFQ closed%'
   );

COMMIT;
