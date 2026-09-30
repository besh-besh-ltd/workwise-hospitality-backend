-- ARC v2 — Blind technical evaluation (anti-favoritism).
-- A STORED per-ARC alias index for each technically-participating vendor.
-- alias_index is assigned by tech-envelope first-submission order (vendor_id as
-- a deterministic tiebreak) — NOT by vendor_id ascending — so the alias does
-- not trivially map back to a real identity. The label "Vendor A / Vendor B …"
-- is derived from alias_index (base-26 bijective) in the server only.
-- Keyed on (arc_id, vendor_id) ONLY (never on evaluation_round): a vendor keeps
-- the same letter across rounds, items, clauses and reloads, and identically for
-- the evaluator and the approver. Written once, then read-only — stable.
CREATE TABLE IF NOT EXISTS public.tbl_arc_vendor_alias (
  id          BIGSERIAL PRIMARY KEY,
  arc_id      BIGINT  NOT NULL REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  vendor_id   INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  alias_index INTEGER NOT NULL,           -- 0-based; label = letterFor(alias_index)
  created_at  TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (arc_id, vendor_id),
  UNIQUE (arc_id, alias_index)
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_vendor_alias_arc ON public.tbl_arc_vendor_alias (arc_id);
