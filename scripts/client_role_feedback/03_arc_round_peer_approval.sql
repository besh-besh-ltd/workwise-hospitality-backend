-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 03 · ARC negotiation rounds approved by peer evaluators, as in RFQ
--
--   ./run.sh 03                                  # DRY: everything, then ROLLBACK
--   CONFIRM_DB=<db> ./run.sh 03 --commit         # real
--
-- For every ARC_NEGOTIATION / ARC_GROUP_NEGOTIATION policy of the buyer whose
-- ONLY level is a ROLE step on the system role 'ARC Commercial Approver'
-- (prod: policy 221, Orchid Mumbai, rule ANY): UPDATE that step IN PLACE to the
-- system role 'ARC Commercial Evaluator' with decision_rule 'ALL' — the round
-- creator's own slot is auto-approved by the engine, so ALL means "every
-- other evaluator at the unit approves" (rule ANY would be satisfied by the
-- creator alone). One change-log row (SCRIPT_ARC_ROUND_PEER_APPROVAL), version + 1.
--
-- Refuses unless: count and ids equal data.sql; both titles name exactly one
-- system role; the target role holds arc-comm read+approve (migration
-- 20261019100200 applied); no PENDING instance on the policies; at least one
-- active user holds the target role at each policy's scope (else rounds there
-- could not be launched at all); in-flight approvals identical afterwards.
-- ═══════════════════════════════════════════════════════════════════════════
\ir lib/backup.sql
\set pending_snapshot _pending_before
\ir lib/pending_state.sql

DO $pre03$
DECLARE
  prm      record;
  r        record;
  v_from   int;
  v_to     int;
  v_ids    int[];
  v_list   text;
BEGIN
  SELECT * INTO STRICT prm FROM _params;

  FOR r IN
    SELECT t AS title, (SELECT count(*) FROM tbl_roles x WHERE x.created_by IS NULL AND x.title = t) AS n
      FROM unnest(ARRAY[prm.arc_from_role_title, prm.arc_to_role_title]) t
  LOOP
    IF r.n <> 1 THEN
      RAISE EXCEPTION 'system role "%" exists % time(s), expected exactly once — refusing', r.title, r.n;
    END IF;
  END LOOP;
  SELECT id INTO STRICT v_from FROM tbl_roles WHERE created_by IS NULL AND title = prm.arc_from_role_title;
  SELECT id INTO STRICT v_to   FROM tbl_roles WHERE created_by IS NULL AND title = prm.arc_to_role_title;

  IF (SELECT count(DISTINCT pm.action) FROM tbl_role_permissions rp JOIN tbl_permissions pm ON pm.id = rp.permission_id
       WHERE rp.role_id = v_to AND pm.resource::text = 'arc-comm' AND pm.action IN ('read', 'approve')) <> 2 THEN
    RAISE EXCEPTION '"%" (role %) lacks arc-comm read+approve — apply migration 20261019100200_arc_commercial_evaluator_round_approval first; refusing',
      prm.arc_to_role_title, v_to;
  END IF;

  PERFORM 1 FROM tbl_approval_policies p
    JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
   WHERE hc.buyer_company_id = prm.buyer_company_id AND p.entity_type = ANY (prm.arc_round_entity_types)
   FOR NO KEY UPDATE OF p;   -- only version/updated_at change

  CREATE TEMP TABLE _t03 AS
  SELECT p.id AS policy_id, p.entity_type, p.is_active, p.hospitality_company_id, p.hotel_id,
         s.id AS step_id, s.step_order, s.decision_rule,
         v_from AS from_role_id, v_to AS to_role_id
    FROM tbl_approval_policies p
    JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
    JOIN tbl_approval_policy_steps s ON s.approval_policy_id = p.id
   WHERE hc.buyer_company_id = prm.buyer_company_id
     AND p.entity_type = ANY (prm.arc_round_entity_types)
     AND s.approver_source_type = 'ROLE' AND s.approver_source_id = v_from
     AND (SELECT count(*) FROM tbl_approval_policy_steps x WHERE x.approval_policy_id = p.id) = 1;
  -- only approver_source_id / decision_rule change (non-key columns)
  PERFORM 1 FROM tbl_approval_policy_steps WHERE id IN (SELECT step_id FROM _t03) FOR NO KEY UPDATE;

  SELECT COALESCE(array_agg(policy_id ORDER BY policy_id), '{}') INTO v_ids FROM _t03;
  IF cardinality(v_ids) <> prm.expected_arc_round_policies
     OR v_ids <> (SELECT array_agg(x ORDER BY x) FROM unnest(prm.expected_arc_round_policy_ids) x) THEN
    RAISE EXCEPTION 'ARC round policies of buyer % on "%" alone are % (expected % = %) — refusing%',
      prm.buyer_company_id, prm.arc_from_role_title, v_ids, prm.expected_arc_round_policies,
      prm.expected_arc_round_policy_ids, CASE WHEN cardinality(v_ids) = 0 THEN ' (already applied?)' ELSE '' END;
  END IF;

  SELECT string_agg(format('policy %s: instance %s (%s %s)', i.approval_policy_id, i.id, i.entity_type, i.entity_id),
                    E'\n  - ' ORDER BY i.id)
    INTO v_list
    FROM tbl_approval_instances i
   WHERE i.approval_policy_id IN (SELECT policy_id FROM _t03) AND i.status = 'PENDING';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION E'PENDING round approvals on the target policies — refusing (let them finish first):\n  - %', v_list;
  END IF;

  -- who would approve rounds afterwards: resolveApprovers' ROLE branch (active
  -- user, role scope at the company/unit, hospitality mapping reaching the unit;
  -- department/process narrowing is per round and not modelled here)
  FOR r IN
    SELECT t.policy_id, t.hospitality_company_id, t.hotel_id,
           (SELECT count(DISTINCT u.id)
              FROM tbl_users u
              JOIN tbl_user_role_scopes urs ON urs.user_id = u.id AND urs.role_id = v_to
               AND urs.company_id = t.hospitality_company_id
               AND (urs.hotel_id IS NULL OR urs.hotel_id = t.hotel_id)
              JOIN tbl_hospitality_user_mappings hum ON hum.user_id = u.id
               AND hum.hospitality_company_id = t.hospitality_company_id
               AND ((t.hotel_id IS NULL AND hum.mapping_type = 0) OR hum.hospitality_hotel_id = t.hotel_id
                    OR (hum.mapping_type = 0 AND hum.hospitality_hotel_id IS NULL))
             WHERE u.status = 1) AS evaluators,
           (SELECT count(DISTINCT u.id)
              FROM tbl_users u
              JOIN tbl_user_role_scopes urs ON urs.user_id = u.id AND urs.role_id = v_from
               AND urs.company_id = t.hospitality_company_id
               AND (urs.hotel_id IS NULL OR urs.hotel_id = t.hotel_id)
              JOIN tbl_hospitality_user_mappings hum ON hum.user_id = u.id
               AND hum.hospitality_company_id = t.hospitality_company_id
               AND ((t.hotel_id IS NULL AND hum.mapping_type = 0) OR hum.hospitality_hotel_id = t.hotel_id
                    OR (hum.mapping_type = 0 AND hum.hospitality_hotel_id IS NULL))
             WHERE u.status = 1) AS approvers
      FROM _t03 t ORDER BY t.policy_id
  LOOP
    RAISE NOTICE '  policy % (company %, unit %): step → "%" rule ALL; % active evaluator(s) at the unit (today: % holder(s) of "%")',
      r.policy_id, r.hospitality_company_id, COALESCE(r.hotel_id::text, 'all'), prm.arc_to_role_title,
      r.evaluators, r.approvers, prm.arc_from_role_title;
    IF r.evaluators = 0 THEN
      RAISE EXCEPTION 'policy %: nobody holds "%" at company % unit % — rounds there could not be launched; refusing',
        r.policy_id, prm.arc_to_role_title, r.hospitality_company_id, COALESCE(r.hotel_id::text, 'all');
    END IF;
  END LOOP;
END $pre03$;

DO $chg03$
DECLARE
  prm  record;
  tgt  record;
  n    int;
BEGIN
  SELECT * INTO STRICT prm FROM _params;

  CREATE TEMP TABLE _t03_steps_before AS
  SELECT s.* FROM tbl_approval_policy_steps s WHERE s.id IN (SELECT step_id FROM _t03);
  CREATE TEMP TABLE _t03_policies_before AS
  SELECT p.* FROM tbl_approval_policies p WHERE p.id IN (SELECT policy_id FROM _t03);

  PERFORM pg_temp.bak_create('03');
  PERFORM pg_temp.bak_put('03', 'tbl_approval_policies',     'before', (SELECT array_agg(policy_id) FROM _t03));
  PERFORM pg_temp.bak_put('03', 'tbl_approval_policy_steps', 'before', (SELECT array_agg(step_id) FROM _t03));

  FOR tgt IN SELECT * FROM _t03 ORDER BY policy_id LOOP
    UPDATE tbl_approval_policy_steps
       SET approver_source_id = tgt.to_role_id, decision_rule = 'ALL'
     WHERE id = tgt.step_id AND approver_source_type = 'ROLE' AND approver_source_id = tgt.from_role_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'policy %: step % not updated', tgt.policy_id, tgt.step_id; END IF;

    INSERT INTO tbl_approval_policy_change_log
      (approval_policy_id, changed_by, change_type, change_summary, affected_instance_ids)
    VALUES (tgt.policy_id, prm.actor_id, 'SCRIPT_ARC_ROUND_PEER_APPROVAL',
            jsonb_build_object(
              'request_id', prm.request_id,
              'step_id', tgt.step_id,
              'from', jsonb_build_object('approver_source_id', tgt.from_role_id, 'role_title', prm.arc_from_role_title,
                                         'decision_rule', tgt.decision_rule),
              'to',   jsonb_build_object('approver_source_id', tgt.to_role_id, 'role_title', prm.arc_to_role_title,
                                         'decision_rule', 'ALL')),
            '{}');
    UPDATE tbl_approval_policies SET version = COALESCE(version, 1) + 1, updated_at = NOW() WHERE id = tgt.policy_id;
  END LOOP;

  -- postchecks: the same step row, only its source and rule changed; the
  -- policy changed only in version; the step now passes the read+approve gate
  IF EXISTS (SELECT 1 FROM _t03_steps_before b
               JOIN _t03 t ON t.step_id = b.id
               LEFT JOIN tbl_approval_policy_steps s ON s.id = b.id
              WHERE s.id IS NULL
                 OR s.approver_source_id <> t.to_role_id OR s.decision_rule <> 'ALL'
                 OR (to_jsonb(s) - 'approver_source_id' - 'decision_rule')
                    <> (to_jsonb(b) - 'approver_source_id' - 'decision_rule')) THEN
    RAISE EXCEPTION 'a target step is not what it should be';
  END IF;
  IF EXISTS (SELECT 1 FROM _t03_policies_before b JOIN tbl_approval_policies p ON p.id = b.id
              WHERE p.version IS DISTINCT FROM COALESCE(b.version, 1) + 1
                 OR (to_jsonb(p) - 'version' - 'updated_at') <> (to_jsonb(b) - 'version' - 'updated_at')) THEN
    RAISE EXCEPTION 'a target policy changed beyond its version';
  END IF;
  IF EXISTS (SELECT 1 FROM _t03 t
              WHERE (SELECT count(DISTINCT pm.action) FROM tbl_role_permissions rp JOIN tbl_permissions pm ON pm.id = rp.permission_id
                      WHERE rp.role_id = t.to_role_id
                        AND pm.resource::text = (SELECT m.resource FROM _resource_map m WHERE m.entity_type = t.entity_type)
                        AND pm.action IN ('read', 'approve')) <> 2) THEN
    RAISE EXCEPTION 'a converted step would not pass the read+approve gate for its entity type';
  END IF;

  SELECT count(*) INTO n FROM tbl_approval_policy_change_log
   WHERE change_type = 'SCRIPT_ARC_ROUND_PEER_APPROVAL' AND change_summary->>'request_id' = prm.request_id::text
     AND changed_by = prm.actor_id AND approval_policy_id IN (SELECT policy_id FROM _t03);
  IF n <> (SELECT count(*) FROM _t03) THEN
    RAISE EXCEPTION 'expected % change-log row(s), found %', (SELECT count(*) FROM _t03), n;
  END IF;

  PERFORM pg_temp.bak_put('03', 'tbl_approval_policies',     'after', (SELECT array_agg(policy_id) FROM _t03));
  PERFORM pg_temp.bak_put('03', 'tbl_approval_policy_steps', 'after', (SELECT array_agg(step_id) FROM _t03));
  RAISE NOTICE 'converted % ARC round policy step(s) in place; version +1; change log written', (SELECT count(*) FROM _t03);
END $chg03$;

\ir lib/assert_pending_unchanged.sql
