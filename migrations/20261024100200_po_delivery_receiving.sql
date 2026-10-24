-- Inventory module: delivery plans (phases x hotels), dispatch notes, line-level
-- GRN, short-close and return-to-vendor, plus the PO-side columns they feed.
-- Spec §5.3 and §5.4, §10.3 (token hardening) and defect D9
-- (docs/superpowers/specs/2026-10-23-inventory-management-design.md).
--
-- Conventions as in 20261024100100_inventory_core.sql: hospitality_company_id
-- on every table, NUMERIC(18,4) quantities, VARCHAR + CHECK statuses, nullable
-- actor FKs to tbl_users.
--
-- Delete behaviour:
--   * Plan rows (tbl_po_delivery / _line) CASCADE from the PO and the PO line:
--     they are regenerable logistics, and the existing draft-PO merge and
--     PO-line edit paths hard-delete PO headers/lines. Once a receipt exists,
--     tbl_grn_line_alloc (NO ACTION) blocks that cascade, which is the point.
--   * Documents (dispatch, GRN, short-close, RTV) never cascade from the PO.
--   * Document lines CASCADE from their own header (draft GRN discard).
--
-- Also here:
--   * tbl_purchase_order_product: cached receipt roll-ups + receipt_status.
--   * tbl_rfq_purchase_order: receipt_status, delivery_plan_locked_at,
--     receipt_legacy. The po_status enum is NOT changed.
--   * tbl_purchase_order_document: invoice_number/date/amount + dispatch_id;
--     any one-invoice-per-PO unique constraint is dropped (none exists in the
--     schema snapshot; the current guard is in code).
--   * tbl_token_login_data: token_hash, expires_at, revoked_at, last_used_at,
--     hotel_id; `token` becomes nullable so the plain token need not be stored.
--   * D9: tbl_payment_milestone.rfq_id and tbl_purchase_order_tasks.rfq_id
--     become nullable (call-off POs have no RFQ).
--
-- Idempotent throughout.

BEGIN;

-- ---------------------------------------------------------------------------
-- §5.3 Delivery plan
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tbl_po_delivery (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  po_id                  INT NOT NULL REFERENCES public.tbl_rfq_purchase_order(id) ON DELETE CASCADE,
  -- NULL = unallocated: the hotel is not decided yet (multi-hotel PO, no split).
  hotel_id               INT REFERENCES public.tbl_hospitality_company_hotels(id),
  phase_no               INT NOT NULL DEFAULT 1 CHECK (phase_no >= 1),
  due_date               DATE,
  status                 VARCHAR(20) NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','partial','received','short_closed')),
  remarks                TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             INT REFERENCES public.tbl_users(id)
);
CREATE INDEX IF NOT EXISTS ix_po_delivery_po ON public.tbl_po_delivery (po_id);
-- One row per (PO, hotel, phase); the unallocated rows share hotel "0".
CREATE UNIQUE INDEX IF NOT EXISTS ux_po_delivery_po_hotel_phase
  ON public.tbl_po_delivery (po_id, COALESCE(hotel_id, 0), phase_no);

-- Source of truth for receiving; PO line/header counters are cached roll-ups.
CREATE TABLE IF NOT EXISTS public.tbl_po_delivery_line (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  delivery_id            INT NOT NULL REFERENCES public.tbl_po_delivery(id) ON DELETE CASCADE,
  po_line_id             INT NOT NULL REFERENCES public.tbl_purchase_order_product(id) ON DELETE CASCADE,
  planned_qty            NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (planned_qty >= 0),
  accepted_qty           NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (accepted_qty >= 0),
  rejected_qty           NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (rejected_qty >= 0),
  returned_replace_qty   NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (returned_replace_qty >= 0),
  returned_credit_qty    NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (returned_credit_qty >= 0),
  short_closed_qty       NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (short_closed_qty >= 0),
  status                 VARCHAR(20) NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','partial','received','short_closed')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             INT REFERENCES public.tbl_users(id),
  CONSTRAINT ux_po_delivery_line_delivery_po_line UNIQUE (delivery_id, po_line_id)
);
CREATE INDEX IF NOT EXISTS ix_po_delivery_line_po_line_status
  ON public.tbl_po_delivery_line (po_line_id, status);

-- ---------------------------------------------------------------------------
-- §5.4 Dispatch notes (vendor)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tbl_po_dispatch (
  id                     SERIAL PRIMARY KEY,
  dispatch_number        VARCHAR(40) NOT NULL,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  po_id                  INT NOT NULL REFERENCES public.tbl_rfq_purchase_order(id),
  -- The vendor user (tbl_rfq_purchase_order.finalized_vendor_id).
  vendor_id              INT NOT NULL REFERENCES public.tbl_users(id),
  delivery_id            INT REFERENCES public.tbl_po_delivery(id),
  hotel_id               INT REFERENCES public.tbl_hospitality_company_hotels(id),
  status                 VARCHAR(20) NOT NULL DEFAULT 'in_transit'
                         CHECK (status IN ('in_transit','received','cancelled')),
  challan_no             VARCHAR(64),
  challan_date           DATE,
  eway_bill_no           VARCHAR(64),
  vehicle_no             VARCHAR(32),
  transporter            VARCHAR(255),
  expected_delivery_date DATE,
  remarks                TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             INT REFERENCES public.tbl_users(id),
  CONSTRAINT ux_po_dispatch_company_number UNIQUE (hospitality_company_id, dispatch_number)
);
CREATE INDEX IF NOT EXISTS ix_po_dispatch_po ON public.tbl_po_dispatch (po_id);

CREATE TABLE IF NOT EXISTS public.tbl_po_dispatch_line (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  dispatch_id            INT NOT NULL REFERENCES public.tbl_po_dispatch(id) ON DELETE CASCADE,
  po_line_id             INT NOT NULL REFERENCES public.tbl_purchase_order_product(id),
  qty                    NUMERIC(18,4) NOT NULL CHECK (qty > 0),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id),
  CONSTRAINT ux_po_dispatch_line_dispatch_po_line UNIQUE (dispatch_id, po_line_id)
);

-- ---------------------------------------------------------------------------
-- §5.4 GRN
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tbl_grn (
  id                     SERIAL PRIMARY KEY,
  -- Assigned when posted; drafts have none.
  grn_number             VARCHAR(40),
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  hotel_id               INT NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id),
  po_id                  INT NOT NULL REFERENCES public.tbl_rfq_purchase_order(id),
  dispatch_id            INT REFERENCES public.tbl_po_dispatch(id),
  doc_type               VARCHAR(10) NOT NULL DEFAULT 'RECEIPT' CHECK (doc_type IN ('RECEIPT','REVERSAL')),
  reverses_grn_id        INT REFERENCES public.tbl_grn(id),
  status                 VARCHAR(20) NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','posted','reversed','partially_reversed')),
  -- The date the goods arrived (not the posting time).
  received_at            DATE NOT NULL,
  -- The buyer user who received. NULL for site-rep token receipts, which set
  -- received_by_token_id instead (and posted_by NULL).
  received_by            INT REFERENCES public.tbl_users(id),
  received_by_token_id   INT REFERENCES public.tbl_token_login_data(id),
  vendor_challan_no      VARCHAR(64),
  vendor_challan_date    DATE,
  vendor_invoice_no      VARCHAR(64),
  vendor_invoice_date    DATE,
  eway_bill_no           VARCHAR(64),
  vehicle_no             VARCHAR(32),
  remarks                TEXT,
  posted_at              TIMESTAMPTZ,
  posted_by              INT REFERENCES public.tbl_users(id),
  -- Idempotency key for scan-session posts: a replay returns this GRN.
  client_event_id        UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             INT REFERENCES public.tbl_users(id),
  CONSTRAINT ux_grn_client_event UNIQUE (client_event_id),
  CONSTRAINT ux_grn_company_number UNIQUE (hospitality_company_id, grn_number),
  -- A reversal always names the GRN it reverses; a receipt never does.
  CONSTRAINT ck_grn_reversal_link CHECK ((doc_type = 'REVERSAL') = (reverses_grn_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_grn_po ON public.tbl_grn (po_id);
CREATE INDEX IF NOT EXISTS ix_grn_hotel_posted ON public.tbl_grn (hotel_id, posted_at);
CREATE INDEX IF NOT EXISTS ix_grn_reverses ON public.tbl_grn (reverses_grn_id) WHERE reverses_grn_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.tbl_grn_line (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  grn_id                 INT NOT NULL REFERENCES public.tbl_grn(id) ON DELETE CASCADE,
  po_line_id             INT NOT NULL REFERENCES public.tbl_purchase_order_product(id),
  product_variant_id     INT REFERENCES public.tbl_product_variant(id),
  -- Resolved (or lazily created) by the time the GRN is posted; may be NULL on a draft.
  inv_item_id            INT REFERENCES public.tbl_inv_item(id),
  -- On a REVERSAL GRN: the RECEIPT line this line reverses (a PO line can
  -- appear on one receipt more than once, e.g. two batches).
  reverses_grn_line_id   INT REFERENCES public.tbl_grn_line(id),
  po_uom                 VARCHAR(99) NOT NULL,   -- the PO line's free-text unit
  received_qty           NUMERIC(18,4) NOT NULL DEFAULT 0,
  accepted_qty           NUMERIC(18,4) NOT NULL DEFAULT 0,
  rejected_qty           NUMERIC(18,4) NOT NULL DEFAULT 0,
  rejection_reason       VARCHAR(30) CHECK (rejection_reason IS NULL OR rejection_reason IN (
                           'damaged','quality','wrong_item','short_shelf_life','temperature','excess','other')),
  -- PO unit -> stock unit; set when posted.
  uom_factor             NUMERIC(18,6) CHECK (uom_factor IS NULL OR uom_factor > 0),
  stock_qty              NUMERIC(18,4),          -- accepted x uom_factor
  unit_cost              NUMERIC(18,4),          -- per STOCK unit
  -- Set when the line was marked out to a department on arrival.
  mark_out_department_id INT REFERENCES public.tbl_department(id),
  batch_no               VARCHAR(64),
  mfg_date               DATE,
  expiry_date            DATE,
  remarks                TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             INT REFERENCES public.tbl_users(id),
  CONSTRAINT ck_grn_line_qty_split CHECK (accepted_qty + rejected_qty = received_qty)
);
CREATE INDEX IF NOT EXISTS ix_grn_line_grn ON public.tbl_grn_line (grn_id);
CREATE INDEX IF NOT EXISTS ix_grn_line_po_line ON public.tbl_grn_line (po_line_id);
CREATE INDEX IF NOT EXISTS ix_grn_line_reverses
  ON public.tbl_grn_line (reverses_grn_line_id) WHERE reverses_grn_line_id IS NOT NULL;

-- How a GRN line was spread across the hotel's plan rows. Signed: a reversal
-- writes negative rows mirroring the originals.
CREATE TABLE IF NOT EXISTS public.tbl_grn_line_alloc (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  grn_line_id            INT NOT NULL REFERENCES public.tbl_grn_line(id) ON DELETE CASCADE,
  delivery_line_id       INT NOT NULL REFERENCES public.tbl_po_delivery_line(id),
  accepted_qty           NUMERIC(18,4) NOT NULL DEFAULT 0,
  rejected_qty           NUMERIC(18,4) NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id)
);
CREATE INDEX IF NOT EXISTS ix_grn_line_alloc_line ON public.tbl_grn_line_alloc (grn_line_id);
CREATE INDEX IF NOT EXISTS ix_grn_line_alloc_delivery_line ON public.tbl_grn_line_alloc (delivery_line_id);

CREATE TABLE IF NOT EXISTS public.tbl_grn_attachment (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  grn_id                 INT NOT NULL REFERENCES public.tbl_grn(id) ON DELETE CASCADE,
  s3_key                 TEXT NOT NULL,
  file_name              VARCHAR(255),
  kind                   VARCHAR(20) NOT NULL DEFAULT 'OTHER'
                         CHECK (kind IN ('CHALLAN','INVOICE','PHOTO','OTHER')),
  uploaded_by            INT REFERENCES public.tbl_users(id),   -- NULL for site-rep uploads
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_grn_attachment_grn ON public.tbl_grn_attachment (grn_id);

-- ---------------------------------------------------------------------------
-- §5.4 Short-close audit log (append-style: a reopen is a new row)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tbl_po_short_close (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  po_id                  INT NOT NULL REFERENCES public.tbl_rfq_purchase_order(id),
  delivery_line_id       INT NOT NULL REFERENCES public.tbl_po_delivery_line(id),
  qty                    NUMERIC(18,4) NOT NULL CHECK (qty > 0),
  reason_code            VARCHAR(30) CHECK (reason_code IS NULL OR reason_code IN (
                           'vendor_cannot_supply','no_longer_needed','substituted','price_dispute','other')),
  remarks                TEXT,
  action                 VARCHAR(10) NOT NULL CHECK (action IN ('close','reopen')),
  acted_by               INT REFERENCES public.tbl_users(id),
  acted_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A close needs a reason; a reopen carries remarks only.
  CONSTRAINT ck_po_short_close_reason CHECK (action = 'reopen' OR reason_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_po_short_close_po ON public.tbl_po_short_close (po_id);
CREATE INDEX IF NOT EXISTS ix_po_short_close_delivery_line ON public.tbl_po_short_close (delivery_line_id);

-- ---------------------------------------------------------------------------
-- §5.4 Return to vendor
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tbl_rtv (
  id                     SERIAL PRIMARY KEY,
  rtv_number             VARCHAR(40),
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  po_id                  INT NOT NULL REFERENCES public.tbl_rfq_purchase_order(id),
  grn_id                 INT NOT NULL REFERENCES public.tbl_grn(id),
  hotel_id               INT NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id),
  disposition            VARCHAR(10) NOT NULL CHECK (disposition IN ('REPLACE','CREDIT')),
  status                 VARCHAR(20) NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','dispatched','closed','cancelled')),
  challan_no             VARCHAR(64),
  credit_note_ref        VARCHAR(64),
  remarks                TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             INT REFERENCES public.tbl_users(id),
  CONSTRAINT ux_rtv_company_number UNIQUE (hospitality_company_id, rtv_number)
);
CREATE INDEX IF NOT EXISTS ix_rtv_po ON public.tbl_rtv (po_id);
CREATE INDEX IF NOT EXISTS ix_rtv_grn ON public.tbl_rtv (grn_id);

CREATE TABLE IF NOT EXISTS public.tbl_rtv_line (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  rtv_id                 INT NOT NULL REFERENCES public.tbl_rtv(id) ON DELETE CASCADE,
  grn_line_id            INT NOT NULL REFERENCES public.tbl_grn_line(id),
  qty                    NUMERIC(18,4) NOT NULL CHECK (qty > 0),
  reason                 TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id)
);
CREATE INDEX IF NOT EXISTS ix_rtv_line_rtv ON public.tbl_rtv_line (rtv_id);
CREATE INDEX IF NOT EXISTS ix_rtv_line_grn_line ON public.tbl_rtv_line (grn_line_id);

-- ---------------------------------------------------------------------------
-- §5.4 PO-side roll-ups (caches of the delivery lines; recomputePoReceipt
-- rebuilds them). The po_status enum is untouched.
-- ---------------------------------------------------------------------------

ALTER TABLE public.tbl_purchase_order_product
  ADD COLUMN IF NOT EXISTS received_qty         NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS accepted_qty         NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rejected_qty         NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS returned_replace_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS returned_credit_qty  NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS short_closed_qty     NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS receipt_status       VARCHAR(20)   NOT NULL DEFAULT 'open';

ALTER TABLE public.tbl_purchase_order_product
  DROP CONSTRAINT IF EXISTS tbl_purchase_order_product_receipt_status_check;
ALTER TABLE public.tbl_purchase_order_product
  ADD CONSTRAINT tbl_purchase_order_product_receipt_status_check
  CHECK (receipt_status IN ('open','partial','received','short_closed'));

ALTER TABLE public.tbl_rfq_purchase_order
  ADD COLUMN IF NOT EXISTS receipt_status          VARCHAR(20) NOT NULL DEFAULT 'not_received',
  ADD COLUMN IF NOT EXISTS delivery_plan_locked_at TIMESTAMPTZ,
  -- Received or accepted before line-level receiving existed (§13, backfilled
  -- by 20261024100500). Excluded from overdue, reorder on_order and OTIF.
  ADD COLUMN IF NOT EXISTS receipt_legacy          BOOLEAN     NOT NULL DEFAULT false;

ALTER TABLE public.tbl_rfq_purchase_order
  DROP CONSTRAINT IF EXISTS tbl_rfq_purchase_order_receipt_status_check;
ALTER TABLE public.tbl_rfq_purchase_order
  ADD CONSTRAINT tbl_rfq_purchase_order_receipt_status_check
  CHECK (receipt_status IN ('not_received','partial','received','closed_short'));

-- ---------------------------------------------------------------------------
-- §5.4 Invoices: one tax invoice per delivery, so several per PO.
-- ---------------------------------------------------------------------------

ALTER TABLE public.tbl_purchase_order_document
  ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(64),
  ADD COLUMN IF NOT EXISTS invoice_date   DATE,
  ADD COLUMN IF NOT EXISTS invoice_amount NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS dispatch_id    INT REFERENCES public.tbl_po_dispatch(id);

-- Drop any unique constraint or unique index on tbl_purchase_order_document
-- that involves purchase_order_id (i.e. "one document of a type per PO"). The
-- schema snapshot has none, so this is expected to be a no-op; it exists so a
-- hand-added one in some environment cannot block the second invoice.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'public.tbl_purchase_order_document'::regclass
       AND c.contype = 'u'
       AND EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.conrelid
            AND a.attnum = ANY (c.conkey)
            AND a.attname = 'purchase_order_id')
  LOOP
    RAISE NOTICE 'dropping unique constraint % on tbl_purchase_order_document', r.conname;
    EXECUTE format('ALTER TABLE public.tbl_purchase_order_document DROP CONSTRAINT %I', r.conname);
  END LOOP;

  FOR r IN
    SELECT ic.relname AS indexname
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
     WHERE i.indrelid = 'public.tbl_purchase_order_document'::regclass
       AND i.indisunique
       AND NOT i.indisprimary
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
       AND EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = i.indrelid
            AND a.attnum = ANY (i.indkey)
            AND a.attname = 'purchase_order_id')
  LOOP
    RAISE NOTICE 'dropping unique index % on tbl_purchase_order_document', r.indexname;
    EXECUTE format('DROP INDEX public.%I', r.indexname);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- §10.3 Site-rep token hardening (storage only; the auth change is task B6).
-- ---------------------------------------------------------------------------

ALTER TABLE public.tbl_token_login_data
  ADD COLUMN IF NOT EXISTS token_hash   VARCHAR(64),   -- sha256 hex of the token
  ADD COLUMN IF NOT EXISTS expires_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hotel_id     INT REFERENCES public.tbl_hospitality_company_hotels(id);

-- The plain token is no longer stored once a row carries token_hash.
ALTER TABLE public.tbl_token_login_data ALTER COLUMN token DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_token_login_data_token_hash
  ON public.tbl_token_login_data (token_hash) WHERE token_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- D9: milestones and tasks on call-off POs (no RFQ).
-- ---------------------------------------------------------------------------

ALTER TABLE public.tbl_payment_milestone    ALTER COLUMN rfq_id DROP NOT NULL;
ALTER TABLE public.tbl_purchase_order_tasks ALTER COLUMN rfq_id DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- Row audit (log_changes_direct; tables with an id).
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tbl_po_delivery_audit ON public.tbl_po_delivery;
CREATE TRIGGER tbl_po_delivery_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.tbl_po_delivery
  FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();

DROP TRIGGER IF EXISTS tbl_po_delivery_line_audit ON public.tbl_po_delivery_line;
CREATE TRIGGER tbl_po_delivery_line_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.tbl_po_delivery_line
  FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();

DROP TRIGGER IF EXISTS tbl_po_dispatch_audit ON public.tbl_po_dispatch;
CREATE TRIGGER tbl_po_dispatch_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.tbl_po_dispatch
  FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();

DROP TRIGGER IF EXISTS tbl_grn_audit ON public.tbl_grn;
CREATE TRIGGER tbl_grn_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.tbl_grn
  FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();

DROP TRIGGER IF EXISTS tbl_rtv_audit ON public.tbl_rtv;
CREATE TRIGGER tbl_rtv_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.tbl_rtv
  FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();

COMMIT;
