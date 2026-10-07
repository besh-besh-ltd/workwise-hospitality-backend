-- Reverse 20260928101000. Dropping the column returns every company to the
-- legacy dashboard (the application treats a missing column as "off").

BEGIN;

ALTER TABLE public.tbl_company DROP COLUMN IF EXISTS buyer_dashboard_v3;

COMMIT;
