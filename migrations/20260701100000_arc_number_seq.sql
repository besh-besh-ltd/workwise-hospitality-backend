-- ARC Contract Serial FY — atomic per-financial-year sequence for arc_number.
--
-- Backs the ARC contract-serial format `ARC-<FY>-<seq>` (e.g. ARC-2026-27-0001),
-- where FY is the Indian financial year (Apr–Mar), computed from IST wall-clock
-- via app/helper/financialYear.js. One row per FY; last_seq is incremented with
-- a single atomic `INSERT … ON CONFLICT … DO UPDATE … RETURNING` upsert run
-- INSIDE the ARC create transaction (see arcModel.nextArcNumber) — race-safe,
-- no explicit locking, and deliberately NOT the RFQ `MAX(rfq_no)+1` pattern
-- (rfqModel.getLastRfQNumber) which is race-prone. A new FY simply inserts a
-- fresh row starting at 1, giving an automatic per-FY reset.
--
-- Existing ARC serials (format `ARC-<calendarYear>-<base36 suffix>`) are NOT
-- rewritten or seeded into this table — it only backs newly-created ARCs
-- going forward; mixed formats coexist under the existing UNIQUE(arc_number).

CREATE TABLE IF NOT EXISTS public.tbl_arc_number_seq (
  fy        VARCHAR(9) PRIMARY KEY,   -- Indian FY label, e.g. '2026-27'
  last_seq  INTEGER NOT NULL
);
