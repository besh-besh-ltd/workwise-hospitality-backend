-- SEC1 pre-deploy checks (inv/sec-finalize). READ-ONLY: SELECTs only.
-- Run on PRODUCTION before qa -> main. Each query lists the rows the new
-- approval-time binding would REFUSE, so an empty result means nothing that is
-- pending today will be blocked by the deploy.
--
-- What is refused (app/services/po/awardQuoteBinding.js):
--   bindParkedAward    - a NEGOTIATION_QUOTE instance's metadata.po_payload
--                        (parked by POST /rfq/finalize) must name a quote line
--                        of its RFQ, by the vendor the PO is for, for the
--                        instance's product. Check 1.
--   bindSelectedQuotes - a NEGOTIATION_QUOTE instance's metadata.selected_quotes
--                        (parked by submit-for-approval) must each be a quote
--                        of this RFQ product by the vendor named. Round-sourced
--                        entries carry negotiation_round_id, regular ones never
--                        do. Check 2.
-- Refused instances stay PENDING (approveQuotes answers 404/400, the approval
-- engine 404/400 for an approver on the current step). Any row returned needs
-- a look before the deploy: re-run commercial finalization / re-submit for the
-- product, or cancel the instance.

-- 1. Pending parked finalize payloads that do not bind. Expect 0 rows.
WITH p AS (
  SELECT ai.id, ai.entity_id, ai.metadata->>'rfq_id' AS meta_rfq, ai.metadata->'po_payload' AS pl
    FROM tbl_approval_instances ai
   WHERE ai.entity_type = 'NEGOTIATION_QUOTE' AND ai.status = 'PENDING' AND ai.metadata ? 'po_payload'
), ids AS (
  SELECT p.*,
    NULLIF(p.pl#>>'{product_info,finalized_vendor_id}','') AS fin_vendor,
    NULLIF(p.pl->>'vendor_id','')                          AS top_vendor,
    CASE WHEN p.pl->>'rfq_id' ~ '^\d+$' THEN (p.pl->>'rfq_id')::int END AS rfq_id,
    CASE WHEN p.pl#>>'{product_info,rfq_product_id}' ~ '^\d+$' THEN (p.pl#>>'{product_info,rfq_product_id}')::int END AS rp_id,
    CASE WHEN COALESCE(NULLIF(p.pl#>>'{product_info,finalized_vendor_id}',''), p.pl->>'vendor_id') ~ '^\d+$'
         THEN COALESCE(NULLIF(p.pl#>>'{product_info,finalized_vendor_id}',''), p.pl->>'vendor_id')::int END AS vendor_id,
    CASE WHEN COALESCE(NULLIF(p.pl->>'quote_item_id',''), p.pl->>'quote_id') ~ '^\d+$'
         THEN COALESCE(NULLIF(p.pl->>'quote_item_id',''), p.pl->>'quote_id')::int END AS qi_id
  FROM p
)
SELECT ids.id
  FROM ids
  LEFT JOIN tbl_quote_items qi ON qi.id = ids.qi_id
  LEFT JOIN tbl_quotes q ON q.id = qi.quote_id
  LEFT JOIN tbl_rfq_products rp ON rp.id = ids.rp_id AND rp.rfq_id = ids.rfq_id
 WHERE (    ids.rp_id = ids.entity_id
        AND (ids.meta_rfq IS NULL OR ids.meta_rfq = ids.rfq_id::text)
        AND (ids.fin_vendor IS NULL OR ids.top_vendor IS NULL OR ids.fin_vendor = ids.top_vendor)
        AND qi.rfq_id = ids.rfq_id AND q.rfq_id = ids.rfq_id
        AND rp.id IS NOT NULL
        AND q.created_by = ids.vendor_id
        AND qi.product_variant_id = rp.product_variant_id
        AND qi.variant IS NOT DISTINCT FROM rp.variant) IS NOT TRUE
 ORDER BY 1;

-- 2. Pending selected_quotes awards with an entry that does not bind. Expect 0 rows.
SELECT ai.id, sq->>'quote_id' AS quote_id
  FROM tbl_approval_instances ai
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ai.metadata->'selected_quotes') = 'array'
                                                THEN ai.metadata->'selected_quotes' ELSE '[]'::jsonb END) sq
 WHERE ai.entity_type = 'NEGOTIATION_QUOTE' AND ai.status = 'PENDING' AND NOT (ai.metadata ? 'po_payload')
   AND (CASE WHEN sq ? 'negotiation_round_id' THEN EXISTS (
              SELECT 1 FROM tbl_negotiation_round_quotes nrq
                JOIN tbl_negotiation_rounds nr ON nr.id = nrq.negotiation_round_id
               WHERE nrq.id::text = sq->>'quote_id' AND nr.source_type = 'RFQ'
                 AND nr.rfq_id::text = ai.metadata->>'rfq_id'
                 AND COALESCE(nrq.rfq_product_id, nr.rfq_product_id) = ai.entity_id
                 AND nrq.vendor_id::text = sq->>'vendor_id')
            ELSE EXISTS (
              SELECT 1 FROM tbl_quotes q
                JOIN tbl_rfq_products rp ON rp.id = ai.entity_id AND rp.rfq_id = q.rfq_id
                JOIN tbl_quote_items qi ON qi.quote_id = q.id AND qi.product_variant_id = rp.product_variant_id
                                       AND qi.variant IS NOT DISTINCT FROM rp.variant
               WHERE q.id::text = sq->>'quote_id' AND q.rfq_id::text = ai.metadata->>'rfq_id'
                 AND q.created_by::text = sq->>'vendor_id')
       END) IS NOT TRUE
 ORDER BY 1;

-- 3. Quote lines whose rfq_id disagrees with their quote's (the binding
--    requires both to be the award's RFQ, so such a line can never be
--    awarded). Expect 0.
SELECT count(*) FROM tbl_quote_items qi JOIN tbl_quotes q ON q.id=qi.quote_id WHERE qi.rfq_id<>q.rfq_id;

-- ── Fix round 2 ──────────────────────────────────────────────────────────────
-- Both binders now also require the INSTANCE's company to own the RFQ its
-- metadata awards, and the instance's product (entity_id) to be on that RFQ.
-- Until this deploy, POST /general/hospitality/approval/submit let any
-- non-vendor open an instance of any engine type with any entity_id and
-- metadata; it now refuses every engine type (403 APPROVAL_TYPE_SERVER_OWNED).
-- Checks 4-5 are the deploy check (PENDING rows that will be refused); 6-8 are
-- FORENSIC: did anyone use the hole before it closed?

-- 4. Pending NEGOTIATION_QUOTE instances the binders will now refuse: the
--    metadata RFQ is not the instance company's, or the instance's product is
--    not on that RFQ. Expect 0 rows.
SELECT ai.id, ai.hospitality_company_id AS instance_company, ai.entity_id AS rfq_product_id,
       ai.metadata->>'rfq_id' AS meta_rfq, r.hospitality_company_id AS rfq_company, rp.rfq_id AS product_rfq
  FROM tbl_approval_instances ai
  LEFT JOIN tbl_rfq r ON r.id::text = ai.metadata->>'rfq_id'
  LEFT JOIN tbl_rfq_products rp ON rp.id = ai.entity_id
 WHERE ai.entity_type = 'NEGOTIATION_QUOTE' AND ai.status = 'PENDING'
   AND (ai.metadata ? 'po_payload' OR jsonb_typeof(ai.metadata->'selected_quotes') = 'array')
   AND (r.hospitality_company_id = ai.hospitality_company_id AND rp.rfq_id = r.id) IS NOT TRUE
 ORDER BY 1;

-- 5. Pending NEGOTIATION instances carrying selected_quotes. Their legacy
--    post-approval award now runs only if the entries bind (bindSelectedQuotes,
--    tenant included); one that does not is logged and awards nothing. Any row
--    here: run check 2's binding by hand for it, or re-submit. Expect 0 rows.
SELECT ai.id, ai.hospitality_company_id, ai.entity_id, ai.metadata->>'rfq_id' AS meta_rfq, ai.created_at
  FROM tbl_approval_instances ai
 WHERE ai.entity_type = 'NEGOTIATION' AND ai.status = 'PENDING'
   AND jsonb_typeof(ai.metadata->'selected_quotes') = 'array'
   AND jsonb_array_length(ai.metadata->'selected_quotes') > 0
 ORDER BY 1;

-- 6. FORENSIC, any status: NEGOTIATION_QUOTE instances whose company does not
--    own the metadata RFQ, or whose product is not on it. A row is either a
--    forged instance or a data defect; for an APPROVED one, look for POs and
--    finalizations on meta_rfq created at/after completed_at. Expect 0 rows.
SELECT ai.id, ai.status, ai.initiated_by, ai.created_at, ai.completed_at,
       ai.hospitality_company_id AS instance_company, ai.entity_id AS rfq_product_id,
       ai.metadata->>'rfq_id' AS meta_rfq, r.hospitality_company_id AS rfq_company, rp.rfq_id AS product_rfq
  FROM tbl_approval_instances ai
  LEFT JOIN tbl_rfq r ON r.id::text = ai.metadata->>'rfq_id'
  LEFT JOIN tbl_rfq_products rp ON rp.id = ai.entity_id
 WHERE ai.entity_type = 'NEGOTIATION_QUOTE'
   AND ai.metadata ? 'rfq_id'
   AND (r.hospitality_company_id = ai.hospitality_company_id AND rp.rfq_id = r.id) IS NOT TRUE
 ORDER BY ai.created_at DESC;

-- 7. FORENSIC: RFQ / TENDER instances (entity_id = the RFQ) whose company does
--    not own the RFQ. handleRFQPostApproval publishes the RFQ named by
--    entity_id, so an approved row here published another company's RFQ.
--    Expect 0 rows.
SELECT ai.id, ai.entity_type, ai.status, ai.initiated_by, ai.created_at, ai.completed_at,
       ai.hospitality_company_id AS instance_company, ai.entity_id AS rfq_id, r.hospitality_company_id AS rfq_company
  FROM tbl_approval_instances ai
  LEFT JOIN tbl_rfq r ON r.id = ai.entity_id
 WHERE ai.entity_type IN ('RFQ', 'TENDER')
   AND (r.hospitality_company_id = ai.hospitality_company_id) IS NOT TRUE
 ORDER BY ai.created_at DESC;

-- 8. FORENSIC: every use of the generic submit route the activity trail saw
--    (no UI calls it; the frontend and admin-panel have no caller). entity_id
--    is the instance it opened. Any row: read that instance's entity_type,
--    entity_id and metadata, and run 6/7 for it. Expect 0 rows outside tests.
SELECT ae.id, ae.occurred_at, ae.actor_user_id, ae.actor_label, ae.hospitality_company_id,
       ae.entity_id AS approval_instance_id, ae.summary,
       ai.entity_type, ai.entity_id AS instance_entity_id, ai.status AS instance_status
  FROM tbl_activity_events ae
  LEFT JOIN tbl_approval_instances ai ON ai.id::text = ae.entity_id::text
 WHERE ae.event_key = 'approval_submitted'
 ORDER BY ae.occurred_at DESC;
