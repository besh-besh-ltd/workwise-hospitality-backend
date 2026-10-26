-- Inventory module: stock operations documents. Spec §5.5 and §8
-- (docs/superpowers/specs/2026-10-23-inventory-management-design.md).
--
--   tbl_inv_out / _line               mark out to a department, or return to stock
--   tbl_inv_adjustment / _line        wastage, breakage, expiry, theft/loss,
--                                     correction, found, and the internal OPENING
--   tbl_inv_count / _line             stock counts (blind optional), posting deltas
--   tbl_inv_count_line_event          every count-line save applied, by clientEventId
--
-- The stock effect of each document is its tbl_inv_movement rows
-- (source_type/source_id); these tables hold the document itself.
--
-- Idempotency for scan sessions: tbl_inv_out.client_event_id and
-- tbl_inv_adjustment.client_event_id are UNIQUE; count-line saves are unique
-- on (count_id, client_event_id) in tbl_inv_count_line_event, which keeps
-- every key a count has applied (the line itself only holds the latest).
-- tbl_material_requisition.client_event_id (nullable, unique when set) makes
-- the reorder list's "Create MR draft" idempotent; MRs raised on the MR page
-- leave it NULL.
--
-- Conventions as in 20261024100100_inventory_core.sql. Idempotent throughout.

-- A lock wait longer than 5s aborts the file (rolling back whole) instead of
-- queueing every PO page behind it; every statement is idempotent: re-run it.
BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Mark out / return to stock. Posted on creation: no draft, no approval.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tbl_inv_out (
  id                     SERIAL PRIMARY KEY,
  out_number             VARCHAR(40) NOT NULL,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  hotel_id               INT NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id),
  doc_type               VARCHAR(10) NOT NULL CHECK (doc_type IN ('OUT','RETURN')),
  department_id          INT NOT NULL REFERENCES public.tbl_department(id),
  requested_by_name      VARCHAR(255),
  remarks                TEXT,
  -- The client's scan-session id (informational). Idempotency is client_event_id.
  client_session_id      VARCHAR(64),
  client_event_id        UUID,
  posted_by              INT REFERENCES public.tbl_users(id),
  posted_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_inv_out_client_event UNIQUE (client_event_id),
  CONSTRAINT ux_inv_out_company_number UNIQUE (hospitality_company_id, out_number)
);
CREATE INDEX IF NOT EXISTS ix_inv_out_hotel_posted ON public.tbl_inv_out (hotel_id, posted_at);

CREATE TABLE IF NOT EXISTS public.tbl_inv_out_line (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  out_id                 INT NOT NULL REFERENCES public.tbl_inv_out(id) ON DELETE CASCADE,
  inv_item_id            INT NOT NULL REFERENCES public.tbl_inv_item(id),
  qty                    NUMERIC(18,4) NOT NULL CHECK (qty > 0),   -- stock units; direction is doc_type
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_inv_out_line_out ON public.tbl_inv_out_line (out_id);

-- ---------------------------------------------------------------------------
-- Adjustments: submitted by inventory.create, approved by inventory.approve,
-- auto-posted at or below tbl_inv_company_settings.adjustment_auto_approve_limit.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tbl_inv_adjustment (
  id                     SERIAL PRIMARY KEY,
  adjustment_number      VARCHAR(40),
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  hotel_id               INT NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id),
  -- OPENING is internal: written only by the opening-stock import.
  reason_code            VARCHAR(20) NOT NULL CHECK (reason_code IN (
                           'WASTAGE','BREAKAGE','EXPIRY','THEFT_LOSS','CORRECTION','FOUND','OPENING')),
  status                 VARCHAR(20) NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','pending_approval','posted','rejected')),
  remarks                TEXT,
  approved_by            INT REFERENCES public.tbl_users(id),
  approved_at            TIMESTAMPTZ,
  rejected_by            INT REFERENCES public.tbl_users(id),
  rejected_at            TIMESTAMPTZ,
  rejection_reason       TEXT,
  client_event_id        UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             INT REFERENCES public.tbl_users(id),
  CONSTRAINT ux_inv_adjustment_client_event UNIQUE (client_event_id),
  CONSTRAINT ux_inv_adjustment_company_number UNIQUE (hospitality_company_id, adjustment_number)
);
CREATE INDEX IF NOT EXISTS ix_inv_adjustment_hotel_status ON public.tbl_inv_adjustment (hotel_id, status);

CREATE TABLE IF NOT EXISTS public.tbl_inv_adjustment_line (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  adjustment_id          INT NOT NULL REFERENCES public.tbl_inv_adjustment(id) ON DELETE CASCADE,
  inv_item_id            INT NOT NULL REFERENCES public.tbl_inv_item(id),
  qty                    NUMERIC(18,4) NOT NULL,   -- signed, stock units
  unit_cost              NUMERIC(18,4),            -- OPENING lines only
  remarks                TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_inv_adjustment_line_adjustment ON public.tbl_inv_adjustment_line (adjustment_id);

-- ---------------------------------------------------------------------------
-- Counts: each line records the system qty at the moment it was counted, and
-- approval posts the delta (counted - system_qty_at_count).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tbl_inv_count (
  id                     SERIAL PRIMARY KEY,
  count_number           VARCHAR(40),
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  hotel_id               INT NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id),
  scope                  VARCHAR(10) NOT NULL CHECK (scope IN ('FULL','SELECTED')),
  status                 VARCHAR(20) NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','submitted','approved','cancelled')),
  is_blind               BOOLEAN NOT NULL DEFAULT false,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at           TIMESTAMPTZ,
  approved_by            INT REFERENCES public.tbl_users(id),
  approved_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             INT REFERENCES public.tbl_users(id),
  CONSTRAINT ux_inv_count_company_number UNIQUE (hospitality_company_id, count_number)
);
-- "Is a count open at this hotel?" (count_freeze) and the counts list.
CREATE INDEX IF NOT EXISTS ix_inv_count_hotel_status ON public.tbl_inv_count (hotel_id, status);

CREATE TABLE IF NOT EXISTS public.tbl_inv_count_line (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  count_id               INT NOT NULL REFERENCES public.tbl_inv_count(id) ON DELETE CASCADE,
  inv_item_id            INT NOT NULL REFERENCES public.tbl_inv_item(id),
  counted_qty            NUMERIC(18,4) CHECK (counted_qty IS NULL OR counted_qty >= 0),   -- NULL = not counted yet
  system_qty_at_count    NUMERIC(18,4),
  counted_at             TIMESTAMPTZ,
  counted_by             INT REFERENCES public.tbl_users(id),
  variance_qty           NUMERIC(18,4),
  variance_value         NUMERIC(18,4),
  reason                 TEXT,
  client_event_id        UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_inv_count_line_count_item UNIQUE (count_id, inv_item_id),
  CONSTRAINT ux_inv_count_line_count_event UNIQUE (count_id, client_event_id)
);

-- Every count-line save applied, by its clientEventId. A save whose key the
-- count has seen before is a replay and a no-op, even when a newer save has
-- changed the line since: a late retry never overwrites a newer count.
CREATE TABLE IF NOT EXISTS public.tbl_inv_count_line_event (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  count_id               INT NOT NULL REFERENCES public.tbl_inv_count(id) ON DELETE CASCADE,
  count_line_id          INT NOT NULL REFERENCES public.tbl_inv_count_line(id) ON DELETE CASCADE,
  client_event_id        UUID NOT NULL,
  counted_qty            NUMERIC(18,4) NOT NULL CHECK (counted_qty >= 0),
  applied_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by             INT REFERENCES public.tbl_users(id),
  CONSTRAINT ux_inv_count_line_event UNIQUE (count_id, client_event_id)
);
CREATE INDEX IF NOT EXISTS ix_inv_count_line_event_line ON public.tbl_inv_count_line_event (count_line_id);

-- ---------------------------------------------------------------------------
-- Reorder "Create MR draft": a retried request answers the draft it made.
-- ---------------------------------------------------------------------------

ALTER TABLE public.tbl_material_requisition ADD COLUMN IF NOT EXISTS client_event_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS ux_material_requisition_client_event
  ON public.tbl_material_requisition (client_event_id) WHERE client_event_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Row audit on the headers that change state under approval.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tbl_inv_adjustment_audit ON public.tbl_inv_adjustment;
CREATE TRIGGER tbl_inv_adjustment_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.tbl_inv_adjustment
  FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();

DROP TRIGGER IF EXISTS tbl_inv_count_audit ON public.tbl_inv_count;
CREATE TRIGGER tbl_inv_count_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.tbl_inv_count
  FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();

COMMIT;
