-- Revert the reports export ledger.
--
-- Dropping this table discards the record of who exported what. That is the
-- audit trail, not scratch data, so archive it before running this anywhere
-- that has served a real download.

BEGIN;
DROP TABLE IF EXISTS public.tbl_report_exports;
COMMIT;
