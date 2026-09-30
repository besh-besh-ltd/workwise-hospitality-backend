-- ARC publish-approval gate — add two pre-live statuses to tbl_arc.
-- pending_publish_approval: publish initiated, ARC_PUBLISH approval instance PENDING (NOT live).
-- publish_rejected:         publish approval rejected (NOT live; creator may revise + re-publish).
ALTER TABLE public.tbl_arc DROP CONSTRAINT IF EXISTS tbl_arc_status_chk;
ALTER TABLE public.tbl_arc ADD  CONSTRAINT tbl_arc_status_chk CHECK (status IN (
  'draft','pending_publish_approval','publish_rejected',
  'floated','submission_closed',
  'tech_eval_in_progress','tech_eval_approved','tech_eval_rejected',
  'comm_eval_in_progress','comm_eval_finalized',
  'committee_review','committee_approved','committee_sent_back','committee_rejected',
  'contract_generated','awaiting_vendor_acceptance','contract_active',
  'expiring_soon','expired','terminated','closed_no_award'
));
