-- ARC v2 — Migration 5 of 10: ARC vendor quotes + commercial evaluation tables.
--
-- Implements plan §4.4. Single-BU release: no bu_id column on quote_line
-- (reserved for the future multi-BU release). Multi-vendor split awards
-- supported: tbl_arc_comm_evaluation_award holds one row per (item × vendor)
-- with allocated_qty (absolute, not a percentage — prevents rounding drift).
-- The reconciliation invariant SUM(allocated_qty) = tbl_arc_item.indicative_qty
-- is enforced in the controller (see plan §5.3) on every save.

CREATE TABLE IF NOT EXISTS public.tbl_arc_quote (
  id              BIGSERIAL PRIMARY KEY,
  arc_id          BIGINT  NOT NULL REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  vendor_id       INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  submitted_at    TIMESTAMP WITHOUT TIME ZONE,
  withdrawn_at    TIMESTAMP WITHOUT TIME ZONE,
  payment_terms   VARCHAR(255),
  gstin_used      VARCHAR(20),
  created_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (arc_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_quote_arc     ON public.tbl_arc_quote (arc_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_quote_vendor  ON public.tbl_arc_quote (vendor_id);

CREATE TABLE IF NOT EXISTS public.tbl_arc_quote_line (
  id              BIGSERIAL PRIMARY KEY,
  arc_quote_id    BIGINT  NOT NULL REFERENCES public.tbl_arc_quote(id) ON DELETE CASCADE,
  arc_item_id     BIGINT  NOT NULL REFERENCES public.tbl_arc_item(id) ON DELETE CASCADE,
  rate            NUMERIC(15,2),
  gst_pct         NUMERIC(5,2),
  charges         JSONB DEFAULT '[]'::jsonb,
  lead_time_days  INTEGER,
  moq             NUMERIC(15,2),
  validity_notes  TEXT,
  created_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (arc_quote_id, arc_item_id)
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_quote_line_item  ON public.tbl_arc_quote_line (arc_item_id);

CREATE TABLE IF NOT EXISTS public.tbl_arc_quote_line_history (
  id                  BIGSERIAL PRIMARY KEY,
  arc_quote_line_id   BIGINT  NOT NULL REFERENCES public.tbl_arc_quote_line(id) ON DELETE CASCADE,
  rate                NUMERIC(15,2),
  gst_pct             NUMERIC(5,2),
  charges             JSONB,
  changed_by          INTEGER REFERENCES public.tbl_users(id) ON DELETE SET NULL,
  changed_at          TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.tbl_arc_comm_evaluation (
  id                     BIGSERIAL PRIMARY KEY,
  arc_id                 BIGINT  NOT NULL UNIQUE REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  status                 VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  finalized_by           INTEGER REFERENCES public.tbl_users(id) ON DELETE SET NULL,
  finalized_at           TIMESTAMP WITHOUT TIME ZONE,
  approval_instance_id   INTEGER,
  created_at             TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tbl_arc_comm_evaluation_status_chk CHECK (status IN ('in_progress','finalized','sent_back'))
);

CREATE TABLE IF NOT EXISTS public.tbl_arc_comm_evaluation_award (
  id                          BIGSERIAL PRIMARY KEY,
  arc_comm_evaluation_id      BIGINT  NOT NULL REFERENCES public.tbl_arc_comm_evaluation(id) ON DELETE CASCADE,
  arc_item_id                 BIGINT  NOT NULL REFERENCES public.tbl_arc_item(id) ON DELETE CASCADE,
  awarded_vendor_id           INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  awarded_quote_line_id       BIGINT  NOT NULL REFERENCES public.tbl_arc_quote_line(id) ON DELETE RESTRICT,
  allocated_qty               NUMERIC(15,2) NOT NULL,
  allocated_share_pct         NUMERIC(7,4),
  l_rank                      VARCHAR(8),
  is_l1_default               BOOLEAN NOT NULL DEFAULT FALSE,
  awarded_quote_snapshot      JSONB NOT NULL DEFAULT '{}'::jsonb,
  awarded_at                  TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (arc_comm_evaluation_id, arc_item_id, awarded_vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_comm_award_eval    ON public.tbl_arc_comm_evaluation_award (arc_comm_evaluation_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_comm_award_item    ON public.tbl_arc_comm_evaluation_award (arc_item_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_comm_award_vendor  ON public.tbl_arc_comm_evaluation_award (awarded_vendor_id);

CREATE TABLE IF NOT EXISTS public.tbl_arc_comm_evaluation_history (
  id                          BIGSERIAL PRIMARY KEY,
  arc_comm_evaluation_id      BIGINT  NOT NULL REFERENCES public.tbl_arc_comm_evaluation(id) ON DELETE CASCADE,
  action                      VARCHAR(40) NOT NULL,
  payload                     JSONB DEFAULT '{}'::jsonb,
  changed_by                  INTEGER REFERENCES public.tbl_users(id) ON DELETE SET NULL,
  changed_at                  TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_comm_eval_history_eval
  ON public.tbl_arc_comm_evaluation_history (arc_comm_evaluation_id, changed_at DESC);
