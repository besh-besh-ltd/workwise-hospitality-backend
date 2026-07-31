-- ===========================================================================
--  P0 DATA REPAIR — tbl_rfq.hospitality_company_id wiped to NULL
-- ===========================================================================
--
--  ⚠️  DEPLOY THE CODE FIX FIRST. ⚠️
--
--  This script is INERT until the fix in
--    app/controllers/rfq/rfqController.js  (saveRfqDraft: "absent" is not "null")
--    app/models/rfqModel.js                (getRfqDraftById: return hospitality_company_id)
--  is live in production. saveRfqDraft used to build an unconditional
--  full-column UPDATE, so a request that simply OMITTED `hospitality_company_id`
--  wrote NULL over it. If you run this repair against the old code, the very
--  next auto-save from the RFQ wizard re-nulls the same rows and you will have
--  burned the maintenance window for nothing.
--
--  Order of operations:
--    1. Deploy backend (rfqController.js + rfqModel.js).
--    2. Smoke-test: open an RFQ draft, let it auto-save, confirm
--       tbl_rfq.hospitality_company_id is unchanged.
--    3. Take a backup / run inside a transaction (below).
--    4. Run section A (identify), eyeball it, then section B (repair).
--
-- ---------------------------------------------------------------------------
--  WHY IT MATTERS
--  Every buyer-visibility query gates on
--      _urs2.company_id = RFQ.hospitality_company_id
--  and `x = NULL` is never TRUE, so a nulled RFQ disappears from every buyer
--  surface — listings, dashboards, AND the direct URL (getRfqById answers 403).
--
--  WHY IT CANNOT CROSS TENANTS
--  The company is derived from the RFQ's OWN hotel: either tbl_rfq.hotel_id or,
--  when that is also NULL, the RFQ's first row in tbl_rfq_hotel_mappings. We
--  never join on anything the RFQ does not already point at, so a row can only
--  ever be restored to the company that owns its own business unit.
--
--  Verified read-only against hospitality_main on 2026-07-30:
--    84 RFQs with hospitality_company_id IS NULL
--    80 repairable (they have a hotel mapping)   <-- section B affects exactly these
--     4 unrepairable (no hotel mapping at all)   <-- section C lists them for manual triage
--     0 RFQs whose hotel mappings span more than one hospitality company
--    Of the 80: 69 are unpublished drafts, 11 are live published RFQs.
--    75 of the 80 also have hotel_id IS NULL and get it restored.
--
-- ---------------------------------------------------------------------------
--  ⚠️  THIS SCRIPT DOES NOT FULLY HEAL THE AFFECTED ROWS. ⚠️
--
--  The same partial save-draft wiped MORE than the company. Verified in prod:
--    35 RFQs have bid_end_date = ''
--    35 of those 35 also have hospitality_company_id IS NULL  (100% overlap)
--     0 rows have an empty bid_end_date with a valid company
--  All 35 are inside section B's 80-row set, so after this repair they will
--  have a correct company and hotel but STILL carry an empty deadline.
--
--  bid_end_date is `text NOT NULL`, so '' is a legal value the DB will not
--  reject — but it is not a legal DATE. Anything that casts it explodes:
--  app/models/hospitalityModel.js casts r.bid_end_date::timestamp in the
--  vendor backfill query, and ONE empty-string row aborts the ENTIRE query
--  with `invalid input syntax for type timestamp: ""`, so every newly
--  registered vendor lands on an empty dashboard. The worst row is
--  RFQ id 744 / rfq_no 536286 — published, 446 invited vendors, both columns
--  wiped.
--
--  bid_end_date CANNOT be repaired mechanically: a procurement deadline is a
--  commercial commitment to the invited vendors, and there is no column,
--  audit row, or hotel attribute to derive the buyer's intended date from.
--  Guessing one (now() + 7 days, say) would silently re-open or foreclose a
--  live bid. Section E lists the rows so the team can chase the RFQ owners for
--  a real date; until then the NULLIF guard in hospitalityModel.js is what
--  keeps the vendor dashboard alive.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- SECTION A — IDENTIFY (read-only). Run this first and keep the output.
-- ---------------------------------------------------------------------------
SELECT
    r.id                       AS rfq_id,
    r.rfq_no,
    r.title,
    r.status,
    r.is_published,
    r.created_by,
    r."timestamp"              AS created_at,
    r.hotel_id                 AS current_hotel_id,
    h.id                       AS resolved_hotel_id,
    h.name                     AS resolved_hotel_name,
    h.hospitality_company_id   AS resolved_company_id,
    hc.name                    AS resolved_company_name,
    (SELECT count(*) FROM tbl_rfq_product_vendors v WHERE v.rfq_id = r.id)
                               AS vendor_invitations
FROM tbl_rfq r
JOIN tbl_hospitality_company_hotels h
       ON h.id = COALESCE(
                    r.hotel_id,
                    (SELECT m.hotel_id
                       FROM tbl_rfq_hotel_mappings m
                      WHERE m.rfq_id = r.id
                      ORDER BY m.id
                      LIMIT 1)
                 )
      AND h.is_deleted = 0
LEFT JOIN tbl_hospitality_companies hc ON hc.id = h.hospitality_company_id
WHERE r.hospitality_company_id IS NULL
  AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings m2 WHERE m2.rfq_id = r.id)
ORDER BY r.is_published DESC, r.id;
-- expect: 80 rows


-- ---------------------------------------------------------------------------
-- SECTION A2 — SAFETY ASSERTION (read-only). MUST return 0.
-- If this returns anything, STOP: those RFQs map to hotels in more than one
-- hospitality company and picking "the first mapping" would be a guess.
-- ---------------------------------------------------------------------------
SELECT r.id AS ambiguous_rfq_id,
       array_agg(DISTINCT h.hospitality_company_id) AS candidate_companies
FROM tbl_rfq r
JOIN tbl_rfq_hotel_mappings m ON m.rfq_id = r.id
JOIN tbl_hospitality_company_hotels h ON h.id = m.hotel_id AND h.is_deleted = 0
WHERE r.hospitality_company_id IS NULL
GROUP BY r.id
HAVING count(DISTINCT h.hospitality_company_id) > 1;
-- expect: 0 rows


-- ---------------------------------------------------------------------------
-- SECTION B — REPAIR.
-- Run inside an explicit transaction so you can inspect the row count before
-- committing:
--
--     BEGIN;
--     \i scripts/repair_null_hospitality_company_id.sql   -- (or paste the UPDATE)
--     -- read the "UPDATE n" line; if n <> 80, ROLLBACK and re-triage.
--     COMMIT;
--
-- hotel_id is restored with COALESCE so an RFQ that lost both columns gets both
-- back; an RFQ that still has its hotel_id keeps exactly the value it had.
-- ---------------------------------------------------------------------------
UPDATE tbl_rfq r
SET hospitality_company_id = h.hospitality_company_id,
    hotel_id               = COALESCE(r.hotel_id, h.id)
FROM tbl_hospitality_company_hotels h
WHERE h.id = COALESCE(
                r.hotel_id,
                (SELECT m.hotel_id
                   FROM tbl_rfq_hotel_mappings m
                  WHERE m.rfq_id = r.id
                  ORDER BY m.id
                  LIMIT 1)
             )
  AND h.is_deleted = 0
  AND r.hospitality_company_id IS NULL
  AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings m2 WHERE m2.rfq_id = r.id);
-- expect: UPDATE 80


-- ---------------------------------------------------------------------------
-- SECTION C — RESIDUE (read-only). The rows section B cannot touch because the
-- RFQ has no hotel mapping to derive a company from. Expect 4. These need a
-- human decision (usually: they are abandoned drafts and can be left alone, or
-- the creator's own hospitality mapping identifies the intended company).
-- ---------------------------------------------------------------------------
SELECT
    r.id AS rfq_id, r.rfq_no, r.title, r.status, r.is_published,
    r.created_by, r."timestamp" AS created_at,
    (SELECT array_agg(DISTINCT hum.hospitality_company_id)
       FROM tbl_hospitality_user_mappings hum
      WHERE hum.user_id = r.created_by) AS creator_companies
FROM tbl_rfq r
WHERE r.hospitality_company_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings m WHERE m.rfq_id = r.id)
ORDER BY r.id;
-- expect: 4 rows


-- ---------------------------------------------------------------------------
-- SECTION D — POST-REPAIR VERIFICATION (read-only).
-- ---------------------------------------------------------------------------
SELECT count(*) AS still_null_with_a_hotel_mapping
FROM tbl_rfq r
WHERE r.hospitality_company_id IS NULL
  AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings m WHERE m.rfq_id = r.id);
-- expect: 0

SELECT count(*) AS rfqs_whose_company_disagrees_with_their_hotel
FROM tbl_rfq r
JOIN tbl_hospitality_company_hotels h ON h.id = r.hotel_id
WHERE r.hospitality_company_id IS NOT NULL
  AND r.hospitality_company_id <> h.hospitality_company_id;
-- expect: 0 (no RFQ pointing at a hotel that belongs to a different company)


-- ---------------------------------------------------------------------------
-- SECTION E — STILL-BROKEN AFTER THIS REPAIR: empty bid_end_date (read-only).
--
-- These rows get their company/hotel back from section B but still hold
-- bid_end_date = '', which is NOT NULL-legal but not a valid timestamp. Every
-- row here needs a REAL deadline from the RFQ owner — do not invent one.
--
-- Work the list top-down: published rows with invited vendors are live bids
-- with real vendors waiting, and are also what breaks the vendor-backfill
-- cast. Unpublished drafts can simply be re-saved by their creator through the
-- fixed wizard, which will write a proper date.
--
-- Expect 35 rows: 34 unpublished drafts + 1 published (id 744 / rfq_no 536286,
-- 446 invited vendors).
--
-- Once an owner supplies a date, set it with an explicit, per-row statement so
-- every change is attributable, e.g.
--     UPDATE tbl_rfq SET bid_end_date = '2026-08-15T18:00:00' WHERE id = 744;
-- ---------------------------------------------------------------------------
SELECT
    r.id AS rfq_id,
    r.rfq_no,
    r.title,
    r.status,
    r.is_published,
    r.created_by,
    u.name  AS owner_name,
    u.email AS owner_email,
    r."timestamp" AS created_at,
    r.hospitality_company_id,   -- non-null once section B has run
    r.hotel_id,
    (SELECT count(*) FROM tbl_rfq_product_vendors v WHERE v.rfq_id = r.id)
        AS invited_vendors,
    (SELECT count(*) FROM tbl_quotes q WHERE q.rfq_id = r.id)
        AS quotes_received
FROM tbl_rfq r
LEFT JOIN tbl_users u ON u.id = r.created_by
WHERE r.bid_end_date = ''
ORDER BY r.is_published DESC, invited_vendors DESC, r.id;
-- expect: 35 rows

-- Quick triage counter for the same set.
SELECT
    count(*)                                              AS empty_deadline_total,
    count(*) FILTER (WHERE r.is_published = 1)            AS live_published,
    count(*) FILTER (WHERE r.is_published = 0)            AS unpublished_drafts,
    count(*) FILTER (WHERE r.hospitality_company_id IS NULL) AS still_missing_company
FROM tbl_rfq r
WHERE r.bid_end_date = '';
-- expect after section B: 35 / 1 / 34 / 0
