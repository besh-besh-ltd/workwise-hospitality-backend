-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 02 · remove the dead 'RFQ Creator' / 'Technical Evaluator' levels
--
--   ./run.sh 02                                  # DRY: everything, then ROLLBACK
--   CONFIRM_DB=<db> ./run.sh 02 --commit         # real
--
-- A level is DEAD when it is a ROLE step naming the SYSTEM role (created_by IS
-- NULL) 'RFQ Creator' or 'Technical Evaluator' and that role lacks read+approve
-- on the policy's entity resource (ENTITY_APPROVE_RESOURCE_MAP: RFQ→rfq,
-- TECHNICAL→te, TENDER→boq, …). createApprovalInstance drops such a step every
-- time, so it never had an approver — but every policy screen shows it, and
-- the propagation engine's ordinal fallback lines instance step 1 up with it.
--
-- For every policy of the buyer (active AND inactive) carrying one:
--   DELETE the dead step;
--   renumber the later steps IN PLACE (step_order - 1; ids preserved, so every
--   instance link — policy_step_id — keeps naming the same row);
--   one tbl_approval_policy_change_log row (SCRIPT_REMOVE_DEAD_LEVEL);
--   version + 1.
-- In-flight instances are not touched: their steps were built without the
-- dead level, so instance step 1 already IS the surviving level 1.
--
-- Historical (non-PENDING) instance steps that still link the deleted step
-- would lose that link through fk_instance_step_policy_step ON DELETE SET
-- NULL. Their number is pinned (data.sql expected_dead_level_history_links,
-- prod 0); if an override allows some, they are backed up and 99_rollback_02
-- restores them.
--
-- Refuses unless: count and per-type breakdown equal data.sql; each target
-- role title names exactly one system role; one dead level per policy; every
-- policy keeps at least one level; NO step of a PENDING instance (any step
-- status) links a dead level; the historical-link count equals data.sql;
-- in-flight approvals identical afterwards.
-- ═══════════════════════════════════════════════════════════════════════════
\ir lib/backup.sql
\set pending_snapshot _pending_before
\ir lib/pending_state.sql

-- ── preflight ───────────────────────────────────────────────────────────────
DO $pre02$
DECLARE
  prm          record;
  rec          record;
  n            int;
  n_inactive   int;
  v_breakdown  text;
  v_expected   text;
  v_list       text;
BEGIN
  SELECT * INTO STRICT prm FROM _params;

  FOR rec IN
    SELECT t AS title, (SELECT count(*) FROM tbl_roles x WHERE x.created_by IS NULL AND x.title = t) AS n
      FROM unnest(prm.dead_level_role_titles) t
  LOOP
    IF rec.n <> 1 THEN
      RAISE EXCEPTION 'system role "%" exists % time(s), expected exactly once — refusing', rec.title, rec.n;
    END IF;
  END LOOP;

  -- Lock every policy of the buyer that names one of the roles. FOR NO KEY
  -- UPDATE: only version/updated_at change, so new approval instances (their
  -- FK check takes KEY SHARE on the policy row) are not blocked, while an
  -- admin policy edit (which locks the policy row) waits for us.
  PERFORM 1
     FROM tbl_approval_policies p
     JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
    WHERE hc.buyer_company_id = prm.buyer_company_id
      AND EXISTS (SELECT 1 FROM tbl_approval_policy_steps s
                    JOIN tbl_roles x ON x.id = s.approver_source_id AND x.created_by IS NULL
                   WHERE s.approval_policy_id = p.id AND s.approver_source_type = 'ROLE'
                     AND x.title = ANY (prm.dead_level_role_titles))
    FOR NO KEY UPDATE OF p;

  CREATE TEMP TABLE _t02_dead AS
  SELECT p.id AS policy_id, p.entity_type, p.is_active, p.hospitality_company_id, p.hotel_id, p.process_id,
         s.id AS step_id, s.step_order, s.approver_source_type, s.approver_source_id,
         r.title AS role_title, m.resource
    FROM tbl_approval_policies p
    JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
    JOIN tbl_approval_policy_steps s ON s.approval_policy_id = p.id AND s.approver_source_type = 'ROLE'
    JOIN tbl_roles r ON r.id = s.approver_source_id AND r.created_by IS NULL
    LEFT JOIN _resource_map m ON m.entity_type = p.entity_type
   WHERE hc.buyer_company_id = prm.buyer_company_id
     AND r.title = ANY (prm.dead_level_role_titles)
     AND (SELECT count(DISTINCT pm.action)
            FROM tbl_role_permissions rp
            JOIN tbl_permissions pm ON pm.id = rp.permission_id
           WHERE rp.role_id = r.id AND pm.resource::text = m.resource
             AND pm.action IN ('read', 'approve')) < 2;

  -- FOR UPDATE only on the steps that change: the dead one (deleted) and the
  -- ones after it (renumbered — step_order is a KEY column, it sits in the
  -- unique idx_unique_step_order, so the UPDATE takes FOR UPDATE anyway;
  -- taking it now avoids a lock upgrade). Earlier steps are not touched.
  PERFORM 1 FROM tbl_approval_policy_steps s
    JOIN _t02_dead d ON d.policy_id = s.approval_policy_id AND s.step_order >= d.step_order
     FOR UPDATE OF s;

  SELECT string_agg(DISTINCT entity_type, ', ') INTO v_list FROM _t02_dead WHERE resource IS NULL;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'entity type(s) % are not in ENTITY_APPROVE_RESOURCE_MAP — refusing', v_list;
  END IF;

  SELECT count(DISTINCT policy_id), count(DISTINCT policy_id) FILTER (WHERE NOT is_active)
    INTO n, n_inactive FROM _t02_dead;
  SELECT string_agg(x, ',' ORDER BY x) INTO v_breakdown
    FROM (SELECT entity_type || '=' || count(DISTINCT policy_id) AS x FROM _t02_dead GROUP BY entity_type) b;
  SELECT string_agg(x, ',' ORDER BY x) INTO v_expected
    FROM unnest(string_to_array(prm.expected_dead_level_breakdown, ',')) x;
  RAISE NOTICE '% policies with a dead level (%), % of them inactive', n, COALESCE(v_breakdown, 'none'), n_inactive;
  IF n <> prm.expected_dead_level_policies OR v_breakdown IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'found % dead-level policies (%), expected % (%) — refusing%',
      n, COALESCE(v_breakdown, 'none'), prm.expected_dead_level_policies, v_expected,
      CASE WHEN n = 0 THEN ' (already applied?)' ELSE '' END;
  END IF;

  SELECT string_agg(policy_id::text, ', ' ORDER BY policy_id) INTO v_list
    FROM (SELECT policy_id FROM _t02_dead GROUP BY policy_id HAVING count(*) > 1) x;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'policies % carry more than one dead level — refusing (needs a human look)', v_list;
  END IF;

  SELECT string_agg(d.policy_id::text, ', ' ORDER BY d.policy_id) INTO v_list
    FROM _t02_dead d
   WHERE NOT EXISTS (SELECT 1 FROM tbl_approval_policy_steps s
                      WHERE s.approval_policy_id = d.policy_id AND s.id <> d.step_id);
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'policies % would have no level left — refusing (needs a human decision)', v_list;
  END IF;

  IF EXISTS (SELECT 1 FROM tbl_approval_policy_steps s
              WHERE s.approval_policy_id IN (SELECT policy_id FROM _t02_dead) AND s.step_order < 1) THEN
    RAISE EXCEPTION 'a target policy has a step_order below 1 — refusing';
  END IF;

  -- an in-flight approval must never be linked to the level being removed
  SELECT string_agg(format('instance %s (%s %s) step %s [%s] → policy step %s',
                           i.id, i.entity_type, i.entity_id, s.id, s.status, s.policy_step_id), E'\n  - ' ORDER BY i.id, s.id)
    INTO v_list
    FROM tbl_approval_instance_steps s
    JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
   WHERE i.status = 'PENDING'
     AND s.policy_step_id IN (SELECT step_id FROM _t02_dead);
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION E'PENDING instance step(s) link a level being removed — refusing:\n  - %', v_list;
  END IF;

  -- History that does (non-PENDING instances): deleting the level NULLs the
  -- link (fk_instance_step_policy_step ON DELETE SET NULL). Pinned by data.sql
  -- (prod: 0); when an override allows some, they are backed up, NULLed by the
  -- FK, and restored by 99_rollback_02.
  CREATE TEMP TABLE _t02_history AS
  SELECT s.id, s.approval_instance_id, s.policy_step_id
    FROM tbl_approval_instance_steps s
   WHERE s.policy_step_id IN (SELECT step_id FROM _t02_dead);
  PERFORM 1 FROM tbl_approval_instance_steps WHERE id IN (SELECT id FROM _t02_history) FOR NO KEY UPDATE;
  SELECT count(*) INTO n FROM _t02_history;
  IF n <> prm.expected_dead_level_history_links THEN
    SELECT string_agg(format('instance %s step %s → policy step %s', approval_instance_id, id, policy_step_id),
                      E'\n  - ' ORDER BY approval_instance_id, id)
      INTO v_list FROM _t02_history;
    RAISE EXCEPTION E'found % historical instance step link(s) to the levels being removed, expected % — refusing:\n  - %',
      n, prm.expected_dead_level_history_links, COALESCE(v_list, '(none)');
  END IF;
  RAISE NOTICE '% historical (non-PENDING) instance step link(s) to a removed level (expected %); the FK NULLs them, backed up',
    n, prm.expected_dead_level_history_links;

  FOR rec IN
    SELECT d.*, (SELECT count(*) FROM tbl_approval_instances i
                  WHERE i.approval_policy_id = d.policy_id AND i.status = 'PENDING') AS pending,
                (SELECT count(*) FROM tbl_approval_policy_steps s
                  WHERE s.approval_policy_id = d.policy_id AND s.step_order > d.step_order) AS shifted
      FROM _t02_dead d ORDER BY d.policy_id
  LOOP
    RAISE NOTICE '  policy % % (%, company %, unit %, process %): remove level % "%" (step %), shift % later level(s); % pending instance(s)',
      rec.policy_id, rec.entity_type, CASE WHEN rec.is_active THEN 'active' ELSE 'inactive' END,
      rec.hospitality_company_id, COALESCE(rec.hotel_id::text, 'all'), COALESCE(rec.process_id::text, 'none'),
      rec.step_order, rec.role_title, rec.step_id, rec.shifted, rec.pending;
  END LOOP;
END $pre02$;

-- ── backup, change, backup ──────────────────────────────────────────────────
DO $chg02$
DECLARE
  prm      record;
  d        record;
  v_renum  jsonb;
  n        int;
  total    int := 0;
BEGIN
  SELECT * INTO STRICT prm FROM _params;

  CREATE TEMP TABLE _t02_steps_before AS
  SELECT s.* FROM tbl_approval_policy_steps s WHERE s.approval_policy_id IN (SELECT policy_id FROM _t02_dead);
  CREATE TEMP TABLE _t02_policies_before AS
  SELECT p.* FROM tbl_approval_policies p WHERE p.id IN (SELECT policy_id FROM _t02_dead);

  PERFORM pg_temp.bak_create('02');
  PERFORM pg_temp.bak_put('02', 'tbl_approval_policies',     'before', (SELECT array_agg(id) FROM _t02_policies_before));
  PERFORM pg_temp.bak_put('02', 'tbl_approval_policy_steps', 'before', (SELECT array_agg(id) FROM _t02_steps_before));
  IF EXISTS (SELECT 1 FROM _t02_history) THEN
    PERFORM pg_temp.bak_put('02', 'tbl_approval_instance_steps', 'before', (SELECT array_agg(id) FROM _t02_history));
  END IF;

  FOR d IN SELECT * FROM _t02_dead ORDER BY policy_id LOOP
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'from', s.step_order, 'to', s.step_order - 1)
                              ORDER BY s.step_order), '[]'::jsonb)
      INTO v_renum
      FROM tbl_approval_policy_steps s
     WHERE s.approval_policy_id = d.policy_id AND s.step_order > d.step_order;

    DELETE FROM tbl_approval_policy_steps WHERE id = d.step_id AND approval_policy_id = d.policy_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'policy %: deleting step % removed % row(s)', d.policy_id, d.step_id, n; END IF;

    -- Two phases, because idx_unique_step_order (approval_policy_id, step_order)
    -- is checked row by row: park the later steps on negative orders, then
    -- flip them back. Rows keep their ids.
    UPDATE tbl_approval_policy_steps SET step_order = -(step_order - 1)
     WHERE approval_policy_id = d.policy_id AND step_order > d.step_order;
    UPDATE tbl_approval_policy_steps SET step_order = -step_order
     WHERE approval_policy_id = d.policy_id AND step_order < 0;

    INSERT INTO tbl_approval_policy_change_log
      (approval_policy_id, changed_by, change_type, change_summary, affected_instance_ids)
    VALUES (d.policy_id, prm.actor_id, 'SCRIPT_REMOVE_DEAD_LEVEL',
            jsonb_build_object(
              'request_id', prm.request_id,
              'removed_step', jsonb_build_object('id', d.step_id, 'step_order', d.step_order,
                                                 'approver_source_type', d.approver_source_type,
                                                 'approver_source_id', d.approver_source_id,
                                                 'role_title', d.role_title),
              'renumbered', v_renum),
            '{}');

    UPDATE tbl_approval_policies SET version = COALESCE(version, 1) + 1, updated_at = NOW() WHERE id = d.policy_id;
    total := total + 1;
  END LOOP;
  RAISE NOTICE 'removed % dead level(s) from % policy(ies)', total, total;
END $chg02$;

-- ── postchecks + after-images ───────────────────────────────────────────────
DO $post02$
DECLARE
  prm  record;
  n    int;
BEGIN
  SELECT * INTO STRICT prm FROM _params;

  -- no dead level left anywhere on the buyer (same rule as the preflight)
  SELECT count(*) INTO n
    FROM tbl_approval_policies p
    JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
    JOIN tbl_approval_policy_steps s ON s.approval_policy_id = p.id AND s.approver_source_type = 'ROLE'
    JOIN tbl_roles r ON r.id = s.approver_source_id AND r.created_by IS NULL
    LEFT JOIN _resource_map m ON m.entity_type = p.entity_type
   WHERE hc.buyer_company_id = prm.buyer_company_id
     AND r.title = ANY (prm.dead_level_role_titles)
     AND (SELECT count(DISTINCT pm.action) FROM tbl_role_permissions rp JOIN tbl_permissions pm ON pm.id = rp.permission_id
           WHERE rp.role_id = r.id AND pm.resource::text = m.resource AND pm.action IN ('read', 'approve')) < 2;
  IF n <> 0 THEN RAISE EXCEPTION '% dead level(s) still present', n; END IF;

  -- every surviving step is the same row, unchanged but for step_order, which
  -- moved down by one exactly when it sat after the removed level
  SELECT count(*) INTO n
    FROM _t02_steps_before b
    JOIN _t02_dead d ON d.policy_id = b.approval_policy_id
    LEFT JOIN tbl_approval_policy_steps s ON s.id = b.id
   WHERE b.id <> d.step_id
     AND (s.id IS NULL
          OR s.step_order <> b.step_order - CASE WHEN b.step_order > d.step_order THEN 1 ELSE 0 END
          OR (to_jsonb(s) - 'step_order') <> (to_jsonb(b) - 'step_order'));
  IF n <> 0 THEN RAISE EXCEPTION '% surviving step(s) are not what they should be', n; END IF;
  IF EXISTS (SELECT 1 FROM tbl_approval_policy_steps s WHERE s.id IN (SELECT step_id FROM _t02_dead)) THEN
    RAISE EXCEPTION 'a dead step survived';
  END IF;
  IF (SELECT count(*) FROM tbl_approval_policy_steps WHERE approval_policy_id IN (SELECT policy_id FROM _t02_dead))
     <> (SELECT count(*) FROM _t02_steps_before) - (SELECT count(*) FROM _t02_dead) THEN
    RAISE EXCEPTION 'target policies gained or lost steps beyond the dead levels';
  END IF;

  IF EXISTS (SELECT 1 FROM _t02_policies_before b JOIN tbl_approval_policies p ON p.id = b.id
              WHERE p.version IS DISTINCT FROM COALESCE(b.version, 1) + 1
                 OR (to_jsonb(p) - 'version' - 'updated_at') <> (to_jsonb(b) - 'version' - 'updated_at')) THEN
    RAISE EXCEPTION 'a target policy changed beyond its version';
  END IF;

  IF EXISTS (SELECT 1 FROM _t02_history h JOIN tbl_approval_instance_steps s ON s.id = h.id
              WHERE s.policy_step_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a historical link to a removed level survived';
  END IF;

  SELECT count(*) INTO n FROM tbl_approval_policy_change_log
   WHERE change_type = 'SCRIPT_REMOVE_DEAD_LEVEL' AND change_summary->>'request_id' = prm.request_id::text;
  IF n <> (SELECT count(*) FROM _t02_dead) THEN RAISE EXCEPTION 'expected % change-log rows, found %', (SELECT count(*) FROM _t02_dead), n; END IF;

  PERFORM pg_temp.bak_put('02', 'tbl_approval_policies', 'after', (SELECT array_agg(id) FROM _t02_policies_before));
  PERFORM pg_temp.bak_put('02', 'tbl_approval_policy_steps', 'after',
    (SELECT array_agg(id) FROM tbl_approval_policy_steps WHERE approval_policy_id IN (SELECT policy_id FROM _t02_dead)));
  IF EXISTS (SELECT 1 FROM _t02_history) THEN
    PERFORM pg_temp.bak_put('02', 'tbl_approval_instance_steps', 'after', (SELECT array_agg(id) FROM _t02_history));
  END IF;
  RAISE NOTICE 'postchecks passed: steps renumbered in place, ids preserved, % change-log row(s), versions +1', n;
END $post02$;

\ir lib/assert_pending_unchanged.sql
