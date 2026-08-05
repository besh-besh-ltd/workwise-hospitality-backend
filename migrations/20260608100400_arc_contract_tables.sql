-- ARC v2 — Migration 6 of 10: ARC contract tables.
--
-- Implements plan §4.6. One contract per (arc_id, vendor_id) — multiple per
-- ARC when items are split across vendors. The ARC moves to `contract_active`
-- only when every vendor contract is signed (see plan §4.6 activation rule).

CREATE TABLE IF NOT EXISTS public.tbl_arc_contract (
  id                       BIGSERIAL PRIMARY KEY,
  arc_id                   BIGINT  NOT NULL REFERENCES public.tbl_arc(id) ON DELETE RESTRICT,
  vendor_id                INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  document_s3_url          TEXT,
  document_hash            VARCHAR(128),
  status                   VARCHAR(40) NOT NULL DEFAULT 'generated',
  generated_at             TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  awaiting_until           TIMESTAMP WITHOUT TIME ZONE,
  signed_by_vendor_at      TIMESTAMP WITHOUT TIME ZONE,
  terminated_at            TIMESTAMP WITHOUT TIME ZONE,
  terminated_reason        TEXT,
  created_at               TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (arc_id, vendor_id),
  CONSTRAINT tbl_arc_contract_status_chk CHECK (status IN (
    'generated','awaiting_acceptance','active','expiring_soon','expired','terminated','declined'
  ))
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_contract_arc     ON public.tbl_arc_contract (arc_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_contract_vendor  ON public.tbl_arc_contract (vendor_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_contract_status  ON public.tbl_arc_contract (status);

CREATE TABLE IF NOT EXISTS public.tbl_arc_contract_line (
  id                       BIGSERIAL PRIMARY KEY,
  arc_contract_id          BIGINT  NOT NULL REFERENCES public.tbl_arc_contract(id) ON DELETE CASCADE,
  arc_item_id              BIGINT  NOT NULL REFERENCES public.tbl_arc_item(id) ON DELETE RESTRICT,
  unit_rate                NUMERIC(15,2) NOT NULL,
  gst_pct                  NUMERIC(5,2),
  charges                  JSONB DEFAULT '[]'::jsonb,
  payment_terms            VARCHAR(255),
  delivery_terms           VARCHAR(255),
  committed_qty            NUMERIC(15,2) NOT NULL,
  consumed_qty             NUMERIC(15,2) NOT NULL DEFAULT 0,
  awarded_quote_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (arc_contract_id, arc_item_id)
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_contract_line_contract  ON public.tbl_arc_contract_line (arc_contract_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_contract_line_item      ON public.tbl_arc_contract_line (arc_item_id);

CREATE TABLE IF NOT EXISTS public.tbl_arc_contract_signature_otp (
  id                   BIGSERIAL PRIMARY KEY,
  arc_contract_id      BIGINT  NOT NULL REFERENCES public.tbl_arc_contract(id) ON DELETE CASCADE,
  vendor_user_id       INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  otp_hash             VARCHAR(128) NOT NULL,
  expires_at           TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  verified_at          TIMESTAMP WITHOUT TIME ZONE,
  attempts             INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_contract_signature_otp_contract
  ON public.tbl_arc_contract_signature_otp (arc_contract_id);
