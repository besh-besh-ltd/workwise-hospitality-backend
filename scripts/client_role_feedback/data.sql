-- ═══════════════════════════════════════════════════════════════════════════
-- Client role feedback data changes · THE INPUTS, in one place
--
-- Loaded by run.sh ahead of every step (and, vars only, ahead of the read-only
-- reconcile report), so every step reads the same facts.
--
-- Two parts:
--   1. psql variables. Constants are set unconditionally. EXPECTATIONS (counts
--      and ids the preflights assert) are defaults that `-v name=value` can
--      override; run.sh prints a loud OVERRIDE line when that happens. Only
--      override after a DRY run has shown the real number and a human has
--      agreed the difference is benign.
--   2. temp tables (_params, _resource_map, …) the plpgsql blocks read —
--      psql variables are not interpolated inside dollar-quoted DO bodies.
--      Skipped when run.sh sets vars_only (read-only reconcile: a read-only
--      transaction may not CREATE even a temp table).
--
-- The expectations are the production facts verified read-only on 2026-10-19
-- (buyer tbl_company 13 = the client):
--   01  processes 8 'RFQ Approval', 9 'RFQ Approval Matrix', 11 'Unit ARC'
--       (0 RFQs / instances / ARCs / role grants); policies 8 (TENDER, hotel 4,
--       process 2, 0 instances ever) and 190 TENDER, 191 TECHNICAL,
--       192 NEGOTIATION, 193 NEGOTIATION_QUOTE (process 9, hotel 11, 0 instances).
--       Process 2 'Day to Day Procurement' is kept.
--   02  ≈ 25 RFQ + 27 TECHNICAL + 1 TENDER (policy 190) = 53 policies,
--       active and inactive, carrying a dead 'RFQ Creator' / 'Technical
--       Evaluator' level. "≈": the preflight re-counts and refuses on any
--       difference.
--   03  policy 221 (ARC_NEGOTIATION, hotel 6): one ROLE step on
--       'ARC Commercial Approver', rule ANY.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── constants ───────────────────────────────────────────────────────────────
\set buyer_company_id 13
-- user 150 "Phileein Hospitality", the operator account the client's
-- matrices are configured under (also the actor on Plaza / Orchid changes)
\set actor_id 150

-- ENTITY_APPROVE_RESOURCE_MAP (app/models/generalModel.js), verbatim. The
-- read+approve gate a ROLE step must pass at instance creation.
\set resource_map '(''RFQ'',''rfq''),(''TENDER'',''boq''),(''TECHNICAL'',''te''),(''NEGOTIATION'',''negotiation''),(''NEGOTIATION_QUOTE'',''quote-compare''),(''PO'',''awarding''),(''MR'',''mr''),(''ARC'',''arc''),(''ARC_PUBLISH'',''arc''),(''ARC_TECH'',''arc-tech''),(''ARC_NEGOTIATION'',''arc-comm''),(''ARC_COMMITTEE'',''arc-committee''),(''ARC_AMENDMENT'',''arc''),(''ARC_GROUP'',''arc''),(''ARC_GROUP_TECH'',''arc-tech''),(''ARC_GROUP_NEGOTIATION'',''arc-comm''),(''ARC_GROUP_COMMITTEE'',''arc-committee''),(''ARC_GROUP_AMENDMENT'',''arc'')'

-- ── expectations (overridable with -v, see header) ──────────────────────────
\if :{?expected_unused_processes}     \else \set expected_unused_processes 3                            \endif
\if :{?expected_unused_process_ids}   \else \set expected_unused_process_ids '{8,9,11}'                 \endif
\if :{?expected_kept_process_id}      \else \set expected_kept_process_id 2                             \endif
\if :{?expected_unused_policies}      \else \set expected_unused_policies 5                             \endif
\if :{?expected_unused_policy_ids}    \else \set expected_unused_policy_ids '{8,190,191,192,193}'       \endif
\if :{?expected_dead_level_policies}  \else \set expected_dead_level_policies 53                        \endif
\if :{?expected_dead_level_breakdown} \else \set expected_dead_level_breakdown 'RFQ=25,TECHNICAL=27,TENDER=1' \endif
\if :{?expected_arc_round_policies}   \else \set expected_arc_round_policies 1                          \endif
\if :{?expected_arc_round_policy_ids} \else \set expected_arc_round_policy_ids '{221}'                  \endif
-- report filter (reconcile_report.sql): '' = every policy of the buyer
\if :{?target_policies}               \else \set target_policies ''                                     \endif
-- only the 99_rollback_* steps use it: the request id of the run to undo
\if :{?rollback_request_id}           \else \set rollback_request_id ''                                 \endif

\if :{?vars_only}
\else

-- ── temp tables for the plpgsql blocks ──────────────────────────────────────
\if :{?request_id} \else
  \echo 'data.sql: request_id is not set (run through run.sh)'
  SELECT 1/0 AS request_id_missing;
\endif
\if :{?expected_db} \else
  \echo 'data.sql: expected_db is not set (run through run.sh)'
  SELECT 1/0 AS expected_db_missing;
\endif

CREATE TEMP TABLE _params AS
SELECT :buyer_company_id::int                          AS buyer_company_id,
       :actor_id::int                                  AS actor_id,
       :'request_id'::uuid                             AS request_id,
       left(replace(:'request_id', '-', ''), 8)        AS request_short,
       NULLIF(:'rollback_request_id', '')::uuid        AS rollback_request_id,
       left(replace(NULLIF(:'rollback_request_id', ''), '-', ''), 8) AS rollback_short,
       :'expected_db'::text                            AS expected_db,
       :expected_unused_processes::int                 AS expected_unused_processes,
       :'expected_unused_process_ids'::int[]           AS expected_unused_process_ids,
       :expected_kept_process_id::int                  AS expected_kept_process_id,
       :expected_unused_policies::int                  AS expected_unused_policies,
       :'expected_unused_policy_ids'::int[]            AS expected_unused_policy_ids,
       :expected_dead_level_policies::int              AS expected_dead_level_policies,
       :'expected_dead_level_breakdown'::text          AS expected_dead_level_breakdown,
       :expected_arc_round_policies::int               AS expected_arc_round_policies,
       :'expected_arc_round_policy_ids'::int[]         AS expected_arc_round_policy_ids,
       -- 01: the processes to retire (matched by buyer + name; names are
       -- UNIQUE per company, uq_process_company_name) and the one to keep
       ARRAY['RFQ Approval', 'RFQ Approval Matrix', 'Unit ARC']::text[] AS unused_process_names,
       'Day to Day Procurement'::text                  AS kept_process_name,
       -- 01: matcher snapshot dimensions. TENDER is left out on purpose: its
       -- policies are the ones being retired.
       ARRAY['RFQ', 'TECHNICAL', 'NEGOTIATION', 'NEGOTIATION_QUOTE', 'PO']::text[] AS matcher_entity_types,
       -- 02: system roles (created_by IS NULL) whose levels are dead
       ARRAY['RFQ Creator', 'Technical Evaluator']::text[] AS dead_level_role_titles,
       -- 03: the round-approval role swap
       'ARC Commercial Approver'::text                 AS arc_from_role_title,
       'ARC Commercial Evaluator'::text                AS arc_to_role_title,
       ARRAY['ARC_NEGOTIATION', 'ARC_GROUP_NEGOTIATION']::text[] AS arc_round_entity_types;

CREATE TEMP TABLE _resource_map AS
SELECT * FROM (VALUES :resource_map) AS v(entity_type, resource);

DO $guard$
BEGIN
  IF current_database() <> (SELECT expected_db FROM _params) THEN
    RAISE EXCEPTION 'connected to %, but this run was confirmed for %',
      current_database(), (SELECT expected_db FROM _params);
  END IF;
END $guard$;

-- every write in this transaction is attributed in tbl_audit_row_changes
-- (log_changes_direct reads both settings; see migrations/20260829090000)
SELECT set_config('app.actor_id', actor_id::text, true)     AS actor_id,
       set_config('app.request_id', request_id::text, true) AS request_id
  FROM _params \gset _audit_

\endif
