-- ARC v2 Phase 1: vendor T&C acceptance gate.
-- terms_accepted_at: set when vendor clicks "Accept" on the Overview stage; gates
-- access to the technical and commercial stages. Idempotent (COALESCE on update).
-- line_pricing / quote_pricing are Phase-2 columns included here so we only need
-- one migration across both sub-cycles. They are UNUSED until Phase 2 activates
-- the server-authoritative pricing engine.
ALTER TABLE public.tbl_arc_quote
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP WITHOUT TIME ZONE;

-- Phase 2 (unused in Phase 1 — additive / safe to include now):
ALTER TABLE public.tbl_arc_quote
  ADD COLUMN IF NOT EXISTS quote_pricing JSONB;

ALTER TABLE public.tbl_arc_quote_line
  ADD COLUMN IF NOT EXISTS line_pricing JSONB;
