-- Up: 20260626100100_arc_manual_doc_and_hsn.sql
-- (1) Distinguish a manually-uploaded already-signed contract PDF from a system-generated one, so the
--     historical-active path is never re-rendered/overwritten by PDF regeneration.
-- (2) Add HSN code on ARC items (India GST classification), absent from the original item table.
-- Apply with: psql $DATABASE_URL -f migrations/20260626100100_arc_manual_doc_and_hsn.sql
BEGIN;

ALTER TABLE public.tbl_arc_contract
  ADD COLUMN IF NOT EXISTS document_source VARCHAR(20) NOT NULL DEFAULT 'generated';
-- values: 'generated' (existing/auto), 'manual_upload' (hand-keyed historical signed PDF)
ALTER TABLE public.tbl_arc_contract
  DROP CONSTRAINT IF EXISTS chk_tbl_arc_contract_document_source;
ALTER TABLE public.tbl_arc_contract
  ADD CONSTRAINT chk_tbl_arc_contract_document_source
  CHECK (document_source IN ('generated','manual_upload'));

ALTER TABLE public.tbl_arc_item
  ADD COLUMN IF NOT EXISTS hsn TEXT;

COMMIT;
