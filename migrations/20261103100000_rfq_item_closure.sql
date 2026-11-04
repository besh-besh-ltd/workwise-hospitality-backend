-- RFQ items closed without award.
--
-- Why. An RFQ whose items were only partly awarded had no way to say what
-- happened to the rest: tbl_rfq_products carries no state, so an item nobody
-- quoted (or nobody acceptable quoted) stayed "open" for good. The RFQ never
-- reached Completed, its POs never auto-initiated (isRfqFullyAwarded waits for
-- every item), linked requisition lines stayed "in sourcing", and closing the
-- whole RFQ recorded one free-text comment for all of it.
--
-- What.
--   1. tbl_rfq_products gets the item's current closure: closed_at, closed_by,
--      close_reason_code, close_remarks. NULL closed_at = the item is not
--      closed. Every query that asks "is this item settled" reads these.
--   2. tbl_rfq_product_closure is the append-only history: one 'close' or
--      'reopen' row per item per action, never updated (same shape as
--      tbl_po_short_close). tbl_rfq_products' own row-audit trigger records
--      the column changes as well.
--
-- Additive: new nullable columns with no default (no table rewrite, no row
-- changes) and a new table. RFQ copy and hotel duplication insert explicit
-- column lists, so a copied RFQ never inherits a closure.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.tbl_rfq_products
  ADD COLUMN IF NOT EXISTS closed_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_by         INTEGER REFERENCES public.tbl_users(id),
  ADD COLUMN IF NOT EXISTS close_reason_code VARCHAR(30),
  ADD COLUMN IF NOT EXISTS close_remarks     TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.tbl_rfq_products'::regclass
                    AND conname = 'ck_rfq_products_close_reason') THEN
    ALTER TABLE public.tbl_rfq_products
      ADD CONSTRAINT ck_rfq_products_close_reason CHECK (
        close_reason_code IS NULL OR close_reason_code IN (
          'no_quotes_received', 'all_vendors_regretted', 'technically_disqualified',
          'quotes_not_acceptable', 'requirement_cancelled', 'sourced_elsewhere',
          'rfq_closed', 'other'));
  END IF;
  -- A closed item always says why; an open one carries no closure fields.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.tbl_rfq_products'::regclass
                    AND conname = 'ck_rfq_products_close_shape') THEN
    ALTER TABLE public.tbl_rfq_products
      ADD CONSTRAINT ck_rfq_products_close_shape CHECK (
        (closed_at IS NULL AND close_reason_code IS NULL AND closed_by IS NULL AND close_remarks IS NULL)
        OR (closed_at IS NOT NULL AND close_reason_code IS NOT NULL
            AND (close_reason_code <> 'other' OR length(btrim(coalesce(close_remarks, ''))) > 0)));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_rfq_products_closed
  ON public.tbl_rfq_products (rfq_id) WHERE closed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.tbl_rfq_product_closure (
  id              SERIAL PRIMARY KEY,
  rfq_id          INTEGER NOT NULL REFERENCES public.tbl_rfq(id) ON DELETE CASCADE,
  rfq_product_id  INTEGER NOT NULL REFERENCES public.tbl_rfq_products(id) ON DELETE CASCADE,
  action          VARCHAR(10) NOT NULL CHECK (action IN ('close', 'reopen')),
  reason_code     VARCHAR(30) CHECK (reason_code IS NULL OR reason_code IN (
                    'no_quotes_received', 'all_vendors_regretted', 'technically_disqualified',
                    'quotes_not_acceptable', 'requirement_cancelled', 'sourced_elsewhere',
                    'rfq_closed', 'other')),
  remarks         TEXT,
  moved_to_rfq_id INTEGER REFERENCES public.tbl_rfq(id) ON DELETE SET NULL,
  acted_by        INTEGER REFERENCES public.tbl_users(id),
  acted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A close needs a reason; a reopen carries remarks only.
  CONSTRAINT ck_rfq_product_closure_reason CHECK (action = 'reopen' OR reason_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_rfq_product_closure_rfq ON public.tbl_rfq_product_closure (rfq_id);
CREATE INDEX IF NOT EXISTS ix_rfq_product_closure_item ON public.tbl_rfq_product_closure (rfq_product_id);

COMMIT;
