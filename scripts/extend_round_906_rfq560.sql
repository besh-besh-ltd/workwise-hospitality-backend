-- ============================================================================
-- Reopen negotiation round 906 (RFQ 560) for vendor 372 (PRATIK MALI).
--
--   STATUS: PREPARED, NOT EXECUTED. Awaiting explicit approval.
--   RECOMMENDATION: prefer OPTION B (new round) over this script. See below.
--
-- CONTEXT
-- Round 906 opened base_price + payment_terms for vendor 372, but every one of
-- that vendor's quote items stores delivery_period = ''. The revised quote was
-- refused by BOTH the wizard and the server — proven in
-- tests/services/rfq.negotiationDeadlock.repro.test.js. Seven rounds have been
-- created on this RFQ; the vendor has never been able to answer one, and
-- tbl_negotiation_round_quotes has zero rows for all of them.
--
-- The round reached its end_date at 2026-08-12 07:30:00 UTC (13:00 IST) and the
-- cron moved it ACTIVE -> ENDED. It is no longer live, so the original
-- "extend the deadline" plan no longer applies.
--
-- TIMEZONE: end_date is a naive column holding UTC. Proof, not assumption:
-- cronManager.js:1086-1088 appends 'Z' when parsing it, and the buyer UI sends
-- moment(...).utc() (NegotiationModal.js:759).
-- Requested 6 PM IST today -> 2026-08-12 18:00 IST -> 2026-08-12 12:30 UTC.
--
-- ---------------------------------------------------------------------------
-- OPTION A (this script): resurrect round 906.
--   Cost: the ACTIVE -> ENDED transition ALREADY fired its lifecycle event and
--   emailed the commercial evaluators that the round closed. Re-activating
--   leaves a trail that reads "ended, then un-ended" with no explaining event.
--
-- OPTION B (recommended): ship the fix, then have the buyer open round 8 from
--   the UI. That is a normal buyer action, produces a clean audit trail, and
--   needs no production write at all. The vendor loses nothing — no response
--   was ever recorded against round 906.
-- ---------------------------------------------------------------------------
--
-- ⚠ IF OPTION A IS CHOSEN, THE UPDATE ALONE IS NOT ENOUGH ⚠
-- Expiry is a ONE-TIME in-memory job scheduled at publish time
-- (negotiationController.js:1187 -> scheduleNegotiationRoundExpiration).
-- The backend re-reads end_date from the DB only on startup
-- (server.js:51 -> rescheduleAllNegotiationRoundExpirations, cronManager.js:1127).
-- So after running this you MUST restart/redeploy the backend, otherwise the
-- reopened round has no scheduled close at all and will hang ACTIVE forever.
--
-- Correct order:  1. deploy the deadlock fix   (otherwise the vendor is still stuck)
--                 2. run this UPDATE
--                 3. restart the backend       (registers the new close time)
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- STEP 1 — PRE-FLIGHT (read-only).
-- ---------------------------------------------------------------------------
SELECT
  nr.id                                    AS round_id,
  nr.rfq_id, r.rfq_no, nr.round_number,
  nr.status,
  nr.published_at,
  nr.closed_at,
  nr.end_date                              AS end_date_utc,
  nr.end_date + interval '5:30'            AS end_date_ist,
  now() AT TIME ZONE 'UTC'                 AS now_utc,
  nr.vendor_ids
FROM tbl_negotiation_rounds nr
JOIN tbl_rfq r ON r.id = nr.rfq_id
WHERE nr.id = 906;

-- The vendor must never have responded — if this is non-zero, STOP and
-- reassess, because reopening would then be rewriting a real submission.
SELECT count(*) AS responses_so_far
  FROM tbl_negotiation_round_quotes
 WHERE negotiation_round_id = 906;

-- No newer round should already exist for this RFQ, or reopening 906 would
-- run two live rounds at once (expect 0).
SELECT count(*) AS newer_live_rounds
  FROM tbl_negotiation_rounds
 WHERE rfq_id = 560 AND id <> 906 AND status IN ('ACTIVE','PENDING_APPROVAL');

-- ---------------------------------------------------------------------------
-- STEP 2 — THE CHANGE (inside a rolled-back transaction = DRY RUN).
-- To execute for real: change ROLLBACK to COMMIT on the final line.
-- ---------------------------------------------------------------------------
BEGIN;

UPDATE tbl_negotiation_rounds
   SET status     = 'ACTIVE',
       end_date   = TIMESTAMP '2026-08-12 12:30:00',   -- 6:00 PM IST today
       closed_at  = NULL,
       updated_at = NOW()
 WHERE id = 906
   AND status = 'ENDED'                                -- only ever re-opens an ENDED round
   -- Refuse a deadline already in the past. The date above is hardcoded but
   -- this script waits for approval, so it may well be run on a later day —
   -- and a past end_date would reopen the round either to close instantly on
   -- the next restart, or to hang ACTIVE with no scheduled close at all.
   -- If this matches 0 rows, update the timestamp rather than removing this.
   AND TIMESTAMP '2026-08-12 12:30:00' > (now() AT TIME ZONE 'UTC')
   AND NOT EXISTS (SELECT 1 FROM tbl_negotiation_round_quotes
                    WHERE negotiation_round_id = 906); -- never overwrite a real response

SELECT id, status,
       end_date                   AS end_date_utc,
       end_date + interval '5:30' AS end_date_ist,
       closed_at, updated_at
  FROM tbl_negotiation_rounds
 WHERE id = 906;

ROLLBACK;   -- <-- DRY RUN. Change to COMMIT only on explicit approval.
