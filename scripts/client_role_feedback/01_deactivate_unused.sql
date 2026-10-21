-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 01 · retire the client's unused approval processes and policies
--
--   ./run.sh 01                                  # DRY: everything, then ROLLBACK
--   CONFIRM_DB=<db> ./run.sh 01 --commit         # real
--
-- Deactivates (is_active = false, updated_at = NOW(); nothing is deleted):
--   • the buyer's processes 'RFQ Approval', 'RFQ Approval Matrix', 'Unit ARC'
--     (prod 8 / 9 / 11), matched by buyer + name;
--   • every ACTIVE policy of the buyer that sits on one of those processes, or
--     is a TENDER policy that has never had an approval instance
--     (prod 8, 190, 191, 192, 193).
-- Keeps 'Day to Day Procurement' (prod 2) and everything on it.
--
-- Refuses unless: the counts and ids equal data.sql; nothing has ever used the
-- processes (RFQs, approval instances, ARCs, role grants — any status); no
-- target policy has ever had an instance; and the policy the engine picks for
-- every unit × {RFQ, TECHNICAL, NEGOTIATION, NEGOTIATION_QUOTE, PO} ×
-- {process 2, no process} is the same before and after.
--
-- Same rule as the admin UI's deactivateApprovalProcessIfUnused (Task 6), but
-- stricter: "ever", not "open".
-- ═══════════════════════════════════════════════════════════════════════════
\ir lib/backup.sql
\set pending_snapshot _pending_before
\ir lib/pending_state.sql

-- ── preflight ───────────────────────────────────────────────────────────────
DO $pre01$
DECLARE
  prm     record;
  v_kept  int;
  v_ids   int[];
  r       record;
  busy    text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO STRICT prm FROM _params;

  SELECT pr.id INTO v_kept
    FROM tbl_approval_processes pr
   WHERE pr.company_id = prm.buyer_company_id AND pr.name = prm.kept_process_name AND pr.is_active;
  IF v_kept IS DISTINCT FROM prm.expected_kept_process_id THEN
    RAISE EXCEPTION 'kept process "%" of buyer % is % (active), expected % — refusing',
      prm.kept_process_name, prm.buyer_company_id, COALESCE(v_kept::text, 'missing'), prm.expected_kept_process_id;
  END IF;

  -- the processes: lock, then count and compare ids. FOR NO KEY UPDATE: only
  -- is_active/updated_at change, so foreign-key checks (KEY SHARE) from rows
  -- being inserted elsewhere are not blocked.
  PERFORM 1 FROM tbl_approval_processes pr
   WHERE pr.company_id = prm.buyer_company_id AND pr.name = ANY (prm.unused_process_names)
   FOR NO KEY UPDATE;
  CREATE TEMP TABLE _t01_processes AS
  SELECT pr.id, pr.name
    FROM tbl_approval_processes pr
   WHERE pr.company_id = prm.buyer_company_id
     AND pr.name = ANY (prm.unused_process_names)
     AND pr.is_active;
  SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_ids FROM _t01_processes;
  IF cardinality(v_ids) <> prm.expected_unused_processes
     OR v_ids <> (SELECT array_agg(x ORDER BY x) FROM unnest(prm.expected_unused_process_ids) x) THEN
    RAISE EXCEPTION 'active unused processes of buyer % are % (expected % = %) — refusing%',
      prm.buyer_company_id, v_ids, prm.expected_unused_processes, prm.expected_unused_process_ids,
      CASE WHEN cardinality(v_ids) = 0 THEN ' (already applied?)' ELSE '' END;
  END IF;

  -- anything that has ever used them
  FOR r IN
    SELECT 'RFQs' AS what, count(*) AS n FROM tbl_rfq x WHERE x.process_id IN (SELECT id FROM _t01_processes)
    UNION ALL SELECT 'approval instances', count(*) FROM tbl_approval_instances x WHERE x.process_id IN (SELECT id FROM _t01_processes)
    UNION ALL SELECT 'rate contracts (ARC)', count(*) FROM tbl_arc x WHERE x.process_id IN (SELECT id FROM _t01_processes)
    UNION ALL SELECT 'role grants', count(*) FROM tbl_user_role_scopes x WHERE x.process_id IN (SELECT id FROM _t01_processes)
  LOOP
    IF r.n > 0 THEN busy := busy || (r.n || ' ' || r.what); END IF;
  END LOOP;
  IF cardinality(busy) > 0 THEN
    RAISE EXCEPTION E'processes % are in use — refusing:\n  - %', v_ids, array_to_string(busy, E'\n  - ');
  END IF;

  -- the policies: on those processes, or TENDER with no instance ever
  PERFORM 1 FROM tbl_approval_policies p
    JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
   WHERE hc.buyer_company_id = prm.buyer_company_id
     AND p.is_active
     AND (p.process_id IN (SELECT id FROM _t01_processes) OR p.entity_type = 'TENDER')
   FOR NO KEY UPDATE OF p;
  CREATE TEMP TABLE _t01_policies AS
  SELECT p.id, p.entity_type, p.hospitality_company_id, p.hotel_id, p.process_id
    FROM tbl_approval_policies p
    JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
   WHERE hc.buyer_company_id = prm.buyer_company_id
     AND p.is_active
     AND (p.process_id IN (SELECT id FROM _t01_processes)
          OR (p.entity_type = 'TENDER'
              AND NOT EXISTS (SELECT 1 FROM tbl_approval_instances i WHERE i.approval_policy_id = p.id)));
  SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_ids FROM _t01_policies;
  IF cardinality(v_ids) <> prm.expected_unused_policies
     OR v_ids <> (SELECT array_agg(x ORDER BY x) FROM unnest(prm.expected_unused_policy_ids) x) THEN
    RAISE EXCEPTION 'unused policies of buyer % are % (expected % = %) — refusing',
      prm.buyer_company_id, v_ids, prm.expected_unused_policies, prm.expected_unused_policy_ids;
  END IF;

  -- a policy on a retired process that HAS instances would have been caught
  -- by the process check; say so explicitly for the TENDER side too
  IF EXISTS (SELECT 1 FROM tbl_approval_instances i WHERE i.approval_policy_id IN (SELECT id FROM _t01_policies)) THEN
    RAISE EXCEPTION 'a target policy has approval instances — refusing';
  END IF;

  -- Informational (decision D4: no tenders through workflows). Once the TENDER
  -- policies are off, submitting a Tender at these units is refused
  -- (startApprovalForRfq) — the intended dead end. Says how many open ones exist.
  RAISE NOTICE '  open Tender RFQs (is_tender = 1, not closed/withdrawn) at the buyer''s units: %',
    (SELECT count(*) FROM tbl_rfq x
       JOIN tbl_hospitality_companies hc ON hc.id = x.hospitality_company_id
      WHERE hc.buyer_company_id = prm.buyer_company_id AND x.is_tender = 1
        AND (x.status IS NULL OR x.status NOT IN (2, 5)));

  FOR r IN SELECT * FROM _t01_processes ORDER BY id LOOP
    RAISE NOTICE '  process % "%" → inactive', r.id, r.name;
  END LOOP;
  FOR r IN SELECT * FROM _t01_policies ORDER BY id LOOP
    RAISE NOTICE '  policy % % (company %, unit %, process %) → inactive',
      r.id, r.entity_type, r.hospitality_company_id, COALESCE(r.hotel_id::text, 'all'), COALESCE(r.process_id::text, 'none');
  END LOOP;
END $pre01$;

\set matcher_snapshot _match_before
\ir lib/matcher_snapshot.sql

-- ── backup, change, backup ──────────────────────────────────────────────────
DO $chg01$
DECLARE
  n_proc int;
  n_pol  int;
BEGIN
  PERFORM pg_temp.bak_create('01');
  PERFORM pg_temp.bak_put('01', 'tbl_approval_processes', 'before', (SELECT array_agg(id) FROM _t01_processes));
  PERFORM pg_temp.bak_put('01', 'tbl_approval_policies',  'before', (SELECT array_agg(id) FROM _t01_policies));

  UPDATE tbl_approval_processes SET is_active = false, updated_at = NOW()
   WHERE id IN (SELECT id FROM _t01_processes) AND is_active;
  GET DIAGNOSTICS n_proc = ROW_COUNT;
  UPDATE tbl_approval_policies SET is_active = false, updated_at = NOW()
   WHERE id IN (SELECT id FROM _t01_policies) AND is_active;
  GET DIAGNOSTICS n_pol = ROW_COUNT;
  IF n_proc <> (SELECT count(*) FROM _t01_processes) OR n_pol <> (SELECT count(*) FROM _t01_policies) THEN
    RAISE EXCEPTION 'deactivated % process(es) / % policy(ies), expected % / %',
      n_proc, n_pol, (SELECT count(*) FROM _t01_processes), (SELECT count(*) FROM _t01_policies);
  END IF;

  PERFORM pg_temp.bak_put('01', 'tbl_approval_processes', 'after', (SELECT array_agg(id) FROM _t01_processes));
  PERFORM pg_temp.bak_put('01', 'tbl_approval_policies',  'after', (SELECT array_agg(id) FROM _t01_policies));
  RAISE NOTICE 'deactivated % process(es) and % policy(ies)', n_proc, n_pol;
END $chg01$;

-- ── postchecks ──────────────────────────────────────────────────────────────
\set matcher_snapshot _match_after
\ir lib/matcher_snapshot.sql

DO $post01$
DECLARE
  n_diff int;
  sample text;
BEGIN
  SELECT count(*) INTO n_diff FROM (
    (SELECT * FROM _match_before EXCEPT ALL SELECT * FROM _match_after)
    UNION ALL
    (SELECT * FROM _match_after EXCEPT ALL SELECT * FROM _match_before)) d;
  IF n_diff > 0 THEN
    SELECT string_agg(format('company %s unit %s %s process %s: %s → %s',
                             b.co, COALESCE(b.hotel_id::text, '-'), b.entity_type, COALESCE(b.process_id::text, 'none'),
                             COALESCE(b.policy_id::text, 'none'), COALESCE(a.policy_id::text, 'none')), E'\n  ')
      INTO sample
      FROM _match_before b
      JOIN _match_after a ON a.co = b.co AND a.hotel_id IS NOT DISTINCT FROM b.hotel_id
                         AND a.entity_type = b.entity_type AND a.process_id IS NOT DISTINCT FROM b.process_id
     WHERE a.policy_id IS DISTINCT FROM b.policy_id;
    RAISE EXCEPTION E'the engine would now pick a different policy (% row(s)) — refusing:\n  %', n_diff, sample;
  END IF;
  RAISE NOTICE 'matcher snapshot unchanged: % (unit × entity type × process) combination(s), % resolve to a policy',
    (SELECT count(*) FROM _match_after), (SELECT count(*) FROM _match_after WHERE policy_id IS NOT NULL);

  IF EXISTS (SELECT 1 FROM tbl_approval_policies p
              WHERE p.process_id IN (SELECT id FROM _t01_processes) AND p.is_active) THEN
    RAISE EXCEPTION 'a retired process still has an active policy';
  END IF;
END $post01$;

\ir lib/assert_pending_unchanged.sql
