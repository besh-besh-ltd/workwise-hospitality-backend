-- Purchase requisitions: follow-up to 20261013101000_pr_tables (final review). Idempotent.
--
-- 1. Indexes on the FK columns a parent delete or a per-PR / per-line read scans.
--    20261013101000 indexed only tbl_purchase_requisition(_line) and
--    tbl_pr_line_rfq (pr_line_id, rfq_id). Without these:
--      - every tbl_rfq_products delete (ON DELETE CASCADE into tbl_pr_line_rfq)
--        seq-scans tbl_pr_line_rfq for rfq_product_id;
--      - every PR / line delete cascades into attachments, clauses, review lines
--        and catalog requests by a seq scan;
--      - the detail's per-PR attachment read and the per-line clause/attachment
--        reads at conversion scan the whole table.
--    Skipped on purpose: tbl_pr_review_line's PK leads with review_id (so
--    pr_line_id still needs its own); uq_pr_catreq_open_per_line is partial
--    (status = 'open') and serves neither the cascade nor a line's history.
--    The tables are new (empty on first deploy), so a plain CREATE INDEX is fine.
--
-- 2. tbl_pr_catalog_request.resolved_by -> tbl_users(id) ON DELETE SET NULL.
--    Every writer stores a tbl_users id: the platform admin (jwtAdm resolves the
--    token to a tbl_users row, adminModel.getUserById) or the buyer/requester
--    whose map / close / cancel auto-resolves the request. The table is new, so
--    the constraint is validated at once (no NOT VALID needed).
--
-- 3. The Company Administrator system role keeps pr.read ONLY (ruling R40).
--    20261013100000 now grants it just pr.read; a dev/test DB that ran the
--    earlier version also gave it pr.create / evaluate / approve / convert, which
--    made every company-wide admin an eligible reviewer of every department, an
--    assignable buyer and the recipient of every review task and approved-PR
--    mail. Those four grants are removed here. Only the system role
--    (created_by IS NULL) is touched; a custom role with the same title is not.
--    The .down.sql does NOT re-grant them.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_pr_attachment_pr      ON public.tbl_pr_attachment (pr_id);
CREATE INDEX IF NOT EXISTS idx_pr_attachment_line    ON public.tbl_pr_attachment (pr_line_id);
CREATE INDEX IF NOT EXISTS idx_pr_line_clause_line   ON public.tbl_pr_line_clause (pr_line_id);
CREATE INDEX IF NOT EXISTS idx_pr_line_rfq_product   ON public.tbl_pr_line_rfq (rfq_product_id);
CREATE INDEX IF NOT EXISTS idx_pr_review_line_line   ON public.tbl_pr_review_line (pr_line_id);
CREATE INDEX IF NOT EXISTS idx_pr_catreq_line        ON public.tbl_pr_catalog_request (pr_line_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_pr_catreq_resolved_by'
       AND conrelid = 'public.tbl_pr_catalog_request'::regclass
  ) THEN
    ALTER TABLE public.tbl_pr_catalog_request
      ADD CONSTRAINT fk_pr_catreq_resolved_by
      FOREIGN KEY (resolved_by) REFERENCES public.tbl_users(id) ON DELETE SET NULL;
  END IF;
END $$;

DELETE FROM public.tbl_role_permissions rp
 USING public.tbl_roles r, public.tbl_permissions p
 WHERE rp.role_id = r.id
   AND rp.permission_id = p.id
   AND r.title = 'Company Administrator'
   AND r.created_by IS NULL
   AND p.resource = 'pr'::public.resource_type
   AND p.action::text IN ('create', 'evaluate', 'approve', 'convert');

COMMIT;
