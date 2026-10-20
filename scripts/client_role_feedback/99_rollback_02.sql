-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK of STEP 02 · put the removed levels back exactly as they were
--
--   ./run.sh 99_rollback_02 -v rollback_request_id=<request id of the 02 run>            # DRY
--   CONFIRM_DB=<db> ./run.sh 99_rollback_02 --commit -v rollback_request_id=<request id>  # real
--
-- From ops_backup._bak_02_<request>: re-inserts each removed step with its
-- original id and row, moves the survivors back to their original step_order
-- (in place, ids preserved — instance links keep naming the same rows),
-- restores each policy's version and the historical instance-step links the
-- FK had NULLed, and logs one SCRIPT_ROLLBACK_REMOVE_DEAD_LEVEL change-log row
-- per policy (the forward rows are kept: the log is append-only).
-- Policies' updated_at is stamped by their BEFORE UPDATE trigger.
--
-- Refuses when any backed-up row no longer equals its after-image (the policy
-- was edited, a step changed, a link was set since): a human decides.
-- ═══════════════════════════════════════════════════════════════════════════
\ir lib/backup.sql
\set pending_snapshot _pending_before
\ir lib/pending_state.sql

SELECT pg_temp.bak_load('02') AS image_rows \gset _rb_

DO $rb02$
DECLARE
  prm    record;
  drift  text[] := ARRAY[]::text[];
  r      record;
  n      int;
BEGIN
  SELECT * INTO STRICT prm FROM _params;

  CREATE TEMP TABLE _rb02_policies AS
  SELECT DISTINCT row_id AS id FROM _bak WHERE src_table = 'tbl_approval_policies';

  PERFORM 1 FROM tbl_approval_policies WHERE id IN (SELECT id FROM _rb02_policies) FOR UPDATE;
  PERFORM 1 FROM tbl_approval_policy_steps WHERE approval_policy_id IN (SELECT id FROM _rb02_policies) FOR UPDATE;
  PERFORM 1 FROM tbl_approval_instance_steps
   WHERE id IN (SELECT row_id FROM _bak WHERE src_table = 'tbl_approval_instance_steps') FOR UPDATE;

  -- ── drift: the live rows must be exactly what step 02 left ────────────────
  FOR r IN
    -- policies: updated_at is trigger-stamped on every write, so it is not drift
    SELECT 'policy ' || b.row_id AS what
      FROM _bak b LEFT JOIN tbl_approval_policies p ON p.id = b.row_id
     WHERE b.src_table = 'tbl_approval_policies' AND b.phase = 'after'
       AND (b.row_data - 'updated_at') IS DISTINCT FROM (to_jsonb(p) - 'updated_at')
    UNION ALL
    SELECT 'policy step ' || b.row_id
      FROM _bak b LEFT JOIN tbl_approval_policy_steps s ON s.id = b.row_id
     WHERE b.src_table = 'tbl_approval_policy_steps' AND b.phase = 'after'
       AND b.row_data IS DISTINCT FROM to_jsonb(s)
    UNION ALL
    SELECT 'policy step ' || s.id || ' (added since)'
      FROM tbl_approval_policy_steps s
     WHERE s.approval_policy_id IN (SELECT id FROM _rb02_policies)
       AND NOT EXISTS (SELECT 1 FROM _bak b WHERE b.src_table = 'tbl_approval_policy_steps'
                                             AND b.phase = 'after' AND b.row_id = s.id)
    UNION ALL
    SELECT 'instance step ' || b.row_id
      FROM _bak b LEFT JOIN tbl_approval_instance_steps s ON s.id = b.row_id
     WHERE b.src_table = 'tbl_approval_instance_steps' AND b.phase = 'after'
       AND b.row_data IS DISTINCT FROM to_jsonb(s)
    UNION ALL
    SELECT 'step id ' || b.row_id || ' is taken'
      FROM _bak b
     WHERE b.src_table = 'tbl_approval_policy_steps' AND b.phase = 'before'
       AND NOT EXISTS (SELECT 1 FROM _bak a WHERE a.src_table = b.src_table AND a.phase = 'after' AND a.row_id = b.row_id)
       AND EXISTS (SELECT 1 FROM tbl_approval_policy_steps s WHERE s.id = b.row_id)
    ORDER BY 1
  LOOP
    drift := drift || r.what;
  END LOOP;
  IF cardinality(drift) > 0 THEN
    RAISE EXCEPTION E'rows changed since step 02 ran — not rolling back:\n  - %', array_to_string(drift, E'\n  - ');
  END IF;

  -- ── restore ───────────────────────────────────────────────────────────────
  -- survivors parked on their negated original order, removed steps re-inserted
  -- on theirs, then everything flipped back (idx_unique_step_order is checked
  -- row by row)
  UPDATE tbl_approval_policy_steps s
     SET step_order = -((b.row_data->>'step_order')::int)
    FROM _bak b
   WHERE b.src_table = 'tbl_approval_policy_steps' AND b.phase = 'before' AND s.id = b.row_id;

  INSERT INTO tbl_approval_policy_steps
  SELECT (jsonb_populate_record(NULL::tbl_approval_policy_steps,
            b.row_data || jsonb_build_object('step_order', -((b.row_data->>'step_order')::int)))).*
    FROM _bak b
   WHERE b.src_table = 'tbl_approval_policy_steps' AND b.phase = 'before'
     AND NOT EXISTS (SELECT 1 FROM _bak a WHERE a.src_table = b.src_table AND a.phase = 'after' AND a.row_id = b.row_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 're-inserted % removed level(s)', n;

  UPDATE tbl_approval_policy_steps SET step_order = -step_order
   WHERE approval_policy_id IN (SELECT id FROM _rb02_policies) AND step_order < 0;

  UPDATE tbl_approval_policies p
     SET version = (b.row_data->>'version')::int
    FROM _bak b
   WHERE b.src_table = 'tbl_approval_policies' AND b.phase = 'before' AND p.id = b.row_id;

  UPDATE tbl_approval_instance_steps s
     SET policy_step_id = (b.row_data->>'policy_step_id')::int
    FROM _bak b
   WHERE b.src_table = 'tbl_approval_instance_steps' AND b.phase = 'before' AND s.id = b.row_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'restored % historical instance-step link(s)', n;

  INSERT INTO tbl_approval_policy_change_log
    (approval_policy_id, changed_by, change_type, change_summary, affected_instance_ids)
  SELECT b.row_id, prm.actor_id, 'SCRIPT_ROLLBACK_REMOVE_DEAD_LEVEL',
         jsonb_build_object('request_id', prm.request_id,
                            'rolled_back_request_id', prm.rollback_request_id,
                            'restored_steps', (SELECT jsonb_agg(jsonb_build_object('id', x.row_id,
                                                                  'step_order', (x.row_data->>'step_order')::int,
                                                                  'approver_source_type', x.row_data->>'approver_source_type',
                                                                  'approver_source_id', (x.row_data->>'approver_source_id')::int)
                                                                ORDER BY x.row_id)
                                                 FROM _bak x
                                                WHERE x.src_table = 'tbl_approval_policy_steps' AND x.phase = 'before'
                                                  AND (x.row_data->>'approval_policy_id')::int = b.row_id
                                                  AND NOT EXISTS (SELECT 1 FROM _bak a WHERE a.src_table = x.src_table
                                                                    AND a.phase = 'after' AND a.row_id = x.row_id))),
         '{}'
    FROM _bak b
   WHERE b.src_table = 'tbl_approval_policies' AND b.phase = 'before';

  -- ── verify: the live rows equal the before-images ─────────────────────────
  SELECT count(*) INTO n FROM (
    SELECT b.row_id FROM _bak b LEFT JOIN tbl_approval_policy_steps s ON s.id = b.row_id
     WHERE b.src_table = 'tbl_approval_policy_steps' AND b.phase = 'before' AND b.row_data IS DISTINCT FROM to_jsonb(s)
    UNION ALL
    SELECT s.id FROM tbl_approval_policy_steps s
     WHERE s.approval_policy_id IN (SELECT id FROM _rb02_policies)
       AND NOT EXISTS (SELECT 1 FROM _bak b WHERE b.src_table = 'tbl_approval_policy_steps' AND b.phase = 'before' AND b.row_id = s.id)
    UNION ALL
    SELECT b.row_id FROM _bak b LEFT JOIN tbl_approval_policies p ON p.id = b.row_id
     WHERE b.src_table = 'tbl_approval_policies' AND b.phase = 'before'
       AND (b.row_data - 'updated_at') IS DISTINCT FROM (to_jsonb(p) - 'updated_at')
    UNION ALL
    SELECT b.row_id FROM _bak b LEFT JOIN tbl_approval_instance_steps s ON s.id = b.row_id
     WHERE b.src_table = 'tbl_approval_instance_steps' AND b.phase = 'before' AND b.row_data IS DISTINCT FROM to_jsonb(s)
  ) x;
  IF n <> 0 THEN RAISE EXCEPTION '% restored row(s) differ from the before-images', n; END IF;
  RAISE NOTICE 'restored % policy(ies) to their before-images', (SELECT count(*) FROM _rb02_policies);
END $rb02$;

\ir lib/assert_pending_unchanged.sql
