-- ===========================================================================
--  PROD 3 — widen EMP003 (Ash I) 'CEO' scope to all departments / all processes
-- ===========================================================================
--
--  WHY
--  EMP003 is a named approver on RFQ policy 148 (hospitality company 13) but
--  could not see the RFQs they were blocking. Their only rfq.read comes from
--  'CEO', which was granted as SEVEN separate rows, one per department
--  (2,3,4,5,9,11,12). RFQ 791 and 788 sit in department 13 (Projects), which
--  is not in that list, so no scope row of theirs both covered the RFQ and
--  carried rfq.read.
--
--  A CEO is not a departmental role. The seven rows are the anomaly; this
--  replaces them with the single unrestricted grant the title implies:
--  department_id NULL (every department) and process_id NULL (every process).
--
--  WHAT THIS DOES NOT DO
--  It does not touch 'Commercial Approver' (14998) or the two ARC roles, and
--  it does not change any other user. It also does not fix the underlying
--  ENGINE gap: EMP003 is named on policy 148 as a USER-source step, and
--  USER-source steps are not permission-gated at resolution, so reverting this
--  script alone will NOT stop them being resolved onto future RFQs — it only
--  makes them blind again (the approver-read exemption keeps them unblocked).
--  Closing that requires the USER-source resolution gate, which is a separate,
--  measured decision (see the report: 9 of 10 live USER-source RFQ approver
--  slots would lose authority).
--
--  REVERSIBLE
--  The seven replaced rows are copied to tbl_user_role_scopes_ash1_backup
--  before deletion, with the original ids, so the previous state can be
--  restored exactly.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  SECTION A — before. Expect 7 CEO rows, departments 2,3,4,5,9,11,12.
-- ---------------------------------------------------------------------------
SELECT 'BEFORE' AS phase, urs.id, r.title AS role,
       urs.company_id, urs.hotel_id, urs.department_id, urs.process_id
  FROM tbl_user_role_scopes urs
  JOIN tbl_roles r ON r.id = urs.role_id
 WHERE urs.user_id = 408 AND r.title = 'CEO'
 ORDER BY urs.department_id;

-- Can EMP003 currently see RFQ 791 by scope alone? Expect FALSE.
SELECT 'BEFORE: can_see_791_by_scope' AS check, EXISTS (
  SELECT 1 FROM tbl_user_role_scopes urs
    JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
    JOIN tbl_permissions p ON p.id = rp.permission_id
   WHERE urs.user_id = 408 AND p.resource::text='rfq' AND p.action='read'
     AND urs.company_id = 13
     AND (urs.hotel_id IS NULL OR urs.hotel_id = 30)
     AND (urs.department_id IS NULL OR urs.department_id = 13)
     AND (urs.process_id IS NULL OR urs.process_id = 5)
) AS result;


-- ---------------------------------------------------------------------------
--  SECTION B — apply.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS tbl_user_role_scopes_ash1_backup (
  LIKE public.tbl_user_role_scopes INCLUDING DEFAULTS
);
ALTER TABLE tbl_user_role_scopes_ash1_backup
  ADD COLUMN IF NOT EXISTS replaced_at timestamptz DEFAULT now();

-- Keep the exact rows being replaced, ids included, so a revert is mechanical.
INSERT INTO tbl_user_role_scopes_ash1_backup
       (id, user_id, role_id, company_id, hotel_id, department_id, process_id)
SELECT urs.id, urs.user_id, urs.role_id, urs.company_id, urs.hotel_id, urs.department_id, urs.process_id
  FROM tbl_user_role_scopes urs
  JOIN tbl_roles r ON r.id = urs.role_id
 WHERE urs.user_id = 408 AND r.title = 'CEO' AND urs.department_id IS NOT NULL;

-- The consolidated grant. NOT EXISTS-guarded so a re-run adds nothing.
INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
SELECT 408, r.id, 13, NULL, NULL, NULL
  FROM tbl_roles r
 WHERE r.title = 'CEO'
   AND NOT EXISTS (
     SELECT 1 FROM tbl_user_role_scopes s
      WHERE s.user_id = 408 AND s.role_id = r.id AND s.company_id = 13
        AND s.hotel_id IS NULL AND s.department_id IS NULL AND s.process_id IS NULL
   );

-- Retire the per-department rows the consolidated grant subsumes.
DELETE FROM tbl_user_role_scopes urs
 USING tbl_roles r
 WHERE r.id = urs.role_id
   AND urs.user_id = 408 AND r.title = 'CEO' AND urs.department_id IS NOT NULL;


-- ---------------------------------------------------------------------------
--  SECTION C — verify inside the transaction. ROLLBACK if anything is off.
-- ---------------------------------------------------------------------------

-- Expect exactly ONE CEO row, all-NULL scope.
SELECT 'AFTER' AS phase, urs.id, r.title AS role,
       urs.company_id, urs.hotel_id, urs.department_id, urs.process_id
  FROM tbl_user_role_scopes urs
  JOIN tbl_roles r ON r.id = urs.role_id
 WHERE urs.user_id = 408 AND r.title = 'CEO';

-- Expect TRUE — the whole point.
SELECT 'AFTER: can_see_791_by_scope' AS check, EXISTS (
  SELECT 1 FROM tbl_user_role_scopes urs
    JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
    JOIN tbl_permissions p ON p.id = rp.permission_id
   WHERE urs.user_id = 408 AND p.resource::text='rfq' AND p.action='read'
     AND urs.company_id = 13
     AND (urs.hotel_id IS NULL OR urs.hotel_id = 30)
     AND (urs.department_id IS NULL OR urs.department_id = 13)
     AND (urs.process_id IS NULL OR urs.process_id = 5)
) AS result;

-- The other three roles must be untouched. Expect ARC Tech Evaluator,
-- ARC Technical Approver, Commercial Approver — unchanged.
SELECT 'AFTER: other roles untouched' AS check, r.title, urs.department_id, urs.process_id
  FROM tbl_user_role_scopes urs
  JOIN tbl_roles r ON r.id = urs.role_id
 WHERE urs.user_id = 408 AND r.title <> 'CEO'
 ORDER BY r.title;

-- Nobody else may have been touched. Expect 0.
SELECT 'AFTER: rows removed for other users' AS check, count(*) AS must_be_zero
  FROM tbl_user_role_scopes_ash1_backup WHERE user_id <> 408;

COMMIT;
-- ROLLBACK;

-- ---------------------------------------------------------------------------
--  TO REVERT
--    BEGIN;
--    DELETE FROM tbl_user_role_scopes urs USING tbl_roles r
--     WHERE r.id = urs.role_id AND urs.user_id = 408 AND r.title = 'CEO'
--       AND urs.department_id IS NULL;
--    INSERT INTO tbl_user_role_scopes (id, user_id, role_id, company_id, hotel_id, department_id, process_id)
--    SELECT id, user_id, role_id, company_id, hotel_id, department_id, process_id
--      FROM tbl_user_role_scopes_ash1_backup WHERE user_id = 408;
--    COMMIT;
--  NOTE: reverting restores BLINDNESS, not exclusion. See "WHAT THIS DOES NOT
--  DO" above — EMP003 will still be resolved onto new RFQs until the
--  USER-source resolution gate ships.
-- ---------------------------------------------------------------------------
