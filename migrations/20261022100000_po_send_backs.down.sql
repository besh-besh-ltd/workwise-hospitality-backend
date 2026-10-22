-- Reverses 20261022100000_po_send_backs. Refuses if any approval action already
-- uses a new value: dropping the CHECK's new values would orphan that history.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tbl_approval_actions
             WHERE action IN ('SEND_BACK','SEND_BACK_ANSWERED','SEND_BACK_WITHDRAWN')) THEN
    RAISE EXCEPTION 'Cannot roll back: tbl_approval_actions has SEND_BACK* rows';
  END IF;
END $$;

ALTER TABLE public.tbl_approval_actions
  DROP CONSTRAINT IF EXISTS tbl_approval_actions_action_check;
ALTER TABLE public.tbl_approval_actions
  ADD CONSTRAINT tbl_approval_actions_action_check CHECK (action::text IN (
    'APPROVE','REJECT','CANCELLED','POLICY_CHANGE','APPROVER_REMOVED','APPROVER_ADDED',
    'STEP_REMOVED','STEP_ADDED','MEMBERSHIP_REVALIDATION'));

ALTER TABLE public.tbl_rfq_purchase_order
  DROP COLUMN IF EXISTS initiate_reminded_at,
  DROP COLUMN IF EXISTS replaces_po_id;

DROP TABLE IF EXISTS public.tbl_po_send_back_files;
DROP TABLE IF EXISTS public.tbl_po_send_backs;

COMMIT;
