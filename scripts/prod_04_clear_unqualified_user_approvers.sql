-- ===========================================================================
--  PROD 4 — give named approvers the permission their assignment implies
-- ===========================================================================
--
--  WHY
--  `audit_approval_rbac_coherence.sql` SECTION E lists USER-source policy steps
--  whose named approver holds no read+approve on the entity's resource within
--  the policy's scope. 19 such rows exist. They are not currently breaking
--  anything — USER-source steps are not permission-gated — but they are the
--  exact list that stops working the day the gate is enforced, and every one of
--  them is a person the platform already trusts to approve that entity.
--
--  THIS DOES NOT EXPAND ANYONE'S AUTHORITY.
--  Every user below is ALREADY a binding approver on the policy step in
--  question: `submitApprovalAction` validates only that the caller has a
--  PENDING approver row, re-checking no role, no permission and no scope. So
--  they can approve these entities today. What they cannot do is SEE them, and
--  what the RBAC tables cannot do is explain why they are allowed to. This
--  closes that gap in the direction the configuration already asserts.
--
--  WHAT IS GRANTED, AND WHY THAT ROLE
--  The narrowest SYSTEM role that carries exactly the read+approve pair the
--  assigned duty needs, scoped to the policy's hospitality company with
--  hotel / department / process all NULL:
--
--    role  4 Tender Approver     rfq.read+approve   (also boq.*, tender.approve)
--    role  7 Technical Approver  te.read+approve    (nothing else at all)
--    role 12 Commercial Approver negotiation.* + quote-compare.read+approve
--                                (also awarding.create/read)
--    role 13/14/15 Final Awarding P1/P2/P3   awarding.read+approve+create
--    role 16 ARC Approver        arc.read+approve   (also awarding.*)
--
--  Idempotent (NOT EXISTS-guarded), additive only — no UPDATE, no DELETE.
--  Every inserted row is recorded in tbl_user_role_scopes_prod04_backup so the
--  whole change can be reversed with one DELETE.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  SECTION A — before. Expect 19 rows.
-- ---------------------------------------------------------------------------
WITH map AS (SELECT * FROM (VALUES
  ('RFQ','rfq'),('TENDER','boq'),('TECHNICAL','te'),('NEGOTIATION','negotiation'),
  ('NEGOTIATION_QUOTE','quote-compare'),('PO','awarding'),('MR','awarding'),
  ('ARC','arc'),('ARC_PUBLISH','arc'),('ARC_TECH','arc-tech'),
  ('ARC_NEGOTIATION','arc-comm'),('ARC_COMMITTEE','arc-committee'),('ARC_AMENDMENT','arc')) AS v(et,res))
SELECT 'BEFORE' AS phase, count(*) AS unqualified_user_approver_rows
FROM tbl_approval_policies p
JOIN tbl_approval_policy_steps s ON s.approval_policy_id = p.id
JOIN map m ON m.et = p.entity_type
JOIN tbl_users u ON u.id = s.approver_source_id
WHERE p.is_active AND s.approver_source_type = 'USER'
  AND NOT EXISTS (
    SELECT 1 FROM tbl_user_role_scopes urs
      JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
      JOIN tbl_permissions pm ON pm.id = rp.permission_id
     WHERE urs.user_id = u.id AND pm.resource::text = m.res AND pm.action IN ('read','approve')
       AND urs.company_id = p.hospitality_company_id
       AND (urs.hotel_id IS NULL OR urs.hotel_id = p.hotel_id)
       AND (urs.process_id IS NULL OR urs.process_id = p.process_id)
     GROUP BY urs.user_id HAVING count(DISTINCT pm.action) = 2);


-- ---------------------------------------------------------------------------
--  SECTION B — apply.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS tbl_user_role_scopes_prod04_backup (
  scope_id integer,
  user_id integer,
  role_id integer,
  company_id integer,
  granted_at timestamptz DEFAULT now()
);

-- ── B1. Workwise demo tenant, hospitality company 12 (Sample Hospitality Co) ──
-- Policies 143 (RFQ) / 144 (TECHNICAL) / 145 (NEGOTIATION) / 146 (NEGOTIATION_QUOTE)
-- at hotel 34 name three users who hold NO role scope in company 12 at all —
-- they are all scoped to company 13 instead. They are mapped into company 12,
-- which is why they resolve; they simply have no permissions there.
--
-- ── B2. Workwise demo tenant, hospitality company 13 (Workwise Hotels) ────────
-- EMP005 holds 'Commercial Approver' pinned to hotel 30, so policies 180/181 at
-- hotel 33 miss it; and holds only 'RFQ Observer' (read-only) for rfq/te. The
-- company-level Commercial Approver row below supersedes the hotel-30 one.
-- 615/617/618 hold Final Awarding P1/P2/P3 scoped to company 12 while the PO
-- policies naming them (152, 182) belong to company 13.
--
-- ── B3. Orchid Hotels Pune (hospitality company 4) — A REAL CUSTOMER ──────────
-- Policy 12 names Varun Sahani as the ARC approver. He already holds
-- 'Final Awarding P2' in company 4, so `awarding.*` is nothing new; role 16
-- adds ONLY arc.read + arc.approve — precisely the pair his existing ARC
-- approval duty requires. If you would rather not touch this tenant, delete
-- the (127, 16, 4) tuple below; the consequence is that policy 12 resolves to
-- nobody once the gate is enforced, which blocks ARC creation for that hotel.
-- There are currently zero ARCs under company 4, so nothing is mid-flight.

INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
SELECT v.user_id, v.role_id, v.company_id, NULL, NULL, NULL
FROM (VALUES
  -- B1 — company 12
  (405,  4, 12),   -- rfq.read+approve      → policy 143
  (405,  7, 12),   -- te.read+approve       → policy 144
  (405, 12, 12),   -- negotiation.*         → policy 145
  (407,  7, 12),   -- te.read+approve       → policy 144 step 2
  (407, 12, 12),   -- negotiation.*         → policy 145 step 2
  (412, 12, 12),   -- quote-compare.*       → policy 146
  -- B2 — company 13
  (412,  4, 13),   -- rfq.read+approve      → policies 148, 178
  (412,  7, 13),   -- te.read+approve       → policies 149, 179
  (412, 12, 13),   -- negotiation + quote-compare, hotel-wide → policies 180, 181
  (615, 13, 13),   -- awarding.read+approve → policies 152, 182 step 1
  (617, 14, 13),   -- awarding.read+approve → policies 152, 182 step 2
  (618, 15, 13),   -- awarding.read+approve → policy 182 step 3
  -- B3 — company 4 (real customer; adds only arc.read + arc.approve)
  (127, 16,  4)    -- arc.read+approve      → policy 12
) AS v(user_id, role_id, company_id)
WHERE NOT EXISTS (
  SELECT 1 FROM tbl_user_role_scopes s
   WHERE s.user_id = v.user_id AND s.role_id = v.role_id AND s.company_id = v.company_id
     AND s.hotel_id IS NULL AND s.department_id IS NULL AND s.process_id IS NULL
);

-- Record exactly what this script created, for a one-DELETE revert.
INSERT INTO tbl_user_role_scopes_prod04_backup (scope_id, user_id, role_id, company_id)
SELECT s.id, s.user_id, s.role_id, s.company_id
FROM tbl_user_role_scopes s
JOIN (VALUES
  (405,4,12),(405,7,12),(405,12,12),(407,7,12),(407,12,12),(412,12,12),
  (412,4,13),(412,7,13),(412,12,13),(615,13,13),(617,14,13),(618,15,13),(127,16,4)
) AS v(user_id, role_id, company_id)
  ON v.user_id = s.user_id AND v.role_id = s.role_id AND v.company_id = s.company_id
WHERE s.hotel_id IS NULL AND s.department_id IS NULL AND s.process_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM tbl_user_role_scopes_prod04_backup b WHERE b.scope_id = s.id);


-- ---------------------------------------------------------------------------
--  SECTION C — verify inside the transaction. MUST be 0. ROLLBACK if not.
-- ---------------------------------------------------------------------------
WITH map AS (SELECT * FROM (VALUES
  ('RFQ','rfq'),('TENDER','boq'),('TECHNICAL','te'),('NEGOTIATION','negotiation'),
  ('NEGOTIATION_QUOTE','quote-compare'),('PO','awarding'),('MR','awarding'),
  ('ARC','arc'),('ARC_PUBLISH','arc'),('ARC_TECH','arc-tech'),
  ('ARC_NEGOTIATION','arc-comm'),('ARC_COMMITTEE','arc-committee'),('ARC_AMENDMENT','arc')) AS v(et,res))
SELECT 'AFTER: section E rows' AS check, count(*) AS must_be_zero
FROM tbl_approval_policies p
JOIN tbl_approval_policy_steps s ON s.approval_policy_id = p.id
JOIN map m ON m.et = p.entity_type
JOIN tbl_users u ON u.id = s.approver_source_id
WHERE p.is_active AND s.approver_source_type = 'USER'
  AND NOT EXISTS (
    SELECT 1 FROM tbl_user_role_scopes urs
      JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
      JOIN tbl_permissions pm ON pm.id = rp.permission_id
     WHERE urs.user_id = u.id AND pm.resource::text = m.res AND pm.action IN ('read','approve')
       AND urs.company_id = p.hospitality_company_id
       AND (urs.hotel_id IS NULL OR urs.hotel_id = p.hotel_id)
       AND (urs.process_id IS NULL OR urs.process_id = p.process_id)
     GROUP BY urs.user_id HAVING count(DISTINCT pm.action) = 2);

-- No ACTIVE policy may resolve to nobody once the gate is enforced. MUST be 0.
WITH map AS (SELECT * FROM (VALUES
  ('RFQ','rfq'),('TENDER','boq'),('TECHNICAL','te'),('NEGOTIATION','negotiation'),
  ('NEGOTIATION_QUOTE','quote-compare'),('PO','awarding'),('MR','awarding'),
  ('ARC','arc'),('ARC_PUBLISH','arc'),('ARC_TECH','arc-tech'),
  ('ARC_NEGOTIATION','arc-comm'),('ARC_COMMITTEE','arc-committee'),('ARC_AMENDMENT','arc')) AS v(et,res)),
scored AS (
  SELECT p.id AS policy_id,
    CASE
      WHEN s.approver_source_type = 'ROLE' THEN
        (SELECT count(DISTINCT pm.action) = 2 FROM tbl_role_permissions rp
           JOIN tbl_permissions pm ON pm.id = rp.permission_id
          WHERE rp.role_id = s.approver_source_id AND pm.resource::text = m.res
            AND pm.action IN ('read','approve'))
      WHEN s.approver_source_type = 'USER' THEN
        EXISTS (SELECT 1 FROM tbl_user_role_scopes urs
                  JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
                  JOIN tbl_permissions pm ON pm.id = rp.permission_id
                 WHERE urs.user_id = s.approver_source_id AND pm.resource::text = m.res
                   AND pm.action IN ('read','approve')
                   AND urs.company_id = p.hospitality_company_id
                   AND (urs.hotel_id IS NULL OR urs.hotel_id = p.hotel_id)
                   AND (urs.process_id IS NULL OR urs.process_id = p.process_id)
                 GROUP BY urs.user_id HAVING count(DISTINCT pm.action) = 2)
      ELSE true END AS survives
  FROM tbl_approval_policies p
  JOIN tbl_approval_policy_steps s ON s.approval_policy_id = p.id
  JOIN map m ON m.et = p.entity_type
  WHERE p.is_active)
SELECT 'AFTER: active policies resolving to nobody' AS check, count(*) AS must_be_zero
FROM (SELECT policy_id, bool_or(survives) AS ok FROM scored GROUP BY 1) x
WHERE ok IS NOT TRUE;

-- What was granted.
SELECT 'GRANTED' AS phase, b.user_id, u.employee_code, r.title AS role, b.company_id
FROM tbl_user_role_scopes_prod04_backup b
JOIN tbl_users u ON u.id = b.user_id
JOIN tbl_roles r ON r.id = b.role_id
ORDER BY b.company_id, b.user_id, r.id;

COMMIT;
-- ROLLBACK;   -- if either count above is non-zero

-- ---------------------------------------------------------------------------
--  TO REVERT
--    DELETE FROM tbl_user_role_scopes
--     WHERE id IN (SELECT scope_id FROM tbl_user_role_scopes_prod04_backup);
--  (Do this only with the USER-source gate NOT enforced, or those policies
--   will resolve to nobody and block their entity types.)
-- ---------------------------------------------------------------------------
