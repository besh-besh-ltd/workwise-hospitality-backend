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
  -- Same absent-vs-empty semantics as the code: the vendor is
  -- `finalized_vendor_id ?? vendor_id` (only JSON null/absent falls back; an
  -- empty string is kept, and refused), the quote line `quote_item_id ||
  -- quote_id` (an empty string falls back). Ids are cast through bigint behind
  -- a digits-only guard, so an oversized number is refused, not an error.
  SELECT p.*,
    p.pl#>>'{product_info,finalized_vendor_id}' AS fin_vendor,
    p.pl->>'vendor_id'                          AS top_vendor,
    CASE WHEN p.pl->>'rfq_id' ~ '^\d{1,18}$' THEN (p.pl->>'rfq_id')::bigint END AS rfq_id,
    CASE WHEN p.pl#>>'{product_info,rfq_product_id}' ~ '^\d{1,18}$' THEN (p.pl#>>'{product_info,rfq_product_id}')::bigint END AS rp_id,
    CASE WHEN COALESCE(p.pl#>>'{product_info,finalized_vendor_id}', p.pl->>'vendor_id') ~ '^\d{1,18}$'
         THEN COALESCE(p.pl#>>'{product_info,finalized_vendor_id}', p.pl->>'vendor_id')::bigint END AS vendor_id,
    CASE WHEN COALESCE(NULLIF(p.pl->>'quote_item_id',''), p.pl->>'quote_id') ~ '^\d{1,18}$'
         THEN COALESCE(NULLIF(p.pl->>'quote_item_id',''), p.pl->>'quote_id')::bigint END AS qi_id
  FROM p
)
SELECT ids.id
  FROM ids
  LEFT JOIN tbl_quote_items qi ON qi.id = ids.qi_id
  LEFT JOIN tbl_quotes q ON q.id = qi.quote_id
  LEFT JOIN tbl_rfq_products rp ON rp.id = ids.rp_id AND rp.rfq_id = ids.rfq_id
 WHERE (    ids.rp_id = ids.entity_id
        AND (ids.meta_rfq IS NULL OR ids.meta_rfq = ids.rfq_id::text)
        AND (ids.fin_vendor IS NULL OR ids.top_vendor IS NULL
             OR (ids.fin_vendor ~ '^\d{1,18}$' AND ids.top_vendor ~ '^\d{1,18}$'
                 AND ids.fin_vendor::bigint = ids.top_vendor::bigint))
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
-- Checks 4, 4b and 5 are deploy checks (PENDING rows that will now be
-- refused); 6 is a GATE (PENDING forged rows to cancel before the deploy);
-- 6b, 7 and 8 are FORENSIC: did anyone use the hole before it closed?
-- (Fix round 3 added 4b, turned 6 into the gate, and extended 6/7 to
-- NEGOTIATION and 8's activity match.)

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

-- 4b. Pending parked finalize payloads whose po_user is not the instance's
--     initiator: bindParkedAward now refuses them (400 AWARD_QUOTE_MISMATCH)
--     on both approval surfaces. finalize parks po_user = the finalizing user,
--     who is the initiator. Expect 0 rows.
SELECT ai.id, ai.initiated_by, ai.metadata#>>'{po_user,id}' AS po_user_id
  FROM tbl_approval_instances ai
 WHERE ai.entity_type = 'NEGOTIATION_QUOTE' AND ai.status = 'PENDING'
   AND ai.metadata ? 'po_payload' AND ai.metadata ? 'po_user'
   AND jsonb_typeof(ai.metadata->'po_user') <> 'null'
   AND ((ai.metadata#>>'{po_user,id}') ~ '^\d{1,18}$'
        AND (ai.metadata#>>'{po_user,id}')::bigint = ai.initiated_by) IS NOT TRUE
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

-- 6. GATE: PENDING instances whose handlers would act on ANOTHER company.
--    Expect 0 rows. Any row is a forged instance (opened through the generic
--    submit route before it was closed) or a data defect: review it, then
--    CANCEL it with the fenced operator block below BEFORE the deploy. The
--    fixed handlers refuse them (and log a warning), but a pending forged
--    instance must not stay in anyone's approval queue.
--      NEGOTIATION_QUOTE: its award and its rejection act on metadata.rfq_id
--        and its product (metadata.rfq_product_id, else entity_id).
--      NEGOTIATION: its approval activates and its rejection cancels the round
--        metadata.round_id (else entity_id); it must be an RFQ round of the
--        instance's company.
WITH neg_scope AS (
  SELECT ai.id, ai.entity_type, ai.status, ai.initiated_by, ai.created_at, ai.completed_at,
         ai.hospitality_company_id AS instance_company,
         ai.metadata->>'rfq_id' AS meta_rfq,
         CASE WHEN ai.entity_type = 'NEGOTIATION_QUOTE'
              THEN COALESCE(CASE WHEN ai.metadata->>'rfq_product_id' ~ '^\d{1,18}$'
                                 THEN (ai.metadata->>'rfq_product_id')::bigint END, ai.entity_id) END AS rfq_product_id,
         CASE WHEN ai.entity_type = 'NEGOTIATION'
              THEN COALESCE(CASE WHEN ai.metadata->>'round_id' ~ '^\d{1,18}$'
                                 THEN (ai.metadata->>'round_id')::bigint END, ai.entity_id) END AS round_id
    FROM tbl_approval_instances ai
   WHERE ai.entity_type IN ('NEGOTIATION_QUOTE', 'NEGOTIATION')
), judged AS (
  SELECT n.*,
         CASE n.entity_type
           WHEN 'NEGOTIATION_QUOTE' THEN EXISTS (
             SELECT 1 FROM tbl_rfq r JOIN tbl_rfq_products rp ON rp.rfq_id = r.id
              WHERE r.id::text = n.meta_rfq AND rp.id = n.rfq_product_id
                AND r.hospitality_company_id = n.instance_company)
           WHEN 'NEGOTIATION' THEN EXISTS (
             SELECT 1 FROM tbl_negotiation_rounds nr JOIN tbl_rfq r ON r.id = nr.rfq_id
              WHERE nr.id = n.round_id AND COALESCE(nr.source_type, 'RFQ') = 'RFQ'
                AND r.hospitality_company_id = n.instance_company)
         END AS own_tenant
    FROM neg_scope n
   WHERE n.meta_rfq IS NOT NULL OR n.entity_type = 'NEGOTIATION'
)
SELECT id, entity_type, status, initiated_by, created_at, instance_company, meta_rfq, rfq_product_id, round_id
  FROM judged
 WHERE status = 'PENDING' AND own_tenant IS NOT TRUE
 ORDER BY id;

-- 6b. FORENSIC, any status: the same test over every NEGOTIATION_QUOTE and
--     NEGOTIATION instance. For an APPROVED/REJECTED row, look on the other
--     company's RFQ (meta_rfq, or the round's RFQ) for POs, finalizations,
--     finalization resets, timeline rows and round status changes at/after
--     completed_at. Expect 0 rows.
--     (Same CTE as 6; repeated so each check runs on its own.)
WITH neg_scope AS (
  SELECT ai.id, ai.entity_type, ai.status, ai.initiated_by, ai.created_at, ai.completed_at,
         ai.hospitality_company_id AS instance_company,
         ai.metadata->>'rfq_id' AS meta_rfq,
         CASE WHEN ai.entity_type = 'NEGOTIATION_QUOTE'
              THEN COALESCE(CASE WHEN ai.metadata->>'rfq_product_id' ~ '^\d{1,18}$'
                                 THEN (ai.metadata->>'rfq_product_id')::bigint END, ai.entity_id) END AS rfq_product_id,
         CASE WHEN ai.entity_type = 'NEGOTIATION'
              THEN COALESCE(CASE WHEN ai.metadata->>'round_id' ~ '^\d{1,18}$'
                                 THEN (ai.metadata->>'round_id')::bigint END, ai.entity_id) END AS round_id
    FROM tbl_approval_instances ai
   WHERE ai.entity_type IN ('NEGOTIATION_QUOTE', 'NEGOTIATION')
), judged AS (
  SELECT n.*,
         CASE n.entity_type
           WHEN 'NEGOTIATION_QUOTE' THEN EXISTS (
             SELECT 1 FROM tbl_rfq r JOIN tbl_rfq_products rp ON rp.rfq_id = r.id
              WHERE r.id::text = n.meta_rfq AND rp.id = n.rfq_product_id
                AND r.hospitality_company_id = n.instance_company)
           WHEN 'NEGOTIATION' THEN EXISTS (
             SELECT 1 FROM tbl_negotiation_rounds nr JOIN tbl_rfq r ON r.id = nr.rfq_id
              WHERE nr.id = n.round_id AND COALESCE(nr.source_type, 'RFQ') = 'RFQ'
                AND r.hospitality_company_id = n.instance_company)
         END AS own_tenant
    FROM neg_scope n
   WHERE n.meta_rfq IS NOT NULL OR n.entity_type = 'NEGOTIATION'
)
SELECT id, entity_type, status, initiated_by, created_at, completed_at, instance_company, meta_rfq, rfq_product_id, round_id
  FROM judged
 WHERE own_tenant IS NOT TRUE
 ORDER BY created_at DESC;

-- 7. FORENSIC: instances naming an RFQ that is not their company's.
--      RFQ / TENDER: entity_id is the RFQ; handleRFQPostApproval publishes it,
--        so an approved row here published another company's RFQ.
--      NEGOTIATION: metadata.rfq_id is the RFQ its legacy selected_quotes
--        award writes finalizations on.
--    Expect 0 rows.
SELECT ai.id, ai.entity_type, ai.status, ai.initiated_by, ai.created_at, ai.completed_at,
       ai.hospitality_company_id AS instance_company,
       CASE WHEN ai.entity_type = 'NEGOTIATION' THEN ai.metadata->>'rfq_id' ELSE ai.entity_id::text END AS named_rfq,
       r.hospitality_company_id AS rfq_company
  FROM tbl_approval_instances ai
  LEFT JOIN tbl_rfq r
         ON r.id::text = CASE WHEN ai.entity_type = 'NEGOTIATION' THEN ai.metadata->>'rfq_id' ELSE ai.entity_id::text END
 WHERE (ai.entity_type IN ('RFQ', 'TENDER')
        OR (ai.entity_type = 'NEGOTIATION' AND ai.metadata ? 'rfq_id'))
   AND (r.hospitality_company_id = ai.hospitality_company_id) IS NOT TRUE
 ORDER BY ai.created_at DESC;

-- 8. FORENSIC: every use of the generic submit route the activity trail saw.
--    No screen calls it (frontend and admin-panel have no caller). The trail
--    stores no entity id for this event, so each row is matched to the
--    instance its actor opened within 10 seconds of it (instances.created_at
--    is a naive timestamp in the session time zone, the trail's occurred_at
--    a timestamptz). COVERAGE: only since activity capture was deployed
--    (migration 20260829091000_activity_events); earlier uses left no row, so
--    6b and 7 are the checks for those. Any row: read the instance's
--    entity_type, entity_id and metadata, and run 6b/7 for it. Expect 0 rows
--    outside tests.
SELECT ae.id, ae.occurred_at, ae.actor_user_id, ae.actor_label, ae.hospitality_company_id, ae.summary,
       ai.id AS approval_instance_id, ai.entity_type, ai.entity_id AS instance_entity_id,
       ai.status AS instance_status, ai.hospitality_company_id AS instance_company
  FROM tbl_activity_events ae
  LEFT JOIN tbl_approval_instances ai
         ON ai.initiated_by = ae.actor_user_id
        AND ai.created_at BETWEEN (ae.occurred_at AT TIME ZONE current_setting('TimeZone')) - interval '10 seconds'
                              AND (ae.occurred_at AT TIME ZONE current_setting('TimeZone')) + interval '10 seconds'
 WHERE ae.event_key = 'approval_submitted'
 ORDER BY ae.occurred_at DESC;

-- ============================================================================
-- OPERATOR BLOCK: NOT A CHECK. NOT READ-ONLY. COMMENTED OUT ON PURPOSE.
-- ----------------------------------------------------------------------------
-- Run ONLY after a person has reviewed every row check 6 returned and agreed
-- each is not a legitimate approval. Paste the reviewed ids by hand; never
-- feed check 6 into it as a subquery. Cancelling an instance runs no
-- post-approval handler, so it writes nothing to either company.
--
-- BEGIN;
-- UPDATE tbl_approval_instances
--    SET status = 'CANCELLED', completed_at = NOW()
--  WHERE status = 'PENDING'
--    AND entity_type IN ('NEGOTIATION_QUOTE', 'NEGOTIATION')
--    AND id IN (/* reviewed ids from check 6 */);
-- -- The row count must equal the number of reviewed ids; otherwise ROLLBACK.
-- COMMIT;
-- ============================================================================
