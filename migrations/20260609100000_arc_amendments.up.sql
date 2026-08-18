-- ARC v2 — Amendments (plan §4.7).
--
-- Single table with a JSONB `payload` keeps the schema simple: every
-- amendment type (price / qty / item_add / item_remove / term) stores its
-- type-specific fields (line_id, new_rate, new_qty, …) under `payload`.
-- The split-line variant from the plan can land later if the data shape
-- proves too unstructured for queries.
--
-- The status enum follows the plan's flow:
--   requested  → approved/rejected   (committee gate)
--                approved → live     (when amendment_from arrives)
--                live     → ended    (when amendment_to passes; rate reverts)
--                voided  is a manual cancellation by an admin.

CREATE TABLE IF NOT EXISTS public.tbl_arc_amendment (
  id                    BIGSERIAL PRIMARY KEY,
  arc_contract_id       BIGINT NOT NULL REFERENCES public.tbl_arc_contract(id) ON DELETE RESTRICT,
  amendment_type        VARCHAR(20) NOT NULL,
  amendment_from        DATE NOT NULL,
  amendment_to          DATE,
  status                VARCHAR(20) NOT NULL DEFAULT 'requested',
  reason                TEXT NOT NULL,
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by          INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  approval_instance_id  INTEGER,
  decided_by            INTEGER REFERENCES public.tbl_users(id) ON DELETE SET NULL,
  decided_at            TIMESTAMP WITHOUT TIME ZONE,
  created_at            TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tbl_arc_amendment_type_chk
    CHECK (amendment_type IN ('price','qty','item_add','item_remove','term')),
  CONSTRAINT tbl_arc_amendment_status_chk
    CHECK (status IN ('requested','approved','rejected','live','ended','voided')),
  CONSTRAINT tbl_arc_amendment_window_chk
    CHECK (amendment_to IS NULL OR amendment_to >= amendment_from)
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_amendment_contract
  ON public.tbl_arc_amendment (arc_contract_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_amendment_status
  ON public.tbl_arc_amendment (status);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_amendment_window
  ON public.tbl_arc_amendment (arc_contract_id, amendment_from, amendment_to);
