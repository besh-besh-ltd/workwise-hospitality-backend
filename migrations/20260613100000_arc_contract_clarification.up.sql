-- ARC v2 — Vendor-initiated contract clarification loop.
--
-- When a vendor reviewing a generated rate-contract disputes a specific field
-- on an awarded line (base price, GST, freight, committed qty, payment or
-- delivery terms), they raise a structured clarification. That rolls the ARC
-- lifecycle back to the commercial stage (red / "clarification needed"), lets
-- the commercial evaluator edit ONLY the disputed field and either revise or
-- uphold it, then flows forward again through committee awarding approval →
-- contract regeneration → vendor re-review. Signing is blocked while any
-- clarification is open — you never e-sign a contract you're disputing.

CREATE TABLE IF NOT EXISTS public.tbl_arc_contract_clarification (
  id                    BIGSERIAL PRIMARY KEY,
  arc_id                BIGINT  NOT NULL REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  arc_contract_id       BIGINT  NOT NULL REFERENCES public.tbl_arc_contract(id) ON DELETE CASCADE,
  -- Keyed on the (stable) ARC item, not the contract line, so regeneration
  -- (which rewrites lines) never cascade-deletes clarification history.
  arc_item_id           BIGINT  NOT NULL REFERENCES public.tbl_arc_item(id) ON DELETE CASCADE,
  vendor_id             INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  field                 VARCHAR(24) NOT NULL,
  round                 INTEGER NOT NULL DEFAULT 1,
  vendor_comment        TEXT NOT NULL,
  status                VARCHAR(16) NOT NULL DEFAULT 'open',
  old_value             JSONB,
  new_value             JSONB,
  buyer_response        TEXT,
  raised_by             INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  resolved_by           INTEGER REFERENCES public.tbl_users(id) ON DELETE SET NULL,
  resolved_at           TIMESTAMP WITHOUT TIME ZONE,
  created_at            TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tbl_arc_contract_clarification_field_chk
    CHECK (field IN ('base_price','gst','charges','committed_qty','payment_terms','delivery_terms')),
  CONSTRAINT tbl_arc_contract_clarification_status_chk
    CHECK (status IN ('open','revised','upheld','withdrawn'))
);
CREATE INDEX IF NOT EXISTS idx_arc_contract_clarification_arc
  ON public.tbl_arc_contract_clarification (arc_id);
CREATE INDEX IF NOT EXISTS idx_arc_contract_clarification_contract
  ON public.tbl_arc_contract_clarification (arc_contract_id, status);

-- Allow the contract to sit in a 'clarification' holding state while the
-- dispute is routed back to the commercial evaluator.
ALTER TABLE public.tbl_arc_contract DROP CONSTRAINT IF EXISTS tbl_arc_contract_status_chk;
ALTER TABLE public.tbl_arc_contract ADD CONSTRAINT tbl_arc_contract_status_chk CHECK (status IN (
  'generated','awaiting_acceptance','clarification','active','expiring_soon','expired','terminated','declined'
));
