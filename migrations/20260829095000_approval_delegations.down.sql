BEGIN;
DROP INDEX IF EXISTS public.idx_delegation_delegate;
DROP INDEX IF EXISTS public.idx_delegation_active;
DROP TABLE IF EXISTS public.tbl_approval_delegations;
COMMIT;
