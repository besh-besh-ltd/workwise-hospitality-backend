BEGIN;
DROP INDEX IF EXISTS public.idx_pop_rfq_product_id_inc;
DROP INDEX IF EXISTS public.idx_pop_purchase_order_id;
DROP INDEX IF EXISTS public.idx_notif_owner_active;
DROP INDEX IF EXISTS public.idx_company_location_company_id;
COMMIT;
