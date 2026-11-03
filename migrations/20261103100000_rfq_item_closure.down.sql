-- Removes item closures. Every closure (current and history) is lost: closed
-- items read as open again, exactly as before the up migration.

BEGIN;

DROP TABLE IF EXISTS public.tbl_rfq_product_closure;

DROP INDEX IF EXISTS public.ix_rfq_products_closed;

ALTER TABLE public.tbl_rfq_products
  DROP CONSTRAINT IF EXISTS ck_rfq_products_close_shape,
  DROP CONSTRAINT IF EXISTS ck_rfq_products_close_reason,
  DROP COLUMN IF EXISTS close_remarks,
  DROP COLUMN IF EXISTS close_reason_code,
  DROP COLUMN IF EXISTS closed_by,
  DROP COLUMN IF EXISTS closed_at;

COMMIT;
