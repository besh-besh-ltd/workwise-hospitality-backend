-- ARC v2 two-envelope tech eval — vendor technical-envelope seal marker.
-- One row per (arc_id, vendor_id) already exists in tbl_arc_quote; the
-- technical envelope rides the same vendor↔ARC relationship as the commercial
-- quote. tech_submitted_at IS NOT NULL = vendor has SEALED their technical
-- envelope (locks further tech-envelope edits). When the ARC requires technical
-- responses, this gates the commercial submitQuote (hard two-step).
ALTER TABLE public.tbl_arc_quote
  ADD COLUMN IF NOT EXISTS tech_submitted_at TIMESTAMP WITHOUT TIME ZONE;
