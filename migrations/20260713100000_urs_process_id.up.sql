-- Process-scoped permissions: add the 4th scope axis (process) to role grants.
--
-- tbl_user_role_scopes today binds a user's role to (company, hotel,
-- department). This adds process_id so an admin can grant "Role A · Company B ·
-- Hotel C · Department E · Process F". NULL process_id is the backwards-compat
-- WILDCARD ("all processes, including entities without a process") — every
-- existing row stays NULL and keeps its current behavior.
--
-- process_id references tbl_approval_processes (the same catalog that
-- tbl_rfq.process_id / tbl_arc.process_id / tbl_approval_policies.process_id
-- already point at). The approver-resolution engine (generalModel.resolveApprovers)
-- and the ABAC gate (authorizationService.assertUserHasScope) filter candidate
-- approvers/actors by this column so only users whose scope covers the entity's
-- process qualify.

ALTER TABLE public.tbl_user_role_scopes
  ADD COLUMN IF NOT EXISTS process_id integer;

-- FK to the process catalog. ON DELETE SET NULL: deleting a process de-scopes
-- the grant back to the all-process wildcard rather than dropping the grant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'tbl_user_role_scopes_process_id_fkey'
      AND table_name = 'tbl_user_role_scopes'
  ) THEN
    ALTER TABLE public.tbl_user_role_scopes
      ADD CONSTRAINT tbl_user_role_scopes_process_id_fkey
      FOREIGN KEY (process_id) REFERENCES public.tbl_approval_processes(id) ON DELETE SET NULL;
  END IF;
END$$;

-- Lookup index for process-filtered approver resolution.
CREATE INDEX IF NOT EXISTS idx_urs_process
  ON public.tbl_user_role_scopes USING btree (process_id);

-- Widen the covering index so the (user_id) → full-scope-row reads stay
-- index-only now that process_id is part of the scope tuple.
DROP INDEX IF EXISTS idx_urs_user_covering;
CREATE INDEX idx_urs_user_covering
  ON public.tbl_user_role_scopes USING btree (user_id)
  INCLUDE (id, role_id, company_id, hotel_id, department_id, process_id);

-- Uniqueness over the FULL scope tuple (NULLs folded to 0 so wildcard rows
-- de-dup too). Guard: if the table already holds duplicate tuples the unique
-- index creation would fail — de-duplicate first, keeping the lowest id.
DELETE FROM public.tbl_user_role_scopes a
USING public.tbl_user_role_scopes b
WHERE a.id > b.id
  AND a.user_id = b.user_id
  AND a.role_id = b.role_id
  AND a.company_id = b.company_id
  AND COALESCE(a.hotel_id, 0) = COALESCE(b.hotel_id, 0)
  AND COALESCE(a.department_id, 0) = COALESCE(b.department_id, 0)
  AND COALESCE(a.process_id, 0) = COALESCE(b.process_id, 0);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_role_scope_tuple
  ON public.tbl_user_role_scopes USING btree (
    user_id, role_id, company_id,
    COALESCE(hotel_id, 0), COALESCE(department_id, 0), COALESCE(process_id, 0)
  );
