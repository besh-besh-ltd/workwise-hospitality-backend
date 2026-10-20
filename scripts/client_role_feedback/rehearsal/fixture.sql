-- ═══════════════════════════════════════════════════════════════════════════
-- Client role feedback · REHEARSAL FIXTURE (scratch database only)
--
-- Loaded by rehearse_local.sh into hospitality_roleterms_rehearsal after
-- schema.sql + seed_reference.sql + pendingMigrations.json. Never run this
-- anywhere else: it renumbers a seeded process and inserts fixed ids.
--
-- Prod-shaped on purpose. The ids the scripts assert (processes 8/9/11,
-- policies 8/190-193, ARC policy 221) are the PRODUCTION ids, and the counts
-- match data.sql (3 processes, 5 policies, 53 dead-level policies = 25 RFQ +
-- 27 TECHNICAL + 1 TENDER, 1 ARC round policy), so the rehearsal runs the
-- exact command lines the production run will use, with no overrides.
--
-- Shape (buyer tbl_company 13 = the client):
--   hosp co 3  hotels 4 (Orchid Pune), 11      core scenarios
--   hosp co 5  hotel 6 (Orchid Mumbai)          ARC policy 221 + a tenant role
--   hosp co 7  hotels 2001-2024                 bulk dead-level policies
--   hosp co 91 hotel 9001 under BUYER 90        negative control, never touched
--
-- Roles are referenced by id here because this is the scratch DB whose ids we
-- just built (seed_reference + migrations): 2 RFQ Creator, 4 RFQ Approver,
-- 6 Technical Evaluator, 7 Technical Approver, 8 Commercial Evaluator,
-- 12 Commercial Approver, 13 Final Awarding P1, 24 ARC Commercial Evaluator,
-- 30 ARC Commercial Approver. The scripts themselves look roles up by title.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
BEGIN;

DO $chk$ BEGIN
  IF current_database() <> 'hospitality_roleterms_rehearsal' THEN
    RAISE EXCEPTION 'fixture.sql refuses to run outside hospitality_roleterms_rehearsal (got %)', current_database();
  END IF;
  -- the role ids below are this DB's; fail loudly if the seed ever moves them
  IF (SELECT string_agg(id || '=' || title, ',' ORDER BY id) FROM tbl_roles
       WHERE id IN (2,4,6,7,8,12,13,24,30) AND created_by IS NULL)
     <> '2=RFQ Creator,4=RFQ Approver,6=Technical Evaluator,7=Technical Approver,8=Commercial Evaluator,12=Commercial Approver,13=Final Awarding P1,24=ARC Commercial Evaluator,30=ARC Commercial Approver' THEN
    RAISE EXCEPTION 'seeded role ids/titles are not what this fixture expects';
  END IF;
END $chk$;

-- ── buyers, people, departments ─────────────────────────────────────────────
INSERT INTO tbl_company (id, company_name, is_hospitality, "createdAt") VALUES
  (13, 'Phileein Hospitality (client)', 1, now()),
  (90, 'Other Buyer Group',             1, now());

INSERT INTO tbl_users (id, name, email, status, company_id, created_at, updated_at) VALUES
  (150,  'Phileein Hospitality', 'hospitality@example.test', 1, 13, now(), now()),
  (9101, 'Asha (RFQ Creator)',          'asha@example.test',   1, 13, now(), now()),
  (9102, 'Bharat (RFQ Approver)',       'bharat@example.test', 1, 13, now(), now()),
  (9103, 'Chitra (RFQ Approver h4)',    'chitra@example.test', 1, 13, now(), now()),
  (9104, 'Dev (Technical Evaluator)',   'dev@example.test',    1, 13, now(), now()),
  (9105, 'Esha (Technical Approver)',   'esha@example.test',   1, 13, now(), now()),
  (9106, 'Farhan (USER step, h11)',     'farhan@example.test', 1, 13, now(), now()),
  (9107, 'Gauri (ARC Comm Approver)',   'gauri@example.test',  1, 13, now(), now()),
  (9108, 'Hari (ARC Comm Evaluator)',   'hari@example.test',   1, 13, now(), now()),
  (9109, 'Isha (ARC Comm Evaluator)',   'isha@example.test',   1, 13, now(), now()),
  (9110, 'Jai (blind approver)',        'jai@example.test',    1, 13, now(), now()),
  (9190, 'Other buyer approver',        'other@example.test',  1, 90, now(), now());

INSERT INTO tbl_department (id, title) VALUES (1, 'Housekeeping'), (2, 'Food & Beverage');

-- A TENANT role that happens to carry a system title. Script 02 keys on
-- created_by IS NULL, so a policy naming this role must NOT be touched.
INSERT INTO tbl_roles (id, title, description, created_by)
VALUES (9201, 'RFQ Creator', 'tenant copy of the title (negative control)', 150);
INSERT INTO tbl_role_permissions (role_id, permission_id)
SELECT 9201, p.id FROM tbl_permissions p WHERE p.resource::text = 'rfq' AND p.action::text IN ('read', 'create');

-- ── hospitality companies and units ─────────────────────────────────────────
INSERT INTO tbl_hospitality_companies (id, buyer_company_id, name) VALUES
  (3,  13, 'Orchid Hotels Pune'),
  (5,  13, 'Orchid Hotels Mumbai'),
  (7,  13, 'Bulk Hotels'),
  (91, 90, 'Other Group (buyer 90)');

INSERT INTO tbl_hospitality_company_hotels (id, hospitality_company_id, name) VALUES
  (4, 3, 'Orchid Pune'), (11, 3, 'Orchid Unit 11'), (6, 5, 'Orchid Mumbai'), (9001, 91, 'Other Hotel');
INSERT INTO tbl_hospitality_company_hotels (id, hospitality_company_id, name)
SELECT 2000 + g, 7, 'Bulk Hotel ' || g FROM generate_series(1, 24) g;

INSERT INTO tbl_hospitality_user_mappings (id, user_id, hospitality_company_id, hospitality_hotel_id, mapping_type) VALUES
  (1, 9101, 3, NULL, 0), (2, 9102, 3, NULL, 0), (3, 9103, 3, NULL, 0), (4, 9104, 3, NULL, 0),
  (5, 9105, 3, NULL, 0), (6, 9106, 3, NULL, 0), (7, 9107, 5, NULL, 0), (8, 9108, 5, NULL, 0),
  (9, 9109, 5, NULL, 0), (10, 9110, 3, NULL, 0), (11, 9102, 7, NULL, 0), (12, 9105, 7, NULL, 0),
  (13, 9190, 91, NULL, 0);

INSERT INTO tbl_user_role_scopes (id, user_id, role_id, company_id, hotel_id, department_id, process_id) VALUES
  (1,  9101, 2,  3, NULL, NULL, NULL),
  (2,  9102, 4,  3, NULL, NULL, NULL),
  (3,  9103, 4,  3, 4,    NULL, NULL),
  (4,  9104, 6,  3, NULL, NULL, NULL),
  (5,  9105, 7,  3, NULL, NULL, NULL),
  (6,  9106, 4,  3, 11,   NULL, NULL),
  (7,  9107, 30, 5, 6,    NULL, NULL),
  (8,  9108, 24, 5, 6,    NULL, NULL),
  (9,  9109, 24, 5, 6,    NULL, NULL),
  (10, 9102, 4,  7, NULL, NULL, NULL),
  (11, 9105, 7,  7, NULL, NULL, NULL),
  (12, 9190, 4,  91, NULL, NULL, NULL);

-- ── processes ───────────────────────────────────────────────────────────────
-- The seed's buyer-90 process 8 is moved out of the way so the client's
-- processes can carry their production ids 8 / 9 / 11. Process 2 ("Day to Day
-- Procurement", buyer 13) is already seeded with its production id.
UPDATE tbl_approval_processes SET id = 18 WHERE id = 8 AND company_id = 90;
INSERT INTO tbl_approval_processes (id, company_id, name, description, is_active, created_by, process_type) VALUES
  (8,  13, 'RFQ Approval',        'unused (prod-shaped)', true, 150, 'RFQ'),
  (9,  13, 'RFQ Approval Matrix', 'unused (prod-shaped)', true, 150, 'RFQ'),
  (11, 13, 'Unit ARC',            'unused (prod-shaped)', true, 150, 'RFQ'),
  -- same name, other buyer: must NOT be deactivated
  (12, 90, 'RFQ Approval',        'negative control',     true, 150, 'RFQ');

-- ── policies ────────────────────────────────────────────────────────────────
INSERT INTO tbl_approval_policies (id, entity_type, hospitality_company_id, hotel_id, department_id, process_id, is_active, is_master, version, created_by, created_at) VALUES
  -- production ids
  (8,    'TENDER',            3, 4,    NULL, 2,    true,  true, 1, 150, '2026-02-20 10:00'),
  (190,  'TENDER',            3, 11,   NULL, 9,    true,  true, 1, 150, '2026-07-01 10:00'),
  (191,  'TECHNICAL',         3, 11,   NULL, 9,    true,  true, 1, 150, '2026-07-01 10:01'),
  (192,  'NEGOTIATION',       3, 11,   NULL, 9,    true,  true, 1, 150, '2026-07-01 10:02'),
  (193,  'NEGOTIATION_QUOTE', 3, 11,   NULL, 9,    true,  true, 1, 150, '2026-07-01 10:03'),
  (221,  'ARC_NEGOTIATION',   5, 6,    NULL, NULL, true,  true, 1, 150, '2026-10-06 10:00'),
  -- core scenarios
  (1001, 'RFQ',               3, 4,    NULL, 2,    true,  true, 3, 150, '2026-03-01 10:00'),
  (1002, 'RFQ',               3, 4,    NULL, 2,    false, true, 1, 150, '2026-02-01 10:00'),
  (1003, 'RFQ',               3, 11,   NULL, 2,    true,  true, 1, 150, '2026-03-01 10:01'),
  (1101, 'TECHNICAL',         3, 4,    NULL, 2,    true,  true, 1, 150, '2026-03-01 10:02'),
  (1102, 'TECHNICAL',         3, 11,   NULL, 2,    true,  true, 1, 150, '2026-03-01 10:03'),
  (1201, 'NEGOTIATION',       3, NULL, NULL, 2,    true,  true, 1, 150, '2026-03-01 10:04'),
  (1202, 'NEGOTIATION_QUOTE', 3, 4,    NULL, 2,    true,  true, 1, 150, '2026-03-01 10:05'),
  (1203, 'PO',                3, 4,    NULL, NULL, true,  true, 1, 150, '2026-03-01 10:06'),
  (1204, 'RFQ',               5, 6,    NULL, 2,    true,  true, 1, 150, '2026-03-01 10:07'),
  (1205, 'TECHNICAL',         5, 6,    NULL, 2,    true,  true, 1, 150, '2026-03-01 10:08'),
  (1301, 'ARC_NEGOTIATION',   3, 4,    NULL, NULL, true,  true, 1, 150, '2026-03-01 10:09'),
  -- buyer 90: negative controls
  (9001, 'RFQ',               91, 9001, NULL, 5,   true,  true, 1, 150, '2026-03-01 10:10'),
  (9002, 'ARC_NEGOTIATION',   91, 9001, NULL, NULL, true, true, 1, 150, '2026-03-01 10:11'),
  (9003, 'TENDER',            91, 9001, NULL, 18,  true,  true, 1, 150, '2026-03-01 10:12');

-- bulk: 22 RFQ (hotels 2001-2022) + 24 TECHNICAL (hotels 2001-2024), process 2
INSERT INTO tbl_approval_policies (id, entity_type, hospitality_company_id, hotel_id, department_id, process_id, is_active, is_master, version, created_by, created_at)
SELECT 1003 + g, 'RFQ', 7, 2000 + g, NULL, 2, true, true, 1, 150, '2026-04-01 10:00'::timestamp + g * interval '1 minute'
  FROM generate_series(1, 22) g;
INSERT INTO tbl_approval_policies (id, entity_type, hospitality_company_id, hotel_id, department_id, process_id, is_active, is_master, version, created_by, created_at)
SELECT 1102 + g, 'TECHNICAL', 7, 2000 + g, NULL, 2, true, true, 1, 150, '2026-04-02 10:00'::timestamp + g * interval '1 minute'
  FROM generate_series(1, 24) g;

-- steps: step id = policy id * 10 + step_order (readable in the reports)
INSERT INTO tbl_approval_policy_steps (id, approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id) VALUES
  (81,    8,    1, 'ANY', 'ROLE', 4),
  (1901,  190,  1, 'ANY', 'ROLE', 2),   -- dead: RFQ Creator lacks boq.approve
  (1902,  190,  2, 'ANY', 'ROLE', 4),
  (1911,  191,  1, 'ANY', 'ROLE', 6),   -- dead
  (1912,  191,  2, 'ANY', 'ROLE', 7),
  (1921,  192,  1, 'ALL', 'ROLE', 8),
  (1931,  193,  1, 'ANY', 'ROLE', 12),
  (2211,  221,  1, 'ANY', 'ROLE', 30),  -- script 03 target
  (10011, 1001, 1, 'ANY', 'ROLE', 2),   -- dead
  (10012, 1001, 2, 'ANY', 'ROLE', 4),
  (10021, 1002, 1, 'ANY', 'ROLE', 2),   -- dead (inactive policy)
  (10022, 1002, 2, 'ANY', 'ROLE', 4),
  (10031, 1003, 1, 'ANY', 'ROLE', 2),   -- dead, two levels shift
  (10032, 1003, 2, 'ALL', 'ROLE', 4),
  (10033, 1003, 3, 'ANY', 'USER', 9106),
  (11011, 1101, 1, 'ANY', 'ROLE', 6),   -- dead
  (11012, 1101, 2, 'ANY', 'ROLE', 7),
  (11021, 1102, 1, 'ANY', 'ROLE', 7),
  (11022, 1102, 2, 'ANY', 'ROLE', 6),   -- dead at the END: nothing to renumber
  (12011, 1201, 1, 'ALL', 'ROLE', 8),
  (12021, 1202, 1, 'ANY', 'ROLE', 12),
  (12031, 1203, 1, 'ANY', 'ROLE', 13),
  (12041, 1204, 1, 'ANY', 'ROLE', 9201), -- tenant 'RFQ Creator': NOT a target
  (12042, 1204, 2, 'ANY', 'ROLE', 4),
  (12051, 1205, 1, 'ANY', 'ROLE', 7),
  (13011, 1301, 1, 'ANY', 'ROLE', 30),  -- two-step ARC policy: NOT a 03 target
  (13012, 1301, 2, 'ALL', 'ROLE', 24),
  (90011, 9001, 1, 'ANY', 'ROLE', 2),   -- other buyer: NOT a target
  (90012, 9001, 2, 'ANY', 'ROLE', 4),
  (90021, 9002, 1, 'ANY', 'ROLE', 30),  -- other buyer: NOT a target
  (90031, 9003, 1, 'ANY', 'ROLE', 4);
INSERT INTO tbl_approval_policy_steps (id, approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
SELECT p.id * 10 + o, p.id, o, 'ANY', 'ROLE',
       CASE WHEN p.entity_type = 'RFQ' THEN (ARRAY[2, 4])[o] ELSE (ARRAY[6, 7])[o] END
  FROM tbl_approval_policies p CROSS JOIN generate_series(1, 2) o
 WHERE p.hospitality_company_id = 7;

-- ── approval instances ──────────────────────────────────────────────────────
-- What the engine builds when a level-1 step is dead: the dead step is dropped
-- and the survivors are renumbered from 1, so instance step 1 links to policy
-- step 2 (or the link is NULL, on instances older than the link column).
INSERT INTO tbl_approval_instances (id, entity_type, entity_id, approval_policy_id, status, current_step, hospitality_company_id, hotel_id, department_id, initiated_by, process_id, created_at, completed_at) VALUES
  (7001, 'RFQ',             5001, 1001, 'PENDING',  1, 3, 4,    1,    9101, 2,    '2026-10-01 09:00', NULL),
  (7002, 'RFQ',             5002, 1001, 'PENDING',  1, 3, 4,    1,    9101, 2,    '2026-10-01 09:01', NULL),
  (7003, 'RFQ',             5003, 1001, 'APPROVED', 1, 3, 4,    1,    9101, 2,    '2026-09-01 09:00', '2026-09-02 09:00'),
  (7004, 'RFQ',             5004, 1002, 'APPROVED', 2, 3, 4,    NULL, 9101, 2,    '2026-02-02 09:00', '2026-02-03 09:00'),
  (7005, 'RFQ',             5005, 1003, 'PENDING',  2, 3, 11,   2,    9101, 2,    '2026-10-02 09:00', NULL),
  (7006, 'TECHNICAL',       6001, 1101, 'PENDING',  1, 3, 4,    1,    9104, 2,    '2026-10-03 09:00', NULL),
  (7007, 'TECHNICAL',       6002, 1102, 'PENDING',  1, 3, 11,   1,    9104, 2,    '2026-10-03 09:01', NULL),
  (7008, 'ARC_NEGOTIATION', 8001, 221,  'APPROVED', 1, 5, 6,    NULL, 9108, NULL, '2026-10-07 09:00', '2026-10-07 10:00'),
  (7009, 'RFQ',             5009, 1001, 'PENDING',  1, 3, 4,    1,    9101, 2,    '2026-10-04 09:00', NULL),
  (7010, 'RFQ',             5010, 9001, 'PENDING',  1, 91, 9001, NULL, 9190, 5,   '2026-10-04 09:01', NULL);

INSERT INTO tbl_approval_instance_steps (id, approval_instance_id, policy_step_id, step_order, decision_rule, status, completed_at) VALUES
  (7101, 7001, 10012, 1, 'ANY', 'PENDING',  NULL),
  (7102, 7002, NULL,  1, 'ANY', 'PENDING',  NULL),
  (7103, 7003, 10012, 1, 'ANY', 'APPROVED', '2026-09-02 09:00'),
  -- history from before the Creator lost authority: links the dead step itself.
  -- Deleting that step NULLs this link (FK ON DELETE SET NULL); 02 backs it up
  -- and 99_rollback_02 restores it.
  (7104, 7004, 10021, 1, 'ANY', 'APPROVED', '2026-02-02 12:00'),
  (7105, 7004, 10022, 2, 'ANY', 'APPROVED', '2026-02-03 09:00'),
  (7106, 7005, 10032, 1, 'ALL', 'APPROVED', '2026-10-02 12:00'),
  (7107, 7005, 10033, 2, 'ANY', 'PENDING',  NULL),
  (7108, 7006, 11012, 1, 'ANY', 'PENDING',  NULL),
  (7109, 7007, 11021, 1, 'ANY', 'PENDING',  NULL),
  (7110, 7008, 2211,  1, 'ANY', 'APPROVED', '2026-10-07 10:00'),
  (7111, 7009, 10012, 1, 'ANY', 'PENDING',  NULL),
  (7112, 7010, 90012, 1, 'ANY', 'PENDING',  NULL);

INSERT INTO tbl_approval_step_approvers (id, approval_instance_step_id, approver_user_id, status, acted_at, removed_at, removal_reason) VALUES
  (7201, 7101, 9102, 'PENDING',  NULL, NULL, NULL),
  (7202, 7101, 9103, 'PENDING',  NULL, NULL, NULL),
  (7203, 7102, 9102, 'PENDING',  NULL, NULL, NULL),
  (7204, 7103, 9102, 'APPROVED', '2026-09-02 09:00', NULL, NULL),
  (7205, 7104, 9101, 'APPROVED', '2026-02-02 12:00', NULL, NULL),
  (7206, 7105, 9102, 'APPROVED', '2026-02-03 09:00', NULL, NULL),
  (7207, 7106, 9102, 'APPROVED', '2026-10-02 12:00', NULL, NULL),
  (7208, 7106, 9103, 'APPROVED', '2026-10-02 12:30', NULL, NULL),
  (7209, 7107, 9106, 'PENDING',  NULL, NULL, NULL),
  (7210, 7108, 9105, 'PENDING',  NULL, NULL, NULL),
  -- pre-existing anomaly the reports must show unchanged: holds nothing on 'te'
  (7211, 7108, 9110, 'PENDING',  NULL, NULL, NULL),
  (7212, 7109, 9105, 'PENDING',  NULL, NULL, NULL),
  (7213, 7110, 9107, 'APPROVED', '2026-10-07 10:00', NULL, NULL),
  -- pre-existing anomaly: the current step's only approver was removed
  (7214, 7111, 9103, 'REMOVED',  NULL, '2026-10-05 09:00+00', 'role_removed'),
  (7215, 7112, 9190, 'PENDING',  NULL, NULL, NULL);

-- bulk pending instances: one linked to policy step 2 per bulk policy, plus a
-- NULL-linked one on every even-numbered bulk RFQ policy
INSERT INTO tbl_approval_instances (id, entity_type, entity_id, approval_policy_id, status, current_step, hospitality_company_id, hotel_id, department_id, initiated_by, process_id, created_at)
SELECT 100000 + p.id * 10 + k, p.entity_type, 500000 + p.id * 10 + k, p.id, 'PENDING', 1, 7, p.hotel_id, 1, 9101, 2,
       '2026-10-10 09:00'::timestamp + (p.id * 10 + k) * interval '1 second'
  FROM tbl_approval_policies p CROSS JOIN generate_series(1, 2) k
 WHERE p.hospitality_company_id = 7 AND (k = 1 OR (p.entity_type = 'RFQ' AND p.id % 2 = 0));
INSERT INTO tbl_approval_instance_steps (id, approval_instance_id, policy_step_id, step_order, decision_rule, status)
SELECT i.id, i.id, CASE WHEN i.id % 10 = 1 THEN i.approval_policy_id * 10 + 2 END, 1, 'ANY', 'PENDING'
  FROM tbl_approval_instances i WHERE i.id >= 100000;
INSERT INTO tbl_approval_step_approvers (id, approval_instance_step_id, approver_user_id, status)
SELECT s.id, s.id, CASE WHEN i.entity_type = 'RFQ' THEN 9102 ELSE 9105 END, 'PENDING'
  FROM tbl_approval_instance_steps s JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
 WHERE s.id >= 100000;

-- ── sequences past the fixed ids, FKs the reference seed made us drop ──────
DO $seq$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.column_default LIKE 'nextval(%'
       AND c.data_type IN ('integer', 'bigint')
  LOOP
    EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, %L), GREATEST(COALESCE(max(%I), 1), 1)) FROM public.%I',
                   'public.' || r.table_name, r.column_name, r.column_name, r.table_name);
  END LOOP;
END $seq$;

ALTER TABLE tbl_approval_processes ADD CONSTRAINT tbl_approval_processes_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES tbl_company(id) NOT VALID;
ALTER TABLE tbl_approval_processes ADD CONSTRAINT tbl_approval_processes_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES tbl_users(id) NOT VALID;

COMMIT;
