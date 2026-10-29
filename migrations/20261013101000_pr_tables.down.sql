-- Revert Purchase Requisition tables (reverse dependency order) and the policy-step threshold column.
BEGIN;
DROP TABLE IF EXISTS public.tbl_pr_event;
DROP TABLE IF EXISTS public.tbl_pr_comment;
DROP TABLE IF EXISTS public.tbl_pr_catalog_request;
DROP TABLE IF EXISTS public.tbl_pr_line_rfq;
DROP TABLE IF EXISTS public.tbl_pr_review_line;
DROP TABLE IF EXISTS public.tbl_pr_review;
DROP TABLE IF EXISTS public.tbl_pr_review_category_map;
DROP TABLE IF EXISTS public.tbl_pr_attachment;
DROP TABLE IF EXISTS public.tbl_pr_line_clause;
DROP TABLE IF EXISTS public.tbl_purchase_requisition_line;
DROP TABLE IF EXISTS public.tbl_purchase_requisition;
ALTER TABLE public.tbl_approval_policy_steps DROP COLUMN IF EXISTS min_amount;
COMMIT;
