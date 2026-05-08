-- Migration 007 — Capture vendor-selection rationale on ARC releases.
--
-- When a contracted item is covered by multiple vendor ARCs, the buyer
-- picks one vendor in the release wizard. The business team wants the
-- reason for that choice recorded on the release (and surfaced on the
-- resulting PO) so audit can trace why this vendor was preferred over
-- the others — especially relevant when the choice isn't the cheapest
-- contracted rate.
--
-- Optional column: blank when only one eligible vendor exists. App
-- tier enforces a presence + minimum-length check ONLY when multiple
-- vendors are eligible at release-creation time.

ALTER TABLE public.tbl_arc_release
  ADD COLUMN IF NOT EXISTS vendor_selection_reason TEXT;
