-- ARC v2 — vendor quote version history (audit trail of every submission).
-- A vendor may re-submit their commercial quote any number of times while the
-- submission window is open. submitQuote overwrites the LIVE quote in place, so
-- this table archives an immutable, append-only snapshot of EACH submission —
-- a COMPLETE record of what was sent, for audit/history.
-- version_no is per arc_quote_id, monotonically increasing (count of existing
-- versions + 1), assigned inside the submit transaction. No FKs: this is a
-- write-once audit ledger that must survive even if the live quote is reshaped.
CREATE TABLE IF NOT EXISTS public.tbl_arc_quote_version (
  id            BIGSERIAL PRIMARY KEY,
  arc_quote_id  BIGINT  NOT NULL,
  arc_id        BIGINT  NOT NULL,
  vendor_id     INTEGER NOT NULL,
  version_no    INTEGER NOT NULL,
  quote_pricing JSONB,
  lines         JSONB,
  submitted_at  TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  created_at    TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_quote_version_lookup
  ON public.tbl_arc_quote_version (arc_id, vendor_id, version_no);
