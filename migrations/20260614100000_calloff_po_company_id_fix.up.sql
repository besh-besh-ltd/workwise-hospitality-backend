-- Fix call-off PO company-scope inconsistency.
--
-- callOffPoService originally wrote the HOSPITALITY company id into
-- tbl_rfq_purchase_order.company_id, whereas every regular RFQ-backed PO stores
-- the parent tbl_company id (tbl_hospitality_companies.buyer_company_id) — the
-- same value carried on tbl_users.company_id. The PO read APIs fall back to
-- `po.company_id = req.user.company_id` whenever a request omits the
-- X-Hospitality-Company header (which the buyer UI does for PO detail), so
-- call-off POs were unreachable (404) while regular POs resolved fine.
--
-- Re-point existing call-off POs at their ARC's hospitality company's
-- buyer_company_id. Idempotent: only rows that actually differ are touched.
UPDATE public.tbl_rfq_purchase_order po
   SET company_id = hc.buyer_company_id,
       updated_at = NOW()
  FROM public.tbl_arc_contract ac
  JOIN public.tbl_arc a                     ON a.id  = ac.arc_id
  JOIN public.tbl_hospitality_companies hc  ON hc.id = a.hospitality_company_id
 WHERE po.is_call_off = TRUE
   AND po.arc_contract_id = ac.id
   AND hc.buyer_company_id IS NOT NULL
   AND po.company_id IS DISTINCT FROM hc.buyer_company_id;
