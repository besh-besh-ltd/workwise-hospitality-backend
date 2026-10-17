-- Auto-initiate attribution flag on Purchase Orders. Set to TRUE when the
-- PO was initiated by the system's auto-initiate batch (fired after the
-- RFQ becomes fully awarded), distinguishing it from a user-driven
-- Force Initiate. The audit-trail "PO initiated" node reads this column
-- to decide whether to show the initiator's user name or "System".
ALTER TABLE public.tbl_rfq_purchase_order
  ADD COLUMN IF NOT EXISTS auto_initiated BOOLEAN NOT NULL DEFAULT FALSE;
