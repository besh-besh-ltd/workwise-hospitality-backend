-- Inventory module, core: settings, stock-item masters, document numbering,
-- the stock ledger and balances. Spec §5.1 and §5.2
-- (docs/superpowers/specs/2026-10-23-inventory-management-design.md); task A1
-- of docs/superpowers/plans/2026-10-24-inventory-management.md.
--
-- Conventions in this file (and in 20261024100200 / 20261024100300):
--   * Every table carries hospitality_company_id -> tbl_hospitality_companies,
--     so a scope check never needs a join chain. Hotel-scoped tables also carry
--     hotel_id -> tbl_hospitality_company_hotels.
--   * Quantities and money are NUMERIC(18,4). Stock quantities are always in
--     the item's stock_uom. Unit-conversion factors are NUMERIC(18,6) (g -> kg
--     is 0.001). Percentages are NUMERIC(9,4).
--   * Status/type columns are VARCHAR + CHECK, never a new enum.
--   * Actor columns (created_by, posted_by, ...) are NULLABLE FKs to tbl_users:
--     system writes and site-rep token receipts have no user.
--   * created_at/created_by everywhere, updated_at/updated_by where mutable.
--     The ledger's own stamp is posted_at/posted_by.
--
-- The ledger (tbl_inv_movement) is append-only: the BEFORE UPDATE OR DELETE
-- trigger below has NO bypass. Corrections are new rows. TRUNCATE does not fire
-- row triggers, which is how tests/setup/db.js#truncateDynamic clears it.
--
-- There is no client_event_id on tbl_inv_movement: one client event writes
-- many movement rows. Idempotency lives on the documents (tbl_grn,
-- tbl_inv_out, tbl_inv_adjustment, tbl_inv_count_line).
--
-- Idempotent: CREATE ... IF NOT EXISTS, DROP TRIGGER IF EXISTS + CREATE,
-- CREATE OR REPLACE FUNCTION.

BEGIN;

-- ---------------------------------------------------------------------------
-- §5.1 Settings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tbl_inv_company_settings (
  hospitality_company_id        INT PRIMARY KEY REFERENCES public.tbl_hospitality_companies(id),
  over_receipt_tolerance_pct    NUMERIC(9,4)  NOT NULL DEFAULT 0 CHECK (over_receipt_tolerance_pct >= 0),
  allow_negative_stock          BOOLEAN       NOT NULL DEFAULT false,
  include_gst_in_cost           BOOLEAN       NOT NULL DEFAULT false,
  -- In rupees; 0 means every adjustment needs approval.
  adjustment_auto_approve_limit NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (adjustment_auto_approve_limit >= 0),
  count_freeze                  BOOLEAN       NOT NULL DEFAULT false,
  created_at                    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by                    INT REFERENCES public.tbl_users(id),
  updated_at                    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by                    INT REFERENCES public.tbl_users(id)
);

CREATE TABLE IF NOT EXISTS public.tbl_inv_hotel_settings (
  hotel_id               INT PRIMARY KEY REFERENCES public.tbl_hospitality_company_hotels(id),
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  -- Short code in document numbers ({DOC}/{doc_code}/{FY}/{seq5}). NULL means
  -- "use the hotel id". No '/' allowed: it is the number's separator.
  doc_code               VARCHAR(20) CHECK (doc_code IS NULL OR doc_code ~ '^[A-Za-z0-9_-]+$'),
  -- NULL means "use the company default".
  include_gst_in_cost    BOOLEAN,
  -- Stamped by the hotel's first approved opening import or count (§13).
  stock_started_at       TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             INT REFERENCES public.tbl_users(id)
);
-- Two hotels of one company must not share a doc_code, or their document
-- numbers would collide.
CREATE UNIQUE INDEX IF NOT EXISTS ux_inv_hotel_settings_doc_code
  ON public.tbl_inv_hotel_settings (hospitality_company_id, lower(doc_code))
  WHERE doc_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- §5.1 Stock-item masters
-- ---------------------------------------------------------------------------

-- The company's stock item: its own entity, not a catalogue variant.
CREATE TABLE IF NOT EXISTS public.tbl_inv_item (
  id                         SERIAL PRIMARY KEY,
  hospitality_company_id     INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  display_name               VARCHAR(255) NOT NULL,
  item_code                  VARCHAR(64),
  -- Free text like tbl_purchase_order_product.unit (VARCHAR(99)): a lazily
  -- created item takes the PO line's unit.
  stock_uom                  VARCHAR(99) NOT NULL,
  track_expiry               BOOLEAN NOT NULL DEFAULT false,
  min_shelf_life_days        INT CHECK (min_shelf_life_days IS NULL OR min_shelf_life_days >= 0),
  -- NULL means "use the company tolerance".
  over_receipt_tolerance_pct NUMERIC(9,4) CHECK (over_receipt_tolerance_pct IS NULL OR over_receipt_tolerance_pct >= 0),
  is_active                  BOOLEAN NOT NULL DEFAULT true,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                 INT REFERENCES public.tbl_users(id),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                 INT REFERENCES public.tbl_users(id)
);
-- item_code: optional, unique per company, case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS ux_inv_item_company_code
  ON public.tbl_inv_item (hospitality_company_id, lower(item_code))
  WHERE item_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_inv_item_company
  ON public.tbl_inv_item (hospitality_company_id);

-- Catalogue variants mapped to a stock item. Several variants may map to one
-- item (duplicate/shadow variants in the global catalogue); a variant maps to
-- at most one item per company. Forward-only mapping.
CREATE TABLE IF NOT EXISTS public.tbl_inv_item_variant (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  inv_item_id            INT NOT NULL REFERENCES public.tbl_inv_item(id),
  product_variant_id     INT NOT NULL REFERENCES public.tbl_product_variant(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id),
  CONSTRAINT ux_inv_item_variant_company_variant UNIQUE (hospitality_company_id, product_variant_id)
);
CREATE INDEX IF NOT EXISTS ix_inv_item_variant_item
  ON public.tbl_inv_item_variant (inv_item_id);

-- Defaults applied when an item is created lazily from a variant's category.
CREATE TABLE IF NOT EXISTS public.tbl_inv_category_default (
  hospitality_company_id      INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  category_id                 INT NOT NULL REFERENCES public.tbl_category(id),
  track_expiry                BOOLEAN NOT NULL DEFAULT false,
  default_mark_out_on_arrival BOOLEAN NOT NULL DEFAULT false,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                  INT REFERENCES public.tbl_users(id),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                  INT REFERENCES public.tbl_users(id),
  PRIMARY KEY (hospitality_company_id, category_id)
);

-- Unit conversions into the item's stock_uom, e.g. "Case" -> 24.
CREATE TABLE IF NOT EXISTS public.tbl_inv_item_uom (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  inv_item_id            INT NOT NULL REFERENCES public.tbl_inv_item(id),
  uom_label              VARCHAR(99) NOT NULL CHECK (btrim(uom_label) <> ''),
  factor_to_stock        NUMERIC(18,6) NOT NULL CHECK (factor_to_stock > 0),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             INT REFERENCES public.tbl_users(id)
);
-- Exactly the spec's key, so ON CONFLICT (inv_item_id, lower(uom_label)) infers it.
CREATE UNIQUE INDEX IF NOT EXISTS ux_inv_item_uom_item_label
  ON public.tbl_inv_item_uom (inv_item_id, lower(uom_label));

-- Barcode aliases (manufacturer EAN/UPC, internal codes). One item, many codes.
CREATE TABLE IF NOT EXISTS public.tbl_inv_item_barcode (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  inv_item_id            INT NOT NULL REFERENCES public.tbl_inv_item(id),
  code                   VARCHAR(128) NOT NULL CHECK (btrim(code) <> ''),
  -- Stock units added per scan (each-unit EAN = 1, carton EAN = 24).
  pack_factor            NUMERIC(18,4) NOT NULL DEFAULT 1 CHECK (pack_factor > 0),
  source                 VARCHAR(20) NOT NULL DEFAULT 'MANUFACTURER'
                         CHECK (source IN ('MANUFACTURER','INTERNAL')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id),
  CONSTRAINT ux_inv_item_barcode_company_code UNIQUE (hospitality_company_id, code)
);
CREATE INDEX IF NOT EXISTS ix_inv_item_barcode_item
  ON public.tbl_inv_item_barcode (inv_item_id);

-- Per-hotel par levels and bin location.
CREATE TABLE IF NOT EXISTS public.tbl_inv_hotel_item (
  hotel_id               INT NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id),
  inv_item_id            INT NOT NULL REFERENCES public.tbl_inv_item(id),
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  min_qty                NUMERIC(18,4) CHECK (min_qty IS NULL OR min_qty >= 0),
  reorder_level          NUMERIC(18,4) CHECK (reorder_level IS NULL OR reorder_level >= 0),
  max_qty                NUMERIC(18,4) CHECK (max_qty IS NULL OR max_qty >= 0),
  bin_label              VARCHAR(64),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             INT REFERENCES public.tbl_users(id),
  PRIMARY KEY (hotel_id, inv_item_id)
);

-- E1 M-5: a barcode is one code ignoring case, as the scan matches it. Codes
-- are stored trimmed (case kept for display); uniqueness is per company on
-- lower(code), replacing the case-sensitive constraint above.
ALTER TABLE public.tbl_inv_item_barcode DROP CONSTRAINT IF EXISTS ux_inv_item_barcode_company_code;
CREATE UNIQUE INDEX IF NOT EXISTS ux_inv_item_barcode_company_code_ci
  ON public.tbl_inv_item_barcode (hospitality_company_id, lower(code));

-- ---------------------------------------------------------------------------
-- §5.1 Document numbering: {DOC}/{doc_code}/{FY}/{seq5}, per hotel + type + FY.
-- Incremented with INSERT ... ON CONFLICT (hotel_id, doc_type, fy)
-- DO UPDATE SET last_no = last_no + 1 RETURNING last_no, inside the posting tx.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tbl_inv_doc_sequence (
  hotel_id               INT NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id),
  doc_type               VARCHAR(3) NOT NULL
                         CHECK (doc_type IN ('GRN','RTV','DSP','OUT','RET','ADJ','CNT')),
  -- Indian financial year label from app/helper/financialYear.js, e.g. '2026-27'.
  fy                     VARCHAR(7) NOT NULL CHECK (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  last_no                INT NOT NULL DEFAULT 0 CHECK (last_no >= 0),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, doc_type, fy)
);

-- E1 I-1: every doc_code a hotel has held. A code belongs to the first hotel
-- that sets it, for good: no other hotel of the company may take it later,
-- so a code that ever numbered documents can never number another hotel's.
-- (A hotel's code is frozen once it has numbered a document; that rule lives
-- in setupService.saveHotelSettings.)
CREATE TABLE IF NOT EXISTS public.tbl_inv_doc_code_history (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  hotel_id               INT NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id),
  doc_code               VARCHAR(20) NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INT REFERENCES public.tbl_users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_inv_doc_code_history_company_code
  ON public.tbl_inv_doc_code_history (hospitality_company_id, lower(doc_code));
INSERT INTO public.tbl_inv_doc_code_history (hospitality_company_id, hotel_id, doc_code)
SELECT hospitality_company_id, hotel_id, doc_code
  FROM public.tbl_inv_hotel_settings
 WHERE doc_code IS NOT NULL
ON CONFLICT (hospitality_company_id, lower(doc_code)) DO NOTHING;

-- ---------------------------------------------------------------------------
-- §5.2 The ledger (append-only) and balances
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tbl_inv_movement (
  id                     BIGSERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  hotel_id               INT NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id),
  inv_item_id            INT NOT NULL REFERENCES public.tbl_inv_item(id),
  product_variant_id     INT REFERENCES public.tbl_product_variant(id),
  movement_type          VARCHAR(20) NOT NULL CHECK (movement_type IN (
                           'GRN_IN','GRN_REVERSAL','RTV_OUT','MARK_OUT','RETURN_IN',
                           'ADJUST_IN','ADJUST_OUT','COUNT_IN','COUNT_OUT','OPENING')),
  -- Signed, in stock units. Inbound types are positive, outbound negative;
  -- OPENING is a delta against the current balance and may be either. A zero
  -- movement is never written (skip zero deltas instead).
  qty                    NUMERIC(18,4) NOT NULL,
  unit_cost              NUMERIC(18,4) NOT NULL,
  value                  NUMERIC(18,4) NOT NULL,   -- signed
  qty_after              NUMERIC(18,4) NOT NULL,
  avg_cost_after         NUMERIC(18,4) NOT NULL,
  department_id          INT REFERENCES public.tbl_department(id),
  batch_no               VARCHAR(64),
  expiry_date            DATE,
  -- The document that wrote the row (e.g. 'GRN', 'OUT'); source_id is its id.
  source_type            VARCHAR(20) NOT NULL,
  source_id              BIGINT NOT NULL,
  source_line_id         BIGINT,
  reason_code            VARCHAR(30),
  posted_by              INT REFERENCES public.tbl_users(id),
  posted_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_inv_movement_qty_sign CHECK (
    qty <> 0 AND (
         (movement_type IN ('GRN_IN','RETURN_IN','ADJUST_IN','COUNT_IN') AND qty > 0)
      OR (movement_type IN ('GRN_REVERSAL','RTV_OUT','MARK_OUT','ADJUST_OUT','COUNT_OUT') AND qty < 0)
      OR movement_type = 'OPENING'
    )
  )
);
CREATE INDEX IF NOT EXISTS ix_inv_movement_hotel_item_posted
  ON public.tbl_inv_movement (hotel_id, inv_item_id, posted_at);
CREATE INDEX IF NOT EXISTS ix_inv_movement_hotel_posted
  ON public.tbl_inv_movement (hotel_id, posted_at);
CREATE INDEX IF NOT EXISTS ix_inv_movement_source
  ON public.tbl_inv_movement (source_type, source_id);

-- Append-only. No bypass setting, deliberately: corrections are new rows.
CREATE OR REPLACE FUNCTION public.tbl_inv_movement_immutable()
  RETURNS trigger
  LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'inventory ledger is append-only: % on tbl_inv_movement is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Post a correcting movement instead.';
END;
$function$;

DROP TRIGGER IF EXISTS tbl_inv_movement_immutable ON public.tbl_inv_movement;
CREATE TRIGGER tbl_inv_movement_immutable
  BEFORE UPDATE OR DELETE ON public.tbl_inv_movement
  FOR EACH ROW EXECUTE FUNCTION public.tbl_inv_movement_immutable();

-- Current position per hotel and item. Written only by the ledger posting
-- service, under SELECT ... FOR UPDATE. Invariant: qty = sum(movement.qty).
CREATE TABLE IF NOT EXISTS public.tbl_inv_balance (
  hotel_id               INT NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id),
  inv_item_id            INT NOT NULL REFERENCES public.tbl_inv_item(id),
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  qty                    NUMERIC(18,4) NOT NULL DEFAULT 0,
  avg_cost               NUMERIC(18,4) NOT NULL DEFAULT 0,
  value                  NUMERIC(18,4) NOT NULL DEFAULT 0,
  last_movement_at       TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, inv_item_id)
);

-- Batch/expiry balances, for track_expiry items only (built in wave D).
-- batch_no '' means "no batch number" so the natural key stays NOT NULL and
-- ON CONFLICT (hotel_id, inv_item_id, batch_no, expiry_date) works.
CREATE TABLE IF NOT EXISTS public.tbl_inv_batch (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INT NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  hotel_id               INT NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id),
  inv_item_id            INT NOT NULL REFERENCES public.tbl_inv_item(id),
  batch_no               VARCHAR(64) NOT NULL DEFAULT '',
  expiry_date            DATE NOT NULL,
  qty                    NUMERIC(18,4) NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_inv_batch_key UNIQUE (hotel_id, inv_item_id, batch_no, expiry_date)
);

-- ---------------------------------------------------------------------------
-- Row audit (log_changes_direct keys on NEW.id, so only tables with an id).
-- Not on the ledger (it is its own audit), balances, batches or sequences.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tbl_inv_item_audit ON public.tbl_inv_item;
CREATE TRIGGER tbl_inv_item_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.tbl_inv_item
  FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();

DROP TRIGGER IF EXISTS tbl_inv_item_variant_audit ON public.tbl_inv_item_variant;
CREATE TRIGGER tbl_inv_item_variant_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.tbl_inv_item_variant
  FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();

DROP TRIGGER IF EXISTS tbl_inv_item_uom_audit ON public.tbl_inv_item_uom;
CREATE TRIGGER tbl_inv_item_uom_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.tbl_inv_item_uom
  FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();

DROP TRIGGER IF EXISTS tbl_inv_item_barcode_audit ON public.tbl_inv_item_barcode;
CREATE TRIGGER tbl_inv_item_barcode_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.tbl_inv_item_barcode
  FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();

COMMIT;
