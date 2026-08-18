-- Sr 54 — commercial-ranked shortlist gate on Technical Evaluation.
--
-- Blind-preserving design (spec §OQ1=A, §OQ2=A, user-confirmed): the SYSTEM
-- ranks the sealed commercial quotes at submission-close (both envelopes are
-- already sealed by then — see arcSubmissionCloseService.js) and stores a
-- per-(arc,vendor) shortlist row. Whole-ARC granularity — one rank per vendor
-- across their entire basket, not per item.
--
-- status:
--   'in_eval'  — one of the top-N (fixed N=5) lowest whole-ARC basket totals;
--                gets scored during technical evaluation.
--   'on_hold'  — rank > N; held back, never scored, never shown to the
--                evaluator beyond an aggregate on-hold COUNT.
--   'promoted' — was 'on_hold', auto-promoted into evaluation because an
--                'in_eval' vendor ended up not_qualified (Sr 54 §OQ4=Automatic).
--
-- commercial_rank + basket_total are SYSTEM-ONLY ranking data — the tech
-- evaluator is never shown either (blind-preserving; only membership +
-- counts reach the technical-stage payload). Never demoted back to
-- 'on_hold' once 'in_eval'/'promoted' (idempotent recompute-safe — see
-- arcEvaluationModel.computeAndStoreShortlist).
CREATE TABLE IF NOT EXISTS public.tbl_arc_tech_shortlist (
  id                BIGSERIAL PRIMARY KEY,
  arc_id            BIGINT  NOT NULL REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  vendor_id         INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  commercial_rank   INTEGER NOT NULL,               -- 1 = lowest whole-ARC basket total
  basket_total      NUMERIC(18,2),                  -- system-only ranking snapshot; NEVER exposed to the tech evaluator
  status            VARCHAR(16) NOT NULL DEFAULT 'on_hold',
  promoted_at       TIMESTAMP WITHOUT TIME ZONE,
  promoted_by       INTEGER REFERENCES public.tbl_users(id) ON DELETE SET NULL,
  created_at        TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (arc_id, vendor_id),
  CONSTRAINT arc_tech_shortlist_status_chk CHECK (status IN ('in_eval', 'on_hold', 'promoted'))
);
CREATE INDEX IF NOT EXISTS idx_arc_tech_shortlist_arc ON public.tbl_arc_tech_shortlist (arc_id);
