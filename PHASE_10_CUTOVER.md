# Phase 10 — Tender / ARC Cutover Plan

This document is the runbook for cutting over the Tender / ARC feature
from `feat/arc` into staging and production. Phase 9 is complete: 13
test suites, 72 tests, all green on local Postgres in <5s.

## Pre-cutover gates

All must be GREEN before staging deploy:

- [ ] `npm test` on `feat/arc` ≥ 429 passing, 0 failing.
- [ ] Frontend builds clean: `cd frontend && npm run lint && npm run build:test`.
- [ ] Migration `app/migrations/001-tender-arc.sql` applies cleanly to a
      staging snapshot of production. Re-run idempotency check (apply twice).
- [ ] Migration `app/migrations/002-arc-global-hierarchy.sql` ditto.
- [ ] Migration `app/migrations/003-bypass-arc-per-product.sql` ditto.
- [ ] Schema sanity in staging:
      ```sql
      \d tbl_arc; \d tbl_arc_item; \d tbl_arc_hotels;
      \d tbl_arc_release; \d tbl_arc_release_items;
      \d tbl_tender_sendback_history; \d tbl_arc_vendor_signing
      SELECT column_name FROM information_schema.columns
       WHERE table_name='tbl_rfq'
         AND column_name IN ('tender_scope','arc_period_from','arc_period_to',
                             'bypass_arc','iteration_number');
      SELECT process_type, COUNT(*) FROM tbl_approval_processes GROUP BY process_type;
      ```

## Staging smoke flow (run in order)

This is the same end-to-end flow exercised by `arc.tender.end-to-end.test.js`,
re-played manually via the live UI to confirm production-grade behavior:

1. **Single ARC create.** Buyer creates a tender, scope=SINGLE,
   hotel A1, picks a TENDER-typed process, period dates, two
   contracted products, two vendor mappings each. Submit.
2. **Tender approval.** TENDER stage approver in the configured
   committee approves the tender create.
3. **Quoting.** Two vendors submit quotes via the vendor portal.
4. **Multi-vendor finalize.** Buyer multi-selects both vendors for
   each product on the ARC route. Confirm 2 envelopes spawn with
   per-cell PENDING approval instances.
5. **ARC committee approval.** Committee approves all 4 cells via
   the matrix UI. Both envelopes go ACTIVE, consolidated PDFs render
   without quantity, period dates present, S3 URLs persisted.
6. **Vendor sees the ARC.** Vendor logs in, sees the active ARC in
   the vendor dashboard with the consolidated PDF download link.
7. **Contracted-item detection.** Buyer drafts a fresh RFQ for the
   contracted product on hotel A1. Item shows the CONTRACTED tag with
   both vendor names + period.
8. **Direct-PO release.** Buyer chooses "Create PO directly", picks
   vendor alpha, enters quantities, releases. Verify:
     - tbl_arc_release status='PO_DRAFTED'
     - tbl_rfq_purchase_order rfq_id=NULL, is_contracted=1, vendor=alpha
     - tbl_purchase_order_product unit_price + qty + total per line
     - Contracted POs listing tab shows the new PO
9. **PO approval + vendor accept (existing WH-21 path).**
10. **Send-back smoke.** From a separate tender at the ARC stage,
    send back to TECHNICAL_EVALUATION with a ≥30-char reason. Verify
    Iteration History panel + drawer + iteration counter +
    CANCELLED-not-DELETED approvals.
11. **Bypass-ARC smoke.** Add a contracted product to a fresh draft,
    choose "Continue with RFQ", enter a ≥30-char reason. Verify
    BypassArcRibbon shows in the wizard, list, and quote-compare.

## Group ARC smoke

Repeat the smoke once with `tender_scope='GROUP'` covering 2+ hotels
(possibly across hospitality companies). Confirm the **Group ARC
hierarchy admin UI** at `/dashboard/admin/hospitality-manager/global-arc-hierarchy`
hosts a configured network-global policy at each tender stage and
that the engine routes there.

## Feature flag

Wrap the buyer-side toggle in the wizard (Tender vs RFQ) under an env
var `TENDER_ARC_ENABLED`. Default to `false` in production until the
above smokes are green; flip to `true` per-environment as the cutover
progresses. The flag check lives in:

  - `frontend/components/dashboard/buyer/createRFQ/CreateRFQ.js` —
    hide/show the Tender toggle button.

## Rollback plan

If a critical issue surfaces post-cutover:

1. Flip `TENDER_ARC_ENABLED=false`. Tender creation is disabled
   instantly; existing tenders continue running their lifecycle but no
   new ones can be created.
2. If the issue is in approval/finalize/release: revert the offending
   commit on `main`; redeploy. The schema migration is forward-only
   and intentionally additive — no rollback DDL is needed; existing
   prod data lives in NEW columns/tables that the old code ignores.
3. If the issue is in the schema: contact DBA. We have backups
   pinned at the migration boundary per the staging deploy script.

## Out of scope (explicitly deferred)

The following were architected during Phase 0–8 but not implemented;
they do not block cutover:

- Vendor in-app ARC acceptance + 3-tier reminder. The
  `tbl_arc_vendor_signing` table exists for forward-compat. The vendor
  ARC dashboard renders the signed PDF; explicit accept/reject flow
  lands in v2.
- Auto-renewal / expiry-warning emails on ARC.
- Bypass-ARC requiring an escalated approval policy. Today the
  bypass uses the standard tender approval chain; v2 may add an
  escalation layer.
- Ranked / split-quantity multi-vendor allocation. Current
  multi-vendor model treats vendors as equal partners; the buyer
  picks one at release time. Splitting a single quantity across
  vendors lands in v2.

## Production deploy gate

Production cutover is gated on:

- All staging smokes ✅
- Zero P1/P2 issues open against `feat/arc`
- Sign-off from product team
- DBA has applied migration on a prod backup snapshot to verify
  apply time + rollback feasibility
