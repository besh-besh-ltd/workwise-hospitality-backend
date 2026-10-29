-- ═══════════════════════════════════════════════════════════════════════════
-- Which policy the engine would pick, for every unit of the buyer.
--
--   \set matcher_snapshot _match_before
--   \ir lib/matcher_snapshot.sql
--
-- Reproduces findBestMatchingPolicy / findBestMatchingPolicyTx
-- (app/models/generalModel.js, MASTER_POLICY_MATCH + POLICY_SPECIFICITY_SCORE):
-- active, department_id IS NULL, hotel match or hotel-wide, process match or
-- process-free; most specific first (process+hotel 4 > process 3 > hotel 2 >
-- neither 1), newest first. uq_approval_policy_scope_process allows one active
-- policy per scope, so there are no ties to break.
--
-- Dimensions: every unit of the buyer (plus a hotel-less request per company)
-- × _params.matcher_entity_types × {the kept process, no process}.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE :matcher_snapshot AS
WITH prm AS (SELECT * FROM _params),
req AS (
  SELECT hc.id AS co, h.id AS hotel_id
    FROM tbl_hospitality_companies hc
    JOIN tbl_hospitality_company_hotels h ON h.hospitality_company_id = hc.id
   WHERE hc.buyer_company_id = (SELECT buyer_company_id FROM prm)
  UNION ALL
  SELECT hc.id, NULL
    FROM tbl_hospitality_companies hc
   WHERE hc.buyer_company_id = (SELECT buyer_company_id FROM prm)
),
dims AS (SELECT unnest(matcher_entity_types) AS entity_type FROM prm),
procs AS (
  SELECT pr.id AS process_id
    FROM tbl_approval_processes pr, prm
   WHERE pr.company_id = prm.buyer_company_id AND pr.name = prm.kept_process_name
  UNION ALL
  SELECT NULL
)
SELECT r.co, r.hotel_id, d.entity_type, pc.process_id,
       (SELECT p.id
          FROM tbl_approval_policies p
         WHERE p.entity_type = d.entity_type
           AND p.hospitality_company_id = r.co
           AND p.is_active = true
           AND p.department_id IS NULL
           AND (p.process_id = pc.process_id OR p.process_id IS NULL)
           AND (p.hotel_id = r.hotel_id OR p.hotel_id IS NULL)
         ORDER BY CASE
                    WHEN p.process_id IS NOT NULL AND p.hotel_id IS NOT NULL THEN 4
                    WHEN p.process_id IS NOT NULL AND p.hotel_id IS NULL THEN 3
                    WHEN p.process_id IS NULL AND p.hotel_id IS NOT NULL THEN 2
                    WHEN p.process_id IS NULL AND p.hotel_id IS NULL THEN 1
                    ELSE 0
                  END DESC,
                  p.created_at DESC
         LIMIT 1) AS policy_id
  FROM req r CROSS JOIN dims d CROSS JOIN procs pc;
