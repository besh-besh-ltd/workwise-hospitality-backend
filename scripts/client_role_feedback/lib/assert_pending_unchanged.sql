-- ═══════════════════════════════════════════════════════════════════════════
-- Refuse to continue unless the buyer's in-flight approvals are exactly as
-- they were before the change (_pending_before vs a fresh _pending_after).
-- Raising aborts the whole transaction, so nothing is committed.
-- ═══════════════════════════════════════════════════════════════════════════
\set pending_snapshot _pending_after
\ir pending_state.sql

CREATE TEMP TABLE _pending_diff AS
SELECT 'missing after' AS side, x.* FROM (SELECT * FROM _pending_before EXCEPT ALL SELECT * FROM _pending_after) x
UNION ALL
SELECT 'new after'     AS side, y.* FROM (SELECT * FROM _pending_after  EXCEPT ALL SELECT * FROM _pending_before) y;

DO $unchanged$
DECLARE
  n_before int;
  n_after  int;
  n_diff   int;
  sample   text;
BEGIN
  SELECT count(*) INTO n_before FROM _pending_before;
  SELECT count(*) INTO n_after  FROM _pending_after;
  SELECT count(*) INTO n_diff   FROM _pending_diff;
  IF n_diff > 0 THEN
    SELECT string_agg(format('%s: instance %s step %s (order %s, link %s) approver %s %s',
                             side, instance_id, step_id, step_order, policy_step_id,
                             approver_user_id, approver_status), E'\n  ')
      INTO sample
      FROM (SELECT * FROM _pending_diff ORDER BY instance_id, step_id, side LIMIT 25) f;
    RAISE EXCEPTION E'in-flight approvals changed (% row(s); first 25 shown) — refusing:\n  %', n_diff, sample;
  END IF;
  RAISE NOTICE 'in-flight approvals unchanged: % approver-slot row(s) before, % after, across % pending instance(s)',
    n_before, n_after, (SELECT count(DISTINCT instance_id) FROM _pending_after);
END $unchanged$;

DROP TABLE _pending_after;
DROP TABLE _pending_diff;
