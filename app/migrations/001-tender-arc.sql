-- ============================================================================
-- Migration 001 — Tender / ARC End-to-End
-- ----------------------------------------------------------------------------
-- Adds:
--   - Tender header extensions on tbl_rfq (tender_scope, period dates,
--     bypass-ARC fields, iteration_number).
--   - ARC envelope chain: tbl_arc, tbl_arc_hotels, tbl_arc_item.
--   - Vendor-signing seam: tbl_arc_vendor_signing (deferred v2 flow).
--   - Release-order chain: tbl_arc_release, tbl_arc_release_items.
--   - Contracted-PO link on tbl_rfq_purchase_order (arc_release_id,
--     is_contracted) and relaxes rfq_id to allow contracted POs without an
--     RFQ parent.
--   - Send-back history: tbl_tender_sendback_history (full JSONB snapshots).
--   - ENUM extensions: lifecycle_entity_type += 'ARC_RELEASE';
--                     permission_action_type += 'send_back','publish','bypass_arc'.
--
-- Reuses (does NOT recreate) tbl_rfq_hotel_mappings as the per-tender hotel
-- coverage junction.
--
-- The ENUM ADD VALUE statements MUST run before any subsequent statement that
-- uses the new value, so we keep them outside the main transaction. Tables
-- are wrapped in a single transaction for atomic rollback on failure.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ENUM extensions (auto-committed per-statement; not transactionable)
-- ---------------------------------------------------------------------------
ALTER TYPE public.lifecycle_entity_type ADD VALUE IF NOT EXISTS 'ARC_RELEASE';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'send_back';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'publish';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'bypass_arc';

-- ---------------------------------------------------------------------------
-- 2. Schema changes (transactional)
-- ---------------------------------------------------------------------------
BEGIN;

-- 2.1 tbl_rfq tender + bypass + iteration extensions
ALTER TABLE public.tbl_rfq
  ADD COLUMN IF NOT EXISTS tender_scope VARCHAR(8),
  ADD COLUMN IF NOT EXISTS arc_period_from DATE,
  ADD COLUMN IF NOT EXISTS arc_period_to DATE,
  ADD COLUMN IF NOT EXISTS bypass_arc SMALLINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bypass_arc_reason TEXT,
  ADD COLUMN IF NOT EXISTS bypass_arc_recorded_by INTEGER,
  ADD COLUMN IF NOT EXISTS bypass_arc_recorded_at TIMESTAMP WITHOUT TIME ZONE,
  ADD COLUMN IF NOT EXISTS iteration_number INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.tbl_rfq
  DROP CONSTRAINT IF EXISTS chk_tbl_rfq_tender_scope;
ALTER TABLE public.tbl_rfq
  ADD CONSTRAINT chk_tbl_rfq_tender_scope
  CHECK (tender_scope IS NULL OR tender_scope IN ('SINGLE', 'GROUP'));

CREATE INDEX IF NOT EXISTS idx_tbl_rfq_tender_scope
  ON public.tbl_rfq(tender_scope) WHERE tender_scope IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tbl_rfq_arc_period
  ON public.tbl_rfq(arc_period_to) WHERE is_tender = 1;

-- 2.2 tbl_arc — envelope: one per (rfq, vendor)
CREATE TABLE IF NOT EXISTS public.tbl_arc (
  id SERIAL PRIMARY KEY,
  rfq_id INTEGER NOT NULL REFERENCES public.tbl_rfq(id),
  vendor_id INTEGER NOT NULL,
  hospitality_company_id INTEGER NOT NULL,
  tender_scope VARCHAR(8) NOT NULL,
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING_COMMITTEE',
  document_url TEXT,
  document_generated_at TIMESTAMP WITHOUT TIME ZONE,
  created_by INTEGER NOT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE,
  CONSTRAINT uq_arc_rfq_vendor UNIQUE (rfq_id, vendor_id),
  CONSTRAINT chk_arc_period CHECK (period_to > period_from),
  CONSTRAINT chk_arc_status CHECK (status IN (
    'PENDING_COMMITTEE',
    'PARTIALLY_DECIDED',
    'DOC_GENERATED',
    'ACTIVE',
    'EXPIRED',
    'VOID'
  )),
  CONSTRAINT chk_arc_scope CHECK (tender_scope IN ('SINGLE', 'GROUP'))
);
CREATE INDEX IF NOT EXISTS idx_arc_rfq ON public.tbl_arc(rfq_id);
CREATE INDEX IF NOT EXISTS idx_arc_vendor ON public.tbl_arc(vendor_id);
CREATE INDEX IF NOT EXISTS idx_arc_status_period
  ON public.tbl_arc(status, period_to)
  WHERE status IN ('ACTIVE', 'DOC_GENERATED');

-- 2.3 tbl_arc_hotels — denormalised hotel coverage of each ARC envelope
-- Populated from tbl_rfq_hotel_mappings at finalization time so the
-- contracted-item lookup can index directly on hotel_id without a tender
-- join (Phase 6 hot path).
CREATE TABLE IF NOT EXISTS public.tbl_arc_hotels (
  id SERIAL PRIMARY KEY,
  arc_id INTEGER NOT NULL REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  hotel_id INTEGER NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE CASCADE,
  CONSTRAINT uq_arc_hotel UNIQUE (arc_id, hotel_id)
);
CREATE INDEX IF NOT EXISTS idx_arc_hotels_hotel ON public.tbl_arc_hotels(hotel_id);

-- 2.4 tbl_arc_item — one per finalized (product, vendor) line under an envelope
CREATE TABLE IF NOT EXISTS public.tbl_arc_item (
  id SERIAL PRIMARY KEY,
  arc_id INTEGER NOT NULL REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  rfq_product_id INTEGER NOT NULL,
  product_variant_id INTEGER NOT NULL,
  variant VARCHAR(255),
  quote_id INTEGER NOT NULL,
  unit_price NUMERIC(14, 2) NOT NULL,
  charges_meta JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  approval_instance_id INTEGER,
  approved_at TIMESTAMP WITHOUT TIME ZONE,
  approved_by INTEGER,
  rejection_remarks TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  CONSTRAINT uq_arc_item UNIQUE (arc_id, product_variant_id, variant),
  CONSTRAINT chk_arc_item_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'))
);
CREATE INDEX IF NOT EXISTS idx_arc_item_product ON public.tbl_arc_item(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_arc_item_arc ON public.tbl_arc_item(arc_id);
CREATE INDEX IF NOT EXISTS idx_arc_item_approval_instance
  ON public.tbl_arc_item(approval_instance_id) WHERE approval_instance_id IS NOT NULL;

-- 2.5 tbl_arc_vendor_signing — v2 seam (table created now; endpoints deferred)
CREATE TABLE IF NOT EXISTS public.tbl_arc_vendor_signing (
  id SERIAL PRIMARY KEY,
  arc_id INTEGER NOT NULL REFERENCES public.tbl_arc(id),
  status VARCHAR(20) DEFAULT 'NOT_REQUIRED',
  signed_at TIMESTAMP WITHOUT TIME ZONE,
  signature_metadata JSONB,
  reminder_count INTEGER DEFAULT 0,
  last_reminder_at TIMESTAMP WITHOUT TIME ZONE,
  CONSTRAINT chk_arc_signing_status CHECK (status IN (
    'NOT_REQUIRED',
    'PENDING',
    'SIGNED',
    'REJECTED'
  ))
);
CREATE INDEX IF NOT EXISTS idx_arc_signing_arc ON public.tbl_arc_vendor_signing(arc_id);

-- 2.6 tbl_arc_release — call-off / release-order
CREATE TABLE IF NOT EXISTS public.tbl_arc_release (
  id SERIAL PRIMARY KEY,
  arc_id INTEGER NOT NULL REFERENCES public.tbl_arc(id),
  hotel_id INTEGER NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id),
  vendor_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'DRAFT',
  total_value NUMERIC(14, 2),
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  CONSTRAINT chk_arc_release_status CHECK (status IN ('DRAFT', 'PO_DRAFTED', 'CANCELLED'))
);
CREATE INDEX IF NOT EXISTS idx_arc_release_arc ON public.tbl_arc_release(arc_id);
CREATE INDEX IF NOT EXISTS idx_arc_release_vendor_hotel
  ON public.tbl_arc_release(vendor_id, hotel_id);

-- 2.7 tbl_arc_release_items
CREATE TABLE IF NOT EXISTS public.tbl_arc_release_items (
  id SERIAL PRIMARY KEY,
  arc_release_id INTEGER NOT NULL REFERENCES public.tbl_arc_release(id) ON DELETE CASCADE,
  arc_item_id INTEGER NOT NULL REFERENCES public.tbl_arc_item(id),
  product_variant_id INTEGER NOT NULL,
  quantity NUMERIC(14, 3) NOT NULL,
  unit_price NUMERIC(14, 2) NOT NULL,
  total_price NUMERIC(14, 2) NOT NULL,
  charges_meta JSONB
);
CREATE INDEX IF NOT EXISTS idx_arc_release_items_release
  ON public.tbl_arc_release_items(arc_release_id);
CREATE INDEX IF NOT EXISTS idx_arc_release_items_arc_item
  ON public.tbl_arc_release_items(arc_item_id);

-- 2.8 tbl_tender_sendback_history — full JSONB snapshots of each iteration wipe
CREATE TABLE IF NOT EXISTS public.tbl_tender_sendback_history (
  id SERIAL PRIMARY KEY,
  rfq_id INTEGER NOT NULL REFERENCES public.tbl_rfq(id),
  iteration_number INTEGER NOT NULL,
  sent_back_from_stage VARCHAR(40) NOT NULL,
  sent_back_to_stage VARCHAR(40) NOT NULL,
  sent_back_by INTEGER NOT NULL,
  sent_back_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  reason TEXT NOT NULL,
  snapshot_arc JSONB,
  snapshot_finalization JSONB,
  snapshot_negotiation JSONB,
  snapshot_tech_eval JSONB,
  snapshot_quotes JSONB,
  snapshot_approval_instances JSONB,
  affected_products INTEGER[],
  affected_vendors INTEGER[],
  metadata JSONB
);
CREATE INDEX IF NOT EXISTS idx_tender_sendback_rfq
  ON public.tbl_tender_sendback_history(rfq_id);
CREATE INDEX IF NOT EXISTS idx_tender_sendback_iteration
  ON public.tbl_tender_sendback_history(rfq_id, iteration_number);

-- 2.9 tbl_rfq_purchase_order — contracted-PO extensions
ALTER TABLE public.tbl_rfq_purchase_order
  ADD COLUMN IF NOT EXISTS arc_release_id INTEGER REFERENCES public.tbl_arc_release(id),
  ADD COLUMN IF NOT EXISTS is_contracted SMALLINT DEFAULT 0;

-- Contracted POs have no RFQ parent; release is the parent instead.
ALTER TABLE public.tbl_rfq_purchase_order
  ALTER COLUMN rfq_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_po_arc_release
  ON public.tbl_rfq_purchase_order(arc_release_id)
  WHERE arc_release_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_po_is_contracted
  ON public.tbl_rfq_purchase_order(is_contracted) WHERE is_contracted = 1;

-- ---------------------------------------------------------------------------
-- 3. Backfill historical data
-- ---------------------------------------------------------------------------

-- Any pre-existing tender rows default to SINGLE scope; admin can edit later.
UPDATE public.tbl_rfq
SET tender_scope = 'SINGLE'
WHERE is_tender = 1 AND tender_scope IS NULL;

-- iteration_number is NOT NULL DEFAULT 1; nothing to backfill, but enforce.
UPDATE public.tbl_rfq SET iteration_number = 1 WHERE iteration_number IS NULL;

COMMIT;

-- ---------------------------------------------------------------------------
-- 4. Permission seeds (idempotent via NOT EXISTS; tbl_permissions has no
--    unique (resource, action) constraint, so we cannot use ON CONFLICT.)
-- ---------------------------------------------------------------------------
INSERT INTO public.tbl_permissions (resource, action, ordering)
SELECT v.resource::public.resource_type,
       v.action::public.permission_action_type,
       0
FROM (VALUES
  ('tender',      'create'),
  ('tender',      'publish'),
  ('tender',      'update'),
  ('tender',      'approve'),
  ('arc',         'create'),
  ('arc',         'approve'),
  ('arc',         'send_back'),
  ('te',          'send_back'),
  ('negotiation', 'send_back'),
  ('rfq',         'bypass_arc')
) AS v(resource, action)
WHERE NOT EXISTS (
  SELECT 1 FROM public.tbl_permissions p
  WHERE p.resource::text = v.resource
    AND p.action::text = v.action
);
