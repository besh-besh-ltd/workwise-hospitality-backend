-- Up: 20260626100000_arc_manual_entry.sql
-- Provenance for manually-entered / backfilled ARCs: records that an ARC was hand-keyed by the
-- purchase team (not produced by the live wizard/vendor flow), the target stage it was landed at,
-- and a snapshot of the committee outcome (backfill has no live approval instance). One row per ARC.
-- Apply with: psql $DATABASE_URL -f migrations/20260626100000_arc_manual_entry.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.tbl_arc_manual_entry (
  id                     BIGSERIAL PRIMARY KEY,
  arc_id                 BIGINT      NOT NULL REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  is_manual              BOOLEAN     NOT NULL DEFAULT TRUE,
  target_stage           VARCHAR(20) NOT NULL,   -- draft|floated|evaluation|sig_pending|active|ended
  eligibility_overridden BOOLEAN     NOT NULL DEFAULT FALSE,
  committee_decision     VARCHAR(20),            -- approved|rejected (NULL pre-committee)
  committee_decided_at   TIMESTAMP,
  committee_decided_by   INTEGER REFERENCES public.tbl_users(id),
  committee_comment      TEXT,
  entered_by             INTEGER     NOT NULL REFERENCES public.tbl_users(id),
  entry_notes            TEXT,
  created_at             TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_arc_manual_entry_arc UNIQUE (arc_id),
  CONSTRAINT chk_arc_manual_entry_target_stage
    CHECK (target_stage IN ('draft','floated','evaluation','sig_pending','active','ended')),
  CONSTRAINT chk_arc_manual_entry_decision
    CHECK (committee_decision IS NULL OR committee_decision IN ('approved','rejected'))
);

CREATE INDEX IF NOT EXISTS idx_tbl_arc_manual_entry_arc ON public.tbl_arc_manual_entry(arc_id);

COMMIT;
