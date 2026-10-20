-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK of STEP 03 · ARC round approval back to 'ARC Commercial Approver'
--
--   ./run.sh 99_rollback_03 -v rollback_request_id=<request id of the 03 run>            # DRY
--   CONFIRM_DB=<db> ./run.sh 99_rollback_03 --commit -v rollback_request_id=<request id>  # real
--
-- From ops_backup._bak_03_<request>: puts each converted step's
-- approver_source_id and decision_rule back (same row), restores the policy's
-- version, and logs one SCRIPT_ROLLBACK_ARC_ROUND_PEER_APPROVAL change-log row
-- per policy. Policies' updated_at is stamped by their BEFORE UPDATE trigger.
--
-- Refuses when a backed-up row no longer equals its after-image, or when a
-- round approval is PENDING on the policy (it was built for the peer rule;
-- switching the policy under it would leave the two disagreeing).
-- ═══════════════════════════════════════════════════════════════════════════
\ir lib/backup.sql
\set pending_snapshot _pending_before
\ir lib/pending_state.sql

SELECT pg_temp.bak_load('03') AS image_rows \gset _rb_

DO $rb03$
DECLARE
  prm    record;
  drift  text[] := ARRAY[]::text[];
  r      record;
  n      int;
BEGIN
  SELECT * INTO STRICT prm FROM _params;

  PERFORM 1 FROM tbl_approval_policies
   WHERE id IN (SELECT row_id FROM _bak WHERE src_table = 'tbl_approval_policies') FOR UPDATE;
  PERFORM 1 FROM tbl_approval_policy_steps
   WHERE id IN (SELECT row_id FROM _bak WHERE src_table = 'tbl_approval_policy_steps') FOR UPDATE;

  FOR r IN
    -- policies: updated_at is trigger-stamped on every write, so it is not drift
    SELECT 'policy ' || b.row_id AS what
      FROM _bak b LEFT JOIN tbl_approval_policies p ON p.id = b.row_id
     WHERE b.src_table = 'tbl_approval_policies' AND b.phase = 'after'
       AND (b.row_data - 'updated_at') IS DISTINCT FROM (to_jsonb(p) - 'updated_at')
    UNION ALL
    SELECT 'policy step ' || b.row_id
      FROM _bak b LEFT JOIN tbl_approval_policy_steps s ON s.id = b.row_id
     WHERE b.src_table = 'tbl_approval_policy_steps' AND b.phase = 'after' AND b.row_data IS DISTINCT FROM to_jsonb(s)
    UNION ALL
    SELECT 'policy ' || i.approval_policy_id || ' has PENDING instance ' || i.id
      FROM tbl_approval_instances i
     WHERE i.status = 'PENDING'
       AND i.approval_policy_id IN (SELECT row_id FROM _bak WHERE src_table = 'tbl_approval_policies')
    ORDER BY 1
  LOOP
    drift := drift || r.what;
  END LOOP;
  IF cardinality(drift) > 0 THEN
    RAISE EXCEPTION E'cannot roll step 03 back safely:\n  - %', array_to_string(drift, E'\n  - ');
  END IF;

  UPDATE tbl_approval_policy_steps s
     SET approver_source_id = (b.row_data->>'approver_source_id')::int,
         decision_rule      = b.row_data->>'decision_rule'
    FROM _bak b
   WHERE b.src_table = 'tbl_approval_policy_steps' AND b.phase = 'before' AND s.id = b.row_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'restored % step(s)', n;

  UPDATE tbl_approval_policies p
     SET version = (b.row_data->>'version')::int
    FROM _bak b
   WHERE b.src_table = 'tbl_approval_policies' AND b.phase = 'before' AND p.id = b.row_id;

  INSERT INTO tbl_approval_policy_change_log
    (approval_policy_id, changed_by, change_type, change_summary, affected_instance_ids)
  SELECT b.row_id, prm.actor_id, 'SCRIPT_ROLLBACK_ARC_ROUND_PEER_APPROVAL',
         jsonb_build_object('request_id', prm.request_id, 'rolled_back_request_id', prm.rollback_request_id),
         '{}'
    FROM _bak b
   WHERE b.src_table = 'tbl_approval_policies' AND b.phase = 'before';

  SELECT count(*) INTO n FROM (
    SELECT b.row_id FROM _bak b LEFT JOIN tbl_approval_policy_steps s ON s.id = b.row_id
     WHERE b.src_table = 'tbl_approval_policy_steps' AND b.phase = 'before' AND b.row_data IS DISTINCT FROM to_jsonb(s)
    UNION ALL
    SELECT b.row_id FROM _bak b LEFT JOIN tbl_approval_policies p ON p.id = b.row_id
     WHERE b.src_table = 'tbl_approval_policies' AND b.phase = 'before'
       AND (b.row_data - 'updated_at') IS DISTINCT FROM (to_jsonb(p) - 'updated_at')
  ) x;
  IF n <> 0 THEN RAISE EXCEPTION '% restored row(s) differ from the before-images', n; END IF;
END $rb03$;

\ir lib/assert_pending_unchanged.sql
