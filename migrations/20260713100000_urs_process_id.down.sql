-- Rollback: 20260713100000_urs_process_id
-- Restores tbl_user_role_scopes to the (company, hotel, department) scope tuple.

DROP INDEX IF EXISTS uq_user_role_scope_tuple;
DROP INDEX IF EXISTS idx_urs_process;

DROP INDEX IF EXISTS idx_urs_user_covering;
CREATE INDEX idx_urs_user_covering
  ON public.tbl_user_role_scopes USING btree (user_id)
  INCLUDE (id, role_id, company_id, hotel_id, department_id);

ALTER TABLE public.tbl_user_role_scopes
  DROP CONSTRAINT IF EXISTS tbl_user_role_scopes_process_id_fkey;

ALTER TABLE public.tbl_user_role_scopes
  DROP COLUMN IF EXISTS process_id;
