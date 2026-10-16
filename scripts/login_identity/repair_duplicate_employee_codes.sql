-- Give every live account its own employee code, ahead of migration
-- 20261016100000_unique_employee_code (which refuses to run over duplicates).
--
-- Verified on production 2026-10-15/16 (read-only): five codes were shared by
-- two live rows each, and one code was stored with a leading space.
--
--   deactivated old account + active account (same person or a re-used code)
--     330 / 360,  135 / 294,  144 / 1005
--       -> the DEACTIVATED account's code gets a suffix "-INACTIVE-<id>".
--          It keeps a recognisable code for history and reports, and gives
--          the active account sole use of the original. Nothing else changes.
--   615 / 617 — Workwise's own test accounts (company 90)
--       -> 617 becomes AWS2.
--   819 — code stored with a leading space (could never log in)
--       -> trimmed.
--   324 / 325 — two ACTIVE people sharing one code
--       -> NOT touched: only the client knows which code is whose. Until it is
--          corrected, login refuses both (neither has ever logged in) and the
--          unique-index migration keeps refusing to run.
--
-- All-or-nothing: every expectation is asserted before and after, and any
-- mismatch (an account reactivated meanwhile, a code already fixed by hand...)
-- RAISEs, which rolls back the whole transaction. Re-running after success
-- therefore refuses, by design.
--
-- Preview first (read-only): scripts/login_identity/preview_duplicate_employee_codes.sql
-- Apply:   psql "$PROD" -v ON_ERROR_STOP=1 -f scripts/login_identity/repair_duplicate_employee_codes.sql
-- Audit:   every row change is in tbl_audit_row_changes under one request_id,
--          printed by the NOTICE at the end.

BEGIN;

-- One request id for the batch, so the audit trail shows these as one action.
SELECT set_config('app.request_id', gen_random_uuid()::text, true);

DO $$
DECLARE
  deactivated_twins constant int[] := ARRAY[330, 135, 144];
  test_account constant int := 617;
  test_account_code constant text := 'AWS2';
  padded_account constant int := 819;
  awaiting_client constant int[] := ARRAY[324, 325];
  twin int;
  n int;
  leftover text;
BEGIN
  ---------------------------------------------------------------- preconditions
  FOREACH twin IN ARRAY deactivated_twins LOOP
    -- still a live, deactivated company account with a code...
    PERFORM 1 FROM public.tbl_users
     WHERE id = twin AND is_deleted = 0 AND user_type = 2 AND status <> 1
       AND employee_code IS NOT NULL AND btrim(employee_code) <> ''
       AND employee_code NOT LIKE '%-INACTIVE-%';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'precondition: user % is no longer a deactivated account holding a code', twin;
    END IF;
    -- ...sharing it with exactly one other live account, which is active.
    SELECT count(*) INTO n
      FROM public.tbl_users o, public.tbl_users t
     WHERE t.id = twin AND o.id <> t.id
       AND o.is_deleted = 0 AND o.user_type <> 1 AND o.status = 1
       AND upper(btrim(o.employee_code)) = upper(btrim(t.employee_code));
    IF n <> 1 THEN
      RAISE EXCEPTION 'precondition: user % shares its code with % active accounts, expected 1', twin, n;
    END IF;
  END LOOP;

  PERFORM 1 FROM public.tbl_users
   WHERE id = test_account AND company_id = 90 AND upper(btrim(employee_code)) = 'AWS1';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'precondition: test account % no longer holds AWS1 in company 90', test_account;
  END IF;
  PERFORM 1 FROM public.tbl_users
   WHERE upper(btrim(employee_code)) = test_account_code AND is_deleted = 0 AND user_type <> 1;
  IF FOUND THEN
    RAISE EXCEPTION 'precondition: % is already in use', test_account_code;
  END IF;

  PERFORM 1 FROM public.tbl_users t
   WHERE t.id = padded_account AND t.employee_code <> btrim(t.employee_code)
     AND NOT EXISTS (
       SELECT 1 FROM public.tbl_users o
        WHERE o.id <> t.id AND o.is_deleted = 0 AND o.user_type <> 1
          AND upper(btrim(o.employee_code)) = upper(btrim(t.employee_code)));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'precondition: user %''s code is no longer padded, or its trimmed form is taken', padded_account;
  END IF;

  ---------------------------------------------------------------- changes
  UPDATE public.tbl_users
     SET employee_code = btrim(employee_code) || '-INACTIVE-' || id
   WHERE id = ANY (deactivated_twins);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 3 THEN RAISE EXCEPTION 'expected to free 3 codes, freed %', n; END IF;

  UPDATE public.tbl_users SET employee_code = test_account_code WHERE id = test_account;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected to recode 1 test account, recoded %', n; END IF;

  UPDATE public.tbl_users SET employee_code = btrim(employee_code) WHERE id = padded_account;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected to trim 1 code, trimmed %', n; END IF;

  ---------------------------------------------------------------- postconditions
  -- The only duplicate allowed to remain is the pair waiting on the client.
  SELECT string_agg(ids, '; ') INTO leftover
    FROM (
      SELECT string_agg(id::text, ',' ORDER BY id) AS ids, array_agg(id) AS id_list
        FROM public.tbl_users
       WHERE is_deleted = 0 AND user_type <> 1
         AND employee_code IS NOT NULL AND btrim(employee_code) <> ''
       GROUP BY upper(btrim(employee_code))
      HAVING count(*) > 1
    ) d
   WHERE NOT (d.id_list <@ awaiting_client);
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'postcondition: duplicates remain beyond the pair awaiting the client: %', leftover;
  END IF;

  RAISE NOTICE 'Repaired. Audit request_id: %', current_setting('app.request_id');
END $$;

COMMIT;
