-- Revert: drop the two new statuses from the CHECK. Any rows still in the new
-- states must be normalised first (defensive: send pending/rejected back to draft).
UPDATE public.tbl_arc SET status = 'draft'
 WHERE status IN ('pending_publish_approval','publish_rejected');
ALTER TABLE public.tbl_arc DROP CONSTRAINT IF EXISTS tbl_arc_status_chk;
ALTER TABLE public.tbl_arc ADD  CONSTRAINT tbl_arc_status_chk CHECK (status IN (
  'draft','floated','submission_closed',
  'tech_eval_in_progress','tech_eval_approved','tech_eval_rejected',
  'comm_eval_in_progress','comm_eval_finalized',
  'committee_review','committee_approved','committee_sent_back','committee_rejected',
  'contract_generated','awaiting_vendor_acceptance','contract_active',
  'expiring_soon','expired','terminated','closed_no_award'
));
