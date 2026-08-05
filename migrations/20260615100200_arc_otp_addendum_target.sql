-- Reuse the contract OTP machinery for addendum signing. NULL = original
-- contract signing; set = addendum signing.
ALTER TABLE public.tbl_arc_contract_signature_otp
  ADD COLUMN IF NOT EXISTS arc_amendment_document_id BIGINT
    REFERENCES public.tbl_arc_amendment_document(id) ON DELETE CASCADE;
