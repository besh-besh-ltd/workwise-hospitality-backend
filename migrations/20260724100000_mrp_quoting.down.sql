-- Down: 20260724100000_mrp_quoting.down.sql
BEGIN;

ALTER TABLE public.tbl_arc_quote_line DROP COLUMN IF EXISTS mrp_discount_mode;
ALTER TABLE public.tbl_arc_quote_line DROP COLUMN IF EXISTS mrp_discount;
ALTER TABLE public.tbl_arc_quote_line DROP COLUMN IF EXISTS entered_mrp;
ALTER TABLE public.tbl_arc_quote_line DROP CONSTRAINT IF EXISTS chk_tbl_arc_quote_line_pricing_method;
ALTER TABLE public.tbl_arc_quote_line DROP COLUMN IF EXISTS pricing_method;

ALTER TABLE public.tbl_arc_quote DROP CONSTRAINT IF EXISTS chk_tbl_arc_quote_pricing_method;
ALTER TABLE public.tbl_arc_quote DROP COLUMN IF EXISTS pricing_method;

ALTER TABLE public.tbl_quote_item_history DROP COLUMN IF EXISTS mrp_discount_mode;
ALTER TABLE public.tbl_quote_item_history DROP COLUMN IF EXISTS mrp_discount;
ALTER TABLE public.tbl_quote_item_history DROP COLUMN IF EXISTS entered_mrp;
ALTER TABLE public.tbl_quote_item_history DROP COLUMN IF EXISTS pricing_method;

ALTER TABLE public.tbl_quote_items DROP COLUMN IF EXISTS mrp_discount_mode;
ALTER TABLE public.tbl_quote_items DROP COLUMN IF EXISTS mrp_discount;
ALTER TABLE public.tbl_quote_items DROP COLUMN IF EXISTS entered_mrp;
ALTER TABLE public.tbl_quote_items DROP CONSTRAINT IF EXISTS chk_tbl_quote_items_pricing_method;
ALTER TABLE public.tbl_quote_items DROP COLUMN IF EXISTS pricing_method;

ALTER TABLE public.tbl_quotes DROP CONSTRAINT IF EXISTS chk_tbl_quotes_pricing_method;
ALTER TABLE public.tbl_quotes DROP COLUMN IF EXISTS pricing_method;

COMMIT;
