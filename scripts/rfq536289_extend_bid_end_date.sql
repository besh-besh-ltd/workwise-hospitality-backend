-- ===========================================================================
--  RFQ 536289 (id 747) — The Orchid Hotel Panchgani, Crockery & Glassware
--  Re-open the quote submission window so the vendor can answer the six
--  technical clauses they never answered.
--
--  CLIENT-CONFIRMED DEADLINE: 2026-08-26 17:19 IST.
--  Kamat Hotels asked for 26 Aug at the same time of day the window originally
--  closed (11 Aug 17:19), so the new value keeps 17:19 and moves only the date.
--
--  The deadline is still a REQUIRED parameter with no default — it is not baked
--  in, so a re-run after the date has lapsed cannot silently reuse a stale value.
--  Pass it explicitly:  -v new_bid_end_date='2026-08-26 17:19'
-- ===========================================================================
--
--  WHY THIS EXISTS
--  ---------------
--  Vendor 497 priced all 14 lines on 8 Aug. Six of those
--  products carry one technical clause each, and they answered none. The window
--  then closed on 11 Aug 17:19 IST, and four independent guards locked the RFQ:
--
--    * addVendorResponse refuses a technical answer once bid_end_date has
--      passed, so the vendor cannot answer.
--    * getVendorScoresForTechEval builds the buyer's scoring list from response
--      rows, so the buyer has nobody to score.
--    * the commercial gate's first condition is RFQ-WIDE — a vendor is dropped
--      from EVERY product unless they hold a technical pass somewhere on the
--      RFQ — so all 14 priced lines read as "awaiting quote".
--    * assertEditAllowed refused every edit, so nobody could re-open the window.
--
--  Moving bid_end_date into the future releases the first three. The fourth is
--  fixed in code on fix/tech-eval-unstartable-edit-unlock; once THAT is
--  deployed the RFQ creator can do this from the Edit screen and this script is
--  unnecessary. Use it only to unblock the client before that deploy.
--
--  WHAT THIS DOES NOT DO
--  ---------------------
--  The app's Edit flow also emails all 31 mapped vendors about the change
--  (sendVendorEditNotifications). This script does NOT. Whoever runs it must
--  contact the quoting vendor directly — the only quote on this RFQ, vendor id
--  497; take the email and mobile from tbl_users at run time — otherwise the
--  window re-opens and nobody knows.
--
--  It also leaves vendor_clarification_date alone at 2026-08-08 10:00. That is
--  fine: this RFQ is not a tender (is_tender = 0) so the clarification window is
--  unused, and the app's only rule is clarification <= bid_end - 1h, which a
--  past date satisfies.
--
--  SHAPE
--  -----
--  Mirrors what the app wrote when this same creator extended this same RFQ on
--  7 Aug (change_history #762, lifecycle #12461): one tbl_rfq UPDATE, one
--  is_material change-history row, one PUBLISHED/EDIT lifecycle row, all
--  attributed to the creator, all sharing one edit_session_id. No re-approval —
--  the app skips that branch for published RFQs and this matches.
--
--  HOW TO RUN
--  ----------
--    # 1. dry run — guards + before/after, then ROLLBACK. Safe.
--    psql -h <host> -U postgres -d hospitality_main \
--         -v new_bid_end_date='2026-08-26 17:19' \
--         -f scripts/rfq536289_extend_bid_end_date.sql
--
--    # 2. for real — same command plus -v commit=yes
--    psql -h <host> -U postgres -d hospitality_main \
--         -v new_bid_end_date='2026-08-26 17:19' -v commit=yes \
--         -f scripts/rfq536289_extend_bid_end_date.sql
--
--  Without -v commit=yes the transaction rolls back, so the dry run is the
--  default and committing is the deliberate act.
--
--  NOTE ON psql VARIABLES: the parameter is copied into a temp table before any
--  DO block reads it. psql does NOT interpolate :vars inside dollar-quoted
--  bodies, so a DO block referring to :new_bid_end_date directly would be a
--  syntax error rather than a substitution.
-- ===========================================================================

\set ON_ERROR_STOP on

\if :{?new_bid_end_date}
\else
  \echo ''
  \echo '*** ABORT: no deadline supplied.'
  \echo '*** Kamat Hotels must confirm how long to re-open the window, then:'
  \echo '***   psql ... -v new_bid_end_date=''YYYY-MM-DD HH:MM'' -f <this file>'
  \echo ''
  \quit
\endif

\if :{?commit}
\else
  \set commit 'no'
\endif

\echo ''
\echo '=== RFQ 536289 — re-open the quote submission window ==='
\echo 'requested bid_end_date (naive IST wall clock):' :'new_bid_end_date'
\echo 'commit:' :'commit'

BEGIN;

-- The parameter, in a form the DO blocks below can actually read.
CREATE TEMP TABLE _p ON COMMIT DROP AS
  SELECT :'new_bid_end_date'::text AS new_bid_end_date,
         :'commit'::text           AS do_commit;

-- ---------------------------------------------------------------------------
-- Guard 1: the new deadline must parse as a timestamp, and must be comfortably
-- in the future.
--
-- The app requires >= now + 2h. This asks for >= now + 12h on purpose:
-- bid_end_date is naive IST read through the Postgres session timezone, and
-- addVendorResponse's own check treats it as END OF DAY in the server's local
-- zone. A margin of a few hours can land on the wrong side of a 5h30m skew. A
-- margin of half a day cannot.
-- ---------------------------------------------------------------------------
DO $guard1$
DECLARE
  v_raw text;
  v_new timestamp;
  v_ist_now timestamp := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata');
BEGIN
  SELECT new_bid_end_date INTO v_raw FROM _p;

  BEGIN
    v_new := CAST(v_raw AS timestamp);
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Could not parse "%" as a timestamp. Use ''YYYY-MM-DD HH:MM''.', v_raw;
  END;

  IF v_new < v_ist_now + interval '12 hours' THEN
    RAISE EXCEPTION
      'New deadline % is not far enough ahead of IST now (%). Give it at least 12 hours of margin.',
      v_new, v_ist_now;
  END IF;

  RAISE NOTICE 'Guard 1 ok: % is % ahead of IST now', v_new, (v_new - v_ist_now);
END
$guard1$;

-- ---------------------------------------------------------------------------
-- Guard 2: this must still be the RFQ we diagnosed on 24 Aug 2026. If anything
-- has moved, stop and re-read the situation rather than writing blind.
-- ---------------------------------------------------------------------------
DO $guard2$
DECLARE
  r record;
  v_answered int;
BEGIN
  SELECT id, rfq_no, status, is_published, created_by, bid_end_date
    INTO r
    FROM tbl_rfq
   WHERE id = 747;

  IF r.id IS NULL THEN
    RAISE EXCEPTION 'RFQ id 747 not found. Wrong database?';
  END IF;
  IF r.rfq_no <> 536289 THEN
    RAISE EXCEPTION 'id 747 is rfq_no %, expected 536289. Wrong database or wrong row.', r.rfq_no;
  END IF;
  IF r.status <> 1 THEN
    RAISE EXCEPTION 'RFQ 536289 is status % (expected 1 = open). It may have been closed — re-check before extending.', r.status;
  END IF;
  IF r.is_published <> 1 THEN
    RAISE EXCEPTION 'RFQ 536289 is not published (is_published = %).', r.is_published;
  END IF;
  IF r.created_by <> 467 THEN
    RAISE EXCEPTION 'Creator is now %, expected 467 — the attribution below would be wrong.', r.created_by;
  END IF;

  -- The entire premise is that nobody has answered. If someone has since
  -- answered, the deadlock is already gone and re-opening the window would be
  -- an unnecessary commercial change.
  SELECT COUNT(*) INTO v_answered
    FROM tbl_rfq_product_tech_evaluation te
    JOIN tbl_rfq_product_tech_evaluation_clauses c
      ON c.tbl_rfq_product_tech_evaluation_id = te.id
    JOIN tbl_rfq_product_tech_evaluation_vendors_response vr
      ON vr.tbl_rfq_product_tech_evaluation_clauses_id = c.id
   WHERE te.rfq_id = 747
     AND COALESCE(TRIM(vr.vendor_response), '') NOT IN ('', 'N/A');

  IF v_answered > 0 THEN
    RAISE EXCEPTION
      'A vendor has now answered % technical clause(s) on RFQ 536289. The deadlock is resolved — do not extend.', v_answered;
  END IF;

  RAISE NOTICE 'Guard 2 ok: rfq_no %, status %, creator %, current bid_end_date %, clauses answered 0',
    r.rfq_no, r.status, r.created_by, r.bid_end_date;
END
$guard2$;

\echo ''
\echo '=== BEFORE ==='
SELECT id, rfq_no, status, bid_end_date, vendor_clarification_date
  FROM tbl_rfq WHERE id = 747;

-- ---------------------------------------------------------------------------
-- The change, plus its audit trail. One edit_session_id ties the three rows
-- together exactly as the app's snapshot-diff flow does.
-- ---------------------------------------------------------------------------
DO $apply$
DECLARE
  v_session uuid := gen_random_uuid();
  v_new     text;
  v_old     text;
BEGIN
  SELECT new_bid_end_date INTO v_new FROM _p;
  SELECT bid_end_date     INTO v_old FROM tbl_rfq WHERE id = 747;

  UPDATE tbl_rfq
     SET bid_end_date = v_new,
         updated_by   = 467
   WHERE id = 747;

  -- WH-69 change history. old_value / new_value hold JSON-encoded scalars in
  -- this table (see rows #762/#763 from the 7 Aug edit), hence to_jsonb.
  INSERT INTO tbl_rfq_change_history
    (rfq_id, edit_session_id, entity_type, entity_id, entity_label,
     field_name, change_type, old_value, new_value, is_material, changed_by, changed_at)
  VALUES
    (747, v_session, 'RFQ', 747, NULL,
     'bid_end_date', 'UPDATE', to_jsonb(v_old), to_jsonb(v_new),
     true, 467, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'));

  INSERT INTO tbl_lifecycle_history
    (entity_id, entity_type, stage, action, performed_by, metadata, remarks, created_at)
  VALUES
    (747, 'RFQ', 'PUBLISHED', 'EDIT', 467,
     jsonb_build_object(
       'material', true,
       'reapproval', NULL,
       'field_count', 1,
       'edit_session_id', v_session::text,
       'applied_by', 'support SQL, not the Edit screen',
       'reason', 'Technical-evaluation deadlock: vendor 497 priced six clause-bearing lines and answered no clauses, then the window closed. Re-opened so they can answer. assertEditAllowed had no unlock branch for this state — see fix/tech-eval-unstartable-edit-unlock.',
       'vendors_notified', false
     ),
     'RFQ 536289 technical-evaluation deadlock repair',
     (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'));

  RAISE NOTICE 'Applied: bid_end_date "%" -> "%", edit_session_id %', v_old, v_new, v_session;
END
$apply$;

\echo ''
\echo '=== AFTER ==='
SELECT id, rfq_no, status, bid_end_date, vendor_clarification_date
  FROM tbl_rfq WHERE id = 747;

\echo ''
\echo '=== audit trail written ==='
SELECT id, field_name, old_value, new_value, is_material, changed_by, changed_at
  FROM tbl_rfq_change_history
 WHERE rfq_id = 747 ORDER BY id DESC LIMIT 3;

SELECT id, stage, action, performed_by, created_at
  FROM tbl_lifecycle_history
 WHERE entity_id = 747 AND entity_type = 'RFQ' ORDER BY id DESC LIMIT 3;

\echo ''
\echo '=== the six clauses the vendor now needs to answer ==='
SELECT rp.id AS rfq_product_id, pv.name AS product,
       c.id AS clause_id, TRIM(c.clause_text) AS clause, te.minimum_passing_score
  FROM tbl_rfq_product_tech_evaluation te
  JOIN tbl_rfq_products rp ON rp.id = te.tbl_rfq_product_id
  LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
  JOIN tbl_rfq_product_tech_evaluation_clauses c
    ON c.tbl_rfq_product_tech_evaluation_id = te.id
 WHERE te.rfq_id = 747
 ORDER BY rp.id;

-- ---------------------------------------------------------------------------
-- Commit only when explicitly asked. A run without -v commit=yes is a dry run:
-- every guard executes, the before/after prints, and nothing persists.
-- ---------------------------------------------------------------------------
SELECT CASE WHEN (SELECT do_commit FROM _p) = 'yes'
            THEN 'COMMITTING — the change is permanent.'
            ELSE 'DRY RUN — rolling back. Re-run with -v commit=yes to apply.'
       END AS outcome;

-- psql cannot branch on a query result, so the decision is made with a psql
-- variable: :commit is the literal 'yes' or 'no' set at the top.
\if :commit
COMMIT;
\else
ROLLBACK;
\endif

\echo ''
\echo '=== REMINDER: this script sends no email. Contact the quoting vendor'
\echo '=== (vendor id 497 — details in tbl_users) to say the window is open, and'
\echo '=== that they must answer the technical clauses above before re-submitting.'
