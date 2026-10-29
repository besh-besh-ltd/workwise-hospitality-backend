-- Client role terminology (feedback 2026-10-19): rename the system roles the
-- client kept reading as the wrong thing, and give every RFQ/ARC role a
-- description that says what the role actually does.
--
--   Tender Approver            -> RFQ Approver
--   Commercial Negotiator N1   -> Commercial Evaluator
--   ARC Tech Evaluator         -> ARC Technical Evaluator   (description kept)
--   ARC Negotiation Approver   -> ARC Commercial Approver
--   RFQ Creator, Commercial Approver, ARC Commercial Evaluator: description only
--
-- Template: 20260829093000_rename_tender_creator_role.sql (only role 2 was ever
-- renamed). Safe for the same reason: nothing in the application joins roles on
-- title; every lookup is by role_id through tbl_user_role_scopes /
-- tbl_role_permissions, and the screens read titles live from tbl_roles.
-- Activity-trail rows keep the title captured when they were written, by
-- design.
--
-- Role ids DIFFER between prod / stage / test (ARC Commercial Evaluator is prod
-- 29 / stage 25 / test 24; stage id 29 is "MR Approver"; stage has no
-- 'ARC Negotiation Approver' row at all). So every statement is keyed on the
-- current title + created_by IS NULL, never on id, and a missing row is a
-- no-op. A tenant's own role (created_by NOT NULL) is never touched, and a
-- rename is skipped if another system role already holds the target title.
-- Re-running changes nothing.

BEGIN;

WITH map(old_title, new_title, new_desc) AS (VALUES
  ('RFQ Creator',              'RFQ Creator',              'Creates and edits RFQs'),
  ('Tender Approver',          'RFQ Approver',             'Approves RFQs before they are published to vendors'),
  ('Commercial Negotiator N1', 'Commercial Evaluator',     'Evaluates quotes, runs negotiation rounds, approves colleagues'' rounds and co-signs the final vendor'),
  ('Commercial Approver',      'Commercial Approver',      'Approves the final vendor and price before the PO'),
  ('ARC Tech Evaluator',       'ARC Technical Evaluator',  NULL),
  ('ARC Commercial Evaluator', 'ARC Commercial Evaluator', 'Runs commercial evaluation and negotiation rounds on Annual Rate Contracts and approves colleagues'' rounds'),
  ('ARC Negotiation Approver', 'ARC Commercial Approver',  'Manager sign-off on ARC negotiation rounds where a workflow names this role')
)
UPDATE public.tbl_roles r
   SET title       = m.new_title,
       description = COALESCE(m.new_desc, r.description)
  FROM map m
 WHERE r.created_by IS NULL
   AND r.title = m.old_title
   AND (m.old_title = m.new_title
        OR NOT EXISTS (SELECT 1 FROM public.tbl_roles x
                        WHERE x.created_by IS NULL
                          AND x.title = m.new_title
                          AND x.id <> r.id));

COMMIT;
