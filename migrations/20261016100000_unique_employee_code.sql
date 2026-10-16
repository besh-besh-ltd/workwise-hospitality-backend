-- One employee code, one live account.
--
-- Why. Buyers log in with their employee code, and nothing kept a code unique:
-- not the create screen (it checked email and mobile only), not the edit
-- screen, not the database. Production held five codes shared by two live rows
-- each (verified 2026-10-15). Login merged the matching rows and the LAST one
-- won; forgot-password reset the FIRST. So a buyer whose old, deactivated
-- account shared his code reset his password seven times in one afternoon and
-- every login still said "Password not matched". Two other people could not
-- log in at all, and a new starter had been created two days earlier on a
-- departed employee's code.
--
-- What. A unique index over the population login searches:
--   * not deleted, and not user_type 1;
--   * DEACTIVATED accounts included — deactivation is reversible, so the
--     account keeps its code and reactivating it can never collide;
--   * blank codes excluded (most accounts have none);
--   * compared trimmed and case-insensitively, exactly as the login lookup
--     (userModel.getUserAuthByEmployeeCode) and the API checks compare them.
--
-- Safety. It cannot be created over existing duplicates, so this refuses to run
-- — naming every offending code and its accounts — rather than failing halfway.
-- Repair them first: scripts/login_identity/repair_duplicate_employee_codes.sql.
--
-- Idempotent: CREATE ... IF NOT EXISTS. tbl_users is ~900 rows, so the brief
-- lock of a plain (non-concurrent) build is not a concern.

BEGIN;

DO $$
DECLARE
  dupes text;
BEGIN
  SELECT string_agg(format('%s (users %s)', code, ids), '; ' ORDER BY code)
    INTO dupes
    FROM (
      SELECT upper(btrim(employee_code)) AS code,
             string_agg(id::text, ', ' ORDER BY id) AS ids
        FROM public.tbl_users
       WHERE is_deleted = 0
         AND user_type <> 1
         AND employee_code IS NOT NULL
         AND btrim(employee_code) <> ''
       GROUP BY upper(btrim(employee_code))
      HAVING count(*) > 1
    ) d;

  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot add uq_users_employee_code_live: employee codes shared by more than one live account: %', dupes
      USING HINT = 'Give each account its own code first (scripts/login_identity/repair_duplicate_employee_codes.sql).';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_employee_code_live
  ON public.tbl_users (upper(btrim(employee_code)))
  WHERE is_deleted = 0
    AND user_type <> 1
    AND employee_code IS NOT NULL
    AND btrim(employee_code) <> '';

COMMIT;
