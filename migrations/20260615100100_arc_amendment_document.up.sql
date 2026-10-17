-- One addendum document per approved amendment. Never overwrites the original
-- signed contract (tbl_arc_contract.document_s3_url) — a parallel artefact that
-- the vendor re-signs (OTP) before the amendment's effects bind.
CREATE TABLE IF NOT EXISTS public.tbl_arc_amendment_document (
  id                   BIGSERIAL PRIMARY KEY,
  arc_amendment_id     BIGINT  NOT NULL REFERENCES public.tbl_arc_amendment(id) ON DELETE CASCADE,
  arc_contract_id      BIGINT  NOT NULL REFERENCES public.tbl_arc_contract(id)  ON DELETE CASCADE,
  addendum_number      INTEGER NOT NULL,
  document_s3_url      TEXT,
  document_hash        VARCHAR(128),
  status               VARCHAR(30) NOT NULL DEFAULT 'awaiting_signature'
                         CHECK (status IN ('awaiting_signature','signed','voided')),
  signed_by_vendor_at  TIMESTAMP,
  signed_by            INTEGER REFERENCES public.tbl_users(id),
  generated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- One addendum per amendment.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tbl_arc_amendment_document_amendment
  ON public.tbl_arc_amendment_document (arc_amendment_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_amendment_document_contract
  ON public.tbl_arc_amendment_document (arc_contract_id, addendum_number);
