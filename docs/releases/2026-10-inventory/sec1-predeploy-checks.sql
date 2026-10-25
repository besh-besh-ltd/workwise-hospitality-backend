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
-- 7 and 8 are FORENSIC: did anyone use the hole before it closed?
-- (Fix round 3 added 4b and 8's activity match. Fix round 4 replaced the
-- per-type 6/6b/7 with ONE generic target test over every engine type, the
-- same resolution the app now runs before any approval handler.)

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

-- 6. GATE: every PENDING instance, of ANY type, whose TARGET is not its own
--    company's, or does not resolve to one company. The target is what its
--    handlers act on: the RFQ it publishes, the round it activates or cancels,
--    the ARC it floats, the MR it releases, the PO it approves (per type in
--    app/services/approvalTargetOwner.js). The app now refuses such an
--    instance at every handler dispatch and before any vote, and its cancel
--    leaves the other company's PO and hold alone; the CTEs from `ids AS (` to the end
--    of `resolved` are that module's TARGET_COMPANY_CTES, verbatim (a test,
--    security.forgedTargetDispatch, holds the two equal).
--    Expect 0 rows. Any row is a forged instance (opened through the generic
--    submit route before c3a51cd6 closed it) or a data defect: review it, then
--    CANCEL the reviewed ids with the fenced operator block below BEFORE the
--    deploy, so it leaves every approver's queue. target_company NULL means
--    the target is missing or names more than one company.
WITH src AS (
  SELECT ai.id, ai.entity_type, ai.entity_id, ai.metadata
    FROM tbl_approval_instances ai
   WHERE ai.status = 'PENDING'
),
ids AS (
  SELECT s.id, s.entity_type, s.entity_id::bigint AS entity_id,
         CASE WHEN s.metadata->>'rfq_id'             ~ '^[0-9]{1,10}$' THEN (s.metadata->>'rfq_id')::bigint END             AS m_rfq,
         CASE WHEN s.metadata->>'rfq_product_id'     ~ '^[0-9]{1,10}$' THEN (s.metadata->>'rfq_product_id')::bigint END     AS m_product,
         CASE WHEN s.metadata->>'round_id'           ~ '^[0-9]{1,10}$' THEN (s.metadata->>'round_id')::bigint END           AS m_round,
         CASE WHEN s.metadata->>'arc_id'             ~ '^[0-9]{1,10}$' THEN (s.metadata->>'arc_id')::bigint END             AS m_arc,
         CASE WHEN s.metadata->>'tech_evaluation_id' ~ '^[0-9]{1,10}$' THEN (s.metadata->>'tech_evaluation_id')::bigint END AS m_te,
         COALESCE(s.metadata->>'rfq_id', '')             <> '' AS has_rfq,
         COALESCE(s.metadata->>'rfq_product_id', '')     <> '' AS has_product,
         COALESCE(s.metadata->>'round_id', '')           <> '' AS has_round,
         COALESCE(s.metadata->>'tech_evaluation_id', '') <> '' AS has_te
    FROM src s
),
named AS (
  SELECT i.id,
         CASE
           WHEN i.entity_type IN ('RFQ', 'TENDER') THEN ARRAY[
             (SELECT r.hospitality_company_id::bigint FROM tbl_rfq r WHERE r.id = i.entity_id)]
           WHEN i.entity_type = 'TECHNICAL' THEN ARRAY[
             (SELECT r.hospitality_company_id::bigint
                FROM tbl_tech_evaluation_rounds tr
                JOIN tbl_rfq_product_tech_evaluation te ON te.id = tr.tbl_rfq_product_tech_evaluation_id
                JOIN tbl_rfq r ON r.id = te.rfq_id
               WHERE tr.id = i.entity_id)]
             || CASE WHEN i.has_te THEN ARRAY[
                  (SELECT r.hospitality_company_id::bigint
                     FROM tbl_rfq_product_tech_evaluation te JOIN tbl_rfq r ON r.id = te.rfq_id
                    WHERE te.id = i.m_te)] ELSE '{}'::bigint[] END
             || CASE WHEN i.has_rfq THEN ARRAY[
                  (SELECT r.hospitality_company_id::bigint FROM tbl_rfq r WHERE r.id = i.m_rfq)] ELSE '{}'::bigint[] END
           WHEN i.entity_type = 'NEGOTIATION' THEN ARRAY[
             (SELECT r.hospitality_company_id::bigint
                FROM tbl_negotiation_rounds nr JOIN tbl_rfq r ON r.id = nr.rfq_id
               WHERE nr.id = CASE WHEN i.has_round THEN i.m_round ELSE i.entity_id END
                 AND COALESCE(nr.source_type, 'RFQ') = 'RFQ')]
             || CASE WHEN i.has_rfq THEN ARRAY[
                  (SELECT r.hospitality_company_id::bigint FROM tbl_rfq r WHERE r.id = i.m_rfq)] ELSE '{}'::bigint[] END
             || CASE WHEN i.has_product THEN ARRAY[
                  (SELECT r.hospitality_company_id::bigint
                     FROM tbl_rfq_products rp JOIN tbl_rfq r ON r.id = rp.rfq_id
                    WHERE rp.id = i.m_product)] ELSE '{}'::bigint[] END
           WHEN i.entity_type = 'NEGOTIATION_QUOTE' THEN ARRAY[
             (SELECT r.hospitality_company_id::bigint
                FROM tbl_rfq_products rp JOIN tbl_rfq r ON r.id = rp.rfq_id
               WHERE rp.id = CASE WHEN i.has_product THEN i.m_product ELSE i.entity_id END)]
             || CASE WHEN i.has_rfq THEN ARRAY[
                  (SELECT r.hospitality_company_id::bigint FROM tbl_rfq r WHERE r.id = i.m_rfq)] ELSE '{}'::bigint[] END
           WHEN i.entity_type = 'MR' THEN ARRAY[
             (SELECT mr.hospitality_company_id::bigint FROM tbl_material_requisition mr WHERE mr.id = i.entity_id)]
           WHEN i.entity_type = 'PO' THEN ARRAY[
             (SELECT COALESCE(r.hospitality_company_id, a.hospitality_company_id, mr.hospitality_company_id)::bigint
                FROM tbl_rfq_purchase_order po
                LEFT JOIN tbl_rfq r ON r.id = po.rfq_id
                LEFT JOIN tbl_arc_contract c ON c.id = po.arc_contract_id
                LEFT JOIN tbl_arc a ON a.id = c.arc_id
                LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
               WHERE po.id = i.entity_id)]
           WHEN i.entity_type IN ('ARC_TECH', 'ARC_COMMITTEE', 'ARC_PUBLISH') THEN ARRAY[
             (SELECT a.hospitality_company_id::bigint FROM tbl_arc a WHERE a.id = i.entity_id)]
           WHEN i.entity_type = 'ARC_AMENDMENT' THEN ARRAY[
             (SELECT a.hospitality_company_id::bigint
                FROM tbl_arc_amendment am
                JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
                JOIN tbl_arc a ON a.id = c.arc_id
               WHERE am.id = i.entity_id)]
             || COALESCE((SELECT array_agg(a.hospitality_company_id::bigint)
                            FROM tbl_arc_amendment am
                            JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
                            JOIN tbl_arc a ON a.id = c.arc_id
                           WHERE am.approval_instance_id = i.id), '{}'::bigint[])
           WHEN i.entity_type = 'ARC_NEGOTIATION' THEN ARRAY[
             (SELECT a.hospitality_company_id::bigint
                FROM tbl_negotiation_rounds nr JOIN tbl_arc a ON a.id = nr.source_id
               WHERE nr.id = i.entity_id
                 AND i.m_round = i.entity_id
                 AND nr.source_type = 'ARC'
                 AND nr.source_id = i.m_arc)]
           WHEN i.entity_type = 'ARC' THEN
             CASE WHEN i.has_rfq THEN ARRAY[
                    (SELECT r.hospitality_company_id::bigint FROM tbl_rfq r
                      WHERE r.id = i.m_rfq
                        AND (i.entity_id = i.m_rfq
                             OR EXISTS (SELECT 1 FROM tbl_rfq_products rp
                                         WHERE rp.id = i.entity_id AND rp.rfq_id = i.m_rfq)))]
                  ELSE ARRAY[(SELECT r.hospitality_company_id::bigint FROM tbl_rfq r WHERE r.id = i.entity_id)]
             END
         END AS companies
    FROM ids i
),
resolved AS (
  SELECT n.id,
         CASE
           WHEN n.companies IS NULL OR cardinality(n.companies) = 0
                OR array_position(n.companies, NULL) IS NOT NULL THEN NULL
           WHEN (SELECT count(DISTINCT c) FROM unnest(n.companies) AS c) = 1 THEN n.companies[1]
         END AS target_company
    FROM named n
)
SELECT ai.id, ai.entity_type, ai.entity_id, ai.hospitality_company_id AS instance_company,
       rs.target_company, ai.initiated_by, ai.created_at
  FROM resolved rs
  JOIN tbl_approval_instances ai ON ai.id = rs.id
 WHERE rs.target_company IS DISTINCT FROM ai.hospitality_company_id
 ORDER BY ai.id;

-- 7. FORENSIC: the same test over every CONCLUDED instance (APPROVED or
--    REJECTED), whose handler ran without this check before the deploy. A row
--    is a decision whose handler may have acted on another company's target:
--    read its entity_id and metadata, and look on that target for status
--    changes, lifecycle rows, finalizations, POs and ARC events at/after
--    completed_at. Expect 0 rows.
WITH src AS (
  SELECT ai.id, ai.entity_type, ai.entity_id, ai.metadata
    FROM tbl_approval_instances ai
   WHERE ai.status IN ('APPROVED', 'REJECTED')
),
ids AS (
  SELECT s.id, s.entity_type, s.entity_id::bigint AS entity_id,
         CASE WHEN s.metadata->>'rfq_id'             ~ '^[0-9]{1,10}$' THEN (s.metadata->>'rfq_id')::bigint END             AS m_rfq,
         CASE WHEN s.metadata->>'rfq_product_id'     ~ '^[0-9]{1,10}$' THEN (s.metadata->>'rfq_product_id')::bigint END     AS m_product,
         CASE WHEN s.metadata->>'round_id'           ~ '^[0-9]{1,10}$' THEN (s.metadata->>'round_id')::bigint END           AS m_round,
         CASE WHEN s.metadata->>'arc_id'             ~ '^[0-9]{1,10}$' THEN (s.metadata->>'arc_id')::bigint END             AS m_arc,
         CASE WHEN s.metadata->>'tech_evaluation_id' ~ '^[0-9]{1,10}$' THEN (s.metadata->>'tech_evaluation_id')::bigint END AS m_te,
         COALESCE(s.metadata->>'rfq_id', '')             <> '' AS has_rfq,
         COALESCE(s.metadata->>'rfq_product_id', '')     <> '' AS has_product,
         COALESCE(s.metadata->>'round_id', '')           <> '' AS has_round,
         COALESCE(s.metadata->>'tech_evaluation_id', '') <> '' AS has_te
    FROM src s
),
named AS (
  SELECT i.id,
         CASE
           WHEN i.entity_type IN ('RFQ', 'TENDER') THEN ARRAY[
             (SELECT r.hospitality_company_id::bigint FROM tbl_rfq r WHERE r.id = i.entity_id)]
           WHEN i.entity_type = 'TECHNICAL' THEN ARRAY[
             (SELECT r.hospitality_company_id::bigint
                FROM tbl_tech_evaluation_rounds tr
                JOIN tbl_rfq_product_tech_evaluation te ON te.id = tr.tbl_rfq_product_tech_evaluation_id
                JOIN tbl_rfq r ON r.id = te.rfq_id
               WHERE tr.id = i.entity_id)]
             || CASE WHEN i.has_te THEN ARRAY[
                  (SELECT r.hospitality_company_id::bigint
                     FROM tbl_rfq_product_tech_evaluation te JOIN tbl_rfq r ON r.id = te.rfq_id
                    WHERE te.id = i.m_te)] ELSE '{}'::bigint[] END
             || CASE WHEN i.has_rfq THEN ARRAY[
                  (SELECT r.hospitality_company_id::bigint FROM tbl_rfq r WHERE r.id = i.m_rfq)] ELSE '{}'::bigint[] END
           WHEN i.entity_type = 'NEGOTIATION' THEN ARRAY[
             (SELECT r.hospitality_company_id::bigint
                FROM tbl_negotiation_rounds nr JOIN tbl_rfq r ON r.id = nr.rfq_id
               WHERE nr.id = CASE WHEN i.has_round THEN i.m_round ELSE i.entity_id END
                 AND COALESCE(nr.source_type, 'RFQ') = 'RFQ')]
             || CASE WHEN i.has_rfq THEN ARRAY[
                  (SELECT r.hospitality_company_id::bigint FROM tbl_rfq r WHERE r.id = i.m_rfq)] ELSE '{}'::bigint[] END
             || CASE WHEN i.has_product THEN ARRAY[
                  (SELECT r.hospitality_company_id::bigint
                     FROM tbl_rfq_products rp JOIN tbl_rfq r ON r.id = rp.rfq_id
                    WHERE rp.id = i.m_product)] ELSE '{}'::bigint[] END
           WHEN i.entity_type = 'NEGOTIATION_QUOTE' THEN ARRAY[
             (SELECT r.hospitality_company_id::bigint
                FROM tbl_rfq_products rp JOIN tbl_rfq r ON r.id = rp.rfq_id
               WHERE rp.id = CASE WHEN i.has_product THEN i.m_product ELSE i.entity_id END)]
             || CASE WHEN i.has_rfq THEN ARRAY[
                  (SELECT r.hospitality_company_id::bigint FROM tbl_rfq r WHERE r.id = i.m_rfq)] ELSE '{}'::bigint[] END
           WHEN i.entity_type = 'MR' THEN ARRAY[
             (SELECT mr.hospitality_company_id::bigint FROM tbl_material_requisition mr WHERE mr.id = i.entity_id)]
           WHEN i.entity_type = 'PO' THEN ARRAY[
             (SELECT COALESCE(r.hospitality_company_id, a.hospitality_company_id, mr.hospitality_company_id)::bigint
                FROM tbl_rfq_purchase_order po
                LEFT JOIN tbl_rfq r ON r.id = po.rfq_id
                LEFT JOIN tbl_arc_contract c ON c.id = po.arc_contract_id
                LEFT JOIN tbl_arc a ON a.id = c.arc_id
                LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
               WHERE po.id = i.entity_id)]
           WHEN i.entity_type IN ('ARC_TECH', 'ARC_COMMITTEE', 'ARC_PUBLISH') THEN ARRAY[
             (SELECT a.hospitality_company_id::bigint FROM tbl_arc a WHERE a.id = i.entity_id)]
           WHEN i.entity_type = 'ARC_AMENDMENT' THEN ARRAY[
             (SELECT a.hospitality_company_id::bigint
                FROM tbl_arc_amendment am
                JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
                JOIN tbl_arc a ON a.id = c.arc_id
               WHERE am.id = i.entity_id)]
             || COALESCE((SELECT array_agg(a.hospitality_company_id::bigint)
                            FROM tbl_arc_amendment am
                            JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
                            JOIN tbl_arc a ON a.id = c.arc_id
                           WHERE am.approval_instance_id = i.id), '{}'::bigint[])
           WHEN i.entity_type = 'ARC_NEGOTIATION' THEN ARRAY[
             (SELECT a.hospitality_company_id::bigint
                FROM tbl_negotiation_rounds nr JOIN tbl_arc a ON a.id = nr.source_id
               WHERE nr.id = i.entity_id
                 AND i.m_round = i.entity_id
                 AND nr.source_type = 'ARC'
                 AND nr.source_id = i.m_arc)]
           WHEN i.entity_type = 'ARC' THEN
             CASE WHEN i.has_rfq THEN ARRAY[
                    (SELECT r.hospitality_company_id::bigint FROM tbl_rfq r
                      WHERE r.id = i.m_rfq
                        AND (i.entity_id = i.m_rfq
                             OR EXISTS (SELECT 1 FROM tbl_rfq_products rp
                                         WHERE rp.id = i.entity_id AND rp.rfq_id = i.m_rfq)))]
                  ELSE ARRAY[(SELECT r.hospitality_company_id::bigint FROM tbl_rfq r WHERE r.id = i.entity_id)]
             END
         END AS companies
    FROM ids i
),
resolved AS (
  SELECT n.id,
         CASE
           WHEN n.companies IS NULL OR cardinality(n.companies) = 0
                OR array_position(n.companies, NULL) IS NOT NULL THEN NULL
           WHEN (SELECT count(DISTINCT c) FROM unnest(n.companies) AS c) = 1 THEN n.companies[1]
         END AS target_company
    FROM named n
)
SELECT ai.id, ai.entity_type, ai.entity_id, ai.status, ai.hospitality_company_id AS instance_company,
       rs.target_company, ai.initiated_by, ai.created_at, ai.completed_at
  FROM resolved rs
  JOIN tbl_approval_instances ai ON ai.id = rs.id
 WHERE rs.target_company IS DISTINCT FROM ai.hospitality_company_id
 ORDER BY ai.completed_at DESC NULLS LAST, ai.id;

-- 8. FORENSIC: every use of the generic submit route the activity trail saw.
--    No screen calls it (frontend and admin-panel have no caller). The trail
--    stores no entity id for this event, so each row is matched to the
--    instance its actor opened within 10 seconds of it (instances.created_at
--    is a naive timestamp in the session time zone, the trail's occurred_at
--    a timestamptz). COVERAGE: only since activity capture was deployed
--    (migration 20260829091000_activity_events); earlier uses left no row, so
--    7 is the check for those. Any row: read the instance's
--    entity_type, entity_id and metadata, and run 7 for it. Expect 0 rows
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
-- each is not a legitimate approval. Paste the reviewed ids by hand into
-- `reviewed` (never feed check 6 into it as a subquery), and the user id of
-- the operator cancelling them into `actor` (the cancel action's
-- approver_user_id, as the app records the canceller).
--
-- It does what the app's cancel does (generalModel.cancelApprovalInstance)
-- for an instance whose target is another company's: the instance goes
-- CANCELLED, its PENDING steps go CANCELLED, and one CANCELLED action row
-- records why. PO rows included: the app's cancel closes a PO's hold only when
-- the PO is the instance's own company's, so for these rows it touches no PO
-- and no hold (a hold on that PO belongs to its own company's approval), and
-- neither does this block. PENDING instances only.
-- Row-count check: unless EVERY reviewed id is a PENDING instance it raises,
-- and the transaction writes nothing. Cancelling runs no post-approval
-- handler, so it writes nothing to either company's entities.
--
-- BEGIN;
-- DO $$
-- DECLARE
--   reviewed bigint[] := ARRAY[/* reviewed ids from check 6 */]::bigint[];
--   actor    int      := /* operator user id */;
--   n        int;
-- BEGIN
--   UPDATE tbl_approval_instances
--      SET status = 'CANCELLED', completed_at = NOW()
--    WHERE id = ANY(reviewed) AND status = 'PENDING';
--   GET DIAGNOSTICS n = ROW_COUNT;
--   IF n <> cardinality(reviewed) THEN
--     RAISE EXCEPTION 'SEC1 cancel: % of % reviewed ids are PENDING instances; nothing written',
--       n, cardinality(reviewed);
--   END IF;
--   UPDATE tbl_approval_instance_steps
--      SET status = 'CANCELLED', completed_at = NOW()
--    WHERE approval_instance_id = ANY(reviewed) AND status = 'PENDING';
--   INSERT INTO tbl_approval_actions (approval_instance_id, approver_user_id, action, comment)
--   SELECT r, actor, 'CANCELLED', '[CANCELLED] SEC1: target belongs to another company'
--     FROM unnest(reviewed) AS r;
-- END $$;
-- COMMIT;
-- ============================================================================
