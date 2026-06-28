-- Down: 20260626100100_arc_manual_doc_and_hsn.down.sql
BEGIN;
ALTER TABLE public.tbl_arc_item DROP COLUMN IF EXISTS hsn;
ALTER TABLE public.tbl_arc_contract DROP CONSTRAINT IF EXISTS chk_tbl_arc_contract_document_source;
ALTER TABLE public.tbl_arc_contract DROP COLUMN IF EXISTS document_source;
COMMIT;
