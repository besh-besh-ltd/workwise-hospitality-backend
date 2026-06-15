-- Revert: restore the pre-fix state where call-off POs carried the hospitality
-- company id in company_id. (This re-introduces the scope inconsistency — only
-- run when rolling back the accompanying callOffPoService change.)
UPDATE public.tbl_rfq_purchase_order po
   SET company_id = a.hospitality_company_id,
       updated_at = NOW()
  FROM public.tbl_arc_contract ac
  JOIN public.tbl_arc a ON a.id = ac.arc_id
 WHERE po.is_call_off = TRUE
   AND po.arc_contract_id = ac.id
   AND po.company_id IS DISTINCT FROM a.hospitality_company_id;
