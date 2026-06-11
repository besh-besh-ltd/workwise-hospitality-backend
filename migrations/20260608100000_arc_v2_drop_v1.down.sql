-- Rollback for 20260608100000_arc_v2_drop_v1.sql
--
-- Best-effort recreate of the v1 ARC tables, empty. Column definitions are
-- reconstructed from the production audit captured in the ARC v2 plan
-- (§Audit findings: existing ARC artifacts in DB). This rollback is intended
-- as a safety net only — restoring v1 behaviour requires also restoring the
-- quarantined files under backend/_deprecated/arc_v1/ and the ARC entries in
-- approvalActionService.js / approvalPropagationService.js.
--
-- Indexes and FKs are not recreated by this rollback; if production rollback
-- is ever needed, take a fresh schema dump first.

CREATE TABLE IF NOT EXISTS public.tbl_arc (
  id                         BIGSERIAL PRIMARY KEY,
  rfq_id                     INTEGER,
  vendor_id                  INTEGER,
  hospitality_company_id     INTEGER,
  tender_scope               VARCHAR,
  period_from                DATE,
  period_to                  DATE,
  status                     VARCHAR,
  document_url               TEXT,
  document_generated_at      TIMESTAMP,
  created_by                 INTEGER,
  created_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.tbl_arc_hotels (
  id                         BIGSERIAL PRIMARY KEY,
  arc_id                     INTEGER REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  hotel_id                   INTEGER
);

CREATE TABLE IF NOT EXISTS public.tbl_arc_item (
  id                         BIGSERIAL PRIMARY KEY,
  arc_id                     INTEGER REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  rfq_product_id             INTEGER,
  quote_id                   INTEGER,
  unit_price                 NUMERIC,
  charges_meta               JSONB,
  approval_instance_id       INTEGER,
  approved_at                TIMESTAMP,
  approved_by                INTEGER,
  product_variant_id         INTEGER,
  created_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.tbl_arc_release (
  id                         BIGSERIAL PRIMARY KEY,
  arc_id                     INTEGER REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  hotel_id                   INTEGER,
  vendor_id                  INTEGER,
  status                     VARCHAR,
  total_value                NUMERIC,
  process_id                 INTEGER,
  vendor_selection_reason    TEXT,
  created_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.tbl_arc_release_items (
  id                         BIGSERIAL PRIMARY KEY,
  arc_release_id             INTEGER REFERENCES public.tbl_arc_release(id) ON DELETE CASCADE,
  arc_item_id                INTEGER REFERENCES public.tbl_arc_item(id) ON DELETE CASCADE,
  quantity                   NUMERIC,
  unit_price                 NUMERIC,
  created_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.tbl_arc_vendor_signing (
  id                         BIGSERIAL PRIMARY KEY,
  arc_id                     INTEGER REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  vendor_id                  INTEGER,
  signed_at                  TIMESTAMP,
  signed_by                  INTEGER,
  signature_hash             VARCHAR,
  created_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
