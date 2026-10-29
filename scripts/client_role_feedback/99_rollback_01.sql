-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK of STEP 01 · re-activate exactly what one run of 01 deactivated
--
--   ./run.sh 99_rollback_01 -v rollback_request_id=<request id of the 01 run>            # DRY
--   CONFIRM_DB=<db> ./run.sh 99_rollback_01 --commit -v rollback_request_id=<request id>  # real
--
-- Restores is_active (and, for processes, updated_at) from the before-images
-- in ops_backup._bak_01_<request>. Policies get updated_at = now() from their
-- BEFORE UPDATE trigger (update_updated_at_column); that cannot be suppressed
-- without disabling triggers, which would also silence the audit trail.
--
-- Refuses when a backed-up row no longer equals its after-image (somebody
-- changed it since), or when re-activating a policy would collide with an
-- active policy created in the same scope since (uq_approval_policy_scope_process).
-- The backup table is kept; drop it by hand once nobody needs it.
-- ═══════════════════════════════════════════════════════════════════════════
\ir lib/backup.sql
\set pending_snapshot _pending_before
\ir lib/pending_state.sql

SELECT pg_temp.bak_load('01') AS image_rows \gset _rb_

DO $rb01$
DECLARE
  r        record;
  drift    text[] := ARRAY[]::text[];
  n        int;
BEGIN
  -- lock what we are about to touch
  -- only is_active / updated_at change: non-key, FOR NO KEY UPDATE
  PERFORM 1 FROM tbl_approval_processes WHERE id IN (SELECT row_id FROM _bak WHERE src_table = 'tbl_approval_processes') FOR NO KEY UPDATE;
  PERFORM 1 FROM tbl_approval_policies  WHERE id IN (SELECT row_id FROM _bak WHERE src_table = 'tbl_approval_policies')  FOR NO KEY UPDATE;

  -- drift: every live row must still equal what 01 left behind (roll later
  -- steps back first: 02 touches policies 01 deactivated)
  FOR r IN
    SELECT b.src_table, b.row_id
      FROM _bak b
      LEFT JOIN tbl_approval_processes pr ON b.src_table = 'tbl_approval_processes' AND pr.id = b.row_id
      LEFT JOIN tbl_approval_policies  p  ON b.src_table = 'tbl_approval_policies'  AND p.id  = b.row_id
     WHERE b.phase = 'after'
       AND CASE b.src_table
             WHEN 'tbl_approval_processes' THEN b.row_data IS DISTINCT FROM to_jsonb(pr)
             -- policies: updated_at is stamped by a trigger on every write
             -- (a later step and its rollback included), so it is not drift
             ELSE (b.row_data - 'updated_at') IS DISTINCT FROM (to_jsonb(p) - 'updated_at') END
     ORDER BY 1, 2
  LOOP
    drift := drift || (r.src_table || ' ' || r.row_id);
  END LOOP;
  IF cardinality(drift) > 0 THEN
    RAISE EXCEPTION E'rows changed since step 01 ran — not rolling back:\n  - %', array_to_string(drift, E'\n  - ');
  END IF;

  -- scope collisions for the policies we would re-activate
  FOR r IN
    SELECT b.row_id, x.id AS other_id
      FROM _bak b
      CROSS JOIN LATERAL jsonb_populate_record(NULL::tbl_approval_policies, b.row_data) old
      JOIN tbl_approval_policies x
        ON x.is_active AND x.id <> old.id
       AND x.entity_type = old.entity_type AND x.hospitality_company_id = old.hospitality_company_id
       AND COALESCE(x.hotel_id, 0) = COALESCE(old.hotel_id, 0)
       AND COALESCE(x.department_id, 0) = COALESCE(old.department_id, 0)
       AND COALESCE(x.process_id, 0) = COALESCE(old.process_id, 0)
     WHERE b.src_table = 'tbl_approval_policies' AND b.phase = 'before' AND old.is_active
  LOOP
    drift := drift || ('policy ' || r.row_id || ' would collide with active policy ' || r.other_id);
  END LOOP;
  IF cardinality(drift) > 0 THEN
    RAISE EXCEPTION E'cannot re-activate — not rolling back:\n  - %', array_to_string(drift, E'\n  - ');
  END IF;

  UPDATE tbl_approval_processes pr
     SET is_active = old.is_active, updated_at = old.updated_at
    FROM _bak b CROSS JOIN LATERAL jsonb_populate_record(NULL::tbl_approval_processes, b.row_data) old
   WHERE b.src_table = 'tbl_approval_processes' AND b.phase = 'before' AND pr.id = b.row_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 're-activated % process(es)', n;

  UPDATE tbl_approval_policies p
     SET is_active = old.is_active
    FROM _bak b CROSS JOIN LATERAL jsonb_populate_record(NULL::tbl_approval_policies, b.row_data) old
   WHERE b.src_table = 'tbl_approval_policies' AND b.phase = 'before' AND p.id = b.row_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 're-activated % policy(ies)', n;

  -- the result must equal the before-images (policies: except updated_at)
  IF EXISTS (
    SELECT 1 FROM _bak b
      LEFT JOIN tbl_approval_processes pr ON b.src_table = 'tbl_approval_processes' AND pr.id = b.row_id
      LEFT JOIN tbl_approval_policies  p  ON b.src_table = 'tbl_approval_policies'  AND p.id  = b.row_id
     WHERE b.phase = 'before'
       AND CASE b.src_table WHEN 'tbl_approval_processes' THEN b.row_data IS DISTINCT FROM to_jsonb(pr)
                            ELSE (b.row_data - 'updated_at') IS DISTINCT FROM (to_jsonb(p) - 'updated_at') END) THEN
    RAISE EXCEPTION 'restored rows differ from the before-images';
  END IF;
END $rb01$;

\ir lib/assert_pending_unchanged.sql
