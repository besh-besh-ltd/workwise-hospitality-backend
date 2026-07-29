-- Rollback ARC v2 vendor contract clarification loop.

ALTER TABLE public.tbl_arc_contract DROP CONSTRAINT IF EXISTS tbl_arc_contract_status_chk;
ALTER TABLE public.tbl_arc_contract ADD CONSTRAINT tbl_arc_contract_status_chk CHECK (status IN (
  'generated','awaiting_acceptance','active','expiring_soon','expired','terminated','declined'
));

DROP TABLE IF EXISTS public.tbl_arc_contract_clarification;
