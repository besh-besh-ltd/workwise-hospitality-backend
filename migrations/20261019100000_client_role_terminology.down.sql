-- Down for 20261019100000_client_role_terminology: restore the previous titles
-- and descriptions, keyed by the NEW title (+ created_by IS NULL), never by id.
--
-- The "old" descriptions are the ones in the test seed (tests/setup/
-- seed_reference.sql), which mirror what the roles were created with. If an
-- environment had hand-edited a description before the up ran, the down
-- restores the seeded text rather than that edit - the up did not record it.
-- ARC Tech Evaluator's description was never changed, so it is left alone.

BEGIN;

WITH map(new_title, old_title, old_desc) AS (VALUES
  ('RFQ Creator',              'RFQ Creator',              'Creates RFQ/Tender documents'),
  ('RFQ Approver',             'Tender Approver',          'Approves tenders for publishing'),
  ('Commercial Evaluator',     'Commercial Negotiator N1', 'First-level commercial negotiator'),
  ('Commercial Approver',      'Commercial Approver',      'Approves commercial negotiations'),
  ('ARC Technical Evaluator',  'ARC Tech Evaluator',       NULL),
  ('ARC Commercial Evaluator', 'ARC Commercial Evaluator', 'Runs commercial evaluation and reconciles split-vendor awards on ARCs.'),
  ('ARC Commercial Approver',  'ARC Negotiation Approver', 'Approves the launch of negotiation rounds on Annual Rate Contracts.')
)
UPDATE public.tbl_roles r
   SET title       = m.old_title,
       description = COALESCE(m.old_desc, r.description)
  FROM map m
 WHERE r.created_by IS NULL
   AND r.title = m.new_title
   AND (m.old_title = m.new_title
        OR NOT EXISTS (SELECT 1 FROM public.tbl_roles x
                        WHERE x.created_by IS NULL
                          AND x.title = m.old_title
                          AND x.id <> r.id));

COMMIT;
